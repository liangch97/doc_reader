/// Doc Reader 模块 — 按页阅读文档 + AI 页面笔记生成
use crate::llm::{LlmClient, Message};
use serde_json::Value;

/// 为单页生成 AI 笔记（基于当前页内容 + 笔记类型）。
///
/// 行为变更（2026-05）：
///   - 每页笔记**独立从 1 开始编号**，不再让 LLM 续上一段的编号。
///   - existing_note 不再注入 prompt（避免被 LLM 看到已有 22 页就续 23,24,...
///     导致后回到第 1 页生成时编号反而更大的混乱）。
///   - 调用方负责把返回的 markdown 包装成 `## 第 N 页：...` 段，并按页码排序合并。
pub async fn generate_page_note(
    llm: &LlmClient,
    doc_title: &str,
    page_index: usize,
    page_content: &str,
    note_type: &str,
    custom_prompt: Option<&str>,
    _existing_note: Option<&str>,  // 保留参数以兼容旧 caller，但忽略
) -> Result<String, String> {
    let type_instruction = type_instruction_with_common(note_type);

    let user_instruction = match custom_prompt {
        Some(p) if !p.trim().is_empty() => format!("\n\n## 用户自定义要求\n{}", p.trim()),
        _ => String::new(),
    };

    let prompt = format!(
        r#"你是一个文档阅读助手。请为以下文档页面生成笔记。

## 文档标题
{doc_title}

## 当前页面（第 {page_num} 页）
{page_content}

## 笔记类型与格式要求
{type_instruction}{user_instruction}

## 通用要求
- 用 Markdown 格式输出
- **不要**在输出开头加 `## 第 N 页` 这样的页码标题（外层会自动加）
- 本页笔记的所有编号 / 列表项**都从 1 开始**，不要参考其他页的编号
- 标题层级从 `###` 开始（让出 `##` 作为页码分隔锚点）
- 请直接输出笔记内容，不要包含额外的说明"#,
        doc_title = doc_title,
        page_num = page_index + 1,
        page_content = page_content,
        type_instruction = type_instruction,
        user_instruction = user_instruction,
    );

    let messages = vec![Message {
        role: "user".into(),
        content: prompt,
    }];

    llm.chat(&messages).await
}

/// 为多页范围生成完整笔记（长文综合阅读笔记）
pub async fn generate_pages_note(
    llm: &LlmClient,
    doc_title: &str,
    page_ranges: &str,
    combined_content: &str,
    note_type: &str,
) -> Result<String, String> {
    let type_instruction = type_instruction_with_common(note_type);

    let prompt = format!(
        r#"你是一个文档阅读助手。请为以下多页内容生成一份完整的综合笔记。

## 文档标题
{doc_title}

## 页面范围
第 {page_ranges} 页

## 页面内容
{combined_content}

## 笔记类型与格式要求
{type_instruction}

## 特别要求
- 这是跨多页的综合笔记，请将所有页面的内容融会贯通
- 识别跨页面的逻辑关联和主线
- 用 Markdown 格式输出
- 内容应比单页笔记更丰富、更有深度
- 总字数可适当放宽到原要求的 2-3 倍
- 请直接输出笔记内容，不要包含额外的说明"#,
        doc_title = doc_title,
        page_ranges = page_ranges,
        combined_content = combined_content,
        type_instruction = type_instruction,
    );

    let messages = vec![Message {
        role: "user".into(),
        content: prompt,
    }];

    llm.chat(&messages).await
}

/// 为选中文本生成笔记
pub async fn generate_text_note(
    llm: &LlmClient,
    doc_title: &str,
    selected_text: &str,
    note_type: &str,
    page_index: Option<usize>,
    custom_prompt: Option<&str>,
) -> Result<String, String> {
    let type_instruction = type_instruction_with_common(note_type);

    let page_info = match page_index {
        Some(idx) => format!("（来源：第 {} 页）", idx + 1),
        None => String::new(),
    };

    let user_instruction = match custom_prompt {
        Some(p) if !p.trim().is_empty() => format!("\n\n## 用户自定义要求\n{}", p.trim()),
        _ => String::new(),
    };

    let prompt = format!(
        r#"你是一个文档阅读助手。请为用户选中的以下文本内容生成笔记。

## 文档标题
{doc_title}

## 选中文本{page_info}
{selected_text}

## 笔记类型与格式要求
{type_instruction}{user_instruction}

## 通用要求
- 用 Markdown 格式输出
- 在笔记开头标注来源页码（如有）
- 提取选中文本的核心信息
- 如有专业术语，提供解释
- 请直接输出笔记内容，不要包含额外的说明"#,
        doc_title = doc_title,
        page_info = page_info,
        selected_text = selected_text,
        type_instruction = type_instruction,
        user_instruction = user_instruction,
    );

    let messages = vec![Message {
        role: "user".into(),
        content: prompt,
    }];

    llm.chat(&messages).await
}

/// 答疑功能：基于文档内容回答用户问题
pub async fn chat_with_doc(
    llm: &LlmClient,
    doc_title: &str,
    page_content: &str,
    page_index: Option<usize>,
    question: &str,
    history: &[(String, String)], // (role, content) pairs
) -> Result<String, String> {
    let page_info = match page_index {
        Some(idx) => format!("当前阅读到第 {} 页", idx + 1),
        None => String::new(),
    };

    let system_prompt = format!(
        r#"你是一个智能文档阅读助手，你的任务是基于文档内容回答用户的问题。

## 文档标题
{doc_title}

## {page_info}当前页面内容
{page_content}

## 回答要求
- 优先基于文档内容进行回答
- 如果文档中没有直接答案，可以结合你自己的知识进行推理和补充，但需注明
- 用 Markdown 格式输出
- 回答要准确、清晰、有条理
- 如果涉及专业术语，提供简要解释
- 直接输出回答内容，不要包含额外的说明"#,
        doc_title = doc_title,
        page_info = page_info,
        page_content = page_content,
    );

    let mut messages = vec![Message {
        role: "system".into(),
        content: system_prompt,
    }];

    // 添加历史对话
    for (role, content) in history {
        messages.push(Message {
            role: role.clone(),
            content: content.clone(),
        });
    }

    // 添加当前问题
    messages.push(Message {
        role: "user".into(),
        content: question.to_string(),
    });

    llm.chat(&messages).await
}

/// 根据笔记类型返回对应的格式指令。
///
/// ⚠️ 2026-05 重构：废弃所有「专用围栏块」（flashcards / qa / mindmap / concept），
/// 一律改用「带编号的标准 Markdown」表达层次。
/// 所有类型共用一套通用规则（编号 + 分层标题 + 高亮），只是侧重点不同。
fn get_type_instruction(note_type: &str) -> &'static str {
    match note_type {
        "summary" => r#"生成**摘要笔记**（150-300 字）：

## 结构
1. 用 1-2 句话概括本页主旨
2. 列出 3-5 个关键要点（用 `1.` `2.` `3.` 编号）
3. 总结核心结论或观点（用 `==高亮==` 标记最重要的一句）"#,

        "mindmap" => r#"生成**层级笔记**（注意：图形思维导图已下线，改为纯文本层级表达）：

## 结构
1. 用 `## 中心主题` 作为开头
2. 一级分支用 `### 1. 分支1` / `### 2. 分支2` 形式编号（3-5 个）
3. 子要点用 `1.` `2.` 列表 + 4 空格缩进，最深 3 层
4. 关键节点术语用 `**加粗**`，核心结论用 `==高亮==`"#,

        "qa" => r#"生成**问答笔记**（3-5 对问答）：

## 结构
1. 用 `## 自测问答` 作为整体标题
2. 每对问答用三级标题 `### 问题1：……` 提问
3. 标题下用一段或一个数字列表给出答案（可多行）
4. 问题应覆盖核心概念、因果关系和应用场景，循序渐进
5. 重要答案点用 `==高亮==` 标记"#,

        "timeline" => r#"生成**时间线 / 步骤笔记**：

## 结构
1. 用 `## 时间线` 或 `## 流程步骤` 作为标题
2. 每个节点用 `1.` `2.` `3.` 编号 + `**[时间/步骤]** — 事件描述`
3. 如果没有明确时间线，按逻辑顺序组织
4. 总字数 200-400 字"#,

        "concept_map" => r#"生成**概念关系笔记**（图形概念图已下线，改为纯文本表达）：

## 结构
1. 用 `## 核心概念` 列出 3-6 个核心概念（每个一条 `1.` 编号 + `**概念名**` + 一句解释）
2. 用 `## 概念关系` 描述它们之间的关系：每条关系一行 `1. **概念A** ——（导致 / 包含 / 影响）—> **概念B**：……`
3. 最后用 1-2 句话总结整体框架"#,

        "flashcard" | "anki" => r#"生成**记忆要点笔记**（5-8 个要点；闪卡格式已下线，改为编号问答列表）：

## 结构
1. 用 `## 必背要点` 作为标题
2. 每个要点用 `### 1. 术语 / 问题` 三级标题
3. 标题下给出 1-3 行精炼答案 / 解释
4. 关键名词用 `**加粗**`，定义中的核心短语用 `==高亮==`"#,

        "fusion" => r#"生成**融合笔记**（综合多种结构，300-600 字）：

## 结构
1. `## 核心摘要` —— 2-3 句话概述
2. `## 知识结构` —— 用 `1.` `2.` 编号 + 4 空格缩进展示层级
3. `## 自测问答` —— 用三级标题提 2-3 个 `### 问题：……`，下面给答案
4. `## 必背术语` —— 列出关键名词及解释（如果有）
5. `## 总结` —— 1 句收尾"#,

        // "note" 或其他未知类型 → 综合阅读笔记
        _ => r#"生成**综合阅读笔记**（200-400 字）：

## 结构
1. `## 概览` —— 1-2 句点出主旨
2. `## 核心要点` —— 用 `1.` `2.` `3.` 编号列出 3-5 个要点（必要时 4 空格缩进给出二级编号）
3. `## 关键术语` —— 列出本页出现的重要术语并简要解释（如果有）
4. 重要结论用 `==高亮==` 标记"#,
    }
}

/// 取得类型说明 + 拼接通用规则；调用方应使用此函数而非直接 get_type_instruction。
fn type_instruction_with_common(note_type: &str) -> String {
    const COMMON: &str = r#"

## 通用排版规则（必须遵守）
1. **分级标题**：用 `##` / `###` / `####`（最深 4 级）。
2. **要点编号**：需要编号时，**一律全部写成 `1.`**（每行都写 `1.`，不要写 `2.` `3.` ……）。
   渲染器会接管自动连续编号；同一篇笔记里不同段落的 `1.` 列表会自动续号，避免"两个第 1 条"或跳号。
   - 一级编号项：行首 `1. ……`
   - 二级编号项：4 空格缩进 + `1. ……`
   - 第 3 层及以下用 `-` 无序列表
3. ⚠️ 不要在编号项里手动写"第二点 / 其次 / 然后"等指代上一项的话，因为顺序可能由渲染层重排。
4. 关键术语用 `**加粗**`，必须记住的结论 / 公式 / 名词用 `==高亮==`（每段最多 2-3 处）。
5. 行内公式 `$...$`，独占 `$$...$$`。
6. ⚠️ **禁止使用** ```flashcards``` / ```qa``` / ```mindmap``` / ```concept``` 等特殊围栏块。
7. 直接输出 Markdown，不要寒暄、不要外层套代码围栏。"#;
    let mut s = String::from(get_type_instruction(note_type));
    s.push_str(COMMON);
    s
}

// ══════════════════════════════════════════════════════════════════════════════
// 自动知识分区笔记（Auto Section）—— 取代用户选择笔记类型
// ══════════════════════════════════════════════════════════════════════════════

/// 生成自动分区笔记。LLM 会根据内容自行挑选合适的结构，输出一份带多小节的 Markdown
/// 作为笔记本中的「一个 section」。
///
/// - `doc_title`    : 文档标题
/// - `source_label` : 来源描述，如 "第 3 页" / "第 2-5 页" / "选中文本（第 4 页）"
/// - `content`      : 需要被笔记化的原始内容
/// - `context_hint` : 可选上下文提示（如用户自定义要求、已有笔记概览）
pub async fn generate_auto_section(
    llm: &LlmClient,
    doc_title: &str,
    source_label: &str,
    content: &str,
    context_hint: Option<&str>,
) -> Result<String, String> {
    let hint = match context_hint {
        Some(h) if !h.trim().is_empty() => format!("\n\n## 额外上下文 / 用户偏好\n{}", h.trim()),
        _ => String::new(),
    };

    let prompt = format!(
        r#"你是一个资深的知识整理助手。请为下面这段文档内容生成**一份自动组织的 Markdown 笔记 section**，
它将被直接追加到用户的笔记本中。不要输出与笔记无关的解释或寒暄。

## 文档标题
{doc_title}

## 本次笔记来源
{source_label}

## 原始内容
{content}{hint}

## 输出要求（严格遵守）
1. 用 **二级标题 `## `** 作为这次笔记 section 的总标题，标题要概括这段内容的主题（而不是写"笔记"）。
2. 紧跟总标题后，写一行 `> 来源：{source_label}` 作为引用块（便于追溯）。
3. 根据内容自行选择合适的子结构；推荐但不强制使用以下三级小节（`### `），按需裁剪、合并或新增：
   - `### 概览` — 用 1-3 句话点出主旨
   - `### 核心概念` — 关键术语/定义（用要点列表或定义列表）
   - `### 结构拆解` — 按原文逻辑或自然分块的分点讲解
   - `### 关键结论 / 易错点`
   - `### 可追问点` — 2-3 个值得深入的问题（留给用户后续"追加讲解"）
4. 不要重复其他 section 可能已经覆盖过的同质内容，专注于本次来源的独特信息。
5. 保持 Markdown 语义正确：列表缩进统一、代码用围栏、公式用 $...$ 或 $$...$$。
6. 总字数 300-700 字为宜；内容本身很短时可以更简洁，很稠密时可适度延展。
7. 直接输出 Markdown 笔记，不要套 ```markdown ``` 代码块，也不要写多余前言后记。"#,
        doc_title = doc_title,
        source_label = source_label,
        content = content,
        hint = hint,
    );

    let messages = vec![Message {
        role: "user".into(),
        content: prompt,
    }];
    llm.chat(&messages).await
}

/// 为已有笔记 section 生成**追加讲解**（更深入的解释 / 类比 / 延伸）。
/// 输出会作为**子 section**（三级标题 `### 追加讲解：…`）以便视觉上和父笔记联动。
pub async fn generate_deep_explanation(
    llm: &LlmClient,
    doc_title: &str,
    parent_section_md: &str,
    original_content: &str,
    user_hint: Option<&str>,
) -> Result<String, String> {
    let hint = match user_hint {
        Some(h) if !h.trim().is_empty() => format!("\n\n## 用户希望重点讲解\n{}", h.trim()),
        _ => String::new(),
    };

    let prompt = format!(
        r#"你是一个擅长「把复杂概念讲透」的讲师。用户已经有一份笔记 section，
现在希望你**在不重复既有内容**的前提下，为这段笔记写一份深入讲解。

## 文档标题
{doc_title}

## 既有笔记 Section（父笔记）
{parent}

## 原始来源内容（可作参考）
{original}{hint}

## 输出要求
1. 用 **三级标题** `### 追加讲解：<主题>` 作为开头，`<主题>` 要具体（如"为什么……"/"与……的对比"）。
2. 内容策略任选其一或组合：
   - 直觉化解释、类比、比喻
   - 分步推导 / 举例 / 对比辨析
   - 延伸到相关知识或常见误区
   - 针对父笔记"可追问点"之一做展开
3. 避免重复父笔记已经说过的定义，聚焦"加深理解"。
4. 用 Markdown 输出，可含公式、代码、列表；不要套 ```markdown ``` 代码块。
5. 字数 200-600 字为宜。"#,
        doc_title = doc_title,
        parent = parent_section_md,
        original = original_content,
        hint = hint,
    );

    let messages = vec![Message {
        role: "user".into(),
        content: prompt,
    }];
    llm.chat(&messages).await
}

/// 为某个笔记 section 做**嵌入式聊天**回答（不改动父 section）。
/// history 是之前的 (role, content) 列表（user / assistant 交替）。
pub async fn section_chat(
    llm: &LlmClient,
    doc_title: &str,
    section_md: &str,
    source_md: &str,
    question: &str,
    history: &[(String, String)],
) -> Result<String, String> {
    let system_prompt = format!(
        r#"你是一个文档阅读助手。用户正在阅读文档《{doc_title}》，
现在正在一个特定笔记 section 的下方和你交流，你的回答应当紧扣这个 section 的主题。

## 该笔记 Section 内容
{section}

## 该 Section 对应的原始文档内容（参考）
{source}

## 回答要求
- 优先基于 section 与原始内容作答，不够时可以引入你的常识，但需要注明
- 使用 Markdown，允许公式 / 代码 / 列表
- 回答要精炼、直击问题，不要重复 section 已有的内容
- 不需要客套，直接回答"#,
        doc_title = doc_title,
        section = section_md,
        source = source_md,
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
    llm.chat(&messages).await
}

// ══════════════════════════════════════════════════════════════════════════════
// 语义化标题生成（Round 3）—— 替换“📖 第 X 页 · 自动笔记”这类系统标题
// ══════════════════════════════════════════════════════════════════════════════

/// 基于 section 内容（和可选的原文参考）生成一个**知识主题标题**。
/// 要求：不包含页码、来源、"自动笔记"、emoji、功能名，直接是内容主题。
pub async fn generate_section_title(
    llm: &LlmClient,
    doc_title: &str,
    section_md: &str,
    role_hint: Option<&str>,
) -> Result<String, String> {
    let role_line = match role_hint {
        Some(r) if !r.trim().is_empty() => format!("\n该 section 的角色提示：{}（可据此微调语气，例如对比类、案例类、问答类）", r),
        _ => String::new(),
    };
    let prompt = format!(
        r#"你是一名知识整理编辑。请为下面这段已经写好的 Markdown 笔记重新拟一个**干净的知识性标题**。

## 约束（必须全部遵守）
1. 标题要**直接反映内容的主题/对象/机制/结论**，可以是"概念-问题-结论"型短语。
2. 禁止出现："第 X 页""第X页""来源：""自动笔记""追加讲解""嵌入问答""📖""📄""💡""📝"等页码/系统/功能字样与 emoji。
3. 长度 6–24 个汉字（或等效英文），一行内，不要标点结尾，不加引号。
4. 如果内容是对某概念的解释/对比/推导，标题应明确指向那个概念；若是流程，标题应命名那个流程。
5. 只输出标题本身一行，不要任何解释。

## 文档背景
{doc_title}
{role_line}

## 笔记正文
{section_md}
"#,
        doc_title = doc_title,
        section_md = section_md,
        role_line = role_line,
    );
    let messages = vec![Message { role: "user".into(), content: prompt }];
    let raw = llm.chat(&messages).await?;
    Ok(sanitize_generated_title(&raw))
}

/// 清洗模型输出，去除常见噪声。公开以便 commands 复用。
pub fn sanitize_generated_title(raw: &str) -> String {
    // 取第一行非空
    let line = raw.lines().find(|l| !l.trim().is_empty()).unwrap_or("").trim();
    // 去除首尾常见包裹字符
    let line = line.trim_matches(|c: char| c == '"' || c == '\'' || c == '“' || c == '”' || c == '`' || c == '《' || c == '》' || c == '【' || c == '】');
    // 去掉常见前缀 emoji / 功能标签
    let banned_prefixes = ["📖", "📄", "💡", "📝", "🔖", "🔹", "📚", "🧠"];
    let mut s: String = line.to_string();
    for p in banned_prefixes.iter() {
        if s.starts_with(p) { s = s[p.len()..].trim_start().to_string(); }
    }
    // 砍掉 "标题：" / "Title: " 前缀
    for head in ["标题：", "标题:", "Title:", "title:"] {
        if let Some(rest) = s.strip_prefix(head) { s = rest.trim().to_string(); }
    }
    // 若仍含有 "第 X 页" 子串，则切掉该片段（尽量保留主体）
    if let Some(idx) = s.find("第 ") {
        if let Some(end) = s[idx..].find(" 页") {
            let cut_end = idx + end + " 页".len();
            let tail = s[cut_end..].trim_start_matches(['·', '—', '-', ':', '：', ' ']);
            let head = s[..idx].trim_end_matches(['·', '—', '-', ':', '：', ' ']);
            s = if !head.is_empty() { head.to_string() } else { tail.to_string() };
        }
    }
    // 超长裁剪
    let char_count = s.chars().count();
    if char_count > 48 {
        s = s.chars().take(48).collect::<String>();
    }
    if s.trim().is_empty() {
        "未命名".to_string()
    } else {
        s.trim().to_string()
    }
}

/// 从 generate_auto_section 的输出 Markdown 中提取首个 `## ` 标题作为 section 标题。
/// 命中后会复用 sanitize_generated_title 的清洗规则；提取失败返回 None。
/// 这样可以**省掉一次额外的 LLM title 调用**，把单页生成耗时压缩近一半。
pub fn extract_section_title_from_md(md: &str) -> Option<String> {
    for line in md.lines() {
        let t = line.trim_start();
        if let Some(rest) = t.strip_prefix("## ") {
            let cleaned = sanitize_generated_title(rest);
            if !cleaned.is_empty() && cleaned != "未命名" {
                return Some(cleaned);
            }
        }
    }
    None
}

/// 根据笔记本内既有 section 元信息，让 LLM 规划知识区排版（聚合主题 / zone 标题 / 顺序）。
/// 输入：JSON 序列化的 section 数组，每个含 entry_id / title / snippet / page_start / page_end / session_id。
/// 输出：模型给出的 JSON 字符串，由调用方解析。
pub async fn plan_knowledge_zones(
    llm: &LlmClient,
    notebook_name: &str,
    sections_json: &str,
) -> Result<String, String> {
    let prompt = format!(
        r#"你是一个知识编辑，负责把用户笔记本里的零散 section **重新聚合成清晰的知识区**。

## 笔记本名
{notebook_name}

## 现有 sections（数组）
{sections_json}

## 任务
把这些 section 归类到若干个"知识区（zone）"中。同一个知识区内的 section 在主题上紧密相关；
不同知识区之间界限清晰。每个知识区要有一个**简短有力的区标题**（6–20 字，直指主题，不加 emoji、不加引号）。

## 约束
- 优先按**语义主题**聚类；同一文档但主题差异大的 section 可以拆成不同 zone；
  不同文档若主题一致也可合并进同一 zone。
- 每个 zone 内 section 按"原文页码升序、page_start 小的在前；没有页码的排到后面"。
- 尽量让 zone 数量在 2–6 个之间；当 section 少于 3 条可全部放一个 zone。
- 若某些 section 标题仍像"第 X 页自动笔记/来源：XX"等系统性标题，请在返回中为它们补一个干净标题 `suggested_title`；其他保持 null。

## 输出
**严格输出 JSON（UTF-8，不要 markdown 代码块、不要解释）**，Schema：
{{
  "zones": [
    {{
      "zone_title": "字符串",
      "zone_summary": "可选 1-2 句话概述",
      "entries": [
        {{ "entry_id": "原 id", "suggested_title": null | "新标题", "order": 数字（从 0 递增） }}
      ]
    }}
  ]
}}
只输出这个 JSON 对象。"#,
        notebook_name = notebook_name,
        sections_json = sections_json,
    );
    let messages = vec![Message { role: "user".into(), content: prompt }];
    llm.chat(&messages).await
}

// ══════════════════════════════════════════════════════════════════════════════
// Learning Outline v1：两步流程
//   Step 1: extract_entry_meta  —— 给每个 entry 抽教学元信息（summary / keypoints / topics / role / difficulty / prereq_hint）
//   Step 2: build_learning_outline —— 基于全局元信息，生成知识主线 + 学习路径 + zone 划分 + 跨条目关联 + 回顾题
// ══════════════════════════════════════════════════════════════════════════════

/// 对单个 entry 抽取教学元信息。返回结构化 JSON（Value）。
///
/// 输出 schema：
/// {
///   "summary": "一句话摘要（≤60字）",
///   "keypoints": ["要点1", "要点2"],
///   "topics": ["主题词1", "主题词2"],
///   "prerequisites_hint": ["前置概念/术语"],
///   "learning_role": "foundation | mechanism | comparison | misconception | application | example | recap",
///   "difficulty": 1..5,
///   "semantic_title": "语义标题（若原标题是系统自动标题则给出建议，否则回传原标题）"
/// }
pub async fn extract_entry_meta(
    llm: &LlmClient,
    doc_title: &str,
    entry_title: &str,
    entry_content: &str,
) -> Result<Value, String> {
    // 内容过长时截断，避免单次 token 爆炸（保留前 3500 字符已足够抽要点）
    let snippet = if entry_content.chars().count() > 3500 {
        entry_content.chars().take(3500).collect::<String>() + "\n…（后续内容已截断）"
    } else {
        entry_content.to_string()
    };

    let system = r#"你是一位资深的课程教学设计师。你将阅读学习者笔记本中的一个 section，抽取它的"教学元信息"，供后续排版为可学习的知识书。
要求：
1. summary 必须是一句话、聚焦内容做了什么（60 字内，不出现"本节/本段/这部分"等元话语）。
2. keypoints 3–6 条，每条 ≤ 30 字，必须可独立阅读，不堆叠术语不解释。
3. topics 是 2–6 个能检索的主题词/概念名，名词短语，不要动词化。
4. prerequisites_hint 列出学习者需要先掌握的概念名（不是章节名），如果是入门级基础内容，可给 []。
5. learning_role 从以下七选一：
   - foundation：概念/定义/现象描述类
   - mechanism：原理/推导/流程/机制讲解类
   - comparison：对比/区别/演进类
   - misconception：易错/反直觉/常见误区类
   - application：应用/实例/实操类
   - example：单纯的例题/案例演示
   - recap：复习/总结/索引类
6. difficulty 1..5：1 为最直观，5 为需要多步推理的高阶内容。
7. semantic_title 重要规则：
   - 若原标题看起来干净语义化（体现内容主题，不含"第 X 页"、emoji、"自动笔记"），原样回传。
   - 若原标题是系统自动生成（含页码/emoji/"来源"等），输出一个 6–20 字的新标题，直指主题，不加标点/emoji/引号。"#;

    let user = format!(
        r#"## 文档背景
{doc_title}

## 该 section 的原标题
{entry_title}

## 正文（Markdown）
{snippet}

## 任务
按系统消息的 schema 输出严格 JSON，对象字段齐全。"#
    );

    // chat_json 内部会在 system 中附加"严格 JSON"硬约束并带重试
    llm.chat_json(system, &user, 2).await
}

/// 基于全部 entry 的元信息，让 LLM 规划整本笔记本的**学习路径**。
///
/// 输入：`metas_json`（序列化的数组；每项含 entry_id / title / semantic_title / summary / keypoints / topics / learning_role / difficulty / prerequisites_hint / source_session_id / source_page_start / parent_entry_id / section_role）
///
/// 输出 schema：
/// {
///   "thesis": "这本笔记的核心主线（2 句话内）",
///   "learning_path": ["foundation","mechanism","comparison","misconception","application"], // 宏观步骤
///   "zones": [
///     {
///       "zone_id": "z1",
///       "title": "知识区标题（6–20 字，直指主题）",
///       "summary": "1–2 句话概述",
///       "learning_goal": "一句话学完这个 zone 能做到什么",
///       "prerequisite_zone_ids": ["z0"],   // 依赖的其它 zone
///       "entries": [
///         {
///           "entry_id": "…",
///           "new_title": "新标题（若与 semantic_title 相同则原样回传）",
///           "learning_role": "foundation|mechanism|...",
///           "difficulty": 1..5,
///           "prerequisite_entry_ids": ["…"]   // 同一 zone 内或上游 zone 的 entry
///         }
///       ],
///       "recap_questions": [
///         { "q": "回顾题", "hint": "简短提示/答题线索（可空）" }
///       ]
///     }
///   ],
///   "entry_order": ["entry_id_in_learning_order", ...],   // 跨 zone 的全局学习序
///   "links": [
///     { "from": "entry_id_a", "to": "entry_id_b", "kind": "cause|compare|extend|example|common_mistake", "note": "一句话说明" }
///   ]
/// }
pub async fn build_learning_outline(
    llm: &LlmClient,
    notebook_name: &str,
    metas_json: &str,
) -> Result<Value, String> {
    let system = r#"你是一名资深的课程主编辑，负责把散落的笔记重构成一本"可学习的知识书"。你的产出必须服务于学习递进，而不是还原来源顺序。

硬性原则：
1. 不要按"文档来源 / 页码"线性堆叠；必须按**学习路径**重排。
2. 学习路径宏观步骤：foundation → mechanism → comparison → misconception → application（并非每步都必须出现，有几步就写几步）。
3. zones 建议 2–6 个；每个 zone 内的 entries 按学习递进排序，不按原文页码。
4. 每个 entry 的 prerequisite_entry_ids 必须真实存在（来源于输入），不要编造；没有前置就给 []。
5. zones 之间的 prerequisite_zone_ids 必须指向已存在的 zone_id（允许空）。
6. entry_order 是整本书的全局学习序，覆盖所有输入 entry_id，不能遗漏、不能重复。
7. links 收录真正有教学价值的跨 entry 关系（cause / compare / extend / example / common_mistake），宁缺毋滥；没有可给 []。
8. 所有标题不得含"第 X 页 / 来源 / 自动笔记 / 追加讲解 / 嵌入问答 / emoji / 引号"。
9. recap_questions 每个 zone 给 2–4 道，覆盖 foundation / mechanism / application 三种题型中的多种。
10. 严格输出 JSON，不要多余文字、不要 markdown 代码块。"#;

    let user = format!(
        r#"## 笔记本名
{notebook_name}

## 全部 section 的教学元信息（JSON 数组）
{metas_json}

## 任务
按系统消息定义的 schema 输出整本笔记的学习大纲 JSON。
- thesis 要点明"这本笔记最终想让读者掌握什么 / 回答什么核心问题"；
- zones 按学习递进排；
- 每个 zone 自洽：有 summary、learning_goal、prerequisite_zone_ids、entries（已排序）、recap_questions；
- 每个 entry 必须给出 learning_role 和 difficulty；
- entry_order 必须是输入所有 entry_id 的一个全排列。"#
    );

    llm.chat_json(system, &user, 2).await
}

// ── 策略 2：压缩 metas，去掉重字段，只保留规划必需的精简信息 ──────────────

/// 将完整的 metas 数组压缩为精简版本，大幅减少 token 消耗。
/// 每条 entry 只保留：entry_id, semantic_title, summary, topics, learning_role, difficulty
pub fn compress_metas_for_prompt(metas: &[Value]) -> Vec<Value> {
    metas.iter().map(|m| {
        serde_json::json!({
            "entry_id": m.get("entry_id").cloned().unwrap_or(Value::Null),
            "title": m.get("semantic_title").cloned()
                .or_else(|| m.get("original_title").cloned())
                .unwrap_or(Value::Null),
            "summary": m.get("summary").cloned().unwrap_or(Value::Null),
            "topics": m.get("topics").cloned().unwrap_or(serde_json::json!([])),
            "learning_role": m.get("learning_role").cloned().unwrap_or(Value::Null),
            "difficulty": m.get("difficulty").cloned().unwrap_or(Value::Null),
        })
    }).collect()
}

/// 粗估中文/混合文本的 token 数（中文约 1 字 ≈ 1.5 token，英文/标点约 4 字符 ≈ 1 token）。
/// 这里用保守的 `字符数 / 1.8` 作为近似值。
pub fn estimate_tokens(text: &str) -> usize {
    let chars = text.chars().count();
    // 保守估计：平均每 1.8 个字符 ≈ 1 token（中英混合场景）
    (chars as f64 / 1.8).ceil() as usize
}

// ── 策略 3：分块规划 + 合并（当压缩后仍超限时的兜底方案） ─────────────────

/// 对一个分块（子集 metas）做局部 zone 规划，输出局部 outline。
pub async fn build_chunk_outline(
    llm: &LlmClient,
    notebook_name: &str,
    chunk_json: &str,
    chunk_index: usize,
    total_chunks: usize,
) -> Result<Value, String> {
    let system = r#"你是一名资深的课程主编辑。你正在处理一本大型笔记本的**一个分块**，需要为这个分块内的 entries 做局部知识区规划。

硬性原则：
1. 按学习路径重排，不按原文页码。
2. zones 建议 1–3 个（这只是全书的一部分）。
3. 每个 zone 内 entries 按学习递进排序。
4. prerequisite_entry_ids 只能引用本分块内已存在的 entry_id。
5. 所有标题不得含"第 X 页 / 来源 / 自动笔记 / emoji / 引号"。
6. recap_questions 每个 zone 给 1–2 道。
7. 严格输出 JSON，不要多余文字。"#;

    let user = format!(
        r#"## 笔记本名
{notebook_name}

## 分块信息
这是第 {ci}/{tc} 个分块。

## 本分块的 section 元信息（JSON 数组）
{chunk_json}

## 任务
为本分块输出局部学习大纲 JSON，schema：
{{
  "zones": [
    {{
      "zone_id": "c{ci}_z1",
      "title": "知识区标题",
      "summary": "1–2 句话概述",
      "learning_goal": "一句话学完能做到什么",
      "entries": [
        {{ "entry_id": "…", "new_title": "…", "learning_role": "…", "difficulty": 1..5 }}
      ],
      "recap_questions": [ {{ "q": "…", "hint": "…" }} ]
    }}
  ],
  "entry_order": ["entry_id_in_learning_order", ...]
}}"#,
        notebook_name = notebook_name,
        ci = chunk_index + 1,
        tc = total_chunks,
        chunk_json = chunk_json,
    );

    llm.chat_json(system, &user, 2).await
}

/// 将多个分块的局部 outline 合并为全局 outline。
/// `chunk_summaries_json` 是一个数组，每项含 zones 的 title/summary/entry_count + entry_ids。
pub async fn merge_chunk_outlines(
    llm: &LlmClient,
    notebook_name: &str,
    chunk_summaries_json: &str,
    all_entry_ids_json: &str,
) -> Result<Value, String> {
    let system = r#"你是一名资深的课程主编辑。你已经拿到了一本大型笔记本各分块的局部知识区规划，现在需要把它们**合并成一份全局学习大纲**。

硬性原则：
1. 合并相似主题的 zone（不同分块中主题接近的 zone 应合并为一个）。
2. 最终 zones 数量控制在 2–6 个。
3. 按学习路径排列 zones：foundation → mechanism → comparison → misconception → application。
4. 生成全局 thesis（核心主线，2 句话内）。
5. entry_order 必须覆盖所有输入的 entry_id，不遗漏不重复。
6. zones 之间的 prerequisite_zone_ids 必须指向已存在的 zone_id。
7. links 收录跨 entry 的教学关系，宁缺毋滥。
8. 严格输出 JSON。"#;

    let user = format!(
        r#"## 笔记本名
{notebook_name}

## 各分块的局部规划摘要
{chunk_summaries_json}

## 全部 entry_id 列表（必须全部出现在 entry_order 中）
{all_entry_ids_json}

## 任务
合并各分块规划，输出全局学习大纲 JSON，schema：
{{
  "thesis": "核心主线",
  "learning_path": ["foundation", ...],
  "zones": [
    {{
      "zone_id": "z1",
      "title": "知识区标题",
      "summary": "概述",
      "learning_goal": "学完能做到什么",
      "prerequisite_zone_ids": [],
      "entries": [
        {{ "entry_id": "…", "new_title": "…", "learning_role": "…", "difficulty": 1..5, "prerequisite_entry_ids": [] }}
      ],
      "recap_questions": [ {{ "q": "…", "hint": "…" }} ]
    }}
  ],
  "entry_order": ["全局学习序，覆盖所有 entry_id"],
  "links": [ {{ "from": "…", "to": "…", "kind": "…", "note": "…" }} ]
}}"#,
        notebook_name = notebook_name,
        chunk_summaries_json = chunk_summaries_json,
        all_entry_ids_json = all_entry_ids_json,
    );

    llm.chat_json(system, &user, 2).await
}

/// 判断标题是否"系统自动生成 / 非语义" —— 需要 LLM 重写。
/// 保持与前端 `titleLooksAuto` 语义对齐，供 commands 复用。
pub fn title_looks_auto(title: &str) -> bool {
    let t = title.trim();
    if t.is_empty() { return true; }
    let lowered = t.to_lowercase();
    let badges = ["第 ", "第", "📖", "📄", "💡", "📝", "🔖", "来源：", "来源:", "自动笔记", "追加讲解", "嵌入问答"];
    for b in badges.iter() {
        if t.contains(b) || lowered.contains(&b.to_lowercase()) { return true; }
    }
    // "page 1 / auto / note" 英文模式
    if lowered.starts_with("page ") || lowered.contains("auto note") || lowered == "未命名" {
        return true;
    }
    false
}

// ══════════════════════════════════════════════════════════════════════════════
// Knowledge Point Title Refinement
//   一次喂多个 KP 摘要给 LLM，返回每个 KP 的 { title, summary } 数组。
//   省 N 次 LLM 调用、按整本书的相对主题给出更连贯的命名。
// ══════════════════════════════════════════════════════════════════════════════

/// 单条 KP 的输入摘要（用于让 LLM 生成标题）。
#[derive(serde::Serialize)]
pub struct KpTitleInput<'a> {
    pub kp_index: i64,
    pub page_start: i64,
    pub page_end: i64,
    /// 该 KP 的代表性文本片段（首块 + 末块前 ~300 字拼成 ~600 字）。
    pub snippet: &'a str,
}

/// 单条 KP 的输出（LLM 返回）。
#[derive(serde::Deserialize, Debug)]
pub struct KpTitleOutput {
    pub kp_index: i64,
    pub title: String,
    #[serde(default)]
    pub summary: String,
}

/// 一次性为整本书的所有 KP 生成标题 + 一句话摘要。
///
/// 失败时返回 Err；调用方应保留 KP 但 `status='detected'`，UI 提示可重试。
/// 单次过长会拆批（默认 ≤ 20 个 KP 一批，~12K tokens）。
pub async fn refine_kp_titles(
    llm: &LlmClient,
    doc_title: &str,
    kps: &[KpTitleInput<'_>],
) -> Result<Vec<KpTitleOutput>, String> {
    if kps.is_empty() {
        return Ok(Vec::new());
    }
    const BATCH: usize = 20;
    let mut out: Vec<KpTitleOutput> = Vec::with_capacity(kps.len());
    for batch in kps.chunks(BATCH) {
        let batch_json = serde_json::to_string(batch)
            .map_err(|e| format!("序列化 KP 输入失败: {e}"))?;
        let system = r#"你是一个学习材料编辑。下面给你一份文档的若干"知识点片段"，
每个片段含 kp_index / 页码范围 / 内容代表片段。请为**每个 kp_index** 输出一个简洁有力的标题和 1-2 句话摘要。

要求：
1. 标题 6-20 字，直指主题；不加 emoji、不加引号、不出现「第 X 页」「来源」等系统词。
2. 摘要 1-2 句话，30-80 字，概括该知识点的核心观点（不是抄原文）。
3. 全部 kp_index 都要输出，按输入顺序。

严格 JSON 输出（UTF-8，不要 markdown 代码块、不要解释）：
{ "items": [ { "kp_index": <数字>, "title": "<标题>", "summary": "<摘要>" }, ... ] }
"#;
        let user = format!(
            "## 文档\n{doc_title}\n\n## 知识点片段数组\n{batch_json}\n\n请输出 JSON。"
        );
        let v = llm.chat_json(system, &user, 2).await?;
        let items = v.get("items").and_then(|x| x.as_array())
            .ok_or_else(|| "LLM 返回 JSON 缺少 items 字段".to_string())?;
        for it in items {
            if let Ok(o) = serde_json::from_value::<KpTitleOutput>(it.clone()) {
                out.push(o);
            }
        }
    }
    Ok(out)
}

