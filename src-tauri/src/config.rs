/// 多模型配置持久化 — JSON 文件读写
use serde::{Deserialize, Serialize};
use std::path::Path;

use crate::llm::LlmConfig;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelConfig {
    /// 显示名称，如 "火山引擎 ark-code"
    pub name: String,
    /// 提供商: "openai" | "custom" | "anthropic"
    pub provider: String,
    /// API 密钥
    pub api_key: String,
    /// API 基础地址
    pub api_base: String,
    /// 模型名称
    pub model: String,
    /// 是否启用（方便临时禁用某个模型）
    pub enabled: bool,
    /// 是否使用系统代理（默认 true）
    #[serde(default = "default_true")]
    pub use_proxy: bool,
}

fn default_true() -> bool { true }

/// 从 JSON 文件加载模型配置列表
pub fn load_models(path: &Path) -> Vec<ModelConfig> {
    match std::fs::read_to_string(path) {
        Ok(content) => {
            serde_json::from_str(&content).unwrap_or_else(|e| {
                log::warn!("解析模型配置文件失败: {e}");
                Vec::new()
            })
        }
        Err(_) => Vec::new(),
    }
}

/// 保存模型配置列表到 JSON 文件
pub fn save_models(path: &Path, models: &[ModelConfig]) -> Result<(), String> {
    let json = serde_json::to_string_pretty(models)
        .map_err(|e| format!("序列化模型配置失败: {e}"))?;
    std::fs::write(path, json)
        .map_err(|e| format!("写入模型配置文件失败: {e}"))?;
    Ok(())
}

/// 将启用的 ModelConfig 转换为 LlmConfig 列表
pub fn to_llm_configs(models: &[ModelConfig]) -> Vec<LlmConfig> {
    models
        .iter()
        .filter(|m| m.enabled)
        .map(|m| LlmConfig {
            provider: m.provider.clone(),
            api_key: m.api_key.clone(),
            api_base: m.api_base.clone(),
            model: m.model.clone(),
            use_proxy: m.use_proxy,
        })
        .collect()
}

/// 对 API Key 脱敏显示（前4位 + **** + 后4位）
pub fn mask_api_key(key: &str) -> String {
    if key.len() <= 8 {
        "****".to_string()
    } else {
        format!("{}****{}", &key[..4], &key[key.len() - 4..])
    }
}
