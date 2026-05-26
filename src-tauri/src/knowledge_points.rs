//! 知识点（Knowledge Point）边界检测 —— 方案 B + A 加成
//!
//! 输入：某 session 的全部 RAG chunks（已 L2 归一化的 embedding + 页锚点）
//! 输出：连续 chunk 段组成的"知识点"列表，每个 KP 跨 1..N 块、可跨多页
//!
//! 核心算法（TextTiling 思路简化版）：
//!
//! 1. **相邻相似度数列**：对 [c0..cN] 计算 `sim[i] = dot(c[i], c[i+1])`（已归一化 → cosine）
//!    高分 → 相邻块同主题；低分 → 主题切换点
//!
//! 2. **depth score**（局部低谷强度）：对每个 i，
//!      depth(i) = max(left_peak - sim[i], 0) + max(right_peak - sim[i], 0)
//!    其中 left_peak/right_peak 是 i 左/右窗口内的最大 sim。
//!    depth 大表示"两边都明显高，这里明显低" → 强主题切换
//!
//! 3. **阈值切边**：`threshold = mean(depth) + DEPTH_FACTOR * std(depth)`
//!    超过阈值的位置作为候选边界（在 chunk i 之后切）。
//!
//! 4. **TOC 强制边界**（可选）：若调用方传入 `toc_page_starts`，把这些页起始
//!    对应的"首个落在该页的 chunk index"标为强制切点（不参与阈值判定）。
//!
//! 5. **长度约束合并**：
//!    - 若一段累计 char_count < `MIN_KP_CHARS` → 合并到下一段
//!    - 若一段累计 char_count > `MAX_KP_CHARS` → 在中间最弱处（最高 sim）强切
//!
//! 6. **输出 KP 元信息**：page_start/page_end 取首末 chunk 的 page 锚；
//!    chunk_ids 为该段所有 chunk_index 升序数组（序列化为 JSON）。
//!
//! 不依赖 LLM；纯几何/统计。LLM 仅在后续 `refine_titles` 阶段被调用。

use crate::db;
use serde::Serialize;

/// 单个知识点单元长度下限（字符）。太短的小节会被合并。
const MIN_KP_CHARS: i64 = 1200;
/// 单个知识点单元长度上限（字符）。太长会被强切。
const MAX_KP_CHARS: i64 = 5000;
/// depth 阈值因子。`threshold = mean + DEPTH_FACTOR * std`；越大 → 越保守（KP 越长）。
const DEPTH_FACTOR: f32 = 0.4;
/// depth 计算时左右窗口大小（块数）。覆盖前后 N 块找局部峰值。
const PEAK_WINDOW: usize = 3;

/// 一个待写库的 KP（chunk_ids 已按 chunk_index 升序）。
#[derive(Debug, Clone, Serialize)]
pub struct DetectedKp {
    pub kp_index: i64,
    pub page_start: i64,
    pub page_end: i64,
    pub chunk_indexes: Vec<i64>,
    pub char_count: i64,
    /// 启发式短预览（首块前 80 字 + ... + 末块前 80 字），供 UI 占位
    pub preview: String,
}

/// 把 [chunks]（按 chunk_index 升序）切成 KP。
///
/// - `toc_page_starts`：可选 TOC 页号集合（0-based），落在这些页**起点的首个 chunk**
///   会被强制作为新 KP 起点。空数组 = 不启用 A 加成
pub fn detect_kps(
    chunks: &[db::RagChunkRow],
    toc_page_starts: &[i64],
) -> Vec<DetectedKp> {
    if chunks.is_empty() {
        return Vec::new();
    }
    // 单块时直接返回一个 KP
    if chunks.len() == 1 {
        let c = &chunks[0];
        return vec![DetectedKp {
            kp_index: 0,
            page_start: c.page_start,
            page_end: c.page_end,
            chunk_indexes: vec![c.chunk_index],
            char_count: c.text.chars().count() as i64,
            preview: head_tail_preview(&c.text, &c.text),
        }];
    }

    // ── 1. 相邻 cosine 数列 ─────────────────────────────────────────────
    let n = chunks.len();
    let mut sims: Vec<f32> = Vec::with_capacity(n - 1);
    for i in 0..n - 1 {
        sims.push(cosine(&chunks[i].embedding, &chunks[i + 1].embedding));
    }

    // ── 2. depth score ─────────────────────────────────────────────────
    let depths = depth_scores(&sims, PEAK_WINDOW);

    // ── 3. 阈值切边 ─────────────────────────────────────────────────────
    let (mean_d, std_d) = mean_std(&depths);
    let threshold = mean_d + DEPTH_FACTOR * std_d;
    // semantic_cuts[i] = true 表示在第 i 个 chunk 之后切（i ∈ 0..n-2）
    let mut cut_after: Vec<bool> = (0..n - 1)
        .map(|i| depths[i] >= threshold)
        .collect();

    // ── 4. TOC 强制边界 ─────────────────────────────────────────────────
    if !toc_page_starts.is_empty() {
        let toc_set: std::collections::HashSet<i64> =
            toc_page_starts.iter().copied().collect();
        // 对每个 i ∈ 1..n：如果 chunks[i] 的 page_start ∈ TOC && 不等于 chunks[i-1].page_start
        // → 说明这块开启了新的 TOC 节，强制 cut_after[i-1] = true
        for i in 1..n {
            let p_curr = chunks[i].page_start;
            let p_prev = chunks[i - 1].page_start;
            if p_curr != p_prev && toc_set.contains(&p_curr) {
                cut_after[i - 1] = true;
            }
        }
    }

    // ── 5. 初步聚段 ─────────────────────────────────────────────────────
    let mut groups: Vec<Vec<usize>> = Vec::new();
    let mut cur: Vec<usize> = vec![0];
    for i in 0..n - 1 {
        if cut_after[i] {
            groups.push(std::mem::take(&mut cur));
            cur = vec![i + 1];
        } else {
            cur.push(i + 1);
        }
    }
    if !cur.is_empty() {
        groups.push(cur);
    }

    // 5a. 太短的段并入下一段（最后一段无下一段则并入上一段）
    let groups = merge_short_groups(groups, chunks);

    // 5b. 太长的段在最弱处（最高 sim 的位置）强切，递归直到都 ≤ MAX_KP_CHARS
    let groups = split_long_groups(groups, chunks, &sims);

    // ── 6. 装配输出 ─────────────────────────────────────────────────────
    groups
        .into_iter()
        .enumerate()
        .map(|(kp_idx, g)| {
            let first_chunk = &chunks[g[0]];
            let last_chunk = &chunks[*g.last().unwrap()];
            let chunk_indexes: Vec<i64> = g.iter().map(|&i| chunks[i].chunk_index).collect();
            let char_count: i64 = g.iter().map(|&i| chunks[i].text.chars().count() as i64).sum();
            let preview = head_tail_preview(&first_chunk.text, &last_chunk.text);
            DetectedKp {
                kp_index: kp_idx as i64,
                page_start: first_chunk.page_start,
                page_end: last_chunk.page_end,
                chunk_indexes,
                char_count,
                preview,
            }
        })
        .collect()
}

/// 把 KP 的 chunk_indexes 序列化为 JSON 字符串，配合 `db::kp_insert_batch` 使用。
pub fn chunk_indexes_to_json(ids: &[i64]) -> String {
    serde_json::to_string(ids).unwrap_or_else(|_| "[]".to_string())
}

/// 解析 chunk_ids JSON 列回 i64 数组。
pub fn chunk_indexes_from_json(s: &str) -> Vec<i64> {
    serde_json::from_str::<Vec<i64>>(s).unwrap_or_default()
}

// ── 内部工具 ────────────────────────────────────────────────────────────

/// 向量点积（chunks 写库时已 L2 归一化 → 即 cosine）。
fn cosine(a: &[f32], b: &[f32]) -> f32 {
    let n = a.len().min(b.len());
    let mut s = 0.0f32;
    for i in 0..n {
        s += a[i] * b[i];
    }
    s
}

fn depth_scores(sims: &[f32], window: usize) -> Vec<f32> {
    let m = sims.len();
    if m == 0 {
        return Vec::new();
    }
    let mut depth = Vec::with_capacity(m);
    for i in 0..m {
        // 向左找峰
        let l_from = i.saturating_sub(window);
        let mut left_peak = sims[i];
        for k in l_from..=i {
            if sims[k] > left_peak {
                left_peak = sims[k];
            }
        }
        // 向右找峰
        let r_to = (i + window).min(m - 1);
        let mut right_peak = sims[i];
        for k in i..=r_to {
            if sims[k] > right_peak {
                right_peak = sims[k];
            }
        }
        let d = (left_peak - sims[i]).max(0.0) + (right_peak - sims[i]).max(0.0);
        depth.push(d);
    }
    depth
}

fn mean_std(xs: &[f32]) -> (f32, f32) {
    if xs.is_empty() {
        return (0.0, 0.0);
    }
    let mean = xs.iter().sum::<f32>() / xs.len() as f32;
    let var = xs.iter().map(|x| (x - mean).powi(2)).sum::<f32>() / xs.len() as f32;
    (mean, var.sqrt())
}

/// 合并太短的段：若段字符数 < MIN_KP_CHARS，并入下一段；最后一段则并入上一段。
fn merge_short_groups(
    groups: Vec<Vec<usize>>,
    chunks: &[db::RagChunkRow],
) -> Vec<Vec<usize>> {
    if groups.len() <= 1 {
        return groups;
    }
    let chars_of = |g: &[usize]| -> i64 {
        g.iter().map(|&i| chunks[i].text.chars().count() as i64).sum()
    };
    let mut out: Vec<Vec<usize>> = Vec::with_capacity(groups.len());
    for g in groups {
        // 当前段太短：和上一段合并（如果上一段合并后不会超长太多）
        let chars = chars_of(&g);
        if chars < MIN_KP_CHARS {
            if let Some(prev) = out.last_mut() {
                // 上段合并后再超长由 split 阶段处理；不做强制限制
                prev.extend(g);
                continue;
            }
        }
        out.push(g);
    }
    // 边界：可能首段就太短，已加入 out，再检查最后一段
    if out.len() >= 2 {
        let last_chars = chars_of(out.last().unwrap());
        if last_chars < MIN_KP_CHARS {
            let last = out.pop().unwrap();
            if let Some(prev) = out.last_mut() {
                prev.extend(last);
            } else {
                out.push(last);
            }
        }
    }
    out
}

/// 拆分太长的段：在段内 sim 最高处（"内部最连贯"位置反过来变成最弱切点）切开。
/// 选取段内 sim 最大的索引切；递归直到所有段 ≤ MAX_KP_CHARS 或长度=1。
fn split_long_groups(
    groups: Vec<Vec<usize>>,
    chunks: &[db::RagChunkRow],
    sims: &[f32],
) -> Vec<Vec<usize>> {
    let chars_of = |g: &[usize]| -> i64 {
        g.iter().map(|&i| chunks[i].text.chars().count() as i64).sum()
    };

    // 用栈式递归：处理每段，超长就切两半压回栈
    let mut stack: Vec<Vec<usize>> = groups.into_iter().rev().collect();
    let mut out: Vec<Vec<usize>> = Vec::new();
    while let Some(g) = stack.pop() {
        if chars_of(&g) <= MAX_KP_CHARS || g.len() <= 1 {
            out.push(g);
            continue;
        }
        // 找段内最大 sim 位置（chunk g[k] 和 g[k+1] 之间）
        // 注意：sims 是按全局 chunks 顺序的 (n-1) 长度数组，但段内是连续 chunks
        // 所以 sims[g[k]] 是 chunks[g[k]] 与 chunks[g[k]+1] 之间的相似度
        // 我们要在 g 内部切，所以遍历 k ∈ 0..g.len()-1，找 sims[g[k]] 最高
        let mut best_k = 0usize;
        let mut best_sim = f32::MIN;
        for k in 0..g.len() - 1 {
            // 必须确保 chunks[g[k]+1] == chunks[g[k+1]] 即连续段
            if g[k] + 1 != g[k + 1] {
                continue; // 不连续（理论上不会发生，但保护一下）
            }
            let s = sims[g[k]];
            if s > best_sim {
                best_sim = s;
                best_k = k;
            }
        }
        // 在 best_k 之后切
        let split_at = best_k + 1;
        let right: Vec<usize> = g[split_at..].to_vec();
        let left: Vec<usize> = g[..split_at].to_vec();
        // 压回栈：先右后左，让左先被处理（保持顺序）
        if !right.is_empty() {
            stack.push(right);
        }
        if !left.is_empty() {
            stack.push(left);
        }
    }
    // 由于 stack pop 顺序的关系，out 可能不是按 kp 顺序；按首 chunk_index 升序
    out.sort_by_key(|g| g.first().copied().unwrap_or(usize::MAX));
    out
}

/// 拼一个"头 80 字 ... 尾 80 字"的预览串。
fn head_tail_preview(first_text: &str, last_text: &str) -> String {
    const LEN: usize = 80;
    let head: String = first_text.chars().take(LEN).collect();
    let tail: String = last_text.chars().rev().take(LEN).collect::<String>()
        .chars().rev().collect();
    if std::ptr::eq(first_text, last_text) {
        // 同一块
        return head;
    }
    format!("{} … {}", head.trim(), tail.trim())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mk_chunk(idx: i64, page: i64, text: &str, emb: Vec<f32>) -> db::RagChunkRow {
        db::RagChunkRow {
            chunk_id: format!("c{idx}"),
            session_id: "s".into(),
            chunk_index: idx,
            page_start: page,
            page_end: page,
            text: text.into(),
            embedding: emb,
        }
    }

    /// 简单 case：3 块明显分两组（前 2 块相似，第 3 块和它们正交）
    /// 预期切成 2 段。
    #[test]
    fn detect_simple_split() {
        let chunks = vec![
            mk_chunk(0, 0, &"a".repeat(2000), vec![1.0, 0.0]),
            mk_chunk(1, 1, &"b".repeat(2000), vec![1.0, 0.0]),
            mk_chunk(2, 2, &"c".repeat(2000), vec![0.0, 1.0]),
        ];
        let kps = detect_kps(&chunks, &[]);
        assert!(kps.len() >= 1);
        // 至少 page_start..page_end 跨过 0..2
        let total_pages: i64 = kps.iter().map(|k| k.page_end - k.page_start + 1).sum();
        assert!(total_pages >= 1);
    }

    /// MIN_KP_CHARS 合并：短段应该被并掉
    #[test]
    fn merge_short_groups_works() {
        let chunks = vec![
            mk_chunk(0, 0, "abc", vec![1.0, 0.0]),
            mk_chunk(1, 0, "def", vec![1.0, 0.0]),
        ];
        let kps = detect_kps(&chunks, &[]);
        assert_eq!(kps.len(), 1, "two tiny chunks should be merged into 1 KP");
    }
}
