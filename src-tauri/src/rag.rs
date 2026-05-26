//! RAG（Retrieval-Augmented Generation）模块
//!
//! 职责：
//! 1. 把整本书 `doc_pages` 切成更细的 chunks（默认 600 token 滑窗 + 80 overlap）
//! 2. 调 `LlmClient::embed` 把每个 chunk 转成向量
//! 3. 写入 `rag_chunks` / `rag_meta` 表
//! 4. 提供 `retrieve` 接口：query → embed → cosine top-k
//!
//! 设计取舍：
//! - 仅做"单本书内"检索；跨书检索只要 retrieve 时改 SQL 多 session 即可，先不做
//! - 全表扫描算 cosine（几千行级别 < 50ms，O(n·d)）。后期需要再上 ANN
//! - chunk 只切英文/中文混排的纯文本，不区分 Markdown / 代码块（语料就是 doc_pages.content）
//! - L2 归一化在写入时一次性完成，retrieve 阶段直接点积即可（单浮点乘加，cache 友好）

use crate::db;
use crate::llm::LlmClient;
use serde::Serialize;

/// 切块时单 chunk 目标字符数。中文 1 字 ≈ 1.5 token，
/// 英文 4 char ≈ 1 token。下面这个 800 字符约相当于：
///   * 纯中文 ~ 1200 token
///   * 纯英文 ~ 200 token
///   * 中英混排 ~ 400-600 token
/// 落在 OpenAI text-embedding-3-small / 火山 doubao-embedding 等的 8K context 内绰绰有余。
const CHUNK_CHAR_TARGET: usize = 800;
/// 相邻 chunk 字符级 overlap：保证句子被切断时仍有上下文残留。
const CHUNK_CHAR_OVERLAP: usize = 100;
/// retrieve 默认 top-k
pub const DEFAULT_TOP_K: usize = 5;

/// 准备好待 embed 的 chunk（page_start/end 已知，文本已清理，等待向量）
#[derive(Clone, Debug)]
pub struct PreparedChunk {
    pub chunk_index: i64,
    pub page_start: i64,
    pub page_end: i64,
    pub text: String,
    pub token_count: i64,
}

/// 检索结果，回给前端用于渲染来源 + 调 LLM
#[derive(Debug, Clone, Serialize)]
pub struct RetrievedChunk {
    pub chunk_id: String,
    pub page_start: i64,
    pub page_end: i64,
    pub text: String,
    pub score: f32,
}

/// 把一批"页文本"切成 chunks。
///
/// 策略：
/// 1. **每页一个起点**：从某页开头开始累加文本，直到达到 `CHUNK_CHAR_TARGET`，
///    或者当前累计已经吃完了若干完整页（page_end 跟着推进）。这样每个 chunk
///    都至少落在某个具体的 page 范围里，retrieve 时能精确指明"来源页 N-M"。
/// 2. **跨页拼接 + 段落优先**：先按 `\n\n` 切段，能完整包含就完整包含；
///    最后一个段落超过 target 再按字符截。
/// 3. **overlap**：上一个 chunk 结尾的最后 ~100 字符会被复制到下一个 chunk 头部，
///    避免在句子边界切断的概念断裂。
///
/// 输入 `pages` 是 `(page_index, content)`，按 page_index 升序。
#[allow(unused_assignments)] // buf_page_* 在 flush 之后做基线赋值，下次循环顶部会再覆盖一次
pub fn chunk_pages(pages: &[(i64, String)]) -> Vec<PreparedChunk> {
    let mut out: Vec<PreparedChunk> = Vec::new();
    if pages.is_empty() {
        return out;
    }

    // 把每一页拆成 (page_index, paragraph) 流；空段落直接跳。
    // 段落是基本单位，不会被打断；过长的段落最后才硬切。
    let mut paragraphs: Vec<(i64, String)> = Vec::new();
    for (pi, content) in pages {
        for para in content.split("\n\n") {
            let p = para.trim();
            if p.is_empty() {
                continue;
            }
            paragraphs.push((*pi, p.to_string()));
        }
    }
    if paragraphs.is_empty() {
        return out;
    }

    let mut chunk_index: i64 = 0;
    let mut buf = String::new();
    let mut buf_page_start: i64 = paragraphs[0].0;
    let mut buf_page_end: i64 = paragraphs[0].0;

    let flush = |buf: &mut String,
                 page_start: i64,
                 page_end: i64,
                 chunk_index: &mut i64,
                 out: &mut Vec<PreparedChunk>| {
        if buf.trim().is_empty() {
            buf.clear();
            return;
        }
        // overlap：保留最后 ~100 字符到下一个 chunk
        let text_owned = buf.trim().to_string();
        let token_count = estimate_tokens(&text_owned) as i64;
        out.push(PreparedChunk {
            chunk_index: *chunk_index,
            page_start,
            page_end,
            text: text_owned,
            token_count,
        });
        *chunk_index += 1;

        let chars: Vec<char> = buf.chars().collect();
        if chars.len() > CHUNK_CHAR_OVERLAP {
            let tail: String = chars.iter().rev().take(CHUNK_CHAR_OVERLAP).rev().collect::<Vec<_>>().into_iter().collect();
            *buf = tail;
        } else {
            buf.clear();
        }
    };

    for (pi, para) in paragraphs.iter() {
        // 段落本身就超长 → 硬切成多个 chunk
        if para.chars().count() > CHUNK_CHAR_TARGET {
            // 先把当前 buf flush 出去
            if !buf.trim().is_empty() {
                let mut ci = chunk_index;
                flush(&mut buf, buf_page_start, buf_page_end, &mut ci, &mut out);
                chunk_index = ci;
                buf_page_start = *pi;
                buf_page_end = *pi;
            }
            // 再把这个超长段按字符切
            let chars: Vec<char> = para.chars().collect();
            let mut start = 0usize;
            while start < chars.len() {
                let end = (start + CHUNK_CHAR_TARGET).min(chars.len());
                let slice: String = chars[start..end].iter().collect();
                let token_count = estimate_tokens(&slice) as i64;
                out.push(PreparedChunk {
                    chunk_index,
                    page_start: *pi,
                    page_end: *pi,
                    text: slice,
                    token_count,
                });
                chunk_index += 1;
                if end == chars.len() {
                    break;
                }
                // overlap step
                start = end.saturating_sub(CHUNK_CHAR_OVERLAP);
                if start <= 0 {
                    start = end; // 避免死循环
                }
            }
            buf.clear();
            buf_page_start = *pi;
            buf_page_end = *pi;
            continue;
        }

        // 普通段落：累加到 buf；超 target 就 flush
        if buf.is_empty() {
            buf_page_start = *pi;
        }
        if !buf.is_empty() {
            buf.push_str("\n\n");
        }
        buf.push_str(para);
        buf_page_end = *pi;

        if buf.chars().count() >= CHUNK_CHAR_TARGET {
            let mut ci = chunk_index;
            flush(&mut buf, buf_page_start, buf_page_end, &mut ci, &mut out);
            chunk_index = ci;
            // flush 后 buf 可能还有 overlap 残余（上个 chunk 末尾文本）；
            // 把 page 范围向"当前段所在页"对齐，避免 page_start 卡在远古 chunk 起点。
            // （函数级 #[allow(unused_assignments)] 已开启）
            buf_page_start = *pi;
            buf_page_end = *pi;
        }
    }
    // 收尾
    if !buf.trim().is_empty() {
        let mut ci = chunk_index;
        flush(&mut buf, buf_page_start, buf_page_end, &mut ci, &mut out);
    }

    out
}

/// 粗略 token 估算：中文字 1.5 token / 英文 4 字符 1 token，混排取折中 1.8。
fn estimate_tokens(s: &str) -> usize {
    let n = s.chars().count();
    (n as f64 / 1.8).ceil() as usize
}

/// 对单个向量做 L2 归一化（in-place）。归一化后两向量内积 = cosine 相似度。
fn l2_normalize(v: &mut [f32]) {
    let mut sum: f32 = 0.0;
    for &x in v.iter() {
        sum += x * x;
    }
    let norm = sum.sqrt();
    if norm > 0.0 {
        for x in v.iter_mut() {
            *x /= norm;
        }
    }
}

/// 内积（已归一化时即 cosine）
fn dot(a: &[f32], b: &[f32]) -> f32 {
    let n = a.len().min(b.len());
    let mut s: f32 = 0.0;
    for i in 0..n {
        s += a[i] * b[i];
    }
    s
}

/// 进度回调签名。
pub type ProgressFn<'a> = &'a (dyn Fn(usize, usize) + Sync);

/// 索引一本书。返回最终 chunk 数。
///
/// 行为：
/// 1. 如果 `clear_existing=true`，先清空旧 chunks。
/// 2. 从 doc_pages 全量拉文本 → chunk_pages 切块。
/// 3. 每批 64 条调 embed → 写库。每批写完都触发 progress(done, total)。
/// 4. 全部完成后写入 rag_meta(status='ready')。
/// 5. 任意一步失败 → 写 rag_meta(status='failed', error=...) 并返回 Err。
pub async fn index_session(
    db_arc: std::sync::Arc<std::sync::Mutex<rusqlite::Connection>>,
    llm: &LlmClient,
    session_id: &str,
    clear_existing: bool,
    progress: Option<ProgressFn<'_>>,
) -> Result<usize, String> {
    // ── 1. 准备阶段：读 pages、切 chunks（在一个锁里完成）──
    let prepared: Vec<PreparedChunk> = {
        let conn = db_arc.lock().map_err(|e| format!("DB 锁失败: {e}"))?;
        if clear_existing {
            db::rag_clear_session(&conn, session_id)?;
        }
        // 拉所有页面文本
        let mut stmt = conn
            .prepare(
                "SELECT page_index, content FROM doc_pages
                 WHERE session_id = ?1 AND content != ''
                 ORDER BY page_index",
            )
            .map_err(|e| format!("查询 doc_pages 失败: {e}"))?;
        let rows = stmt
            .query_map(rusqlite::params![session_id], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
            })
            .map_err(|e| format!("遍历 doc_pages 失败: {e}"))?;
        let pages: Vec<(i64, String)> = rows
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("收集 doc_pages 失败: {e}"))?;

        if pages.is_empty() {
            // 没有可索引的内容（EPUB 等流式资料目前不支持 RAG）
            db::rag_upsert_meta(&conn, session_id, "ready", 0, llm.embedding_model_name(), 0, "")?;
            return Ok(0);
        }
        chunk_pages(&pages)
    };

    if prepared.is_empty() {
        let conn = db_arc.lock().map_err(|e| format!("DB 锁失败: {e}"))?;
        db::rag_upsert_meta(&conn, session_id, "ready", 0, llm.embedding_model_name(), 0, "")?;
        return Ok(0);
    }

    let total = prepared.len();
    log::info!("RAG[{}]: 切块完成 {} 块，开始 embedding…", session_id, total);

    // 标记 building
    {
        let conn = db_arc.lock().map_err(|e| format!("DB 锁失败: {e}"))?;
        db::rag_upsert_meta(&conn, session_id, "building", 0, llm.embedding_model_name(), 0, "")?;
    }

    // ── 2. 分批 embed + 写库 ──
    const EMBED_BATCH: usize = 32; // 比 LlmClient::embed 内部的 64 略小，事件粒度更细
    let mut completed = 0usize;
    let mut dim: usize = 0;
    let model_name = llm.embedding_model_name().to_string();

    for batch in prepared.chunks(EMBED_BATCH) {
        let texts: Vec<String> = batch.iter().map(|c| c.text.clone()).collect();
        let vectors = match llm.embed(&texts).await {
            Ok(v) => v,
            Err(e) => {
                let conn = db_arc.lock().map_err(|err| format!("DB 锁失败: {err}"))?;
                db::rag_upsert_meta(
                    &conn,
                    session_id,
                    "failed",
                    completed,
                    &model_name,
                    dim,
                    &e,
                )?;
                return Err(e);
            }
        };
        if vectors.is_empty() {
            return Err("embedding 返回空批次".to_string());
        }
        if dim == 0 {
            dim = vectors[0].len();
        }

        // L2 归一化（写库前一次性完成，retrieve 阶段省去重复计算）
        let mut normed: Vec<Vec<f32>> = vectors
            .into_iter()
            .map(|mut v| {
                l2_normalize(&mut v);
                v
            })
            .collect();

        // 写库
        {
            let conn = db_arc.lock().map_err(|e| format!("DB 锁失败: {e}"))?;
            let inserts: Vec<db::RagChunkInsert> = batch
                .iter()
                .zip(normed.iter())
                .map(|(c, vec)| db::RagChunkInsert {
                    chunk_id: "", // 占位，下面动态生成
                    session_id,
                    chunk_index: c.chunk_index,
                    page_start: c.page_start,
                    page_end: c.page_end,
                    text: &c.text,
                    token_count: c.token_count,
                    embedding: vec,
                    model: &model_name,
                })
                .collect();
            // 给每条生成 chunk_id：session_id + chunk_index 唯一即可
            let chunk_ids: Vec<String> = batch
                .iter()
                .map(|c| format!("{}::{}", session_id, c.chunk_index))
                .collect();
            let inserts_with_id: Vec<db::RagChunkInsert> = inserts
                .into_iter()
                .zip(chunk_ids.iter())
                .map(|(mut ins, id)| {
                    ins.chunk_id = id.as_str();
                    ins
                })
                .collect();
            db::rag_insert_chunks(&conn, &inserts_with_id)?;
        }
        // normed 仅在 inserts_with_id 引用期间需要保留生命周期
        normed.clear();

        completed += batch.len();
        if let Some(cb) = progress {
            cb(completed, total);
        }
    }

    // ── 3. 写 ready meta ──
    {
        let conn = db_arc.lock().map_err(|e| format!("DB 锁失败: {e}"))?;
        db::rag_upsert_meta(&conn, session_id, "ready", completed, &model_name, dim, "")?;
    }
    log::info!("RAG[{}]: 索引完成 {} chunks dim={}", session_id, completed, dim);
    Ok(completed)
}

/// 检索：query → embed → cosine top-k
///
/// 返回的 chunks 已按 score 降序。score 是 cosine 相似度（0..1，更大更相关）。
pub async fn retrieve(
    db_arc: std::sync::Arc<std::sync::Mutex<rusqlite::Connection>>,
    llm: &LlmClient,
    session_id: &str,
    query: &str,
    top_k: usize,
) -> Result<Vec<RetrievedChunk>, String> {
    if query.trim().is_empty() {
        return Ok(Vec::new());
    }

    // 1) embed query
    let mut q_vec = llm
        .embed(&[query.to_string()])
        .await?
        .into_iter()
        .next()
        .ok_or_else(|| "query embedding 为空".to_string())?;
    l2_normalize(&mut q_vec);

    // 2) 全表扫描算 cosine
    let chunks = {
        let conn = db_arc.lock().map_err(|e| format!("DB 锁失败: {e}"))?;
        db::rag_load_chunks(&conn, session_id)?
    };
    if chunks.is_empty() {
        return Ok(Vec::new());
    }

    let mut scored: Vec<(f32, db::RagChunkRow)> = chunks
        .into_iter()
        .filter_map(|c| {
            if c.embedding.len() != q_vec.len() {
                // 维度不匹配（用户切换了 embedding 模型未重建索引），跳过
                None
            } else {
                let s = dot(&q_vec, &c.embedding);
                Some((s, c))
            }
        })
        .collect();

    // 部分排序：top_k 一般 5-10，全排序无所谓，简单 sort_by
    scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    let k = top_k.min(scored.len());
    Ok(scored
        .into_iter()
        .take(k)
        .map(|(score, c)| RetrievedChunk {
            chunk_id: c.chunk_id,
            page_start: c.page_start,
            page_end: c.page_end,
            text: c.text,
            score,
        })
        .collect())
}

/// 把检索结果拼成 LLM 用的"上下文段落"块。
/// 返回 (context_md, sources_for_response)。
pub fn build_context_for_chat(retrieved: &[RetrievedChunk]) -> (String, serde_json::Value) {
    use serde_json::json;
    if retrieved.is_empty() {
        return (String::new(), json!([]));
    }
    let mut ctx = String::new();
    ctx.push_str("## 检索到的相关段落（按相关度排序，标号 [P开始页-结束页]）\n\n");
    for c in retrieved {
        let label = if c.page_start == c.page_end {
            format!("P{}", c.page_start + 1)
        } else {
            format!("P{}-{}", c.page_start + 1, c.page_end + 1)
        };
        ctx.push_str(&format!("### [{}]\n{}\n\n", label, c.text));
    }
    let sources: Vec<serde_json::Value> = retrieved
        .iter()
        .map(|c| {
            let snippet: String = c.text.chars().take(160).collect();
            json!({
                "chunk_id": c.chunk_id,
                "page_start": c.page_start,
                "page_end": c.page_end,
                "snippet": snippet,
                "score": c.score,
            })
        })
        .collect();
    (ctx, serde_json::Value::Array(sources))
}

/// 真正调 LLM 做 RAG 答疑。
pub async fn rag_answer(
    llm: &LlmClient,
    doc_title: &str,
    current_page_index: Option<usize>,
    current_page_content: &str,
    retrieved: &[RetrievedChunk],
    question: &str,
    history: &[(String, String)],
) -> Result<String, String> {
    let messages = build_rag_messages(
        doc_title,
        current_page_index,
        current_page_content,
        retrieved,
        question,
        history,
        "deep",
    );
    llm.chat(&messages).await
}

/// 流式版 RAG 答疑。每个 token 增量调 `on_token`;遇到 `<think>` 进入/离开
/// 时调 `on_reasoning`(供 UI 显示「思考中…」)。
pub async fn rag_answer_stream<F, R>(
    llm: &LlmClient,
    doc_title: &str,
    current_page_index: Option<usize>,
    current_page_content: &str,
    retrieved: &[RetrievedChunk],
    question: &str,
    history: &[(String, String)],
    mode: &str,
    on_token: F,
    on_reasoning: R,
) -> Result<String, String>
where
    F: FnMut(&str) + Send,
    R: FnMut(crate::llm::ReasoningPhase) + Send,
{
    let messages = build_rag_messages(
        doc_title,
        current_page_index,
        current_page_content,
        retrieved,
        question,
        history,
        mode,
    );
    llm.chat_stream(&messages, on_token, on_reasoning).await
}

/// 把上下文 + 问题打包成 messages。
///
/// **设计回归**:取消 quick/deep/cite 三模式,统一用一种"基于 RAG 的笔记式回答"。
/// `_mode` 参数保留是为了向后兼容已经在路上的命令调用,但内部不再分发。
fn build_rag_messages(
    doc_title: &str,
    current_page_index: Option<usize>,
    current_page_content: &str,
    retrieved: &[RetrievedChunk],
    question: &str,
    history: &[(String, String)],
    _mode: &str,
) -> Vec<crate::llm::Message> {
    use crate::llm::Message;

    let (ctx_md, _) = build_context_for_chat(retrieved);

    let current_block = if !current_page_content.trim().is_empty() {
        let label = match current_page_index {
            Some(i) => format!("P{}（用户正在阅读）", i + 1),
            None => "用户正在阅读的段落".to_string(),
        };
        format!("\n## 当前页 [{label}]\n{}\n", current_page_content.trim())
    } else {
        String::new()
    };

    let system_prompt = format!(
        r#"你是一个智能文档阅读助手。基于下面的检索段落 + 当前页内容,为用户问题输出一份结构化的"学习笔记"。

## 文档标题
{doc_title}

{ctx_md}{current_block}

## 输出格式(笔记式,不是问答式)
1. 用 `## 主题` 作为开头总标题(根据问题归纳一个简短主题,而不是抄问题原文)
2. 接下来用 `### 概念`/`### 推导`/`### 对比`/`### 例子` 等三级小节组织内容,按需取舍
3. 要点用 `1.` `2.` 编号,深一层用 4 空格缩进 + 子编号
4. 重要术语用 `**加粗**`,关键结论 / 公式用 `==高亮==`(每节最多 2-3 处)
5. 引用具体段落时,在句末挂 `[P页码]` 或 `[P起-止]`,例如 `…该结论详见 [P12-13]`
6. 资料里没有的内容若必须补充,标注 **【常识补充】**
7. 末尾另起一行 `> 来源:[P...] [P...]` 列出本笔记引用的所有页码(去重)
8. 公式 `$...$` / `$$...$$`,代码用围栏。不要寒暄、不要复述问题。"#
    );

    let mut messages = vec![Message {
        role: "system".into(),
        content: system_prompt,
    }];
    for (role, content) in history {
        messages.push(Message {
            role: role.clone(),
            content: content.clone(),
        });
    }
    messages.push(Message {
        role: "user".into(),
        content: question.to_string(),
    });
    messages
}

/// 基于已生成的回答 + 上下文，让 LLM 给 3 个"用户可能想问的下一题"。
/// 用 chat_json 拿严格 JSON 数组，失败时返回 vec![].
pub async fn generate_followups(
    llm: &LlmClient,
    doc_title: &str,
    question: &str,
    answer: &str,
) -> Vec<String> {
    let system = r#"你是一个学习引导助手。看完用户的问题和 AI 给出的答案，请生成 3 个最有学习价值的「下一步追问」。
要求：
1. 每个问题独立成句，6-30 字
2. 选题要：① 深挖原答案的弱点 / 模糊处；② 横向对比相关概念；③ 应用到实际场景。三种题型尽量都覆盖。
3. 不要重复用户已经问过的内容
4. 严格 JSON 输出：{ "followups": ["问题1", "问题2", "问题3"] }，不要 markdown 不要解释"#;

    let user = format!(
        r#"## 文档
{doc_title}

## 用户原问题
{question}

## AI 已给出的答案
{answer}

请输出 3 个追问。"#
    );

    match llm.chat_json(system, &user, 1).await {
        Ok(v) => {
            let arr = v.get("followups").and_then(|x| x.as_array()).cloned().unwrap_or_default();
            arr.into_iter()
                .filter_map(|x| x.as_str().map(|s| s.trim().to_string()))
                .filter(|s| !s.is_empty())
                .take(3)
                .collect()
        }
        Err(e) => {
            log::warn!("generate_followups 失败: {e}");
            Vec::new()
        }
    }
}
