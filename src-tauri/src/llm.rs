/// OpenAI 兼容 HTTP 客户端（支持 openai / custom / anthropic）
/// 支持多模型轮询负载均衡
use serde_json::{json, Value};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use futures::stream::StreamExt;

#[derive(Debug, Clone)]
pub struct LlmConfig {
    pub provider: String,
    pub api_key: String,
    pub api_base: String,
    pub model: String,
    pub use_proxy: bool,
}

impl LlmConfig {
    /// 从环境变量加载（优先 .env 文件，再系统环境变量）
    pub fn from_env() -> Result<Self, String> {
        // 尝试加载 .env（仅桌面平台）
        #[cfg(not(target_os = "android"))]
        let _ = dotenvy::dotenv();

        let provider = std::env::var("LLM_PROVIDER").unwrap_or_else(|_| "openai".into());

        match provider.as_str() {
            "openai" | "custom" => {
                let key_var = if provider == "openai" { "OPENAI_API_KEY" } else { "CUSTOM_API_KEY" };
                let base_var = if provider == "openai" { "OPENAI_API_BASE" } else { "CUSTOM_API_BASE" };
                let model_var = if provider == "openai" { "OPENAI_MODEL" } else { "CUSTOM_MODEL" };
                Ok(LlmConfig {
                    provider: provider.clone(),
                    api_key: std::env::var(key_var).map_err(|_| format!("{key_var} 未设置"))?,
                    api_base: std::env::var(base_var)
                        .unwrap_or_else(|_| "https://api.openai.com/v1".into()),
                    model: std::env::var(model_var).unwrap_or_else(|_| "gpt-4o".into()),
                    use_proxy: true,
                })
            }
            "anthropic" => Ok(LlmConfig {
                provider,
                api_key: std::env::var("ANTHROPIC_API_KEY")
                    .map_err(|_| "ANTHROPIC_API_KEY 未设置".to_string())?,
                api_base: "https://api.anthropic.com".into(),
                model: std::env::var("ANTHROPIC_MODEL")
                    .unwrap_or_else(|_| "claude-3-5-sonnet-20241022".into()),
                use_proxy: true,
            }),
            other => Err(format!("不支持的 LLM_PROVIDER: {other}")),
        }
    }
}

/// 单个 LLM 后端
struct LlmBackend {
    config: LlmConfig,
    http: reqwest::Client,
}

/// 池化 LLM 客户端 — 支持多模型轮询负载均衡
/// 对外 API (chat / chat_json) 与单模型完全一致
pub struct LlmClient {
    backends: Arc<Vec<LlmBackend>>,
    counter: Arc<AtomicUsize>,
}

impl Clone for LlmClient {
    fn clone(&self) -> Self {
        // Arc::clone 共享池和计数器，所有克隆共享同一轮询状态
        Self {
            backends: Arc::clone(&self.backends),
            counter: Arc::clone(&self.counter),
        }
    }
}

#[derive(Debug, Clone)]
pub struct Message {
    pub role: String,
    pub content: String,
}

/// 流式过程中的"推理阶段"状态变化,供 UI 显示「思考中…」
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReasoningPhase {
    /// 进入 `<think>` 块
    Start,
    /// 离开 `</think>` 块,开始正常输出
    End,
}

/// 流式 think 标签过滤器:状态机式增量处理,把跨 chunk 的 `<think>...</think>`
/// 内容剥离出去,只输出用户应该看到的部分。
///
/// 单个增量 `delta_in` → 返回 `(visible_text, phase_changes)`:
///   - visible_text: 应该渲染给用户的纯净文本
///   - phase_changes: 发生的 think 状态切换(可能多次,因为一个 chunk 内可能 `<think>...</think>` 全闭合)
///
/// **挑战**:`<think>` 这 7 个字符可能被切成两个 chunk,例如先来 `<thi` 再来 `nk>`。
/// 解决:`partial` 缓冲区保存"可能是标签起头但还没确认"的尾巴,直到下次 chunk 拼接到能判断。
#[derive(Default, Debug)]
pub struct ThinkFilter {
    /// 是否身处 `<think>` 块内
    pub in_think: bool,
    /// 上一 chunk 末尾的"未消化"字符(可能是标签的开头几个 byte,也可能是普通文本只是看着像标签头)
    partial: String,
}

impl ThinkFilter {
    /// 处理一个增量。返回 `(visible_output, vec_of_phase_changes)`。
    pub fn feed(&mut self, delta: &str) -> (String, Vec<ReasoningPhase>) {
        // 拼上次未消化的 + 本次新 delta
        let mut buf = std::mem::take(&mut self.partial);
        buf.push_str(delta);

        let mut visible = String::new();
        let mut phases: Vec<ReasoningPhase> = Vec::new();
        let mut i = 0usize;
        let bytes = buf.as_bytes();

        // 用字节扫描以避免 char 索引带来的复杂性;`<think>` / `</think>` 都是 ASCII,
        // 不会跟中文字节冲突
        while i < bytes.len() {
            if !self.in_think {
                // 找下一个 "<think>"
                if let Some(pos) = find_substr(&bytes[i..], b"<think>") {
                    visible.push_str(&buf[i..i + pos]);
                    i += pos + b"<think>".len();
                    self.in_think = true;
                    phases.push(ReasoningPhase::Start);
                } else {
                    // 没找到完整标签,但末尾可能正在拼一半。保留最后 6 个字节(<think 长度-1)
                    // 作 partial,其余作为可见
                    let tail_keep = (b"<think>".len() - 1).min(bytes.len() - i);
                    let cut = bytes.len() - tail_keep;
                    if cut > i {
                        // 但我们只想保留"看起来像标签开头"的尾巴,如果尾巴完全不像就别保留
                        let tail = &buf[cut..];
                        if could_be_open_tag_prefix(tail) {
                            visible.push_str(&buf[i..cut]);
                            self.partial = tail.to_string();
                        } else {
                            visible.push_str(&buf[i..]);
                        }
                    } else {
                        // i 已经在 cut 之后(buf 太短),整体作 partial
                        let tail = &buf[i..];
                        if could_be_open_tag_prefix(tail) {
                            self.partial = tail.to_string();
                        } else {
                            visible.push_str(tail);
                        }
                    }
                    break;
                }
            } else {
                // 在 think 内,丢弃直到 "</think>"
                if let Some(pos) = find_substr(&bytes[i..], b"</think>") {
                    i += pos + b"</think>".len();
                    self.in_think = false;
                    phases.push(ReasoningPhase::End);
                } else {
                    // 没找到闭合;保留最后 7 字节(</think 长度-1)做 partial,其余直接丢
                    let tail_keep = (b"</think>".len() - 1).min(bytes.len() - i);
                    let cut = bytes.len() - tail_keep;
                    if cut > i {
                        let tail = &buf[cut..];
                        if could_be_close_tag_prefix(tail) {
                            self.partial = tail.to_string();
                        }
                    } else {
                        let tail = &buf[i..];
                        if could_be_close_tag_prefix(tail) {
                            self.partial = tail.to_string();
                        }
                    }
                    break;
                }
            }
        }

        (visible, phases)
    }

    /// 流结束时调用:把残余 partial 输出(如果不在 think 块里)
    pub fn flush(&mut self) -> String {
        if self.in_think {
            // 模型异常没闭合 think;丢弃残留
            self.partial.clear();
            String::new()
        } else {
            std::mem::take(&mut self.partial)
        }
    }
}

/// 在 haystack 字节里找 needle 的位置(从 0 起)
fn find_substr(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    let max = haystack.len() - needle.len();
    for i in 0..=max {
        if &haystack[i..i + needle.len()] == needle {
            return Some(i);
        }
    }
    None
}

/// 判断 s 是否**可能**是 `<think>` 标签的某个前缀(< / <t / <th / <thi / <thin / <think)
fn could_be_open_tag_prefix(s: &str) -> bool {
    matches!(s, "<" | "<t" | "<th" | "<thi" | "<thin" | "<think")
}
/// 判断 s 是否**可能**是 `</think>` 标签的某个前缀
fn could_be_close_tag_prefix(s: &str) -> bool {
    matches!(s, "<" | "</" | "</t" | "</th" | "</thi" | "</thin" | "</think")
}

fn build_http_client(use_proxy: bool) -> reqwest::Client {
    // 长内容 / 慢模型场景下 60s 经常超时（一键排版、整页生成等）；
    // 放宽到 180s（连接 15s）。后台任务包裹后 UI 不会因此阻塞。
    let mut builder = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(180))
        .connect_timeout(std::time::Duration::from_secs(15));
    if !use_proxy {
        builder = builder.no_proxy();
    } else {
        // ── 显式探测代理 ──
        // 由于 reqwest 0.12 在 default-features=false 时不会自动读 Windows 注册表里的
        // 系统代理（"自动检测系统代理"功能在默认特性里），仅靠 use_proxy=true 是不够的。
        // 这里按优先级显式读：
        //   1. HTTPS_PROXY / HTTP_PROXY 环境变量（最显式、最明确）
        //   2. Windows 注册表 HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings
        //      \ProxyEnable + ProxyServer（用户在 Windows 设置面板配的代理）
        // 任一命中后注册到 reqwest builder；都没有则 reqwest 会走直连。
        let detected = detect_proxy_url();
        if let Some(proxy_url) = detected {
            log::info!("LLM HTTP: 使用代理 {}", proxy_url);
            match reqwest::Proxy::all(&proxy_url) {
                Ok(p) => {
                    builder = builder.proxy(p);
                }
                Err(e) => {
                    log::warn!("代理 {} 解析失败,降级直连: {}", proxy_url, e);
                }
            }
        } else {
            log::debug!("LLM HTTP: 未检测到代理,直连");
        }
    }
    builder.build().expect("reqwest 客户端构建失败")
}

/// 探测一个可用的 HTTP/HTTPS 代理 URL,返回如 "http://127.0.0.1:7898" 这种。
/// 优先级:HTTPS_PROXY > HTTP_PROXY > Windows 注册表 InternetSettings.ProxyServer
///
/// **进程级缓存**:每次调 chat / embed 都会构造 LlmClient → 这里被调一次。
/// 不缓存的话,每次发请求都要 spawn 两个 reg.exe 子进程(Windows GUI 程序里这会
/// 闪黑窗一瞬)。用 OnceLock 一次探测、永久持有,代理变更需要重启 app。
fn detect_proxy_url() -> Option<String> {
    use std::sync::OnceLock;
    static CACHE: OnceLock<Option<String>> = OnceLock::new();
    CACHE.get_or_init(detect_proxy_url_uncached).clone()
}

fn detect_proxy_url_uncached() -> Option<String> {
    // 1. 环境变量(大小写都查;curl 同时认 HTTPS_PROXY / https_proxy)
    for k in &["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"] {
        if let Ok(v) = std::env::var(k) {
            let v = v.trim();
            if !v.is_empty() {
                return Some(normalize_proxy_url(v));
            }
        }
    }
    // 2. Windows 注册表
    #[cfg(target_os = "windows")]
    {
        if let Some(p) = read_windows_system_proxy() {
            return Some(p);
        }
    }
    None
}

/// 把用户写的 "127.0.0.1:7898" 这种缺协议的字符串补成 "http://127.0.0.1:7898"
fn normalize_proxy_url(s: &str) -> String {
    let s = s.trim();
    if s.starts_with("http://") || s.starts_with("https://") || s.starts_with("socks5://") || s.starts_with("socks5h://") {
        s.to_string()
    } else {
        format!("http://{}", s)
    }
}

/// 读 Windows 注册表 HKCU\...\Internet Settings\ProxyServer
/// ProxyServer 可能是:
///   - 单个值: "127.0.0.1:7898"
///   - 多协议: "http=127.0.0.1:7898;https=127.0.0.1:7898;socks=127.0.0.1:7891"
/// 我们只关心 https/http 那条;没分协议时整体当 http 用。
///
/// **黑窗修复**:Tauri Windows GUI 程序(`windows_subsystem = "windows"`)在 spawn
/// 子进程时,如果不指定 CREATE_NO_WINDOW(0x08000000) flag,Windows 会给子进程
/// 分配一个新 console 窗口,表现就是用户看到一个黑框一闪。这里用
/// `CommandExt::creation_flags` 显式抑制。
#[cfg(target_os = "windows")]
fn read_windows_system_proxy() -> Option<String> {
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    /// `CREATE_NO_WINDOW` — 等价于 winapi `windows-sys`(避免新依赖,直接写常量值)。
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let path = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings";

    let enabled = Command::new("reg.exe")
        .args(["query", path, "/v", "ProxyEnable"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;
    let enabled_text = String::from_utf8_lossy(&enabled.stdout);
    // ProxyEnable 是 REG_DWORD,值为 0x0 或 0x1
    if !enabled_text.contains("0x1") {
        return None;
    }

    let server = Command::new("reg.exe")
        .args(["query", path, "/v", "ProxyServer"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;
    let server_text = String::from_utf8_lossy(&server.stdout);
    // 解析最后一行的最后一个 token,例如:
    //   "    ProxyServer    REG_SZ    127.0.0.1:7898"
    let raw = server_text
        .lines()
        .filter(|l| l.contains("ProxyServer"))
        .last()?
        .split_whitespace()
        .last()?
        .to_string();
    if raw.is_empty() {
        return None;
    }
    // 多协议格式:取 "https=" 那条;没有就取整体
    let pick = if raw.contains('=') {
        raw.split(';')
            .find_map(|seg| {
                let mut kv = seg.splitn(2, '=');
                let k = kv.next()?.trim().to_lowercase();
                let v = kv.next()?.trim().to_string();
                if (k == "https" || k == "http") && !v.is_empty() {
                    Some(v)
                } else {
                    None
                }
            })
            .unwrap_or(raw)
    } else {
        raw
    };
    Some(normalize_proxy_url(&pick))
}

impl LlmClient {
    /// 单模型构造（向后兼容 .env 配置）
    pub fn new(config: LlmConfig) -> Self {
        let use_proxy = config.use_proxy;
        let backend = LlmBackend {
            config,
            http: build_http_client(use_proxy),
        };
        Self {
            backends: Arc::new(vec![backend]),
            counter: Arc::new(AtomicUsize::new(0)),
        }
    }

    /// 多模型池构造（轮询负载均衡）
    pub fn from_pool(configs: Vec<LlmConfig>) -> Self {
        assert!(!configs.is_empty(), "模型池不能为空");
        let backends: Vec<LlmBackend> = configs
            .into_iter()
            .map(|config| {
                let use_proxy = config.use_proxy;
                LlmBackend {
                    config,
                    http: build_http_client(use_proxy),
                }
            })
            .collect();
        log::info!("LLM 模型池初始化: {} 个模型", backends.len());
        for (i, b) in backends.iter().enumerate() {
            log::info!("  [{}] {} ({})", i, b.config.model, b.config.api_base);
        }
        Self {
            backends: Arc::new(backends),
            counter: Arc::new(AtomicUsize::new(0)),
        }
    }

    /// 返回池中模型数量
    pub fn pool_size(&self) -> usize {
        self.backends.len()
    }

    /// 轮询选择下一个后端
    fn next_backend(&self) -> &LlmBackend {
        let idx = self.counter.fetch_add(1, Ordering::Relaxed) % self.backends.len();
        &self.backends[idx]
    }

    /// 发送对话请求，返回助手回复文本
    pub async fn chat(&self, messages: &[Message]) -> Result<String, String> {
        let backend = self.next_backend();
        log::debug!("LLM 轮询选中: {}", backend.config.model);
        match backend.config.provider.as_str() {
            "anthropic" => Self::chat_anthropic(backend, messages).await,
            _ => Self::chat_openai(backend, messages).await,
        }
    }

    async fn chat_openai(backend: &LlmBackend, messages: &[Message]) -> Result<String, String> {
        let msgs: Vec<Value> = messages
            .iter()
            .map(|m| json!({ "role": m.role, "content": m.content }))
            .collect();

        let url = format!("{}/chat/completions", backend.config.api_base.trim_end_matches('/'));
        let body = json!({
            "model": backend.config.model,
            "messages": msgs,
            "temperature": 0.4
        });

        let resp = backend
            .http
            .post(&url)
            .bearer_auth(&backend.config.api_key)
            .json(&body)
            .send()
            .await
            .map_err(|e| {
                let detail = format!(
                    "connect={}, timeout={}, request={}, url={}",
                    e.is_connect(), e.is_timeout(), e.is_request(),
                    e.url().map(|u| u.as_str()).unwrap_or("unknown")
                );
                log::error!("HTTP 请求失败: {e} [{detail}]");
                format!("HTTP 请求失败: {e} [{detail}]")
            })?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            log::error!("API 错误 {status}: {text}");
            return Err(format!("API 错误 {status}: {text}"));
        }

        let json: Value = resp.json().await.map_err(|e| format!("JSON 解析失败: {e}"))?;
        extract_assistant_text(&json)
            .ok_or_else(|| format!("响应格式异常: {json}"))
    }

    async fn chat_anthropic(backend: &LlmBackend, messages: &[Message]) -> Result<String, String> {
        let mut system_prompt = String::new();
        let mut chat_msgs: Vec<Value> = Vec::new();

        for m in messages {
            if m.role == "system" {
                system_prompt = m.content.clone();
            } else {
                chat_msgs.push(json!({ "role": m.role, "content": m.content }));
            }
        }

        let mut body = json!({
            "model": backend.config.model,
            "max_tokens": 16384,
            "temperature": 0.4,
            "messages": chat_msgs
        });
        if !system_prompt.is_empty() {
            body["system"] = json!(system_prompt);
        }

        let url = format!("{}/v1/messages", backend.config.api_base.trim_end_matches('/'));
        let is_official = backend.config.api_base.contains("anthropic.com");
        log::info!("chat_anthropic: url={url}, is_official={is_official}, api_base={}", backend.config.api_base);
        let mut req = backend.http.post(&url);
        // 官方 Anthropic 仅用 x-api-key；第三方兼容端点同时发两种认证头以兼容不同实现
        if is_official {
            req = req.header("x-api-key", &backend.config.api_key);
        } else {
            req = req
                .header("Authorization", format!("Bearer {}", backend.config.api_key))
                .header("x-api-key", &backend.config.api_key);
        }
        req = req.header("anthropic-version", "2023-06-01");
        let resp = req
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("HTTP 请求失败: {e}"))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            log::error!("Anthropic API 错误 {status}: {text}");
            return Err(format!("Anthropic API 错误 {status}: {text}"));
        }

        let json: Value = resp.json().await.map_err(|e| format!("JSON 解析失败: {e}"))?;
        // 遍历 content 数组，优先找 type=text 的块；兼容 MiniMax 等带 thinking 块的响应
        if let Some(arr) = json["content"].as_array() {
            for block in arr {
                if block["type"].as_str() == Some("text") {
                    if let Some(t) = block["text"].as_str() {
                        return Ok(t.to_string());
                    }
                }
            }
            // 没有 text 块，取第一个有 text 字段的
            for block in arr {
                if let Some(t) = block["text"].as_str() {
                    return Ok(t.to_string());
                }
            }
        }
        // fallback: 统一抽取器兼容 OpenAI / thinking-only 响应
        extract_assistant_text(&json)
            .ok_or_else(|| format!("响应格式异常: {json}"))
    }

    /// Anthropic SSE 流式：`/v1/messages` + `stream: true`
    ///
    /// 事件类型（每条以 `data: <json>` 开头，前面可选 `event: <name>` 行）：
    ///   - `message_start`             : 起步，无文本
    ///   - `content_block_start`       : 一个 content_block 起步（type=text / thinking）
    ///   - `content_block_delta`       : `delta.type` ∈ { "text_delta" → delta.text,
    ///                                                    "thinking_delta" → delta.thinking,
    ///                                                    "input_json_delta" → 工具用，忽略 }
    ///   - `content_block_stop`        : 块结束
    ///   - `message_delta`             : usage 等元数据
    ///   - `message_stop`              : 整个流结束
    ///   - `ping` / `error` 等
    ///
    /// 我们把 text_delta 喂给 on_token；thinking_delta 暂只触发一次 reasoning Start，
    /// 文本本身不进可见区（避免污染讲解段）。流结束时若可见区为空但有 thinking，
    /// 兜底把 thinking 内容当作可见输出（兼容 MiniMax M2.7 把答案塞 thinking 的行为）。
    async fn chat_anthropic_stream<F, R>(
        backend: &LlmBackend,
        messages: &[Message],
        on_token: &mut F,
        on_reasoning: &mut R,
    ) -> Result<String, String>
    where
        F: FnMut(&str) + Send,
        R: FnMut(ReasoningPhase) + Send,
    {
        // StreamExt 已在文件顶部 use（futures::stream::StreamExt）

        let mut system_prompt = String::new();
        let mut chat_msgs: Vec<Value> = Vec::new();
        for m in messages {
            if m.role == "system" {
                system_prompt = m.content.clone();
            } else {
                chat_msgs.push(json!({ "role": m.role, "content": m.content }));
            }
        }

        let mut body = json!({
            "model": backend.config.model,
            "max_tokens": 16384,
            "temperature": 0.4,
            "stream": true,
            "messages": chat_msgs,
        });
        if !system_prompt.is_empty() {
            body["system"] = json!(system_prompt);
        }

        let url = format!("{}/v1/messages", backend.config.api_base.trim_end_matches('/'));
        let is_official = backend.config.api_base.contains("anthropic.com");
        log::info!("chat_anthropic_stream: url={url}, is_official={is_official}");
        let mut req = backend.http.post(&url);
        if is_official {
            req = req.header("x-api-key", &backend.config.api_key);
        } else {
            req = req
                .header("Authorization", format!("Bearer {}", backend.config.api_key))
                .header("x-api-key", &backend.config.api_key);
        }
        req = req
            .header("anthropic-version", "2023-06-01")
            .header("accept", "text/event-stream");

        let resp = req
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("HTTP 请求失败: {e}"))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("Anthropic stream API 错误 {status}: {text}"));
        }

        // 端点不返回 SSE → 让上层降级到非流式
        let is_sse = resp
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_ascii_lowercase().contains("text/event-stream"))
            .unwrap_or(false);
        if !is_sse {
            let ct = resp
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("")
                .to_string();
            return Err(format!("非 SSE 响应 (content-type={ct})"));
        }

        let mut full = String::new();
        let mut thinking_buf = String::new();
        let mut buf = String::new();
        let mut byte_stream = resp.bytes_stream();
        let mut in_thinking = false;
        let mut event_count = 0u32;

        while let Some(chunk) = byte_stream.next().await {
            let bytes = chunk.map_err(|e| format!("流式读取失败: {e}"))?;
            let text = match std::str::from_utf8(&bytes) {
                Ok(s) => s.to_string(),
                Err(_) => String::from_utf8_lossy(&bytes).into_owned(),
            };
            buf.push_str(&text);

            // 按 "\n\n" 切 SSE event 段
            while let Some(pos) = buf.find("\n\n") {
                let raw_event = buf[..pos].to_string();
                buf.drain(..pos + 2);

                // 单 event 段可能多行；data: 行可能多次（少见），用最后一行 data
                let mut data_payload: Option<&str> = None;
                for line in raw_event.lines() {
                    if let Some(rest) = line.strip_prefix("data:") {
                        data_payload = Some(rest.trim());
                    }
                }
                let Some(data) = data_payload else { continue };
                if data.is_empty() || data == "[DONE]" {
                    continue;
                }
                let v: Value = match serde_json::from_str(data) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                event_count += 1;
                let evt_type = v["type"].as_str().unwrap_or("");
                match evt_type {
                    "content_block_start" => {
                        let block_type = v["content_block"]["type"].as_str().unwrap_or("");
                        if block_type == "thinking" {
                            in_thinking = true;
                            on_reasoning(ReasoningPhase::Start);
                        } else if block_type == "text" {
                            if in_thinking {
                                in_thinking = false;
                                on_reasoning(ReasoningPhase::End);
                            }
                        }
                    }
                    "content_block_delta" => {
                        let delta_type = v["delta"]["type"].as_str().unwrap_or("");
                        match delta_type {
                            "text_delta" => {
                                if let Some(t) = v["delta"]["text"].as_str() {
                                    if !t.is_empty() {
                                        full.push_str(t);
                                        on_token(t);
                                    }
                                }
                            }
                            "thinking_delta" => {
                                if let Some(t) = v["delta"]["thinking"].as_str() {
                                    thinking_buf.push_str(t);
                                }
                            }
                            _ => {}
                        }
                    }
                    "content_block_stop" => {
                        if in_thinking {
                            in_thinking = false;
                            on_reasoning(ReasoningPhase::End);
                        }
                    }
                    "message_stop" => break,
                    "error" => {
                        let msg = v["error"]["message"].as_str().unwrap_or("unknown");
                        return Err(format!("Anthropic stream error: {msg}"));
                    }
                    _ => {}
                }
            }
        }

        log::info!(
            "chat_anthropic_stream: 结束 events={} text_len={} thinking_len={}",
            event_count, full.len(), thinking_buf.len()
        );

        // 兜底：模型把答案全塞 thinking（MiniMax M2.7），把 thinking 当可见输出一次性推
        if full.is_empty() && !thinking_buf.is_empty() {
            log::warn!("chat_anthropic_stream: 仅收到 thinking，兜底当可见输出");
            on_token(&thinking_buf);
            return Ok(thinking_buf);
        }
        Ok(full)
    }

    /// 结构化输出：发送请求并解析 JSON，带重试
    pub async fn chat_json(
        &self,
        system: &str,
        user: &str,
        max_retries: usize,
    ) -> Result<Value, String> {
        let base_messages = vec![
            Message {
                role: "system".into(),
                content: format!(
                    "{system}\n你必须输出严格 JSON：\n- 不要输出解释文字\n- 不要使用 markdown 代码块\n- 字段名与类型必须匹配 schema"
                ),
            },
            Message {
                role: "user".into(),
                content: user.to_string(),
            },
        ];

        let mut last_err = String::new();

        for _ in 0..max_retries {
            let raw = self.chat(&base_messages).await?;
            match parse_json_from_text(&raw) {
                Ok(v) => return Ok(v),
                Err(e) => {
                    last_err = e.clone();
                }
            }
        }
        Err(format!("结构化输出失败（重试 {max_retries} 次）：{last_err}"))
    }

    // ──────────────────────────────────────────────────────────────────────
    // Embeddings — OpenAI / 火山 / DeepSeek / 智谱兼容路径 `/embeddings`
    // ──────────────────────────────────────────────────────────────────────
    /// 取**第一个** backend 作为 embedding 调用对象。embedding 模型一般独立配置，
    /// 不走 chat 池的轮询；单实例即可，简单可控。
    fn embedding_backend(&self) -> &LlmBackend {
        &self.backends[0]
    }

    /// 生成一批文本的 embedding 向量。
    ///
    /// - 一次请求最多 64 条（多数厂商 64 是上限），自动分批
    /// - 兼容 OpenAI / 火山 / DeepSeek / 智谱：路径 `{api_base}/embeddings`，
    ///   body `{ "model": ..., "input": [...] }`，返回 `data[].embedding[]`
    /// - 维度由响应推断，调用方可拿到第一个向量长度
    /// - 若 backend 是 anthropic（不提供 embedding），返回明确错误
    pub async fn embed(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, String> {
        if texts.is_empty() {
            return Ok(Vec::new());
        }
        let backend = self.embedding_backend();
        if backend.config.provider == "anthropic" {
            return Err("Anthropic 不提供 embedding API，请在设置中为 RAG 选择 OpenAI 兼容的模型（如火山 / DeepSeek / OpenAI）".to_string());
        }

        let url = format!(
            "{}/embeddings",
            backend.config.api_base.trim_end_matches('/')
        );
        log::info!(
            "embed: POST {} model={} batch_count={}",
            url, backend.config.model, texts.len()
        );

        let mut all: Vec<Vec<f32>> = Vec::with_capacity(texts.len());
        // 每批 64 条；OpenAI 上限是 2048 token 总和、火山 256，64 是各家通行的安全值
        const BATCH: usize = 64;
        for chunk in texts.chunks(BATCH) {
            let body = json!({
                "model": backend.config.model,
                "input": chunk,
            });

            let resp = backend
                .http
                .post(&url)
                .bearer_auth(&backend.config.api_key)
                .json(&body)
                .send()
                .await
                .map_err(|e| {
                    let detail = format!(
                        "connect={}, timeout={}, request={}, url={}",
                        e.is_connect(),
                        e.is_timeout(),
                        e.is_request(),
                        e.url().map(|u| u.as_str()).unwrap_or("unknown")
                    );
                    log::error!("embedding HTTP 请求失败: {e} [{detail}]");
                    format!("embedding HTTP 请求失败: {e} [{detail}]")
                })?;

            if !resp.status().is_success() {
                let status = resp.status();
                let text = resp.text().await.unwrap_or_default();
                log::error!("embedding API 错误 {status}: {text}");
                return Err(format!("embedding API 错误 {status}: {text}"));
            }

            let json: Value = resp.json().await.map_err(|e| format!("embedding JSON 解析失败: {e}"))?;
            let data = json["data"].as_array().ok_or_else(|| {
                format!("embedding 响应格式异常: {}", json)
            })?;
            if data.len() != chunk.len() {
                return Err(format!(
                    "embedding 响应数量不匹配：请求 {} 条，返回 {} 条",
                    chunk.len(),
                    data.len()
                ));
            }
            for (i, item) in data.iter().enumerate() {
                let arr = item["embedding"].as_array().ok_or_else(|| {
                    format!("embedding 第 {i} 条无 embedding 字段: {}", item)
                })?;
                let vec: Vec<f32> = arr
                    .iter()
                    .map(|v| v.as_f64().unwrap_or(0.0) as f32)
                    .collect();
                if vec.is_empty() {
                    return Err(format!("embedding 第 {i} 条向量为空"));
                }
                all.push(vec);
            }
        }
        Ok(all)
    }

    /// 返回当前 embedding backend 的模型名（用于持久化到 rag_meta.model）
    pub fn embedding_model_name(&self) -> &str {
        &self.embedding_backend().config.model
    }

    // ──────────────────────────────────────────────────────────────────────
    // 流式聊天 — 通过回调把 token 增量推回去
    // ──────────────────────────────────────────────────────────────────────
    /// 流式调用 OpenAI 兼容 `/chat/completions` 端点，每收到一个 delta 就调
    /// `on_token(delta)`。Anthropic backend 不走流式，自动 fallback 到 `chat()`，
    /// 整段一次性触发回调，UI 行为兜底（不报错）。
    ///
    /// **思考块过滤**:有些模型(MiniMax M2.7、DeepSeek-R1 等)会把内部推理直接
    /// 夹在 `delta.content` 里,用 `<think>...</think>` 包裹。这部分对终端用户没有
    /// 价值且体感是"30 秒在刷英文乱码",必须过滤。`on_reasoning` 用于让上层把
    /// 思考状态显示为"思考中…"而不是直接渲染。
    ///
    /// 返回完整的 assistant 内容(已剥离 think 块,即用户应该看到的那部分)。
    pub async fn chat_stream<F, R>(
        &self,
        messages: &[Message],
        mut on_token: F,
        mut on_reasoning: R,
    ) -> Result<String, String>
    where
        F: FnMut(&str) + Send,
        R: FnMut(ReasoningPhase) + Send,
    {
        let backend = self.next_backend();
        log::debug!("LLM(stream) 轮询选中: {}", backend.config.model);

        if backend.config.provider == "anthropic" {
            // Anthropic 走自己的 SSE 协议（事件含 content_block_delta / text_delta / thinking_delta）。
            // 失败 / 端点不支持 stream 时，再退化为非流式 chat_anthropic。
            match Self::chat_anthropic_stream(backend, messages, &mut on_token, &mut on_reasoning).await {
                Ok(full) => return Ok(full),
                Err(e) => {
                    log::warn!("chat_anthropic_stream 失败，降级非流式: {e}");
                    let full = Self::chat_anthropic(backend, messages).await?;
                    on_token(&full);
                    return Ok(full);
                }
            }
        }

        let msgs: Vec<Value> = messages
            .iter()
            .map(|m| json!({ "role": m.role, "content": m.content }))
            .collect();
        let url = format!("{}/chat/completions", backend.config.api_base.trim_end_matches('/'));
        let body = json!({
            "model": backend.config.model,
            "messages": msgs,
            "temperature": 0.4,
            "stream": true,
        });

        let resp = backend
            .http
            .post(&url)
            .bearer_auth(&backend.config.api_key)
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("HTTP 请求失败: {e}"))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("API 错误 {status}: {text}"));
        }

        // 关键:很多兼容端点(MiniMax 网关 / 部分国产)即使收到 stream:true,
        // 也会返回 application/json 而不是 text/event-stream。这种情况按 SSE 解析
        // 会从头到尾找不到 `data:` 行,表现就是"等很久 → 一次性炸出整段",
        // 跟非流式无区别。
        // 处理方法:看 Content-Type,不是 event-stream 就走非流式 fallback,把
        // 完整响应一次性当作单个 token 推回去(UI 至少不再卡 30 秒空白)。
        let is_sse = resp
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_ascii_lowercase().contains("text/event-stream"))
            .unwrap_or(false);
        if !is_sse {
            log::warn!(
                "chat_stream: 端点未返回 SSE(content-type={:?}),按非流式解析",
                resp.headers().get(reqwest::header::CONTENT_TYPE)
            );
            // 当 OpenAI 标准 JSON 回应解析:choices[0].message.content
            let v: Value = resp
                .json()
                .await
                .map_err(|e| format!("非流式响应 JSON 解析失败: {e}"))?;
            // 宽松提取：兼容 OpenAI choices / Anthropic content[].text / 仅 thinking 块的 MiniMax 响应
            let raw_content = extract_assistant_text(&v)
                .ok_or_else(|| format!("响应格式异常: {v}"))?;
            // 同样过滤 <think> 块
            let mut filter = ThinkFilter::default();
            let (visible, _phases) = filter.feed(&raw_content);
            let tail = filter.flush();
            let cleaned = format!("{}{}", visible, tail);
            on_token(&cleaned);
            return Ok(cleaned);
        }

        // SSE 解析:response.bytes_stream() 给我们 Bytes 块;按 "\n\n" 切 event 段,
        // 每段以 "data: " 开头是 JSON。`data: [DONE]` 表示流结束。
        // 注意:一个 chunk 内可能有多 event,也可能一个 event 跨多个 chunk。
        let mut full = String::new();
        let mut buf = String::new(); // 行缓冲(处理跨 chunk)
        let mut byte_stream = resp.bytes_stream();

        log::info!("chat_stream: SSE 解析开始 url={} model={}", url, backend.config.model);
        let mut event_count = 0u32;
        let mut filter = ThinkFilter::default();

        while let Some(chunk) = byte_stream.next().await {
            let bytes = chunk.map_err(|e| format!("流式读取失败: {e}"))?;
            let s = match std::str::from_utf8(&bytes) {
                Ok(s) => s,
                Err(_) => continue, // 不完整 utf-8（极少见,跨 chunk 的多字节）— 跳过
            };
            buf.push_str(s);

            // 按 "\n\n" 切 event 段
            while let Some(pos) = buf.find("\n\n") {
                let event = buf[..pos].to_string();
                buf = buf[pos + 2..].to_string();
                for line in event.lines() {
                    let line = line.trim();
                    if !line.starts_with("data:") {
                        continue;
                    }
                    let payload = line.trim_start_matches("data:").trim();
                    if payload == "[DONE]" {
                        let tail = filter.flush();
                        if !tail.is_empty() {
                            full.push_str(&tail);
                            on_token(&tail);
                        }
                        log::info!(
                            "chat_stream: SSE 流结束 [DONE] events={} full_len={}",
                            event_count,
                            full.len()
                        );
                        return Ok(full);
                    }
                    // 解析增量 JSON
                    if let Ok(v) = serde_json::from_str::<Value>(payload) {
                        // OpenAI 风格：choices[0].delta.content
                        if let Some(delta) = v["choices"][0]["delta"]["content"].as_str() {
                            if !delta.is_empty() {
                                let (visible, phases) = filter.feed(delta);
                                for ph in phases {
                                    on_reasoning(ph);
                                }
                                if !visible.is_empty() {
                                    full.push_str(&visible);
                                    event_count += 1;
                                    on_token(&visible);
                                }
                            }
                        }
                        // 部分模型走标准化的 reasoning_content 字段(DeepSeek 等):
                        // 视为思考阶段,不入 visible,但首次见到时触发 reasoning Start
                        if v["choices"][0]["delta"]["reasoning_content"].is_string() {
                            on_reasoning(ReasoningPhase::Start);
                        }
                    }
                }
            }
        }
        // 流被服务端切断而没收到 [DONE]:仍把过滤器的尾巴输出
        let tail = filter.flush();
        if !tail.is_empty() {
            full.push_str(&tail);
            on_token(&tail);
        }
        log::info!(
            "chat_stream: SSE 流自然结束(无 [DONE]) events={} full_len={}",
            event_count,
            full.len()
        );
        Ok(full)
    }
}

pub fn parse_json_from_text(text: &str) -> Result<Value, String> {
    let trimmed = text.trim();
    // 去除 ```json ... ``` 包裹
    let stripped = if trimmed.starts_with("```") {
        trimmed
            .trim_start_matches("```json")
            .trim_start_matches("```")
            .trim_end_matches("```")
            .trim()
    } else {
        trimmed
    };

    if stripped.starts_with('{') || stripped.starts_with('[') {
        return serde_json::from_str(stripped).map_err(|e| e.to_string());
    }

    // 搜索第一个 {...}
    if let Some(start) = stripped.find('{') {
        if let Some(end) = stripped.rfind('}') {
            let candidate = &stripped[start..=end];
            if let Ok(v) = serde_json::from_str(candidate) {
                return Ok(v);
            }
        }
    }

    Err(format!("未找到可解析 JSON，原始内容: {}", &text[..text.len().min(200)]))
}

/// 宽松地从 LLM 响应 JSON 里抽 assistant 文本。
/// 适配三种端点形态：
///   1. OpenAI 标准 / 兼容: `choices[0].message.content` (string)
///   2. Anthropic / Claude: `content: [{type:"text", text:"..."}, ...]`
///   3. MiniMax extended-thinking 模式: `content: [{type:"thinking", thinking:"..."}]`
///      （没有 text 块，答案被塞进 thinking）—— 兜底取 thinking 字段，
///      避免抛"响应格式异常"。模型把 markdown 塞进了思考块虽然不雅，但能跑通。
fn extract_assistant_text(v: &Value) -> Option<String> {
    // 1) OpenAI
    if let Some(s) = v["choices"][0]["message"]["content"].as_str() {
        if !s.is_empty() {
            return Some(s.to_string());
        }
    }
    // OpenAI streaming chunk 偶尔会用 delta（非流式 fallback 也兼容一下）
    if let Some(s) = v["choices"][0]["delta"]["content"].as_str() {
        if !s.is_empty() {
            return Some(s.to_string());
        }
    }
    // 2) Anthropic 标准
    if let Some(arr) = v["content"].as_array() {
        // 优先 type=text
        for block in arr {
            if block["type"].as_str() == Some("text") {
                if let Some(t) = block["text"].as_str() {
                    if !t.is_empty() {
                        return Some(t.to_string());
                    }
                }
            }
        }
        // 任意带 text 字段
        for block in arr {
            if let Some(t) = block["text"].as_str() {
                if !t.is_empty() {
                    return Some(t.to_string());
                }
            }
        }
        // 3) 全是 thinking 块（MiniMax M2.7 highspeed 行为）：兜底取 thinking 文本
        for block in arr {
            if let Some(t) = block["thinking"].as_str() {
                if !t.is_empty() {
                    return Some(t.to_string());
                }
            }
        }
    }
    None
}
