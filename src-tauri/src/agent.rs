/// 学习 Agent 模块（DESIGN.md §13 v2 Auto-Pilot）
///
/// 三个 LLM 入口：
///   1. `generate_outline`           : 整本路线图 = `skip_pages[]` + `units[]`
///                                     Agent 自主决定哪些页跳过（版权/目录/索引）、哪些
///                                     页归到一个学习单元、哪个单元值不值得出题。
///                                     1 req/书。
///   2. `build_teach_unit_messages`  : 构造单元教学的流式 messages。流式输出复合协议：
///                                     [markdown 讲解...] <<<QUESTIONS>>> [JSON questions]
///                                     1 req/单元。
///   3. `grade_subjective`           : 简答题批量判分。0~1 req/单元。
///
/// 流式协议设计原因：
///   - 真正的 token 流（不是前端打字机假象），体验和 ChatTab 一致
///   - 单次 LLM 调用同时拿"讲解 + 题目"，遵守"按 request 计费"红线
///   - 用 `<<<QUESTIONS>>>` 分隔符而不是流式 JSON：JSON 增量解析复杂且对 UI 不友好
use crate::llm::{LlmClient, Message};
use serde_json::{json, Value};

/// 教学协议中的 questions 段分隔符。前端按此切分：
///   - 之前的内容 → 实时渲染为 markdown 讲解
///   - 之后的内容 → 累积到流末，整体解析 JSON 数组
#[allow(dead_code)] // v3: 废弃用 ```quiz``` 围栏，保留定义以备回退
pub const QUESTIONS_DELIMITER: &str = "<<<QUESTIONS>>>";

// ════════════════════════════════════════════════════════════════════════════
// 1) 路线图 — 整本书一次性 1 req
// ════════════════════════════════════════════════════════════════════════════

/// 基于 doc_title + 抽样页文本 → 学习路线图。
///
/// 输出 JSON schema:
/// ```json
/// {
///   "thesis": "整本书核心主张（≤ 80 字）",
///   "skip_pages": [1, 2, 3, 18],
///   "skip_reason": "前 3 页为版权页和目录；第 18 页为课程介绍",
///   "units": [
///     {
///       "id": "u1",
///       "title": "线性代数基础",
///       "pages": [4, 5, 6, 7, 8],
///       "key_points": ["向量空间", "线性变换", "基与维数"],
///       "needs_quiz": true,
///       "difficulty": 3
///     },
///     {
///       "id": "u2",
///       "title": "推导细节（可略读）",
///       "pages": [9, 10],
///       "key_points": ["..."],
///       "needs_quiz": false,
///       "difficulty": 2
///     }
///   ]
/// }
/// ```
///
/// `sample_pages`: 已抽样的页面 `(page_index_0_based, excerpt)`，excerpt 限 ≤ 600 字。
pub async fn generate_outline(
    llm: &LlmClient,
    doc_title: &str,
    page_total: usize,
    sample_pages: &[(usize, String)],
    // 可选：用户在生成前回答的 wizard 配置（难度/范围/目标等）。
    // 传入时附加到 system prompt，引导 LLM 按用户偏好规划。
    user_preferences: Option<&str>,
) -> Result<Value, String> {
    let sample_text = sample_pages
        .iter()
        .map(|(idx, txt)| format!("### 第 {} 页（节选）\n{}", idx + 1, txt.trim()))
        .collect::<Vec<_>>()
        .join("\n\n");

    let system = r#"你是一名擅长教学设计的学习教练。给你一本书的元信息和章节抽样文本，
你需要规划一份"自动驾驶式"的学习路线图——AI 会按你的规划，自动逐单元讲解给学生。

你的任务：

1. **识别应跳过的页**：版权页、目录、致谢、索引、参考文献、纯封面、纯空白页、
   课程营销/简介页（"本课程将让你..."这类）。把它们的页码（1-based）放进 `skip_pages`。

2. **把剩余内容拆成 3-12 个学习单元**：
   - 每个单元是一个**完整的小知识闭环**，可能跨 1 页也可能跨 N 页
   - 同一主题的连续页应合并为一个单元，不要按"每页一个单元"机械切分
   - 字段：
     * `id`         : "u1" / "u2" 顺序
     * `title`      : 简短标题（≤ 20 字），描述本单元学完后能回答的问题
     * `pages`      : 该单元覆盖的页码数组（1-based，可不连续）
     * `key_points` : 2-4 个核心知识点（每个 ≤ 15 字）
     * `needs_quiz` : 这个单元的内容**是否值得用题目检测理解**
                      true  = 涉及关键概念/方法/推理；考过能巩固理解
                      false = 纯背景介绍、案例展示、过渡性内容、纯描述性事实
     * `difficulty` : 1-5（1=入门 / 5=深奥）

3. **总结全书主张**：用 ≤ 80 字概括整本书想让学生学到什么（`thesis`）。

约束：
- units 覆盖的 pages 不应包含 skip_pages 里的页
- units[i].pages 与 units[j].pages 不重叠
- 不必覆盖每一页（允许少量过渡页留白）
- **严禁退化为"每页一个单元"**：如果是 PPT/课件，多张连续幻灯片往往讲一个完整概念，必须合并
- units 数量硬性约束：**`units.length ≤ max(3, ceil(非跳过页数 / 2))`**，宁可少不要多
- 例：30 页课件去掉 4 页跳过 → 26 页 → units 数量 ≤ 13；通常 5-10 个单元即可
- needs_quiz=true 的单元应占总单元数的 60-80%（不要全部都出题，也不要全都不出）
- 严格输出 JSON，不要任何解释文字、不要 markdown 代码块"#;

    let prefs_block = match user_preferences {
        Some(p) if !p.trim().is_empty() => format!(
            "\n\n## 学生偏好（请严格遵守这些约束规划路线）\n{}\n",
            p.trim()
        ),
        _ => String::new(),
    };

    let user = format!(
        r#"## 文档标题
{doc_title}

## 总页数
{page_total}

## 章节抽样内容
{sample_text}{prefs_block}

请输出 JSON 路线图。"#,
    );

    llm.chat_json(system, &user, 2).await
}

// ════════════════════════════════════════════════════════════════════════════
// 1.5) Clarify Wizard：生成路线图前先让 LLM 出 3-5 道择题问学生偏好
// ════════════════════════════════════════════════════════════════════════════
//
// 设计思路：
//   - 不写死"难度/范围/目标"四问，而是让 LLM 看了抽样内容后**动态**出题
//     —— 不同书需要问的事情不同（小说问"读为兴趣还是分析"，技术书问
//     "已掌握 X 想跳过吗"，论文问"重点在方法还是结论"...）
//   - 每题都是单选（让 UX 简单），但保留一个"开放补充"框留白
//   - 题数 3-5 道，避免太多让用户烦
//
// 输出 JSON 格式：
// ```
// {
//   "questions": [
//     { "id": "q1", "prompt": "...", "options": ["A) ...", "B) ...", ...] },
//     ...
//   ]
// }
// ```
pub async fn generate_clarify_questions(
    llm: &LlmClient,
    doc_title: &str,
    sample_pages: &[(usize, String)],
) -> Result<Value, String> {
    let sample_text = sample_pages
        .iter()
        .take(8) // 只取前 8 页抽样，足够 LLM 判断书的特征
        .map(|(idx, txt)| format!("### 第 {} 页\n{}", idx + 1, txt.trim()))
        .collect::<Vec<_>>()
        .join("\n\n");

    let system = r#"你是一名学习教练。学生马上要让 AI 给他设计一份学习路线图。
在出路线图之前，你需要先**问学生 3-5 个问题**，了解他的偏好——这样路线图能贴合他的需求。

任务：基于书的内容特点，**动态生成** 3-5 道单选题。
- **不要**机械问"难度/范围/目标"——根据这本书的体裁（小说/教材/PPT/论文/操作手册...），问最值得问的事
- 每题 2-4 个选项，每个选项要让学生**一眼看懂含义**，避免抽象
- 至少有一道是"目标定位"类问题（学这本书是为了什么）
- 至少有一道是"深度偏好"类问题（要细嚼慢咽还是快速浏览）
- 选项里可以包含"让 AI 帮我决定"这样的兜底项

输出 JSON 格式（严格）：
```
{
  "questions": [
    {
      "id": "q1",
      "prompt": "你打算用多少时间学完这本书？",
      "options": ["A) 1-2 小时快速浏览", "B) 半天系统学", "C) 几天精读"]
    },
    ...
  ]
}
```

约束：
- 题数 3-5 道，多了用户烦
- prompt 用第二人称"你"，亲切
- 选项前缀必须是 "A) " "B) " "C) " "D) "（含右括号 + 空格）
- 严格输出 JSON，不要解释、不要 markdown 代码块"#;

    let user = format!(
        r#"## 文档标题
{doc_title}

## 章节抽样
{sample_text}

请输出 3-5 道单选问题（JSON）。"#,
    );

    llm.chat_json(system, &user, 2).await
}

// ════════════════════════════════════════════════════════════════════════════
// 2) 单元教学（流式）— 1 req/单元
// ════════════════════════════════════════════════════════════════════════════

/// 构造流式教学 messages。调用方使用 `LlmClient::chat_stream` 喂 token，
/// 自行解析 `<<<QUESTIONS>>>` 分隔符。
///
/// `unit`: 路线图里的某个 unit（包含 title / key_points / needs_quiz）
/// `pages_text`: 该单元覆盖的所有页文本，已拼接（按 page 顺序）
pub fn build_teach_unit_messages(
    doc_title: &str,
    unit: &Value,
    pages_text: &str,
    // v2.1 新增：上下文轨迹
    thesis: &str,                       // 整本书总主张（≤ 80 字）
    previous_units: &[Value],           // 已学完的 unit JSON（按顺序）
    next_unit_title: Option<&str>,      // 紧随其后的下一个 unit 标题（用于结尾铺垫）
    unit_position: (usize, usize),      // (当前 1-based 序号, 总 unit 数)
) -> Vec<Message> {
    let unit_title = unit.get("title").and_then(|x| x.as_str()).unwrap_or("");
    let key_points = unit
        .get("key_points")
        .and_then(|x| x.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str())
                .collect::<Vec<_>>()
                .join("、")
        })
        .unwrap_or_default();
    // v4 (2026-05)：题目搬到训练板块；学习区只讲解。`needs_quiz` 字段保留但不再
    // 影响讲解 prompt（仅影响路线图阶段是否把该单元标记为"训练板块出题候选"）。
    let _needs_quiz = unit
        .get("needs_quiz")
        .and_then(|x| x.as_bool())
        .unwrap_or(true);

    // 上一阶段已学单元摘要：最多回看 5 个，每个一行 "标题 — 要点1/要点2"
    let prev_recap = if previous_units.is_empty() {
        String::from("（无，这是第一个学习单元）")
    } else {
        let recent = previous_units
            .iter()
            .rev()
            .take(5)
            .collect::<Vec<_>>();
        recent
            .iter()
            .rev()
            .enumerate()
            .map(|(i, u)| {
                let title = u.get("title").and_then(|x| x.as_str()).unwrap_or("");
                let kp = u
                    .get("key_points")
                    .and_then(|x| x.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|v| v.as_str())
                            .take(2)
                            .collect::<Vec<_>>()
                            .join("/")
                    })
                    .unwrap_or_default();
                format!("{}. {}{}", i + 1, title, if kp.is_empty() { String::new() } else { format!(" — {kp}") })
            })
            .collect::<Vec<_>>()
            .join("\n")
    };

    let next_hint = match next_unit_title {
        Some(t) if !t.is_empty() => format!("- 下一单元：**{t}**（在本单元概括末尾，用 1 句话自然引向它）"),
        _ => String::from("- 这是**最后一个**单元，本单元概括末尾用 1 句话总结全书核心收获"),
    };
    let (pos_now, pos_total) = unit_position;

    // 该单元覆盖的页码列表（1-based），告诉 LLM 必须对每一页都给出回应
    let pages_list: Vec<i64> = unit
        .get("pages")
        .and_then(|x| x.as_array())
        .map(|arr| arr.iter().filter_map(|v| v.as_i64()).collect())
        .unwrap_or_default();
    let pages_list_str = if pages_list.is_empty() {
        String::from("（未提供页码）")
    } else {
        pages_list
            .iter()
            .map(|p| p.to_string())
            .collect::<Vec<_>>()
            .join(", ")
    };
    let pages_count = pages_list.len();

    // v4 (2026-05)：学习区不再出题、不再画思维导图 —— 题目搬到训练板块，
    // 思维导图整体下线。讲解 prompt 只关注"讲清楚一个知识点"。

    let system = format!(
        r#"你是一名经验丰富的老师，正在给学生**一对一讲课**。
你像老师在黑板前一步步把一个知识点剖析清楚 —— 既要用讲课的口吻把事讲透，又要善用**板书 / 表格 / 流程图**这些视觉手段，让抽象概念落到实处。**纯文字、无排版的大段散文是不可接受的**。

把单元里值得讲的内容拆成 **3-6 个知识点**，按学习顺序逐个讲。每个知识点都是"段落讲解 + 视觉元素混排"的完整骨架。

## 输出结构（前端切屏依赖，**1 个硬性锚点**）

每个知识点严格按以下骨架：

```
## 知识点 N · 简洁标题（来自 P{{x}}-P{{y}}）

（讲解段落 1：抛钩子 / 提问）

（可选 ### 子小节 + 段落 2）

| 表头A | 表头B |       <-- 视觉元素：表格 / 代码块 / ASCII 图 / 公式 至少 1-2 个
| --- | --- |
| ... | ... |

（段落 3：解释表格 / 收尾）
```

锚点规则：
- `## 知识点 N · 标题（来自 Pxx-Pyy）` 是前端切屏锚点；N 从 1 递增
- 页码区间真实，标本知识点主要覆盖的页（1-3 页）
- `## 知识点 N` 内部**允许 `###` 子小节**（2-4 个，用于结构化层次），**严禁 `##`**
- 不要逐页讲；同一页可拆到多个知识点，多页可融合到一个

**所有知识点之后**，固定收尾：

```
## 本单元小结

（2-3 段自然语言，把所有知识点串起来，体现整本书脉络；如有下一单元，末句自然引出。**不要**列表、不要"核心要点"标签。）
```

## 讲解风格（**重中之重**）

### 1. 讲课口吻 + 一步步剖析

- 多用"我们""你看""注意""想一下""别急"这种课堂引导词
- 知识点开头先抛**具体问题 / 现象 / 误解 / 例子**，让学生先有疑惑感
- 然后顺着钩子，**一步步**展开为什么、是什么、怎么用
- 容易混淆 / 容易踩坑处明确点出："注意这里很多人会以为是...，但实际是..."
- **绝对不要**用"核心要点""速览""一句话本质""直觉提示"这种总结化标签
- **绝对不要**为了简洁压缩成干巴巴的短句；宁可多写两段把事情讲透

### 2. 图文混排是**强制要求**（每个知识点至少 1-2 个视觉元素）

把以下视觉元素当作"老师在黑板上的板书"，穿插在段落之间。**禁止**整个知识点全是纯文字段落。

**(a) 表格**（对比 / 步骤 / 参数 / 优缺点） —— 用 GFM 表格：

```
| 维度 | 方案A | 方案B |
| --- | --- | --- |
| 时间复杂度 | O(n) | O(log n) |
| 适用场景 | ... | ... |
```

**(b) 代码块 / ASCII 流程图** —— 用三反引号包裹（可选语言标签）：

```
        Input
          │
          ▼
   ┌──────────┐
   │  Process │
   └──────────┘
          │
          ▼
        Output
```

**(c) 行内 / 段落公式** —— 用 KaTeX 语法：

- 行内：`时间复杂度 $O(n \log n)$`
- 独立段落：`$$ f(n) = \sum_{{i=1}}^{{n}} i = \frac{{n(n+1)}}{{2}} $$`

**(d) 引用块** —— 用 `>` 标注**原文摘录** / **关键警示**：

```
> "递归的本质是把问题规模缩小，而不是把代码变短。" —— 原文 P3
```

**(e) 加粗术语 + 偶尔列表**：

- 关键术语第一次出现就 `**加粗**`，紧跟一句解释
- 真正需要并列罗列（3 项以上短语）时可用 `-` 列表，但**不要**用列表替代段落讲解

### 3. ### 子小节（可选但鼓励）

`## 知识点 N` 内部允许用 `### 子主题` 拆段，让长知识点有结构层次。例如：

```
## 知识点 2 · 闭包的本质（来自 P5-P7）

（开头段落）

### 函数作为一等公民

（段落讲解）

### 词法作用域如何捕获变量

（段落 + 代码块）

### 一个常见的踩坑场景

（段落）
```

**注意**：`###` 标题是**真实的子主题名**，不要写成 "核心要点 / 速览 / 一句话本质" 这种总结标签。

### 4. 字数与节奏

- 每个知识点 **400-700 字**（含视觉元素行数）
- 第一个知识点开头**用一两句承接前一单元**（若有）
- 最后一个知识点结尾留"那接下来呢"的悬念，自然过渡到小结

### 5. 围栏纪律

- 普通代码块（无标签 ```、或 ```c ```python ```sql 等）用于代码 / ASCII 图，正常使用
- **严禁**自创特殊围栏：`flashcards` / `qa` / `concept` / `summary` / `quiz` / `mindmap` —— 题目和思维导图已下线，这里只输出讲解
- **严禁**：emoji 装饰标签（🎯 💡 📌）；加粗短语当小标题；空 `###` 标题
- 严禁在 `## 知识点 N` 和 `## 本单元小结` 之外另起 `##` 标题
- 知识点数量 3-6 个

记住：学生想听到"老师把一件事讲明白 + 把它画在黑板上"，不是"一大段干巴巴的话"。本面板只负责讲清楚知识点；做题在训练板块，不在这里。"#
    );

    let user = format!(
        r#"## 文档标题
{doc_title}

## 整本书核心主张
{thesis}

## 学习进度
当前是第 {pos_now} / {pos_total} 个单元

## 截至目前学生已经学过的单元（按时间顺序）
{prev_recap}

## 现在要讲的单元
- 标题：{unit_title}
- 大纲（仅供你参考、决定怎么拆知识点；**不是输出格式**）：{key_points}
- **本单元覆盖的页码**：[{pages_list_str}]（共 {pages_count} 页）—— 你按知识点切，每个知识点的标题里标出"来自 P{{x}}-P{{y}}"

## 学完本单元后的衔接
{next_hint}

## 单元覆盖的原文（按页号给出，已 prefix `### 第 N 页`）
{pages_text}

请开始。第一个知识点的正文开头**用一句话承接前一单元**（若有），结尾的 `## 本单元小结` 末尾自然引向下一单元。"#,
        doc_title = doc_title,
        thesis = if thesis.is_empty() { "（未提供）" } else { thesis },
        pos_now = pos_now,
        pos_total = pos_total,
        prev_recap = prev_recap,
        unit_title = unit_title,
        key_points = key_points,
        pages_list_str = pages_list_str,
        pages_count = pages_count,
        next_hint = next_hint,
        pages_text = pages_text.trim(),
    );

    vec![
        Message { role: "system".into(), content: system },
        Message { role: "user".into(), content: user },
    ]
}

/// 从已生成的单元 markdown 中抽取所有 ```quiz``` 围栏，合并成 questions 数组，
/// 同时返回**剥离掉这些围栏后**的 clean markdown（用于持久化和前端渲染）。
///
/// 用途：替代旧的 `<<<QUESTIONS>>>` 分隔符协议 —— LLM 在每个知识点末尾用
/// ```quiz [...]``` 内嵌题目，更稳健（围栏是 markdown 母语，不容易输错），
/// 且天然让"题目-知识点"绑定（前端拿到围栏在哪个 ## 知识点 N 段下即可关联）。
///
/// 支持的围栏形态：
///   ```quiz
///   [ {...}, {...} ]
///   ```
///   信息标签必须是 `quiz`（小写）；如果 LLM 写错了（QUIZ / Quiz），也容错识别。
///
/// 解析失败的围栏：原文保留在 clean_md 中（不删除），便于前端用代码块兜底显示，
/// 避免完全丢失内容。
pub fn extract_quizzes_from_md(md: &str) -> (String, Vec<Value>) {
    use regex::Regex;
    // 多行 + 非贪婪：` ```quiz\n ... \n``` `
    // (?is) → case-insensitive + dot-matches-newline
    // 内部捕获组 1 = JSON 文本（可能跨多行）
    static RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(r"(?im)^\s*```\s*quiz\s*\r?\n([\s\S]*?)\r?\n\s*```\s*$").unwrap()
    });

    let mut questions: Vec<Value> = Vec::new();
    let mut clean = String::with_capacity(md.len());
    let mut last_end = 0usize;
    for m in re.captures_iter(md) {
        let whole = m.get(0).unwrap();
        let json_raw = m.get(1).map(|x| x.as_str()).unwrap_or("").trim();
        // 尝试 parse
        let parsed: Result<Value, _> = serde_json::from_str(json_raw);
        match parsed {
            Ok(Value::Array(arr)) => {
                // 把数组里每个 question 平铺到结果
                for q in arr {
                    if q.is_object() {
                        questions.push(q);
                    }
                }
                // 抽走围栏：clean 拼接 [last_end..whole.start()]
                clean.push_str(&md[last_end..whole.start()]);
                last_end = whole.end();
            }
            Ok(Value::Object(_)) => {
                // 兼容：LLM 错写成单对象（非数组）
                questions.push(parsed.unwrap());
                clean.push_str(&md[last_end..whole.start()]);
                last_end = whole.end();
            }
            _ => {
                // 解析失败：保留原文（前端会渲染成代码块）
            }
        }
    }
    clean.push_str(&md[last_end..]);

    // 去重 id（防 LLM 重复编号），保留首个；不强制 id 规范，前端会兜底
    let mut seen_ids = std::collections::HashSet::new();
    questions.retain(|q| match q.get("id").and_then(|v| v.as_str()) {
        Some(id) => seen_ids.insert(id.to_string()),
        None => true,
    });

    // 折叠抽走围栏后的多余空行（最多保留 2 个连续换行）
    let cleaned = collapse_blank_lines(&clean);
    (cleaned.trim().to_string(), questions)
}

fn collapse_blank_lines(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut blank_run = 0usize;
    for line in s.split_inclusive('\n') {
        let trimmed = line.trim_end_matches(|c: char| c == '\n' || c == '\r');
        if trimmed.is_empty() {
            blank_run += 1;
            if blank_run <= 2 {
                out.push_str(line);
            }
        } else {
            blank_run = 0;
            out.push_str(line);
        }
    }
    out
}

// ════════════════════════════════════════════════════════════════════════════
// 2.1) 单元追问 — 智能追问建议（非流式 chat_json）+ 用户追问回答（流式）
// ════════════════════════════════════════════════════════════════════════════

/// 在某单元讲解结束后，让 LLM 给 3 个"对本单元的智能追问"。
/// 用于 ChipBar 顶部展示，点击后调 `build_unit_followup_answer_messages` 流式回答。
///
/// 输出严格 JSON：`{ "followups": ["问题1", "问题2", "问题3"] }`
/// 拿不到时 caller 应 fallback 到空 vec。
pub async fn generate_unit_followups(
    llm: &LlmClient,
    doc_title: &str,
    unit_title: &str,
    unit_explanation: &str,
) -> Vec<String> {
    let system = r#"你是一名学习引导教练。学生刚学完一个知识单元，请基于讲解内容给出 3 个最有学习价值的「追问」。
要求：
1. 每个问题独立成句，6-30 字，问句结尾用 ？
2. 题型尽量分散：① 深挖讲解里某个概念的边界 / 反例；② 横向对比相关概念；③ 应用到实际场景或下一步
3. **以学生第一人称提问**（"如果…那…是不是会…？" / "怎么…？" / "为什么…？"），不是"请解释 X" 这种命令句
4. 严格 JSON 输出：{ "followups": ["问题1", "问题2", "问题3"] }，不要 markdown 不要解释"#;

    let user = format!(
        r#"## 文档
{doc_title}

## 刚学完的单元
{unit_title}

## 讲解内容摘录
{unit_explanation}

请输出 3 个学生视角的追问。"#,
        unit_explanation = unit_explanation.chars().take(2500).collect::<String>(),
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
            log::warn!("generate_unit_followups 失败: {e}");
            Vec::new()
        }
    }
}

/// 用户在 ChipBar 上点击追问 / 在学习区自由提问 → 用这个 messages 让 LLM 流式回答。
///
/// 设计定位（2026-05 重构）：
///   追问框不再是"贴在小卡里的轻补充"，而是一个**深入浅出、全面完整的讲解器**。
///   学生问"什么是 B 树"，就要把概念、数据结构形态（ASCII 图）、增删查改操作、
///   复杂度与适用场景一次讲透 —— 图文结合，代码默认 C++。
///
/// 上下文策略（关键改动）：
///   - 单元讲解摘要降级为**轻量背景**（截断到 ~800 字），不再霸占 prompt，
///     也不再强制"紧扣本单元"——避免长上下文把模型从问题本身带偏。
///   - `retrieved`：基于问题做 RAG 检索出来的原文片段（top-k），作为**精准知识来源**，
///     与聊天区同源。可为空（无索引时）。
///   - `prev_followups`：本单元历史追问，保证多轮连续性。
pub fn build_unit_followup_messages(
    doc_title: &str,
    unit_title: &str,
    unit_explanation: &str,
    prev_followups: &[(String, String)], // (question, answer) 已答完的轮次
    retrieved: &[crate::rag::RetrievedChunk],
    question: &str,
) -> Vec<Message> {
    let prev_block = if prev_followups.is_empty() {
        String::from("（本单元尚无追问历史）")
    } else {
        prev_followups
            .iter()
            .enumerate()
            .map(|(i, (q, a))| {
                let a_short: String = a.chars().take(280).collect();
                format!("第 {} 轮\n  Q: {}\n  A: {}", i + 1, q, a_short)
            })
            .collect::<Vec<_>>()
            .join("\n\n")
    };

    // RAG 检索片段：复用聊天区的格式化，按相关度排序、带页码标号
    let (rag_ctx, _) = crate::rag::build_context_for_chat(retrieved);
    let rag_block = if rag_ctx.trim().is_empty() {
        String::from("（本次未检索到相关原文片段，请基于你的知识把问题讲透）")
    } else {
        rag_ctx
    };

    let system = r#"你是一名循序渐进、深入浅出的讲师，学生在学习过程中向你提问。你的职责是把学生提出的问题**讲深讲透、全面完整**，而不是敷衍地补一两句。

## 核心原则
- **深入浅出**：先用直觉 / 类比把概念讲明白，再逐步深入到机制与细节，照顾零基础也能跟上。
- **全面完整**：围绕问题把相关知识点成体系地讲清楚。例如学生问"什么是 B 树"，就应覆盖：它是什么、为什么需要它、**数据结构长什么样（画出来）**、增删查改怎么操作、时间/空间复杂度、典型应用场景与易错点。该展开就展开，不要怕长。
- **图文结合（强制）**：抽象结构必须画出来，用 ``` 围栏包裹 **ASCII 图**展示数据结构 / 内存布局 / 流程。纯文字讲数据结构是不合格的。

## 视觉与代码规范
1. **ASCII 图**：用代码围栏画结构图。例如树 / 链表 / 指针 / 表格状布局：
```
        [ 30 | 60 ]
       /    |     \
  [10|20] [40|50] [70|80]
```
2. **代码默认 C++**：除非学生指定其它语言，所有示例代码都用 ` ```cpp ` 围栏，写出可读、规范、有必要注释的代码（如结构体定义、关键操作函数）。
3. **表格**：对比 / 复杂度 / 操作步骤用 GFM 表格。
4. **公式**：用 KaTeX，行内 `$O(\log n)$`，独立段落 `$$...$$`。
5. **结构化**：内容多时用 `###` 子小节组织（如 `### 结构`/`### 插入`/`### 删除`/`### 复杂度`）；要点用 `1. 2. 3.`；关键术语首次出现 `**加粗**` 并解释。

## 上下文使用
- 「检索到的原文片段」是与问题相关的书内原文，**优先据此作答**并在引用处标注页码 `[P页码]`；不足的部分用你的专业知识补全（标注 **【补充】**）。
- 「单元讲解摘要」只是了解学生当前进度的**轻量背景**，**不必围绕它作答、不要复述它**——学生的问题本身才是核心，即使问题超出该单元也要正常讲透。

## 风格
- 直接开讲，不要"好问题！"之类的客套，不要复述问题。
- 讲课口吻，多用"我们""你看""注意""想一下"引导；容易踩坑处明确点出。
- 长度服从把问题讲透的需要：简单问题简洁，概念性 / 数据结构类问题该长则长。"#;

    let user = format!(
        r#"## 文档
{doc_title}

## 学生当前所在单元（仅供了解进度，**不必围绕它作答**）
{unit_title}

## 单元讲解摘要（轻量背景，可忽略，**不要复述**）
{unit_explanation}

## 检索到的相关原文片段（优先据此作答，引用请标 [P页码]）
{rag_block}

## 本单元此前的追问（保持多轮连贯）
{prev_block}

## 学生现在的问题
{question}

请把这个问题讲深讲透：该画图就画 ASCII 图，代码默认用 C++。"#,
        unit_explanation = unit_explanation.chars().take(800).collect::<String>(),
    );

    vec![
        Message { role: "system".into(), content: system.to_string() },
        Message { role: "user".into(), content: user },
    ]
}

/// 用户在某个知识点屏点"+ 再来 N 道"按钮 → 用这个 messages 让 LLM 流式生成更多题。
///
/// 设计目标：
///   1. **不重复**：把已有题目的 prompt 列出，明确禁止重复或近似措辞
///   2. **高覆盖**：要求覆盖不同维度（定义 / 应用 / 对比 / 边界 / 易错点 / 推论）
///   3. **答案明确**：每题必须给 answer + rubric（评分点 / 解析）
///   4. **流式友好**：要求**每行一道题**的 JSONL 格式 —— 后端按换行符 partial-parse，
///      第 1 题就能在第 1 秒推到前端，避免等整个 JSON 数组结束。
///
/// `k_idx`：知识点编号，用于生成 q.id（如 "k2q5_extra1"）
/// `k_title`：知识点标题（"闭包的本质"等），用作命题主题
/// `k_body`：知识点正文 markdown（不含 ```quiz``` / ```mindmap``` 围栏），是命题素材
/// `existing_prompts`：已有题目的题面文本列表，用来避免重复
/// `count`：要生成的题数（前端按钮指定，通常 3）
pub fn build_more_quizzes_messages(
    doc_title: &str,
    unit_title: &str,
    k_idx: u32,
    k_title: &str,
    k_body: &str,
    existing_prompts: &[String],
    count: u32,
) -> Vec<Message> {
    let existing_block = if existing_prompts.is_empty() {
        String::from("（本知识点暂无已有题目）")
    } else {
        existing_prompts
            .iter()
            .enumerate()
            .map(|(i, p)| format!("{}. {}", i + 1, p.trim()))
            .collect::<Vec<_>>()
            .join("\n")
    };

    let system = format!(
        r#"你是一名出题专家，正在给学生**针对一个具体知识点**追加 {count} 道高质量练习题。

## 输出格式（**严格 JSONL —— 每行一道题，独立 JSON 对象**）

```
{{"id":"k{k_idx}qE1","type":"choice","prompt":"...","choices":["A. ...","B. ...","C. ...","D. ..."],"answer":"B","rubric":"考察 X 概念。A 错因..., C 错因..., D 错因..."}}
{{"id":"k{k_idx}qE2","type":"short","prompt":"...","answer":"参考答案 30-80 字","rubric":"应包含要点 1 / 要点 2 / 要点 3"}}
{{"id":"k{k_idx}qE3","type":"choice","prompt":"...","choices":[...],"answer":"A","rubric":"..."}}
```

**严格要求**：
- 每行就是一个完整闭合的 JSON 对象，**绝对不要**换行内嵌（不能让一道题跨行）
- **绝对不要**外层数组 `[ ]`、不要 markdown 代码围栏、不要解释性文字
- 第一行就是第一道题的 JSON，最后一行就是最后一道题的 JSON
- 只输出 {count} 行，不多不少

## 题目命名

- id 必须是 `"k{k_idx}qE{{n}}"` 形式（n 从 1 开始递增）
- "qE" 中的 E 表示 Extra（区分于核心题 q1/q2）

## 题型与难度搭配

- {count} 道题中至少 1 道 short（简答），其余可以 choice（4 选 1）
- 选择题干扰项要有迷惑性，不要"明显错"的弱选项
- 难度由浅入深：第 1 题概念回顾，最后 1 题接近知识迁移 / 边界讨论

## **覆盖维度**（这是关键，避免出重复题）

新题必须覆盖以下维度中**不同的几个**（不要全集中在"是什么"）：

1. **定义 / 概念识别**：核心定义、术语区分
2. **应用场景**：什么情况下用、典型用例
3. **对比 / 区分**：与相似概念的差异
4. **机制 / 过程**：内部如何工作、为什么这样设计
5. **边界 / 反例**：何时不适用、容易失效的场景
6. **易错点 / 误解**：常见误用、混淆点
7. **推论 / 迁移**：基于本知识点能推出什么、能解决什么新问题

## 不重复原则（**重中之重**）

下面列出了本知识点已有的题目题面 —— 你的新题**必须避开**这些题面的考察角度：
- 不能问相同问题
- 不能用相同的例子套同样的考点
- 不能只是改了数字 / 换了说法的"换皮题"
- 如果某维度已经被覆盖，**主动选别的维度**出题

## answer / rubric 要求

- **choice 题**：`answer` 填字母 "A" / "B" / "C" / "D"；`rubric` 必须**点出每个选项错在哪**（"B 是对的，因为...; A 错因...; C 错因...; D 错因..."），让学生看到解析就明白
- **short 题**：`answer` 是 30-80 字的参考答案；`rubric` 列出**应包含的 2-3 个要点**（"应包含要点A; 要点B; 不要混淆 X 和 Y"），方便学生自评

记住：JSONL 每行一题，不要外层数组，不要任何 markdown 装饰。"#
    );

    let user = format!(
        r#"## 文档
{doc_title}

## 当前单元
{unit_title}

## 当前知识点
**知识点 {k_idx} · {k_title}**

## 知识点讲解原文（命题素材）
{k_body}

## 本知识点已有的题目题面（**新题必须避开重复 / 近似考点**）
{existing_block}

请按 JSONL 格式输出 {count} 道新题，覆盖不同维度，第一行直接是第一题 JSON。"#,
        k_body = k_body.chars().take(2400).collect::<String>(),
    );

    vec![
        Message { role: "system".into(), content: system },
        Message { role: "user".into(), content: user },
    ]
}

/// 流式累积器：把 token 增量切成"讲解段" + "题目段"。
///
/// 用法：每次拿到 token delta 调 `push`；
/// `push` 返回 `(explanation_delta, questions_done)`：
///   - explanation_delta : 这次新增中**应该渲染为讲解**的部分（可能为空）
///   - questions_done    : 是否已经看到完整 `<<<QUESTIONS>>>` 分隔符
///                          一旦为 true，后续的 token 累积到 questions_buf 不再产生讲解 delta
///
/// 流结束后调 `finish` 拿到 `(explanation_full, questions_json_str)`。
#[allow(dead_code)] // v3: 废弃。粒度更细的 ```quiz``` 抽题请看 extract_quizzes_from_md
#[derive(Default, Debug)]
pub struct TeachStreamSplitter {
    raw: String,
    explanation_end: Option<usize>, // raw 中 explanation 的结尾位置（分隔符之前）
    seen_delimiter: bool,
}

#[allow(dead_code)] // v3: 废弃
impl TeachStreamSplitter {
    pub fn new() -> Self {
        Self::default()
    }

    /// 喂入新 token，返回讲解侧应当追加渲染的增量。
    pub fn push(&mut self, delta: &str) -> String {
        if self.seen_delimiter {
            self.raw.push_str(delta);
            return String::new();
        }
        let prev_len = self.raw.len();
        self.raw.push_str(delta);

        // 在新累积的 raw 中查找分隔符
        if let Some(pos) = self.raw.find(QUESTIONS_DELIMITER) {
            self.seen_delimiter = true;
            self.explanation_end = Some(pos);
            // 讲解段增量 = [prev_len..pos)（仅之前还没暴露的那部分）
            let start = prev_len.min(pos);
            if start < pos {
                return self.raw[start..pos].to_string();
            }
            return String::new();
        }

        // 防御：分隔符可能被切在两个 token 之间。保留尾部 < 分隔符长度 的字符不暴露，
        // 等下一个 delta 再决定。
        let tail_keep = QUESTIONS_DELIMITER.len();
        if self.raw.len() <= tail_keep {
            // 太短，全部 hold 住
            return String::new();
        }
        // 找到一个安全的"暴露上限"：必须在字符边界上。
        let mut safe_end = self.raw.len() - tail_keep;
        while safe_end > prev_len && !self.raw.is_char_boundary(safe_end) {
            safe_end -= 1;
        }
        if safe_end <= prev_len {
            return String::new();
        }
        self.raw[prev_len..safe_end].to_string()
    }

    /// 流结束。返回 (explanation_markdown, questions_raw_str_or_empty)。消费 self。
    pub fn finish(self) -> (String, String) {
        if let Some(end) = self.explanation_end {
            let expl = self.raw[..end].to_string();
            let after = end + QUESTIONS_DELIMITER.len();
            let questions = if after < self.raw.len() {
                self.raw[after..].to_string()
            } else {
                String::new()
            };
            (expl.trim().to_string(), questions.trim().to_string())
        } else {
            (self.raw.trim().to_string(), String::new())
        }
    }

    /// 等价于 `finish` 但不消费 self（在 `Arc<Mutex<Self>>` 模式下，
    /// commands 层无法 `try_unwrap` Arc 时使用）。会取走内部 raw 字符串。
    pub fn take_finish(&mut self) -> (String, String) {
        let raw = std::mem::take(&mut self.raw);
        let end = self.explanation_end;
        if let Some(end) = end {
            let expl = if end <= raw.len() { raw[..end].to_string() } else { raw.clone() };
            let after = end + QUESTIONS_DELIMITER.len();
            let questions = if after < raw.len() { raw[after..].to_string() } else { String::new() };
            (expl.trim().to_string(), questions.trim().to_string())
        } else {
            (raw.trim().to_string(), String::new())
        }
    }
}

/// 解析 questions 字符串为 Value 数组（容错：失败返回空数组）。
/// 支持以下 LLM 输出形态：
///   - 直接 `[...]`
///   - 包了 markdown 代码块：```json [...] ``` 或 ``` [...] ```
#[allow(dead_code)] // v3: 调用点迁到 extract_quizzes_from_md
pub fn parse_questions(raw: &str) -> Vec<Value> {
    let s = raw.trim();
    if s.is_empty() {
        return Vec::new();
    }
    // 尝试剥离 markdown 代码块
    let stripped = if let Some(rest) = s.strip_prefix("```json") {
        rest.trim_start().trim_end_matches("```").trim()
    } else if let Some(rest) = s.strip_prefix("```") {
        rest.trim_start().trim_end_matches("```").trim()
    } else {
        s
    };
    // 找第一个 [
    let lb = stripped.find('[');
    let rb = stripped.rfind(']');
    let json_slice = match (lb, rb) {
        (Some(a), Some(b)) if b > a => &stripped[a..=b],
        _ => stripped,
    };
    serde_json::from_str::<Vec<Value>>(json_slice).unwrap_or_default()
}

// ════════════════════════════════════════════════════════════════════════════
// 3) 简答判分 — 批量 1 req
// ════════════════════════════════════════════════════════════════════════════

pub async fn grade_subjective(
    llm: &LlmClient,
    doc_title: &str,
    items: &[Value],
) -> Result<Vec<Value>, String> {
    if items.is_empty() {
        return Ok(Vec::new());
    }

    let items_json = serde_json::to_string_pretty(items)
        .map_err(|e| format!("序列化判分输入失败: {e}"))?;

    let system = r#"你是一名严格但鼓励性的学习教练，正在批改学生的简答题。
对每道题，根据 rubric（评分要点）和 reference_answer（参考答案）判断学生答案：
- is_correct  : true 如果学生答案抓住了 rubric 中 ≥ 60% 的要点
- score       : 0-100 整数。完全错=0，全对=100，部分给分
- ai_feedback : 1-2 句话点评。先指出对的地方，再点缺漏；不要复述题目；中文输出

严格输出 JSON：
{
  "results": [
    {"question_id": "q2", "is_correct": true, "score": 85, "ai_feedback": "..."}
  ]
}

results 顺序和数量必须与输入完全一致。"#;

    let user = format!(
        r#"## 文档标题
{doc_title}

## 待批改题目（数组）
{items_json}

请输出 JSON。"#,
    );

    let v = llm.chat_json(system, &user, 2).await?;
    let results = v
        .get("results")
        .and_then(|x| x.as_array())
        .cloned()
        .unwrap_or_default();
    Ok(results)
}

// ════════════════════════════════════════════════════════════════════════════
// 工具：从教学包提取 questions / 合并判分结果
// ════════════════════════════════════════════════════════════════════════════

pub fn extract_questions(teach_pack: &Value) -> Vec<Value> {
    teach_pack
        .get("questions")
        .and_then(|x| x.as_array())
        .cloned()
        .unwrap_or_default()
}

/// 提取本单元**所有**题目：核心题（teach_pack.questions）+ 全部知识点的加题
/// （teach_pack.extra_questions[k_idx]，按 k_idx 升序 flatten）。
///
/// 用于单元末统一判分：把"再来 N 道"产生的加题也纳入 LLM 评分流程，结果
/// 持久化到 answers_json，重启 / 翻屏后状态仍在。
///
/// 顺序：先核心题（保持原顺序）→ 再按 k_idx 升序依次拼接 extras。
pub fn extract_all_questions(teach_pack: &Value) -> Vec<Value> {
    let mut out = extract_questions(teach_pack);
    if let Some(extras) = teach_pack
        .get("extra_questions")
        .and_then(|x| x.as_object())
    {
        // 按 k_idx 数字顺序遍历（key 是字符串"0"/"1"/"2"...）
        let mut keys: Vec<&String> = extras.keys().collect();
        keys.sort_by_key(|k| k.parse::<i64>().unwrap_or(i64::MAX));
        for k in keys {
            if let Some(arr) = extras.get(k).and_then(|x| x.as_array()) {
                for q in arr {
                    out.push(q.clone());
                }
            }
        }
    }
    out
}

/// 把判分结果（Vec<Value>）和原 questions 拼成 answers_json 持久化形态。
pub fn merge_grade_results(
    questions: &[Value],
    user_answers: &[(String, String)],
    grade_results: &[Value],
    objective_judgements: &[(String, bool)],
) -> Value {
    let mut out: Vec<Value> = Vec::with_capacity(questions.len());
    for q in questions {
        let qid = q.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string();
        let qtype = q
            .get("type")
            .and_then(|x| x.as_str())
            .unwrap_or("short")
            .to_string();
        let prompt = q
            .get("prompt")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string();
        let user_answer = user_answers
            .iter()
            .find(|(id, _)| id == &qid)
            .map(|(_, a)| a.clone())
            .unwrap_or_default();

        let mut entry = json!({
            "question_id": qid,
            "type": qtype,
            "prompt": prompt,
            "user_answer": user_answer,
            "is_correct": false,
            "score": 0,
            "ai_feedback": "",
        });

        if qtype == "choice" {
            let is_correct = objective_judgements
                .iter()
                .find(|(id, _)| id == &qid)
                .map(|(_, ok)| *ok)
                .unwrap_or(false);
            entry["is_correct"] = json!(is_correct);
            entry["score"] = json!(if is_correct { 100 } else { 0 });
            let correct_letter = q.get("answer").and_then(|x| x.as_str()).unwrap_or("");
            let rubric = q.get("rubric").and_then(|x| x.as_str()).unwrap_or("");
            entry["ai_feedback"] = json!(if is_correct {
                if rubric.is_empty() {
                    "正确".to_string()
                } else {
                    format!("正确。{}", rubric)
                }
            } else if rubric.is_empty() {
                format!("正确答案是 {}", correct_letter)
            } else {
                format!("正确答案是 {}。{}", correct_letter, rubric)
            });
        } else if let Some(g) = grade_results.iter().find(|g| {
            g.get("question_id").and_then(|x| x.as_str()) == Some(qid.as_str())
        }) {
            entry["is_correct"] = g.get("is_correct").cloned().unwrap_or(json!(false));
            entry["score"] = g.get("score").cloned().unwrap_or(json!(0));
            entry["ai_feedback"] = g.get("ai_feedback").cloned().unwrap_or(json!(""));
        }
        out.push(entry);
    }
    Value::Array(out)
}
