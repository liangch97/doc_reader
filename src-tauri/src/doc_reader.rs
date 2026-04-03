/// Doc Reader 模块 — 按页阅读文档 + AI 页面笔记生成
use crate::llm::{LlmClient, Message};

/// 为单页生成 AI 笔记（基于当前页内容 + 笔记类型）
pub async fn generate_page_note(
    llm: &LlmClient,
    doc_title: &str,
    page_index: usize,
    page_content: &str,
    note_type: &str,
    custom_prompt: Option<&str>,
) -> Result<String, String> {
    let type_instruction = get_type_instruction(note_type);

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
    let type_instruction = get_type_instruction(note_type);

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
    let type_instruction = get_type_instruction(note_type);

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

/// 根据笔记类型返回对应的格式指令
fn get_type_instruction(note_type: &str) -> &'static str {
    match note_type {
        "summary" => r#"生成**摘要笔记**：
1. 用 1-2 句话概括本页主旨
2. 提取 3-5 个关键要点，用有序列表
3. 总结核心结论或观点
4. 总字数控制在 150-300 字"#,

        "mindmap" => r#"生成**思维导图笔记**：
1. 用一级标题 `# 中心主题` 表示核心主题
2. 用二级标题 `## 分支` 表示主要分支（3-5 个）
3. 在每个二级标题下用 `- ` 无序列表列出该分支的要点（每个分支 2-4 个要点）
4. 要点只用一层列表，不要嵌套子列表
5. 保持简洁，每个要点控制在一行以内
6. 总共不超过 20 个要点"#,

        "cornell" => r#"生成**康奈尔笔记**，包含三个区域：
1. **关键词/问题栏**（用 `### 关键词` 标记）：列出本页 3-5 个关键术语或问题
2. **笔记栏**（用 `### 笔记` 标记）：详细记录本页核心内容，用要点列表
3. **总结栏**（用 `### 总结` 标记）：用 2-3 句话总结本页精华
4. 总字数控制在 200-400 字"#,

        "qa" => r#"生成**问答笔记**：
1. 根据本页内容设计 3-5 个有价值的问题
2. 每个问题后紧跟详细的答案
3. 格式：用 `**Q:** ` 开头提问，用 `**A:** ` 开头回答
4. 问题应涵盖核心概念、因果关系和应用场景
5. 答案要准确、简洁，总字数控制在 300-500 字"#,

        "timeline" => r#"生成**时间线笔记**：
1. 如果页面包含事件、步骤或流程，按时间/顺序排列
2. 每个节点格式：`**[时间/步骤]** — 事件描述`
3. 如果没有明确的时间线，按逻辑顺序组织要点
4. 用有序列表表示先后关系
5. 总字数控制在 200-400 字"#,

        "concept_map" => r#"生成**概念图笔记**：
1. 识别本页 3-5 个核心概念
2. 用 `**概念名**` 标记每个概念
3. 描述概念之间的关系（如：A → 导致 → B）
4. 格式示例：`**概念A** —[关系]→ **概念B**`
5. 最后用 1-2 句话说明概念间的整体框架
6. 总字数控制在 200-400 字"#,

        "flashcard" | "anki" => r#"生成**闪卡/记忆卡片**：
1. 根据本页内容制作 5-8 张记忆卡片
2. 每张卡片格式：
   - `**正面：** ` 问题或提示
   - `**背面：** ` 答案或解释
3. 卡片应覆盖本页最重要的知识点
4. 答案要简洁精确，便于快速记忆
5. 用 `---` 分隔每张卡片"#,

        "fusion" => r#"生成**融合笔记**（综合多种笔记法）：
1. 先用 2-3 句话做**核心摘要**
2. 然后用**思维导图**格式展示知识结构（用二级标题表示分支，每个分支下用列表列出要点）
3. 提出 2-3 个**关键问题**并简要回答
4. 如果有术语，用**闪卡**格式列出（正面/背面）
5. 最后用 1 句话做**总结**
6. 总字数控制在 300-500 字"#,

        // "note" 或其他未知类型，使用综合笔记
        _ => r#"生成**综合阅读笔记**：
1. 提取该页的核心要点（3-5 个）
2. 如果有重要术语或概念，简要解释
3. 用简洁的 Markdown 格式输出
4. 总字数控制在 200-400 字"#,
    }
}
