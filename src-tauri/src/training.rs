/// 训练模块（DESIGN.md §15 训练板块 v1）
///
/// 与"学习 Agent"模块的关系：
///   - 学习 Agent（agent.rs）：被动学习路线 —— 讲解 → 小测 → 推进
///   - 训练（training.rs）：主动刷题 —— 用户挑题型 → 答题 → 评分 → 技能树升级
///
/// 三个核心数据：
///   1. **技能树**（skill tree）：软件工程预设，硬编码在本文件 SE_SKILL_TREE 常量
///   2. **训练记录**（training_attempts）：每题一行，存答案 + 得分 + 反馈
///   3. **技能掌握度**（skill_mastery）：会话级（每个文档独立），按 skill_id 聚合
///
/// 题型扩展：
///   - choice / short：复用 agent 已有
///   - **code**：代码题，starter_code + tests，走 Piston 真实运行
///   - **debug**：找 bug + 修复，走 Piston 验证
///   - **fill**：填空题（代码 / 文本），LLM 评分
///   - **sequence**：步骤排序题，LLM 评分
use crate::llm::{LlmClient, Message};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

// ════════════════════════════════════════════════════════════════════════════
// 软件工程技能树预设
// ════════════════════════════════════════════════════════════════════════════
//
// 设计原则：
//   - **两层结构**：category (大类) → skills (具体技能)，不超过 3 层避免过度细化
//   - **覆盖软件工程主线**：编程基础 / 数据结构 / 算法 / OOP / 设计模式 / DB / 网络 /
//                         OS / SE / 架构（10 大类）
//   - **每个技能挂关键词**：用于 LLM 出题时从单元 explanation 中匹配 → 自动归类
//   - 用户掌握度：0-1 浮点数；每答对一道关联题 +0.05（封顶 1.0），答错 -0.02（不低于 0）

/// 技能节点定义（前端用）。`mastery` 字段在 DB 查询时填充，常量定义里为 0。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillNode {
    pub id: String,
    pub name: String,
    pub category: String,
    pub description: String,
    /// LLM 出题时用来匹配 explanation 关键词；前端不展示
    pub keywords: Vec<String>,
    /// 难度上限：1-5。这个 skill 的题目难度天花板（前端用于过滤可生成题型）
    pub max_difficulty: u8,
}

/// 软件工程预设技能树。35 个技能，分 10 大类。
/// 覆盖软件工程本科 4 年主线课程的核心知识点。
pub fn se_skill_tree() -> Vec<SkillNode> {
    vec![
        // ─── 编程基础 ───────────────────────────────────────────────
        sk("prog.basics.variables", "变量与类型", "编程基础", "原始类型、复合类型、类型推导", &["变量", "类型", "声明", "类型推导"], 2),
        sk("prog.basics.control-flow", "控制流", "编程基础", "条件、循环、跳转语句", &["if", "else", "while", "for", "break", "continue", "switch", "条件", "循环"], 2),
        sk("prog.basics.functions", "函数与作用域", "编程基础", "函数定义、参数、返回值、闭包、作用域", &["函数", "参数", "返回值", "作用域", "闭包", "function", "lambda"], 3),
        sk("prog.basics.recursion", "递归", "编程基础", "递归思想、终止条件、栈溢出", &["递归", "recursion", "调用栈", "终止条件"], 4),
        sk("prog.basics.error-handling", "异常与错误处理", "编程基础", "异常机制、Result/Option、错误传播", &["异常", "exception", "try", "catch", "Result", "Option", "错误处理"], 3),

        // ─── 数据结构 ────────────────────────────────────────────────
        sk("ds.array", "数组与字符串", "数据结构", "线性表、字符串处理、双指针", &["数组", "array", "字符串", "string", "双指针"], 3),
        sk("ds.linked-list", "链表", "数据结构", "单链表、双链表、循环链表", &["链表", "linked list", "节点", "next", "prev"], 3),
        sk("ds.stack-queue", "栈与队列", "数据结构", "LIFO/FIFO、单调栈、优先队列", &["栈", "stack", "队列", "queue", "优先队列", "LIFO", "FIFO"], 3),
        sk("ds.tree", "树", "数据结构", "二叉树、BST、堆、平衡树、Trie", &["树", "tree", "二叉树", "BST", "堆", "heap", "平衡", "Trie", "前缀树"], 4),
        sk("ds.graph", "图", "数据结构", "图的表示、遍历、最短路径", &["图", "graph", "邻接表", "邻接矩阵", "BFS", "DFS", "最短路径", "Dijkstra"], 5),
        sk("ds.hash", "哈希表", "数据结构", "哈希函数、冲突解决、HashMap/HashSet", &["哈希", "hash", "HashMap", "HashSet", "字典", "散列"], 3),

        // ─── 算法 ─────────────────────────────────────────────────────
        sk("algo.sort", "排序", "算法", "比较排序、非比较排序、稳定性", &["排序", "sort", "快排", "归并", "堆排", "冒泡", "插入"], 3),
        sk("algo.search", "搜索", "算法", "二分、回溯、剪枝", &["搜索", "search", "二分", "binary search", "回溯", "backtracking", "剪枝"], 4),
        sk("algo.dp", "动态规划", "算法", "状态转移、最优子结构、记忆化", &["动态规划", "DP", "状态转移", "记忆化", "最优子结构"], 5),
        sk("algo.greedy", "贪心", "算法", "贪心选择性质、反例", &["贪心", "greedy", "局部最优"], 4),
        sk("algo.divide-conquer", "分治", "算法", "分而治之、主定理", &["分治", "divide", "conquer", "主定理"], 4),
        sk("algo.complexity", "复杂度分析", "算法", "时间复杂度、空间复杂度、大 O", &["复杂度", "complexity", "大O", "Big-O", "时间", "空间"], 3),

        // ─── 面向对象 ─────────────────────────────────────────────────
        sk("oop.encap", "封装", "面向对象", "访问控制、getter/setter、隐藏实现", &["封装", "private", "public", "encapsulation", "访问控制"], 2),
        sk("oop.inherit", "继承与多态", "面向对象", "is-a 关系、虚函数、动态绑定", &["继承", "inherit", "多态", "polymorphism", "override", "虚函数"], 3),
        sk("oop.interface", "接口与抽象类", "面向对象", "interface、abstract、契约式编程", &["接口", "interface", "abstract", "抽象类"], 3),
        sk("oop.solid", "SOLID 原则", "面向对象", "单一职责 / 开闭 / 里氏替换 / 接口隔离 / 依赖倒置", &["SOLID", "单一职责", "开闭", "里氏", "接口隔离", "依赖倒置"], 4),

        // ─── 设计模式 ─────────────────────────────────────────────────
        sk("dp.creational", "创建型模式", "设计模式", "单例、工厂、建造者、原型", &["单例", "singleton", "工厂", "factory", "建造者", "builder", "原型"], 3),
        sk("dp.structural", "结构型模式", "设计模式", "适配器、装饰器、代理、外观", &["适配器", "adapter", "装饰器", "decorator", "代理", "proxy", "外观"], 3),
        sk("dp.behavioral", "行为型模式", "设计模式", "观察者、策略、模板方法、命令", &["观察者", "observer", "策略", "strategy", "模板方法", "命令"], 4),

        // ─── 数据库 ───────────────────────────────────────────────────
        sk("db.sql", "SQL", "数据库", "SELECT/JOIN/聚合、子查询", &["SQL", "SELECT", "JOIN", "WHERE", "GROUP BY", "聚合"], 3),
        sk("db.normalization", "范式与建模", "数据库", "1NF/2NF/3NF/BCNF、ER 模型", &["范式", "1NF", "2NF", "3NF", "BCNF", "ER", "建模"], 4),
        sk("db.index-tx", "索引与事务", "数据库", "B+ 树索引、ACID、隔离级别", &["索引", "index", "B+树", "事务", "transaction", "ACID", "隔离级别"], 4),

        // ─── 计算机网络 ────────────────────────────────────────────────
        sk("net.http", "HTTP / REST", "计算机网络", "请求方法、状态码、REST 架构", &["HTTP", "GET", "POST", "状态码", "REST", "RESTful", "API"], 3),
        sk("net.tcp-ip", "TCP/IP 协议栈", "计算机网络", "三次握手、四次挥手、可靠传输", &["TCP", "IP", "UDP", "三次握手", "四次挥手", "OSI"], 4),

        // ─── 操作系统 ─────────────────────────────────────────────────
        sk("os.process-thread", "进程与线程", "操作系统", "进程切换、线程模型、上下文切换", &["进程", "process", "线程", "thread", "上下文", "PCB"], 4),
        sk("os.concurrency", "并发与同步", "操作系统", "锁、信号量、死锁、协程、async/await", &["并发", "concurrency", "锁", "mutex", "信号量", "semaphore", "死锁", "deadlock", "协程", "coroutine", "async", "await"], 5),
        sk("os.memory", "内存管理", "操作系统", "虚拟内存、分页、堆栈、GC", &["内存", "memory", "虚拟内存", "分页", "page", "堆", "栈", "GC", "垃圾回收"], 4),

        // ─── 软件工程 ─────────────────────────────────────────────────
        sk("se.vcs", "版本控制", "软件工程", "Git 工作流、分支、合并、冲突", &["Git", "branch", "merge", "rebase", "冲突", "版本控制"], 2),
        sk("se.testing", "测试", "软件工程", "单元测试、集成测试、TDD、覆盖率", &["测试", "test", "单元测试", "unit test", "集成测试", "TDD", "覆盖率"], 3),
        sk("se.refactor", "重构与代码质量", "软件工程", "重构手法、坏味道、Code Review", &["重构", "refactor", "代码质量", "code review", "坏味道", "smell"], 4),

        // ─── 架构 ─────────────────────────────────────────────────────
        sk("arch.layered", "分层架构", "架构", "MVC、MVVM、三层架构", &["MVC", "MVVM", "分层", "三层", "controller", "view", "model"], 3),
        sk("arch.distributed", "分布式 / 微服务", "架构", "服务拆分、CAP、消息队列", &["分布式", "distributed", "微服务", "microservice", "CAP", "消息队列", "MQ"], 5),
    ]
}

#[inline]
fn sk(id: &str, name: &str, category: &str, desc: &str, keywords: &[&str], max_diff: u8) -> SkillNode {
    SkillNode {
        id: id.to_string(),
        name: name.to_string(),
        category: category.to_string(),
        description: desc.to_string(),
        keywords: keywords.iter().map(|s| s.to_string()).collect(),
        max_difficulty: max_diff,
    }
}

/// 从一段文本（如单元 explanation）中匹配出关联的 skill ids。
/// 简单关键词匹配（不区分大小写），命中即算关联。
pub fn match_skills(text: &str) -> Vec<String> {
    let text_lc = text.to_lowercase();
    let mut hits = Vec::new();
    for skill in se_skill_tree() {
        for kw in &skill.keywords {
            if text_lc.contains(&kw.to_lowercase()) {
                hits.push(skill.id.clone());
                break; // 一个 skill 命中即可，不重复
            }
        }
    }
    hits
}

// ════════════════════════════════════════════════════════════════════════════
// Piston 代码运行（可配置 endpoint）
// ════════════════════════════════════════════════════════════════════════════
//
// API 文档：https://piston.readthedocs.io/en/latest/api-v2/
//
// v6 (2026-05) #3++ 修订（emkc.org 公共 API 2026/2/15 起改为白名单 → 401）：
//   endpoint 改成由调用方传入（从 app_prefs `code_runner.endpoint` 读取）。
//   默认值 = 空字符串，让 command 层负责给出明确"未配置"错误，引导用户去设置面板填。
//
// 推荐配置：
//   1. **自部署 Piston**（强烈推荐，零成本零限速）
//      docker run -d --rm -p 2000:2000 ghcr.io/engineer-man/piston
//      endpoint = http://localhost:2000/api/v2/execute
//   2. 社区维护的公共节点（不稳定，且很多已下线 / 加白名单）
//
// Request:
//   {
//     "language": "python",
//     "version": "3.10.0",   // 可选，省略用最新
//     "files": [{"name": "main.py", "content": "print('hi')"}],
//     "stdin": "",
//     "args": [],
//     "compile_timeout": 10000,  // ms
//     "run_timeout": 10000        // ms
//   }
//
// Response:
//   {
//     "language": "python",
//     "version": "3.10.0",
//     "run": { "stdout": "hi\n", "stderr": "", "code": 0, "signal": null, "output": "hi\n" },
//     "compile": { ... } // 仅编译型语言
//   }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodeRunResult {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub time_ms: u64,
    pub language: String,
    pub version: Option<String>,
    /// 是否走了 fallback（Piston 不可用时由 LLM 模拟评分）。前端用来加提示文案
    pub fallback_used: bool,
}

/// 判断 endpoint 的 host 是否是 localhost / loopback / 私网地址（用来决定要不要绕过代理）
fn endpoint_is_localhost_or_private(endpoint: &str) -> bool {
    // 简单解析：找 "://" 之后第一个 '/'  或 '?' 之前那段，再去掉 ":port"
    let after_scheme = endpoint.split("://").nth(1).unwrap_or(endpoint);
    let host_with_port = after_scheme
        .split(|c: char| c == '/' || c == '?' || c == '#')
        .next()
        .unwrap_or("");
    // 去掉 :port（注意 IPv6 [::1]:2000 形式）
    let host = if let Some(stripped) = host_with_port.strip_prefix('[') {
        // [IPv6]:port → 取 ']' 之前
        stripped.split(']').next().unwrap_or("")
    } else {
        // 普通 host:port → 取 ':' 之前
        host_with_port.split(':').next().unwrap_or("")
    };
    let h = host.to_lowercase();
    if h == "localhost" || h == "::1" || h == "0.0.0.0" {
        return true;
    }
    // IPv4 解析
    if let Ok(ip) = h.parse::<std::net::Ipv4Addr>() {
        return ip.is_loopback() || ip.is_private() || ip.is_link_local();
    }
    // IPv6
    if let Ok(ip) = h.parse::<std::net::Ipv6Addr>() {
        return ip.is_loopback();
    }
    false
}

/// 把 execute endpoint（`.../api/v2/execute`）转成 runtimes endpoint（`.../api/v2/runtimes`）。
fn execute_to_runtimes_endpoint(execute_endpoint: &str) -> String {
    if let Some(idx) = execute_endpoint.rfind("/execute") {
        return format!("{}/runtimes", &execute_endpoint[..idx]);
    }
    // 兜底：保持原 endpoint —— 调用方会在 HTTP 失败时报错
    execute_endpoint.to_string()
}

/// 解析 Piston 已安装的精确语言版本（用于 execute 端点 —— 它不接受 `*` / 缺省）。
///
/// 流程：GET /api/v2/runtimes → 找 `language` 或其 alias 匹配 `target_lang` 的项 → 取 `version`。
/// 找不到 = 该语言没装；返回带操作指引的 Err。
async fn resolve_installed_version(
    client: &reqwest::Client,
    execute_endpoint: &str,
    target_lang: &str,
) -> Result<String, String> {
    let url = execute_to_runtimes_endpoint(execute_endpoint);
    let resp = client.get(&url).send().await.map_err(|e| {
        format!("查询已装语言列表失败（{url} 不可达）：{e}\n（这一步是为了把 version=\"*\" 解析成精确版本号 —— Piston execute 端点不接受通配。）")
    })?;
    if !resp.status().is_success() {
        let status = resp.status();
        let txt = resp.text().await.unwrap_or_default();
        return Err(format!("查询 /runtimes 返回 {}: {}", status, txt));
    }
    let arr: Vec<Value> = resp
        .json()
        .await
        .map_err(|e| format!("解析 /runtimes 响应失败：{e}"))?;

    // 匹配规则：language 字段 == target_lang，或 aliases 数组里包含 target_lang
    let target_l = target_lang.to_lowercase();
    let matched = arr.iter().find(|rt| {
        let lang = rt.get("language").and_then(|x| x.as_str()).unwrap_or("").to_lowercase();
        if lang == target_l {
            return true;
        }
        rt.get("aliases")
            .and_then(|x| x.as_array())
            .map(|aliases| {
                aliases
                    .iter()
                    .any(|a| a.as_str().map(|s| s.to_lowercase()) == Some(target_l.clone()))
            })
            .unwrap_or(false)
    });

    match matched {
        Some(rt) => {
            let v = rt.get("version").and_then(|x| x.as_str()).unwrap_or("");
            if v.is_empty() {
                Err(format!(
                    "Piston 已装 {target_lang} 但没返回版本号。/runtimes 响应：{rt}",
                    rt = serde_json::to_string(rt).unwrap_or_default()
                ))
            } else {
                Ok(v.to_string())
            }
        }
        None => {
            // 列出已装的语言名,帮用户判断要装什么
            let installed: Vec<String> = arr
                .iter()
                .filter_map(|rt| rt.get("language").and_then(|x| x.as_str()).map(String::from))
                .collect();
            let hint = if installed.is_empty() {
                "（容器内尚未安装任何语言）".to_string()
            } else {
                format!("（已装：{}）", installed.join(", "))
            };
            Err(format!(
                "Piston 容器内未安装 `{target_lang}` 运行时。{hint}\n\
                 请到「设置 → 代码运行」点对应语言按钮安装。"
            ))
        }
    }
}

/// 调 Piston endpoint 跑代码。失败（网络 / 超时 / 5xx）返回 Err，调用方决定是否 fallback。
///
/// `endpoint` 必须是完整的 execute URL，例如：
///   - 自部署：`http://localhost:2000/api/v2/execute`
///   - 公共节点：`https://<host>/api/v2/piston/execute`（如有可用的）
pub async fn piston_execute(
    endpoint: &str,
    language: &str,
    source: &str,
    stdin: &str,
    version: Option<&str>,
) -> Result<CodeRunResult, String> {
    if endpoint.trim().is_empty() {
        return Err(
            "尚未配置代码运行 endpoint。请到「设置 → 代码运行」填写 Piston endpoint URL。\n\
             推荐自部署：\n  \
             docker run -d --rm -p 2000:2000 ghcr.io/engineer-man/piston\n  \
             然后 endpoint 填 http://localhost:2000/api/v2/execute"
                .to_string(),
        );
    }
    let started = std::time::Instant::now();

    // 文件名按语言推导（Piston 要求要有合法文件名扩展）
    let filename = match language {
        "python" => "main.py",
        "javascript" | "node" => "main.js",
        "typescript" => "main.ts",
        "rust" => "main.rs",
        "java" => "Main.java",
        "c" => "main.c",
        "cpp" | "c++" => "main.cpp",
        "go" => "main.go",
        "ruby" => "main.rb",
        "kotlin" => "main.kt",
        "swift" => "main.swift",
        "csharp" | "c#" => "Main.cs",
        _ => "main.txt",
    };
    // Piston 用的语言别名规范化
    let lang_normalized = match language {
        "node" | "js" => "javascript",
        "ts" => "typescript",
        "c++" => "cpp",
        "c#" => "csharp",
        other => other,
    };

    // v6 (2026-05) #3++ 修订：localhost / 私网 endpoint 必须禁用系统代理
    //   原因：reqwest 默认读 Windows 注册表 / HTTP(S)_PROXY env，
    //   走系统代理（clash / v2rayN 等）会把 localhost:2000 转给代理，代理处理失败 → 502 / 连接拒绝。
    //   表现：`error sending request for url (http://localhost:2000/...)`
    let is_local = endpoint_is_localhost_or_private(endpoint);
    let mut builder = reqwest::Client::builder().timeout(std::time::Duration::from_secs(25));
    if is_local {
        builder = builder.no_proxy();
    }
    let client = builder
        .build()
        .map_err(|e| format!("HTTP client 构造失败: {}", e))?;

    // 决定要发给 execute 的 version：
    //   - 用户显式指定（且不是 "*"）→ 直接用
    //   - 否则 → 调 /runtimes 找该语言已装的精确版本号（execute 端点不接受 "*"，
    //     会回 400 "<lang>-* runtime is unknown"）。找不到 = 该语言没装，明确报错。
    let resolved_version = match version {
        Some(v) if !v.is_empty() && v != "*" => v.to_string(),
        _ => resolve_installed_version(&client, endpoint, lang_normalized).await?,
    };

    let body = json!({
        "language": lang_normalized,
        "version": resolved_version,
        "files": [{ "name": filename, "content": source }],
        "stdin": stdin,
        // Piston 容器内置上限（默认 PISTON_COMPILE_TIMEOUT=10000 / PISTON_RUN_TIMEOUT=3000）。
        // 我们要 ≤ 容器上限，否则 Piston 会回 400 "<x>_timeout cannot exceed the configured limit of N"。
        // 默认容器没设 env → 上限就是默认值（3s 运行 / 10s 编译）。
        // 想跑更长的题目，要么重建容器加 env（见 runtime::piston_run_args），要么前端按情况降低这俩。
        "compile_timeout": 10000,
        "run_timeout": 3000,
    });

    let resp = client
        .post(endpoint)
        .json(&body)
        .send()
        .await
        .map_err(|e| {
            let mut hint = String::new();
            // reqwest::Error 自带分类
            if e.is_connect() {
                hint.push_str("\n常见原因：\n  · Piston 容器没有运行（请到「设置 → 代码运行」检查容器状态）\n  · 端口 2000 被其他程序占用 / 被防火墙挡住");
            } else if e.is_request() && is_local {
                hint.push_str("\n常见原因（localhost endpoint）：\n  · 系统代理拦截了 localhost 流量（reqwest 已禁用代理，仍失败可能是 socket 层问题）");
            } else if !is_local {
                hint.push_str("\n常见原因：\n  · 网络问题 / DNS 解析失败 / TLS 握手失败");
            }
            format!("Piston 请求失败（{endpoint} 不可达）: {}{hint}", e)
        })?;

    let status = resp.status();
    if !status.is_success() {
        let txt = resp.text().await.unwrap_or_default();
        // 401 一般是公共节点白名单 / 私有节点 token 错。给用户明确提示
        if status.as_u16() == 401 {
            return Err(format!(
                "Piston 返回 401 Unauthorized：该节点已限制访问（emkc 公共 API 已于 2026/2/15 改为白名单）。\n\
                 请到「设置 → 代码运行」更换 endpoint，推荐自部署：\n  \
                 docker run -d --rm -p 2000:2000 ghcr.io/engineer-man/piston\n  \
                 然后 endpoint 填 http://localhost:2000/api/v2/execute\n\n\
                 原始响应：{txt}"
            ));
        }
        return Err(format!("Piston 返回 {}: {}", status, txt));
    }

    let json_body: Value = resp.json().await.map_err(|e| format!("Piston 响应非 JSON: {}", e))?;
    // run 段是必有的；compile 段（如果存在）失败也算运行失败
    let run = json_body.get("run").cloned().unwrap_or(json!({}));
    let compile = json_body.get("compile").cloned().unwrap_or(Value::Null);

    let mut stdout = run.get("stdout").and_then(|x| x.as_str()).unwrap_or("").to_string();
    let mut stderr = run.get("stderr").and_then(|x| x.as_str()).unwrap_or("").to_string();
    let exit_code = run.get("code").and_then(|x| x.as_i64()).map(|x| x as i32);
    // v9 (2026-05) 新增：信号字段（如 "SIGKILL" 超时被杀）
    //   Piston 容器里 PISTON_RUN_TIMEOUT 触发时进程会被 SIGKILL，这时 stderr/stdout 可能为空
    //   仅 signal 有值。如果有信号信息就 prepend 到 stderr，让用户知道为什么没输出。
    let signal = run.get("signal").and_then(|x| x.as_str()).unwrap_or("").to_string();
    if !signal.is_empty() {
        let hint = match signal.as_str() {
            "SIGKILL" => "进程被强制终止（SIGKILL）—— 通常是运行超时（默认 3 秒）或内存超限。",
            "SIGTERM" => "进程被请求终止（SIGTERM）。",
            "SIGSEGV" => "进程发生段错误（SIGSEGV）—— 通常是访问非法内存。",
            "SIGABRT" => "进程异常终止（SIGABRT）—— 通常是 assert 失败 / abort()。",
            _ => "进程被信号终止。",
        };
        let line = format!("[运行被信号 {} 终止] {}", signal, hint);
        stderr = if stderr.is_empty() {
            line
        } else {
            format!("{}\n{}", line, stderr)
        };
    }

    // v9 (2026-05) 兜底：某些语言/Piston 版本把所有输出（包括 traceback / panic 信息）
    //   一股脑塞进 run.output 字段（按时序混合 stdout + stderr），单独的 stdout/stderr
    //   是空的。这种情况下 stdout 和 stderr 都为空但 output 有内容 —— 用户会看到"无任何输出"
    //   误以为代码没运行。把 output 作为兜底放到 stderr 区让用户能看到。
    let output = run.get("output").and_then(|x| x.as_str()).unwrap_or("").to_string();
    if stdout.is_empty() && stderr.is_empty() && !output.is_empty() {
        stderr = format!("[Piston output 兜底]\n{}", output);
    }

    // 如果有编译阶段且失败，把编译输出合并到 stderr
    if let Some(compile_obj) = compile.as_object() {
        let c_code = compile_obj.get("code").and_then(|x| x.as_i64()).unwrap_or(0);
        if c_code != 0 {
            let c_stderr = compile_obj.get("stderr").and_then(|x| x.as_str()).unwrap_or("");
            let c_stdout = compile_obj.get("stdout").and_then(|x| x.as_str()).unwrap_or("");
            if !c_stderr.is_empty() {
                stderr = format!("[编译错误]\n{}\n{}", c_stderr, stderr);
            }
            if !c_stdout.is_empty() {
                stdout = format!("[编译输出]\n{}\n{}", c_stdout, stdout);
            }
        }
    }

    let success = exit_code == Some(0) && stderr.is_empty() && signal.is_empty();
    let elapsed_ms = started.elapsed().as_millis() as u64;

    Ok(CodeRunResult {
        success,
        stdout,
        stderr,
        exit_code,
        time_ms: elapsed_ms,
        language: json_body.get("language").and_then(|x| x.as_str()).unwrap_or(language).to_string(),
        version: json_body.get("version").and_then(|x| x.as_str()).map(|s| s.to_string()),
        fallback_used: false,
    })
}

// ════════════════════════════════════════════════════════════════════════════
// LLM 训练题生成
// ════════════════════════════════════════════════════════════════════════════

/// 训练题集生成 prompt。
///
/// `material`：命题素材（单元 explanation 或多个知识点的 body 拼接）
/// `types`：要生成的题型集合（"choice" / "short" / "code" / "debug" / "fill" / "sequence"）
/// `count`：总题数
/// `difficulty`：1-5，决定题目深度
/// `language`：代码题语言（可选，仅 code/debug 类型使用）
pub fn build_training_pack_messages(
    doc_title: &str,
    unit_title: Option<&str>,
    material: &str,
    types: &[String],
    count: u32,
    difficulty: u8,
    language: Option<&str>,
) -> Vec<Message> {
    let lang = language.unwrap_or("python");
    let types_block = types.join(" / ");
    let diff_label = match difficulty {
        1 => "极简（概念识别）",
        2 => "入门（基本应用）",
        3 => "中等（综合理解）",
        4 => "进阶（深度推理）",
        5 => "挑战（迁移创新）",
        _ => "中等",
    };

    let system = format!(
        r#"你是一名计算机科学训练教练，要给软件工程学生生成**针对性训练题集**。

## 输出格式（**严格 JSON 数组**，每题一个对象）

```json
[
  {{
    "id": "tq1",
    "type": "choice",
    "skills": ["ds.array"],
    "difficulty": 2,
    "prompt": "题面...",
    "choices": ["A. ...", "B. ...", "C. ...", "D. ..."],
    "answer": "B",
    "rubric": "考察 X。A 错因..., C 错因..., D 错因..."
  }},
  {{
    "id": "tq2",
    "type": "code",
    "skills": ["algo.sort", "ds.array"],
    "difficulty": 3,
    "language": "{lang}",
    "prompt": "实现一个函数 ...",
    "starter_code": "def solve(arr):\n    # TODO: 实现\n    pass\n\nif __name__ == '__main__':\n    print(solve([3, 1, 2]))",
    "tests": [
      {{ "stdin": "", "expected_stdout": "[1, 2, 3]\n", "description": "基础升序" }},
      {{ "stdin": "", "expected_stdout": "[]\n", "description": "空数组" }}
    ],
    "answer": "def solve(arr):\n    return sorted(arr)\n...",
    "rubric": "应实现升序排序；处理空数组；时间复杂度 O(n log n)"
  }},
  {{
    "id": "tq3",
    "type": "debug",
    "skills": ["prog.basics.recursion"],
    "difficulty": 3,
    "language": "{lang}",
    "prompt": "下面的递归求阶乘代码有 bug，找出并修复。",
    "starter_code": "def factorial(n):\n    if n == 0:\n        return 0  # ← bug 在这\n    return n * factorial(n - 1)",
    "tests": [
      {{ "stdin": "", "expected_stdout": "120\n", "description": "factorial(5)" }}
    ],
    "answer": "把 return 0 改成 return 1（0! = 1）。",
    "rubric": "要识别基线情况错误；修复后通过所有测试用例"
  }},
  {{
    "id": "tq4",
    "type": "fill",
    "skills": ["prog.basics.variables"],
    "difficulty": 1,
    "prompt": "Rust 中无符号 8 位整数的最大值是 ___。",
    "answer": "255",
    "rubric": "u8 范围 0-255"
  }},
  {{
    "id": "tq5",
    "type": "sequence",
    "skills": ["se.vcs"],
    "difficulty": 2,
    "prompt": "下面是 Git 提交流程，请按正确顺序排列：",
    "choices": ["git push", "git add .", "git commit -m \"...\"", "修改文件"],
    "answer": "修改文件 -> git add . -> git commit -m \"...\" -> git push",
    "rubric": "完整 Git 工作流标准顺序"
  }},
  {{
    "id": "tq6",
    "type": "short",
    "skills": ["algo.complexity"],
    "difficulty": 2,
    "prompt": "用一句话解释为什么二分查找的时间复杂度是 O(log n)。",
    "answer": "每次比较把搜索范围减半，n 规模需 log2(n) 次操作。",
    "rubric": "应包含：① 减半 ② 对数关系 ③ 与线性查找对比"
  }}
]
```

## 题目要求

- 总数：{count} 道，**严格按照**用户要求的题型分布（types: {types_block}）
- 难度：{diff_label}（difficulty 字段填 {difficulty}）
- 每题必须有 `id` (`tq1`, `tq2`...) / `type` / `skills` (1-3 个 skill id) / `difficulty` / `prompt` / `answer` / `rubric`
- **code / debug 题**：必须有 `language` / `starter_code` / `tests`（至少 2 个测试用例）；`answer` 是参考实现
  - **`starter_code` 必须可直接运行（不能仅给空函数）**：
    - 必须包含顶层调用入口（如 Python `if __name__ == '__main__': ...` / C++ `int main() {{ ... }}` / Rust `fn main() {{ ... }}`）
    - 入口里必须有至少一处 `print` / `console.log` / `println!` 等输出语句，让用户即使只跑骨架也能看到运行轨迹
    - 函数体可以用 `# TODO` + `pass` / 占位 return 让用户填空，但**入口和打印不能省**
    - 反例（绝对禁止）：只给 `def producer(): pass\ndef consumer(): pass` 而无任何调用 → 跑出来 stdout/stderr 都是空，用户无从下手
  - `tests` 的 `expected_stdout` 必须与上面 starter_code 入口跑出的实际输出**一致**（用户填完逻辑后才能匹配）
- **choice 题**：必须有 `choices` (4 项); `answer` 是字母 A/B/C/D
- **fill 题**：`prompt` 用 `___` 表示空；`answer` 是填入内容（可以是单词 / 数字 / 短语）
- **sequence 题**：`choices` 是乱序的步骤列表；`answer` 是用 ` -> ` 连接的正确顺序
- **short 题**：`prompt` 提开放性问题；`answer` 是 30-100 字参考回答

## skills 字段（v4 自由命名规则）

- 不再有固定枚举 —— 你可以**根据当前学习材料自由命名** skill_id（最多 3 个/题，由"最相关"到"次要"）
- skill_id 规则：
  - 全小写 + 点分层级，如 `frontend.react.hooks` / `algo.dp.knapsack` / `db.indexing.btree`
  - 只用字母 / 数字 / 点 / 短横，不要中文 / 空格 / 下划线
  - 同主题的不同题应共用同一个 skill_id（如三道 hooks 题都用 `frontend.react.hooks`）
- 在题目数组**之外**，请额外提供一个 `skill_meta` 字段，描述本次新出现的 skill_id：

```json
{{
  "questions": [ /* 上面的题目数组 */ ],
  "skill_meta": {{
    "frontend.react.hooks": {{ "name": "React Hooks", "category": "前端", "description": "useState / useEffect / 自定义 Hooks 等" }},
    "algo.dp.knapsack": {{ "name": "背包动规", "category": "算法", "description": "0-1 / 完全背包 / 状态压缩等变体" }}
  }}
}}
```

- skill_meta 让用户在"技能树管理"页能看到中文显示名；如果你**不确定**某个 skill 的描述，可以不放 skill_meta，后端会用 skill_id 默认填充
- **不要**强行套用别人的 skill_id —— 内容是哪科就命名哪科

## 输出严格性

- 顶层是 JSON **对象**：`{{ "questions": [...], "skill_meta": {{...}} }}`
- 第一个字符必须是 `{{`，最后一个字符必须是 `}}`
- **绝对不要**用 markdown 代码围栏 `````json`，**绝对不要**外层加任何说明文字
- JSON 内部字符串可用 `\n` 表示换行（不要真换行，避免 JSON parse 失败）
- 不要输出注释、不要输出"以下是题目..."之类的解释

记住：你的回复就是一个纯 JSON 对象，其他什么都不要。"#
    );

    let unit_block = unit_title
        .map(|t| format!("\n## 当前单元\n{}\n", t))
        .unwrap_or_default();

    let user = format!(
        r#"## 文档
{doc_title}
{unit_block}
## 命题素材
{material}

## 学生要求
- 题型：{types_block}
- 题数：{count} 道
- 难度：{diff_label}（difficulty = {difficulty}）
- 代码题语言：{lang}

请按 JSON 数组格式输出，第一个字符就是 `[`。"#,
        material = material.chars().take(3500).collect::<String>(),
    );

    vec![
        Message { role: "system".into(), content: system },
        Message { role: "user".into(), content: user },
    ]
}

/// 训练题评分 prompt。
///
/// 给一道题 + 学生答案 + 代码运行结果（可选），让 LLM 输出：
///   { "score": 0-100, "is_correct": bool, "feedback": "...", "missed_points": ["...", "..."] }
pub fn build_training_grade_messages(
    question: &Value,
    user_answer: &str,
    code_result: Option<&CodeRunResult>,
) -> Vec<Message> {
    let q_type = question.get("type").and_then(|x| x.as_str()).unwrap_or("short");
    let prompt = question.get("prompt").and_then(|x| x.as_str()).unwrap_or("");
    let reference = question.get("answer").and_then(|x| x.as_str()).unwrap_or("");
    let rubric = question.get("rubric").and_then(|x| x.as_str()).unwrap_or("");

    let code_block = if let Some(r) = code_result {
        format!(
            r#"
## 代码运行结果（来自 Piston 真实执行）
- 是否成功：{}
- exit_code：{:?}
- stdout：
```
{}
```
- stderr：
```
{}
```
"#,
            if r.success { "✅ 通过" } else { "❌ 失败" },
            r.exit_code,
            r.stdout.chars().take(800).collect::<String>(),
            r.stderr.chars().take(800).collect::<String>(),
        )
    } else {
        String::new()
    };

    let tests_block = question.get("tests").and_then(|x| x.as_array()).map(|tests| {
        let lines: Vec<String> = tests.iter().enumerate().map(|(i, t)| {
            let desc = t.get("description").and_then(|x| x.as_str()).unwrap_or("");
            let stdin = t.get("stdin").and_then(|x| x.as_str()).unwrap_or("");
            let expected = t.get("expected_stdout").and_then(|x| x.as_str()).unwrap_or("");
            format!("用例 {}: {}\n  stdin: {}\n  expected_stdout: {}", i + 1, desc, stdin, expected)
        }).collect();
        format!("\n## 测试用例\n{}", lines.join("\n"))
    }).unwrap_or_default();

    let system = r#"你是一名严格但公正的训练评分员。

## 输出格式（**严格 JSON 对象**）

```json
{
  "score": 85,
  "is_correct": true,
  "feedback": "答案基本正确。优点：你抓住了 X；改进：可以补充 Y。",
  "missed_points": ["未提到时间复杂度", "边界情况处理欠缺"]
}
```

## 评分原则

- score：0-100 整数。≥ 80 = is_correct=true；< 80 = is_correct=false
- choice 题：答对就 100 分；答错就 0 分；不存在中间分
- fill 题：完全匹配（忽略大小写 / 空格）= 100；同义词 / 等价表达 = 80-95；错 = 0
- short 题：按 rubric 给的"应包含要点"逐点评分；少一个扣 20-30 分
- code/debug 题：
  - 如果有"代码运行结果"且 success=true：基础 70 分起；再看代码风格 / 边界处理 / 复杂度加分到 100
  - 如果 success=false：从 stderr 找具体错误点；给 0-50 分（看接近正确的程度）；feedback 必须**指出错在哪行 / 哪个概念**
- sequence 题：完全顺序对 = 100；错 1 步 = 60；错 2 步及以上 = 30；颠倒 = 0

## feedback 风格

- 简洁直接，60-150 字
- 先说"对的部分"再说"差的部分"（前提是有对的部分）
- code 题：必须**点出具体改进方向**（如"递归基线应该返回 1 而不是 0"），而不是泛泛说"代码有问题"

## 输出严格性

- 第一个字符必须是 `{`，最后一个字符必须是 `}`
- 不要 markdown 围栏，不要解释性文字
- missed_points 数组可以为空（学生答对时）"#;

    let user = format!(
        r#"## 题目类型
{q_type}

## 题目
{prompt}
{tests_block}

## 参考答案
{reference}

## 评分细则
{rubric}

## 学生答案
{user_answer}
{code_block}

请按 JSON 格式输出评分结果，第一个字符就是 `{{`。"#,
    );

    vec![
        Message { role: "system".into(), content: system.to_string() },
        Message { role: "user".into(), content: user },
    ]
}

/// 抽取 LLM 评分输出 → 结构化字段。LLM 输出鲁棒处理：
///   - 优先解析 JSON
///   - 失败时尝试摘 ```json``` 围栏
///   - 再失败返回默认（score=50, feedback="解析失败"）
pub fn parse_grade_output(raw: &str) -> Value {
    let txt = raw.trim();
    // 直接解析
    if let Ok(v) = serde_json::from_str::<Value>(txt) {
        if v.is_object() {
            return v;
        }
    }
    // 摘 ```json``` 围栏
    if let Some(start) = txt.find("```json").or_else(|| txt.find("```")) {
        let after = &txt[start..];
        if let Some(end) = after[3..].find("```") {
            let inner = &after[3..3 + end];
            // 跳过可选的 "json\n"
            let cleaned = inner.trim_start_matches("json").trim();
            if let Ok(v) = serde_json::from_str::<Value>(cleaned) {
                if v.is_object() {
                    return v;
                }
            }
        }
    }
    // 摘 { 到 } 之间最大块
    if let (Some(first), Some(last)) = (txt.find('{'), txt.rfind('}')) {
        if last > first {
            let candidate = &txt[first..=last];
            if let Ok(v) = serde_json::from_str::<Value>(candidate) {
                if v.is_object() {
                    return v;
                }
            }
        }
    }
    // 兜底
    json!({
        "score": 50,
        "is_correct": false,
        "feedback": format!("评分解析失败（LLM 输出非 JSON）。原始输出: {}", txt.chars().take(200).collect::<String>()),
        "missed_points": [],
    })
}

// v5 (2026-05) B2: 学习单元自动出题 prompt（LLM 自主决定题型分布）
//
// 与 build_training_pack_messages 的关键差异：
//   - 不要求用户指定 types，由 LLM 根据材料内容自主选题型
//   - 明确"非编程内容禁止 code/debug，编程内容可以全是 code"
//   - 用于 agent_teach_unit_stream done 后的异步生成（学习↔训练同步）
pub fn build_unit_auto_pack_messages(
    doc_title: &str,
    unit_title: &str,
    explanation: &str,
    count: u32,
    difficulty: u8,
) -> Vec<Message> {
    let diff_label = match difficulty {
        1 => "极简（概念识别）",
        2 => "入门（基本应用）",
        3 => "中等（综合理解）",
        4 => "进阶（深度推理）",
        5 => "挑战（迁移创新）",
        _ => "中等",
    };

    let system = format!(
        r#"你是一名教学训练教练，要根据学生刚学完的**单元讲解**，设计一组配套训练题。

## 输出格式（**严格 JSON 对象**）

```json
{{
  "questions": [
    {{ "id": "tu1", "type": "choice", "skills": [...], "difficulty": 2, "prompt": "...", "choices": [...], "answer": "B", "rubric": "..." }},
    {{ "id": "tu2", "type": "code", "skills": [...], "difficulty": 3, "language": "python", "prompt": "...", "starter_code": "...", "tests": [...], "answer": "...", "rubric": "..." }},
    ...
  ],
  "skill_meta": {{
    "<skill_id>": {{ "name": "...", "category": "...", "description": "..." }}
  }}
}}
```

## 核心原则（v5 B2 自动模式）

1. **题型由你根据材料决定**，不再由用户预先指定。可选题型：`choice` / `short` / `code` / `debug` / `fill` / `sequence`
2. **代码题判定规则（重要）**：
   - 若讲解材料**包含**代码、伪代码、算法描述、API 用法、编程概念 → 应该出 1-3 道 `code`/`debug` 题
   - 若讲解材料**完全不涉及编程**（如纯文学、历史、哲学、自然科学概念） → **绝对不要**出 `code`/`debug` 题
   - 介于两者之间（如计算机理论但无具体代码）→ 可以选择性出 1 道 `code` 验证理解
3. **分布建议**（总 {count} 道）：
   - 编程类材料：约 1 道 choice + 1 道 short + 1-2 道 code + 1 道 fill / sequence
   - 非编程材料：约 2-3 道 choice + 2-3 道 short + 1 道 fill
4. **难度**：所有题目 difficulty = {difficulty}（{diff_label}）

## 题型字段约束

- `id`: `tu1` / `tu2` / ... 顺序编号
- `skills`: 1-3 个 skill_id（自由命名，规则：小写 + 点分层级，如 `react.hooks` / `algo.dp` / `lit.metaphor`）
- `prompt`: 题面（可包含代码块、公式、表格）
- `answer`: 参考答案
- `rubric`: 评分要点（评分 LLM 会用，描述"应该考察什么 / 常见错误"）
- **code / debug 题专属**：`language` (默认 python) + `starter_code` + `tests`（至少 2 个 stdin/expected_stdout）
  - **`starter_code` 必须可直接运行**：包含顶层入口（Python `if __name__ == '__main__': ...` / C++ `int main()` / Rust `fn main()`）+ 至少一处 print/console.log/println 输出语句
  - 函数体可用 `# TODO + pass` 占位让用户填，但**入口和打印不能省**——否则用户运行后 stdout/stderr 全空无从调试
  - `tests.expected_stdout` 应与"用户正确填完逻辑后入口跑出的实际输出"一致
- **choice 题**：`choices` (4 项 A/B/C/D) + `answer` 字母
- **fill 题**：`prompt` 用 `___` 表示空 + `answer` 填入内容
- **sequence 题**：`choices` 乱序步骤 + `answer` 用 ` -> ` 连接正确顺序

## skill_meta 字段

- 顶层 `skill_meta` 对象（可省）：描述本次新出现的 skill_id 的中文显示名
- 例：`{{ "react.hooks": {{ "name": "React Hooks", "category": "前端", "description": "useState/useEffect/自定义 Hooks" }} }}`

## 输出严格性

- 顶层是 JSON **对象**：`{{ "questions": [...], "skill_meta": {{...}} }}`
- 第一个字符 `{{`，最后一个字符 `}}`
- **绝对不要** markdown 代码围栏，**绝对不要**外层说明文字
- 字符串内换行用 `\n`（避免真换行破坏 JSON）

记住：你的回复就是一个纯 JSON 对象，其他什么都不要。"#
    );

    let user = format!(
        r#"## 文档
{doc_title}

## 当前单元
{unit_title}

## 单元讲解（命题依据）
{explanation}

## 任务
基于上面**单元讲解**的内容，自主判断该出什么题型（参考核心原则 §2 代码题判定规则），生成 {count} 道训练题。

请直接输出纯 JSON 对象，第一个字符就是 `{{`。"#,
        explanation = explanation.chars().take(3500).collect::<String>(),
    );

    vec![
        Message { role: "system".into(), content: system },
        Message { role: "user".into(), content: user },
    ]
}

/// 学习单元自动出题：基于单元 explanation 生成训练 pack（LLM 自主决定题型）。
///
/// 与 `generate_training_pack` 的区别：
///   - 用 `build_unit_auto_pack_messages` 而非 `build_training_pack_messages`
///   - LLM 自主决定题型分布（含代码题判定）
///   - 失败回退：返回空 pack 而非 Err（避免阻塞学习流）
pub async fn generate_unit_auto_pack(
    llm: &LlmClient,
    doc_title: &str,
    unit_title: &str,
    explanation: &str,
    count: u32,
    difficulty: u8,
) -> Result<GeneratedPack, String> {
    let messages = build_unit_auto_pack_messages(doc_title, unit_title, explanation, count, difficulty);
    let raw = llm
        .chat(&messages)
        .await
        .map_err(|e| format!("LLM 单元自动出题失败: {}", e))?;
    let txt = raw.trim();

    // 复用 generate_training_pack 的解析逻辑（3 重 fallback）
    let try_parse_object = |s: &str| -> Option<GeneratedPack> {
        let v: Value = serde_json::from_str(s).ok()?;
        let obj = v.as_object()?;
        let questions = obj.get("questions")?.as_array()?.clone();
        let skill_meta = obj
            .get("skill_meta")
            .and_then(|v| v.as_object().cloned())
            .unwrap_or_default();
        Some(GeneratedPack { questions, skill_meta })
    };
    let try_parse_array = |s: &str| -> Option<GeneratedPack> {
        let arr: Vec<Value> = serde_json::from_str(s).ok()?;
        Some(GeneratedPack { questions: arr, skill_meta: serde_json::Map::new() })
    };
    if let Some(p) = try_parse_object(txt).or_else(|| try_parse_array(txt)) {
        return Ok(p);
    }
    if let Some(start) = txt.find("```json").or_else(|| txt.find("```")) {
        let after = &txt[start..];
        if let Some(end) = after[3..].find("```") {
            let inner = &after[3..3 + end];
            let cleaned = inner.trim_start_matches("json").trim();
            if let Some(p) = try_parse_object(cleaned).or_else(|| try_parse_array(cleaned)) {
                return Ok(p);
            }
        }
    }
    if let (Some(first), Some(last)) = (txt.find('{'), txt.rfind('}')) {
        if last > first {
            let candidate = &txt[first..=last];
            if let Some(p) = try_parse_object(candidate) {
                return Ok(p);
            }
        }
    }
    Err(format!("LLM 输出无法解析为 JSON：{}", txt.chars().take(200).collect::<String>()))
}

/// LLM 题集生成结果：题目数组 + 本次新增/更新的 skill 元数据（可空）。
pub struct GeneratedPack {
    pub questions: Vec<Value>,
    pub skill_meta: serde_json::Map<String, Value>,
}

/// LLM 题集生成调用包装。
///
/// v4 (2026-05) 起 LLM 返回的是顶层对象：
/// ```json
/// { "questions": [...], "skill_meta": { "<skill_id>": { name, category, description } } }
/// ```
///
/// 兼容旧 schema：若直解出 JSON 数组，自动包装为 `{ questions: arr, skill_meta: {} }`。
pub async fn generate_training_pack(
    llm: &LlmClient,
    doc_title: &str,
    unit_title: Option<&str>,
    material: &str,
    types: &[String],
    count: u32,
    difficulty: u8,
    language: Option<&str>,
) -> Result<GeneratedPack, String> {
    let messages = build_training_pack_messages(
        doc_title, unit_title, material, types, count, difficulty, language,
    );
    let raw = llm.chat(&messages).await.map_err(|e| format!("LLM 题集生成失败: {}", e))?;
    let txt = raw.trim();

    // 尝试解析为对象（新 schema）
    let try_parse_object = |s: &str| -> Option<GeneratedPack> {
        let v: Value = serde_json::from_str(s).ok()?;
        let obj = v.as_object()?;
        let questions = obj.get("questions")?.as_array()?.clone();
        let skill_meta = obj
            .get("skill_meta")
            .and_then(|v| v.as_object().cloned())
            .unwrap_or_default();
        Some(GeneratedPack {
            questions,
            skill_meta,
        })
    };
    // 尝试解析为数组（旧 schema 兼容）
    let try_parse_array = |s: &str| -> Option<GeneratedPack> {
        let arr: Vec<Value> = serde_json::from_str(s).ok()?;
        Some(GeneratedPack {
            questions: arr,
            skill_meta: serde_json::Map::new(),
        })
    };

    // 1) 直接解析
    if let Some(p) = try_parse_object(txt).or_else(|| try_parse_array(txt)) {
        return Ok(p);
    }
    // 2) 摘 ```json``` 围栏
    if let Some(start) = txt.find("```json").or_else(|| txt.find("```")) {
        let after = &txt[start..];
        if let Some(end) = after[3..].find("```") {
            let inner = &after[3..3 + end];
            let cleaned = inner.trim_start_matches("json").trim();
            if let Some(p) = try_parse_object(cleaned).or_else(|| try_parse_array(cleaned)) {
                return Ok(p);
            }
        }
    }
    // 3) 找 { 到 }（对象）或 [ 到 ]（数组）
    if let (Some(first), Some(last)) = (txt.find('{'), txt.rfind('}')) {
        if last > first {
            let candidate = &txt[first..=last];
            if let Some(p) = try_parse_object(candidate) {
                return Ok(p);
            }
        }
    }
    if let (Some(first), Some(last)) = (txt.find('['), txt.rfind(']')) {
        if last > first {
            let candidate = &txt[first..=last];
            if let Some(p) = try_parse_array(candidate) {
                return Ok(p);
            }
        }
    }
    Err(format!(
        "LLM 输出无法解析为 JSON：{}",
        txt.chars().take(300).collect::<String>()
    ))
}

// ════════════════════════════════════════════════════════════════════════════
// v9 (2026-05) 单题语言翻译
// ════════════════════════════════════════════════════════════════════════════
//
// 用户在训练区做某道代码题时，可临时换语言（如 Python → Rust），不需要退回
// 重新生成整个题集。此函数让 LLM 把现有题目（prompt / starter_code / answer /
// tests / rubric）整体翻译到目标语言，保留题意、测试用例语义、难度。
//
// 输入：原题 JSON + 目标语言
// 输出：新题 JSON（仅替换语言相关字段；id / type / skills / difficulty 保持不变）

/// 构造单题语言翻译的 LLM 消息。
pub fn build_translate_question_messages(
    question: &Value,
    target_language: &str,
) -> Vec<Message> {
    let q_str = serde_json::to_string_pretty(question).unwrap_or_else(|_| "{}".to_string());
    let system = format!(
        r#"你是一名编程多语言精通的训练教练。把下面这道**代码题**整体翻译成 {target_language}。

## 翻译要求

- **保留**：题目 id / type / skills / difficulty / prompt 的题意 / rubric 的考察重点
- **改写**（针对 {target_language} 习惯）：
  - `language`: 改成 "{target_language}"
  - `prompt`: 题面文字保留语义，但代码片段（如有）翻译成 {target_language} 语法
  - `starter_code`: 必须按 {target_language} 习惯改写：
    * 必须有顶层入口（Python 用 `if __name__ == '__main__': ...`、C/C++ 用 `int main()`、Rust 用 `fn main()`、Go 用 `func main()`、Java 用 `public static void main(String[] args)` 等）
    * 入口里至少一处 print 输出（`println!` / `console.log` / `printf` / `System.out.println` 等）
    * 函数体可保留 `// TODO` + 占位 return 让用户填
  - `answer`: 用 {target_language} 给出参考实现
  - `tests`: stdin/expected_stdout 的语义保留，但若 expected_stdout 中包含语言特定输出格式（如 Python `[1, 2, 3]` vs Rust `[1, 2, 3]`），按目标语言习惯调整。如果原 expected_stdout 是通用文本（数字/字符串），照原样保留
  - `rubric`: 评分要点改写为 {target_language} 语境（如"使用 Vec 而非 array"），但考察重点不变

## 输出格式

直接输出**纯 JSON 对象**（一道题），第一个字符 `{{`，最后一个字符 `}}`。
**绝对不要** markdown 围栏，**绝对不要**外层说明文字。
字符串内换行用 `\n`。

## 必备字段

至少要有：`id` / `type` / `skills` / `difficulty` / `language` / `prompt` / `starter_code` / `tests` / `answer` / `rubric`
（type / skills / id 与原题完全一致；其余按上面规则翻译）"#,
        target_language = target_language
    );

    let user = format!(
        r#"## 原题

```json
{q_str}
```

## 目标语言

{target_language}

## 任务

按上述规则把此题翻译成 {target_language}，输出新题的 JSON 对象。"#,
        q_str = q_str,
        target_language = target_language
    );

    vec![
        Message {
            role: "system".into(),
            content: system,
        },
        Message {
            role: "user".into(),
            content: user,
        },
    ]
}

/// 调 LLM 把一道代码题翻译到目标语言，返回新题 JSON。
///
/// 失败：LLM 输出无法解析为 JSON，或解析出的对象缺少必备字段。
/// 调用方负责持久化（如果需要）。
pub async fn translate_question_to_language(
    llm: &LlmClient,
    question: &Value,
    target_language: &str,
) -> Result<Value, String> {
    let messages = build_translate_question_messages(question, target_language);
    let raw = llm
        .chat(&messages)
        .await
        .map_err(|e| format!("LLM 翻译题目失败: {}", e))?;
    let txt = raw.trim();

    let try_parse = |s: &str| -> Option<Value> {
        let v: Value = serde_json::from_str(s).ok()?;
        if v.is_object() {
            Some(v)
        } else {
            None
        }
    };

    // 1) 直接解析
    if let Some(v) = try_parse(txt) {
        return validate_translated(v, question, target_language);
    }
    // 2) 摘 ```json``` 围栏
    if let Some(start) = txt.find("```json").or_else(|| txt.find("```")) {
        let after = &txt[start..];
        if let Some(end) = after[3..].find("```") {
            let inner = &after[3..3 + end];
            let cleaned = inner.trim_start_matches("json").trim();
            if let Some(v) = try_parse(cleaned) {
                return validate_translated(v, question, target_language);
            }
        }
    }
    // 3) 找 { 到 }
    if let (Some(first), Some(last)) = (txt.find('{'), txt.rfind('}')) {
        if last > first {
            let candidate = &txt[first..=last];
            if let Some(v) = try_parse(candidate) {
                return validate_translated(v, question, target_language);
            }
        }
    }
    Err(format!(
        "LLM 翻译输出无法解析为 JSON：{}",
        txt.chars().take(300).collect::<String>()
    ))
}

/// 校验翻译产物：补回缺失的元字段（id / type / skills / difficulty）从原题继承。
/// 必须有 starter_code / answer / language —— 缺失则报错。
fn validate_translated(
    mut translated: Value,
    original: &Value,
    target_language: &str,
) -> Result<Value, String> {
    let obj = translated
        .as_object_mut()
        .ok_or_else(|| "翻译结果不是对象".to_string())?;

    // 补回元字段（LLM 可能漏写）
    for key in ["id", "type", "skills", "difficulty"] {
        if !obj.contains_key(key) {
            if let Some(v) = original.get(key) {
                obj.insert(key.to_string(), v.clone());
            }
        }
    }
    // 强制 language 字段为目标语言
    obj.insert(
        "language".to_string(),
        Value::String(target_language.to_string()),
    );
    // 必备字段检查
    for key in ["prompt", "starter_code", "answer"] {
        let present = obj
            .get(key)
            .and_then(|v| v.as_str())
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false);
        if !present {
            return Err(format!("翻译产物缺少必备字段或为空：{key}"));
        }
    }
    // tests 缺失时从原题复制（语言无关的 stdin/expected_stdout 仍可用）
    if !obj.contains_key("tests") {
        if let Some(t) = original.get("tests") {
            obj.insert("tests".to_string(), t.clone());
        }
    }
    Ok(translated)
}

/// LLM 评分调用包装。
pub async fn grade_attempt(
    llm: &LlmClient,
    question: &Value,
    user_answer: &str,
    code_result: Option<&CodeRunResult>,
) -> Value {
    let messages = build_training_grade_messages(question, user_answer, code_result);
    match llm.chat(&messages).await {
        Ok(raw) => parse_grade_output(&raw),
        Err(e) => json!({
            "score": 0,
            "is_correct": false,
            "feedback": format!("LLM 评分失败: {}", e),
            "missed_points": [],
        }),
    }
}

// ════════════════════════════════════════════════════════════════════════════
// 批量评分（v4 2026-05）：把一组题一次性评分
// ════════════════════════════════════════════════════════════════════════════
//
// 设计目标：用户在训练会话内一次性提交 N 题 → 后端按下面策略一次性返回 N 个评分：
//   - choice / fill / sequence → **本地规则化**（不调 LLM）
//   - short / code / debug      → **批量打包后单次 LLM 调用**
//
// 这样 N 题最坏一次 LLM，最好 0 次 LLM，把传统"每题一次 grade"压成"一次批"，
// 大幅省 token + 等待时间。

/// 批量评分单项请求。
#[derive(Debug, Clone)]
pub struct BatchGradeItem {
    pub question: Value,
    pub user_answer: String,
    pub code_result: Option<CodeRunResult>,
}

/// 规则化评分：choice / fill / sequence。
/// 返回 Some(grade) 表示已得到结果，None 表示需要 LLM。
pub fn rule_grade(question: &Value, user_answer: &str) -> Option<Value> {
    let q_type = question.get("type").and_then(|x| x.as_str()).unwrap_or("");
    let reference = question.get("answer").and_then(|x| x.as_str()).unwrap_or("").trim();
    let user_norm = user_answer.trim();

    let make_grade = |is_correct: bool, score: i64, feedback: &str| -> Value {
        json!({
            "score": score,
            "is_correct": is_correct,
            "feedback": feedback,
            "missed_points": Vec::<String>::new(),
        })
    };

    match q_type {
        "choice" => {
            // 取首字母比对：用户答 "A" 或 "a" 或 "A. 选项内容" 都视作 "A"
            let pick = |s: &str| -> Option<char> {
                s.chars()
                    .find(|c| !c.is_whitespace())
                    .map(|c| c.to_ascii_uppercase())
            };
            let u = pick(user_norm);
            let r = pick(reference);
            if let (Some(u), Some(r)) = (u, r) {
                if u == r {
                    return Some(make_grade(true, 100, "选择正确。"));
                }
                return Some(make_grade(false, 0, &format!("选择错误。正确答案：{}", r)));
            }
            None
        }
        "fill" => {
            if reference.is_empty() {
                return None;
            }
            // 忽略大小写 + 首尾空白比较
            if user_norm.eq_ignore_ascii_case(reference) {
                return Some(make_grade(true, 100, "答案完全匹配。"));
            }
            // 不严格匹配则交给 LLM
            None
        }
        "sequence" => {
            if reference.is_empty() {
                return None;
            }
            // 规范化两边：移除空白后比对
            let normalize = |s: &str| -> String {
                s.split(|c: char| c == ',' || c == '\n' || c == '|')
                    .map(|p| p.trim().to_string())
                    .filter(|p| !p.is_empty())
                    .collect::<Vec<_>>()
                    .join("|")
            };
            let u = normalize(user_norm);
            let r = normalize(reference);
            if u == r {
                return Some(make_grade(true, 100, "顺序完全正确。"));
            }
            // 不匹配则交给 LLM 给部分分
            None
        }
        _ => None,
    }
}

/// 构建批量评分 LLM 消息。
///
/// 让模型一次评分多题，返回 JSON 数组，每个对象对应一题：
///   `[{score, is_correct, feedback, missed_points}, ...]`
///
/// 数量限制：单次 batch 建议 ≤ 10 题（避免输出过长被截断）；调用方自行分桶。
pub fn build_batch_grade_messages(items: &[&BatchGradeItem]) -> Vec<Message> {
    let mut blocks: Vec<String> = Vec::with_capacity(items.len());
    for (i, item) in items.iter().enumerate() {
        let q_type = item.question.get("type").and_then(|x| x.as_str()).unwrap_or("short");
        let prompt = item.question.get("prompt").and_then(|x| x.as_str()).unwrap_or("");
        let reference = item.question.get("answer").and_then(|x| x.as_str()).unwrap_or("");
        let rubric = item.question.get("rubric").and_then(|x| x.as_str()).unwrap_or("");
        let tests_block = item
            .question
            .get("tests")
            .and_then(|x| x.as_array())
            .map(|tests| {
                let lines: Vec<String> = tests
                    .iter()
                    .enumerate()
                    .map(|(j, t)| {
                        let desc = t.get("description").and_then(|x| x.as_str()).unwrap_or("");
                        let stdin = t.get("stdin").and_then(|x| x.as_str()).unwrap_or("");
                        let expected = t
                            .get("expected_stdout")
                            .and_then(|x| x.as_str())
                            .unwrap_or("");
                        format!(
                            "  用例 {}: {}\n    stdin: {}\n    expected_stdout: {}",
                            j + 1,
                            desc,
                            stdin,
                            expected
                        )
                    })
                    .collect();
                format!("\n## 测试用例\n{}", lines.join("\n"))
            })
            .unwrap_or_default();
        let code_block = if let Some(r) = &item.code_result {
            format!(
                r#"
## 代码运行结果
- 是否成功：{}
- exit_code：{:?}
- stdout：
```
{}
```
- stderr：
```
{}
```
"#,
                if r.success { "✅ 通过" } else { "❌ 失败" },
                r.exit_code,
                r.stdout.chars().take(500).collect::<String>(),
                r.stderr.chars().take(500).collect::<String>(),
            )
        } else {
            String::new()
        };
        blocks.push(format!(
            r#"### 第 {idx} 题（type={q_type}）

#### 题面
{prompt}
{tests_block}

#### 参考答案
{reference}

#### 评分细则
{rubric}

#### 学生答案
{user_answer}
{code_block}"#,
            idx = i + 1,
            q_type = q_type,
            prompt = prompt,
            tests_block = tests_block,
            reference = reference,
            rubric = rubric,
            user_answer = item.user_answer,
            code_block = code_block,
        ));
    }

    let system = format!(
        r#"你是一名严格但公正的训练评分员，现在需要**一次评分 {count} 道题**。

## 输出格式（**严格 JSON 数组，长度必须 = {count}**）

```json
[
  {{ "score": 85, "is_correct": true, "feedback": "...", "missed_points": ["..."] }},
  {{ "score": 0,  "is_correct": false, "feedback": "...", "missed_points": [] }}
]
```

## 评分原则

- score：0-100 整数；≥ 80 = is_correct=true；< 80 = is_correct=false
- short：按 rubric 给的"应包含要点"逐点评分；少一个扣 20-30 分
- code/debug：
  - 如果有"代码运行结果"且 success=true：基础 70 分起；再看代码风格 / 边界处理 / 复杂度加分到 100
  - 如果 success=false：从 stderr 找具体错误点；给 0-50 分（看接近正确的程度）；feedback 必须**指出错在哪行 / 哪个概念**
- fill / sequence：完全匹配 100 分；有部分对的可给 30-70；feedback 指出差异

## feedback 风格

- 简洁直接，60-150 字
- 先说"对的部分"再说"差的部分"（前提是有对的部分）

## 输出严格性

- 第一个字符必须是 `[`，最后一个字符必须是 `]`
- 数组长度必须等于 {count}，**与题目顺序严格对齐**（第 1 个对象 = 第 1 题）
- 不要 markdown 围栏，不要解释性文字
- missed_points 数组可为空"#,
        count = items.len()
    );

    let user = format!(
        r#"## 待评分的 {count} 道题

{blocks}

请按 JSON 数组格式输出 {count} 个评分对象，第一个字符就是 `[`。"#,
        count = items.len(),
        blocks = blocks.join("\n\n---\n\n"),
    );

    vec![
        Message {
            role: "system".into(),
            content: system,
        },
        Message {
            role: "user".into(),
            content: user,
        },
    ]
}

/// 解析批量评分 LLM 输出 → Vec<Value>，长度对齐 expected_len。
/// 不足时尾部用 fallback 填充。
pub fn parse_batch_grade_output(raw: &str, expected_len: usize) -> Vec<Value> {
    let txt = raw.trim();
    let fallback = || -> Value {
        json!({
            "score": 50,
            "is_correct": false,
            "feedback": "评分解析失败（LLM 输出未对齐）。",
            "missed_points": [],
        })
    };
    // 直接解析
    let mut arr: Option<Vec<Value>> = None;
    if let Ok(v) = serde_json::from_str::<Vec<Value>>(txt) {
        arr = Some(v);
    }
    // 摘 ```json``` 围栏
    if arr.is_none() {
        if let Some(start) = txt.find("```json").or_else(|| txt.find("```")) {
            let after = &txt[start..];
            if let Some(end) = after[3..].find("```") {
                let inner = &after[3..3 + end];
                let cleaned = inner.trim_start_matches("json").trim();
                if let Ok(v) = serde_json::from_str::<Vec<Value>>(cleaned) {
                    arr = Some(v);
                }
            }
        }
    }
    // 找 [ 到 ] 之间
    if arr.is_none() {
        if let (Some(first), Some(last)) = (txt.find('['), txt.rfind(']')) {
            if last > first {
                let candidate = &txt[first..=last];
                if let Ok(v) = serde_json::from_str::<Vec<Value>>(candidate) {
                    arr = Some(v);
                }
            }
        }
    }
    let mut out = arr.unwrap_or_default();
    out.truncate(expected_len);
    while out.len() < expected_len {
        out.push(fallback());
    }
    out
}

/// 批量评分入口：
///
/// 1. 把规则化能搞定的（choice / fill 严格匹配 / sequence 完全匹配）直接判
/// 2. 剩下的（short / code / debug / fill 不严格匹配 / sequence 部分匹配）按 batch 大小拆分，
///    每批一次 LLM 调用，**严格按返回顺序回填**到对应位置
///
/// 返回与 items 等长的评分数组（顺序对齐）。
pub async fn batch_grade_attempts(
    llm: &LlmClient,
    items: &[BatchGradeItem],
) -> Vec<Value> {
    let mut results: Vec<Option<Value>> = vec![None; items.len()];
    let mut needs_llm: Vec<usize> = Vec::new();

    for (i, item) in items.iter().enumerate() {
        if let Some(grade) = rule_grade(&item.question, &item.user_answer) {
            results[i] = Some(grade);
        } else {
            needs_llm.push(i);
        }
    }

    if !needs_llm.is_empty() {
        // 单次 batch 上限：保守 8 题，避免 LLM 输出超长被截
        const BATCH_LIMIT: usize = 8;
        for chunk in needs_llm.chunks(BATCH_LIMIT) {
            let batch_items: Vec<&BatchGradeItem> = chunk.iter().map(|&i| &items[i]).collect();
            let messages = build_batch_grade_messages(&batch_items);
            let raw = llm.chat(&messages).await.unwrap_or_else(|e| {
                log::warn!("[batch_grade_attempts] LLM 调用失败: {}", e);
                String::new()
            });
            let parsed = parse_batch_grade_output(&raw, chunk.len());
            for (k, &idx) in chunk.iter().enumerate() {
                results[idx] = Some(parsed[k].clone());
            }
        }
    }

    results
        .into_iter()
        .map(|o| {
            o.unwrap_or_else(|| {
                json!({
                    "score": 50,
                    "is_correct": false,
                    "feedback": "评分缺失",
                    "missed_points": [],
                })
            })
        })
        .collect()
}
