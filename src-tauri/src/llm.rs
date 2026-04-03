/// OpenAI 兼容 HTTP 客户端（支持 openai / custom / anthropic）
/// 支持多模型轮询负载均衡
use serde_json::{json, Value};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

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
        // 尝试加载 .env
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

fn build_http_client(use_proxy: bool) -> reqwest::Client {
    let mut builder = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .connect_timeout(std::time::Duration::from_secs(10));
    if !use_proxy {
        builder = builder.no_proxy();
    }
    builder.build().expect("reqwest 客户端构建失败")
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
        json["choices"][0]["message"]["content"]
            .as_str()
            .map(|s| s.to_string())
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
        // fallback: 直接取 content[0].text（原逻辑）
        json["content"][0]["text"]
            .as_str()
            .map(|s| s.to_string())
            .ok_or_else(|| format!("响应格式异常: {json}"))
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
