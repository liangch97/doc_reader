use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};
use futures::stream::{self, StreamExt};

use crate::agent;
use crate::config;
use crate::db::{self, AppState};
use crate::doc_reader;
use crate::knowledge_points;
use crate::llm::{LlmClient, LlmConfig};
use crate::parser;
use crate::rag;
use crate::training;

// ══════════════════════════════════════════════════════════════════════════════
// LLM 配置管理命令
// ══════════════════════════════════════════════════════════════════════════════

#[tauri::command]
pub async fn get_llm_models(state: State<'_, AppState>) -> Result<Value, String> {
    let models = config::load_models(&state.config_path);
    let masked: Vec<Value> = models
        .iter()
        .enumerate()
        .map(|(i, m)| {
            json!({
                "index": i,
                "name": m.name,
                "provider": m.provider,
                "api_key_masked": config::mask_api_key(&m.api_key),
                "api_base": m.api_base,
                "model": m.model,
                "enabled": m.enabled,
            })
        })
        .collect();
    Ok(json!(masked))
}

/// 保存 LLM 模型配置列表
#[tauri::command]
pub async fn save_llm_models(
    state: State<'_, AppState>,
    models: Vec<config::ModelConfig>,
) -> Result<(), String> {
    config::save_models(&state.config_path, &models)?;
    log::info!("模型配置已保存: {} 个模型", models.len());
    Ok(())
}

/// 测试单个 LLM 模型连接
#[tauri::command]
pub async fn test_llm_model(model: config::ModelConfig) -> Result<Value, String> {
    log::info!("test_llm_model: 测试模型 '{}' ({}) provider={} base={} kind={}",
        model.name, model.model, model.provider, model.api_base,
        if model.kind.is_empty() { "chat" } else { model.kind.as_str() });
    let cfg = LlmConfig {
        provider: model.provider.clone(),
        api_key: model.api_key.clone(),
        api_base: model.api_base.clone(),
        model: model.model.clone(),
        use_proxy: model.use_proxy,
    };
    let client = LlmClient::new(cfg);

    // 根据用途自动走对应的探测路径
    let kind = if model.kind.is_empty() { "chat" } else { model.kind.as_str() };
    if kind == "embedding" {
        // 用一句短文本调 /embeddings,回报第一条向量的维度
        match client.embed(&["Hello, this is a connection test.".to_string()]).await {
            Ok(vectors) => {
                let dim = vectors.first().map(|v| v.len()).unwrap_or(0);
                Ok(json!({
                    "success": true,
                    "model": model.model,
                    "kind": "embedding",
                    "dim": dim,
                    "reply": format!("OK · 返回 1 个向量,维度 {}", dim),
                }))
            }
            Err(e) => Ok(json!({
                "success": false,
                "model": model.model,
                "kind": "embedding",
                "error": e,
            })),
        }
    } else {
        // chat:沿用原有探测逻辑
        let messages = vec![crate::llm::Message {
            role: "user".into(),
            content: "Hi, reply with just 'ok'.".into(),
        }];
        match client.chat(&messages).await {
            Ok(reply) => Ok(json!({
                "success": true,
                "model": model.model,
                "kind": "chat",
                "reply": reply.chars().take(100).collect::<String>(),
            })),
            Err(e) => Ok(json!({
                "success": false,
                "model": model.model,
                "kind": "chat",
                "error": e,
            })),
        }
    }
}

/// 删除指定索引的 LLM 模型
#[tauri::command]
pub async fn delete_llm_model(state: State<'_, AppState>, index: usize) -> Result<(), String> {
    let mut models = config::load_models(&state.config_path);
    if index >= models.len() {
        return Err(format!("索引越界: {} (共 {} 个模型)", index, models.len()));
    }
    let removed = models.remove(index);
    config::save_models(&state.config_path, &models)?;
    log::info!("已删除模型: {} ({})", removed.name, removed.model);
    Ok(())
}

/// 获取完整模型配置列表（含真实 api_key，前端仅在 toggle/edit 时调用）
#[tauri::command]
pub async fn get_llm_models_raw(state: State<'_, AppState>) -> Result<Vec<config::ModelConfig>, String> {
    Ok(config::load_models(&state.config_path))
}

// ══════════════════════════════════════════════════════════════════════════════
// Doc Reader Commands
// ══════════════════════════════════════════════════════════════════════════════

/// 打开文档：按页解析
#[tauri::command]
pub async fn doc_reader_open(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    file_name: String,
    file_data: String,
) -> Result<Value, String> {
    use base64::Engine;

    let session_id = uuid::Uuid::new_v4().to_string();
    log::info!("doc_reader_open: {} ({} bytes base64)", file_name, file_data.len());

    // 1) 解码 base64
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&file_data)
        .map_err(|e| format!("Base64 解码失败: {e}"))?;

    // 2) 按页解析文档
    let doc = parser::parse_pages(&file_name, &bytes)?;
    log::info!("文档按页解析完成: {} ({} 页)", doc.title, doc.pages.len());

    // 3) 保存原始文件到 uploads 目录
    let ext = file_name.rsplit('.').next().unwrap_or("bin").to_lowercase();
    let saved_name = format!("{}.{}", session_id, ext);
    let file_path = state.uploads_dir.join(&saved_name);
    std::fs::write(&file_path, &bytes)
        .map_err(|e| format!("保存上传文件失败: {e}"))?;
    let file_path_str = file_path.to_string_lossy().to_string();

    // 4) 保存会话和页面到 DB
    {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        db::dr_save_session(&conn, &session_id, &file_name, doc.pages.len(), &file_path_str)?;
        db::dr_save_pages(&conn, &session_id, &doc.pages)?;
    }

    // 5) 自动尝试构建 RAG 索引（best-effort，没配 embedding 模型就静默跳过）。
    //    用户可在阅读器右栏「聊天」上方手动点「构建知识库」重新触发。
    let models = config::load_models(&state.config_path);
    let has_embed = !config::to_embedding_configs(&models).is_empty();
    if has_embed {
        let sid_for_index = session_id.clone();
        let app_for_index = app_handle.clone();
        let state_inner = state.inner().clone();
        tokio::spawn(async move {
            // 构造 embedding client
            let llm = match config::to_embedding_configs(&config::load_models(&state_inner.config_path)).into_iter().next() {
                Some(cfg) => crate::llm::LlmClient::new(cfg),
                None => return,
            };
            let app_for_progress = app_for_index.clone();
            let sid_for_progress = sid_for_index.clone();
            let progress_fn = move |done: usize, total: usize| {
                let _ = app_for_progress.emit(
                    "rag-build-progress",
                    json!({ "session_id": sid_for_progress, "completed": done, "total": total }),
                );
            };
            let result = rag::index_session(
                state_inner.db.clone(),
                &llm,
                &sid_for_index,
                false,
                Some(&progress_fn),
            ).await;
            match result {
                Ok(total_chunks) => {
                    let dim = state_inner.db.lock().ok()
                        .and_then(|conn| db::rag_get_meta(&conn, &sid_for_index).ok().flatten())
                        .and_then(|m| m.get("dim").and_then(|v| v.as_i64()))
                        .unwrap_or(0);
                    let _ = app_for_index.emit(
                        "rag-build-done",
                        json!({
                            "session_id": sid_for_index,
                            "success": true,
                            "total_chunks": total_chunks,
                            "dim": dim,
                            "auto": true,
                        }),
                    );
                }
                Err(e) => {
                    log::warn!("RAG[{}] 自动索引失败（用户可手动重试）: {}", sid_for_index, e);
                    let _ = app_for_index.emit(
                        "rag-build-done",
                        json!({ "session_id": sid_for_index, "success": false, "error": e, "auto": true }),
                    );
                }
            }
        });
    }

    // 立即返回会话信息（无 KG 提取，直接 ready）
    let pages_summary: Vec<Value> = doc.pages.iter().map(|p| json!({
        "page_index": p.page_index,
        "word_count": p.word_count,
        "has_note": false,
    })).collect();

    let file_type = ext.clone();

    Ok(json!({
        "session_id": session_id,
        "title": doc.title,
        "page_count": doc.pages.len(),
        "pages": pages_summary,
        "kg_status": "ready",
        "file_type": file_type,
    }))
}

/// 获取阅读会话状态（含所有页面和笔记）
#[tauri::command]
pub async fn doc_reader_get_session(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Value, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let session = db::dr_get_session(&conn, &session_id)?;
    let pages = db::dr_get_pages_summary(&conn, &session_id)?;
    let notes = db::dr_get_all_notes(&conn, &session_id)?;
    Ok(json!({
        "session": session,
        "pages": pages,
        "notes": notes,
    }))
}

/// 获取单页内容
#[tauri::command]
pub async fn doc_reader_get_page(
    state: State<'_, AppState>,
    session_id: String,
    page_index: usize,
) -> Result<Value, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let page = db::dr_get_page(&conn, &session_id, page_index)?;
    let note = db::dr_get_note(&conn, &session_id, page_index)?;
    Ok(json!({
        "page": page,
        "note": note,
    }))
}

/// 按页码合并笔记：把整本笔记按 `## 第 N 页` 锚点切片，按页码升序排序，
/// 同页则把新内容追加到该页末尾，并在前面加 `---` 分隔。
///
/// 2026-05 引入：解决"按时序生成笔记导致后生成的页编号反而更大"的问题。
fn merge_note_by_page(existing: &str, new_page_num: u32, new_body: &str) -> String {
    use std::collections::BTreeMap;

    let mut sections: BTreeMap<u32, String> = BTreeMap::new();
    let mut preface = String::new();
    let mut current_page: Option<u32> = None;
    let mut current_buf = String::new();

    let flush = |current_page: Option<u32>,
                 buf: String,
                 sections: &mut BTreeMap<u32, String>,
                 preface: &mut String| match current_page {
        Some(p) => {
            let trimmed = buf.trim_matches('\n').to_string();
            sections
                .entry(p)
                .and_modify(|s| {
                    if !s.is_empty() {
                        s.push_str("\n\n---\n\n");
                    }
                    s.push_str(&trimmed);
                })
                .or_insert(trimmed);
        }
        None => {
            *preface = buf.trim_matches('\n').to_string();
        }
    };

    for line in existing.lines() {
        // 识别形如 "## 第 22 页" / "## 第 22 页 — 标题" 的锚点
        let is_header = line.strip_prefix("## 第 ").and_then(|rest| {
            let num_str = rest.split_whitespace().next()?;
            num_str.parse::<u32>().ok()
        });

        if let Some(n) = is_header {
            let buf = std::mem::take(&mut current_buf);
            flush(current_page, buf, &mut sections, &mut preface);
            current_page = Some(n);
            continue;
        }
        current_buf.push_str(line);
        current_buf.push('\n');
    }
    let buf = std::mem::take(&mut current_buf);
    flush(current_page, buf, &mut sections, &mut preface);

    // 插入 / 合并新页
    let new_body_trim = new_body.trim_matches('\n').trim().to_string();
    sections
        .entry(new_page_num)
        .and_modify(|s| {
            if !s.is_empty() {
                s.push_str("\n\n---\n\n");
            }
            s.push_str(&new_body_trim);
        })
        .or_insert(new_body_trim);

    let mut out = String::new();
    if !preface.is_empty() {
        out.push_str(preface.trim_end());
        out.push_str("\n\n");
    }
    let mut first = true;
    for (page, body) in &sections {
        if !first {
            out.push_str("\n\n");
        }
        first = false;
        out.push_str(&format!("## 第 {} 页\n\n", page));
        out.push_str(body.trim_end());
    }
    out
}

/// 为单页生成 AI 笔记
#[tauri::command]
pub async fn doc_reader_generate_note(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    page_index: usize,
    note_type: Option<String>,
    page_content: Option<String>,
    custom_prompt: Option<String>,
    // 真实"当前阅读页"序号（0-based）。前端把整本笔记存到 page_index=0 哨兵，
    // 因此 page_index 不再是真实页码；这个参数才是 LLM prompt + `## 第 N 页` 锚点用的。
    display_page_index: Option<usize>,
    // 已废弃：现在每页笔记独立从 1 开始编号、按 `## 第 N 页` 锚点合并，
    // 不再让 LLM 看到已有内容续编号。保留参数以兼容旧前端版本。
    existing_note: Option<String>,
) -> Result<Value, String> {
    let _ = existing_note; // 显式忽略，保持 ABI 兼容
    // 用真实页码喂给 LLM 和合并锚点；不传时回退到 page_index（旧前端兼容）。
    let real_page = display_page_index.unwrap_or(page_index);
    // 读取页面内容：优先使用前端传入的文本（确保与渲染页面一致）
    let (page_content, doc_title) = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        let session = db::dr_get_session(&conn, &session_id)?;
        let content = if let Some(ref c) = page_content {
            if !c.trim().is_empty() { c.clone() } else {
                let page = db::dr_get_page(&conn, &session_id, page_index)?;
                page["content"].as_str().unwrap_or("").to_string()
            }
        } else {
            let page = db::dr_get_page(&conn, &session_id, page_index)?;
            page["content"].as_str().unwrap_or("").to_string()
        };
        (
            content,
            session["filename"].as_str().unwrap_or("").to_string(),
        )
    };

    let sid = session_id.clone();
    let state_inner = state.inner().clone();
    let app_inner = app_handle.clone();
    let ntype = note_type.unwrap_or_else(|| "note".to_string());
    let cprompt = custom_prompt;
    let real_page_inner = real_page;

    tokio::spawn(async move {
        let llm = {
            let models = config::load_models(&state_inner.config_path);
            let configs = config::to_llm_configs(&models);
            if !configs.is_empty() {
                LlmClient::from_pool(configs)
            } else {
                match LlmConfig::from_env() {
                    Ok(c) => LlmClient::new(c),
                    Err(e) => {
                        let _ = app_inner.emit("doc-note-error", json!({
                            "session_id": sid, "page_index": page_index, "error": e
                        }));
                        return;
                    }
                }
            }
        };

        match doc_reader::generate_page_note(
            &llm,
            &doc_title,
            real_page_inner,
            &page_content,
            &ntype,
            cprompt.as_deref(),
            None,
        ).await {
            Ok(ai_text) => {
                // ── 原子合并策略（2026-05 按页码插入版） ───────────────────
                // 在持锁期间一次性完成：读取已有笔记 → 按 `## 第 N 页` 锚点
                // 切片 → 把新页 body 插入到正确位置（同页则追加分隔） → 写回。
                //
                // 这样不论用户先生成 22 页还是先生成 1 页，最终笔记永远按页码
                // 升序排列，每页的子编号也独立从 1 开始。
                // ----------------------------------------------------------------
                let merged = {
                    let conn_res = state_inner.db.lock();
                    match conn_res {
                        Ok(conn) => {
                            let db_existing = db::dr_get_note(&conn, &sid, page_index)
                                .ok()
                                .flatten()
                                .and_then(|n| n["content"].as_str().map(|s| s.to_string()))
                                .unwrap_or_default();
                            let merged_str = merge_note_by_page(
                                &db_existing,
                                (real_page_inner + 1) as u32,
                                ai_text.trim(),
                            );
                            let _ = db::dr_save_note(&conn, &sid, page_index, &merged_str, "ai");
                            Some(merged_str)
                        }
                        Err(_) => None,
                    }
                };
                if let Some(merged_str) = merged {
                    let note = serde_json::json!({
                        "content": merged_str,
                        "source": "ai",
                        "page_index": page_index,
                    });
                    let _ = app_inner.emit("doc-note-generated", json!({
                        "session_id": sid,
                        "page_index": page_index,
                        "note": note,
                    }));
                } else {
                    let _ = app_inner.emit("doc-note-error", json!({
                        "session_id": sid,
                        "page_index": page_index,
                        "error": "笔记保存失败",
                    }));
                }
            }
            Err(e) => {
                log::error!("页面笔记生成失败: {} / page {} - {}", sid, page_index, e);
                let _ = app_inner.emit("doc-note-error", json!({
                    "session_id": sid, "page_index": page_index, "error": e
                }));
            }
        }
    });

    Ok(json!({ "status": "generating", "page_index": page_index }))
}

/// 文档答疑：基于当前文档内容回答用户问题
#[tauri::command]
pub async fn doc_reader_chat(
    state: State<'_, AppState>,
    session_id: String,
    question: String,
    page_index: Option<usize>,
    page_content: Option<String>,
    history: Option<Vec<(String, String)>>,
) -> Result<Value, String> {
    // 获取文档信息和页面内容
    let (doc_title, content) = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        let session = db::dr_get_session(&conn, &session_id)?;
        let doc_title = session["filename"].as_str().unwrap_or("").to_string();

        let content = if let Some(ref pc) = page_content {
            if !pc.trim().is_empty() { pc.clone() } else {
                if let Some(idx) = page_index {
                    let page = db::dr_get_page(&conn, &session_id, idx)?;
                    page["content"].as_str().unwrap_or("").to_string()
                } else { String::new() }
            }
        } else if let Some(idx) = page_index {
            let page = db::dr_get_page(&conn, &session_id, idx)?;
            page["content"].as_str().unwrap_or("").to_string()
        } else {
            String::new()
        };
        (doc_title, content)
    };

    if question.trim().is_empty() {
        return Err("问题不能为空".to_string());
    }

    let llm = {
        let models = config::load_models(&state.config_path);
        let configs = config::to_llm_configs(&models);
        if !configs.is_empty() {
            LlmClient::from_pool(configs)
        } else {
            LlmConfig::from_env().map(LlmClient::new).map_err(|e| e.to_string())?
        }
    };

    let hist = history.unwrap_or_default();
    let answer = doc_reader::chat_with_doc(
        &llm, &doc_title, &content, page_index, &question, &hist,
    ).await?;

    Ok(json!({
        "answer": answer,
        "page_index": page_index,
    }))
}

/// 批量生成所有页面笔记
#[tauri::command]
pub async fn doc_reader_generate_all(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    note_type: Option<String>,
) -> Result<Value, String> {
    let (doc_title, page_count) = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        let session = db::dr_get_session(&conn, &session_id)?;
        (
            session["filename"].as_str().unwrap_or("").to_string(),
            session["page_count"].as_i64().unwrap_or(0) as usize,
        )
    };

    let sid = session_id.clone();
    let state_inner = state.inner().clone();
    let app_inner = app_handle.clone();
    let ntype = note_type.unwrap_or_else(|| "note".to_string());

    tokio::spawn(async move {
        let llm = {
            let models = config::load_models(&state_inner.config_path);
            let configs = config::to_llm_configs(&models);
            if !configs.is_empty() {
                LlmClient::from_pool(configs)
            } else {
                match LlmConfig::from_env() {
                    Ok(c) => LlmClient::new(c),
                    Err(e) => {
                        let _ = app_inner.emit("doc-generate-all-done", json!({
                            "session_id": sid, "success": false, "error": e
                        }));
                        return;
                    }
                }
            }
        };

        // 预先读取所有页面内容
        let mut pages: Vec<(usize, String)> = Vec::new();
        for page_idx in 0..page_count {
            let page_content = {
                if let Ok(conn) = state_inner.db.lock() {
                    db::dr_get_page(&conn, &sid, page_idx)
                        .ok()
                        .and_then(|p| p["content"].as_str().map(|s| s.to_string()))
                        .unwrap_or_default()
                } else {
                    String::new()
                }
            };
            if !page_content.trim().is_empty() {
                pages.push((page_idx, page_content));
            }
        }

        let total_non_empty = pages.len();
        let completed = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));

        // 并发生成，最多同时 4 个请求
        let concurrency = 4usize.min(total_non_empty);
        stream::iter(pages)
            .for_each_concurrent(concurrency, |(page_idx, page_content)| {
                let llm = &llm;
                let doc_title = &doc_title;
                let ntype = &ntype;
                let sid = &sid;
                let state_inner = &state_inner;
                let app_inner = &app_inner;
                let completed = &completed;
                async move {
                    match doc_reader::generate_page_note(llm, doc_title, page_idx, &page_content, ntype, None, None).await {
                        Ok(note_content) => {
                            let save_ok = if let Ok(conn) = state_inner.db.lock() {
                                db::dr_save_note(&conn, sid, page_idx, &note_content, "ai").is_ok()
                            } else {
                                false
                            };
                            let done = completed.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
                            if save_ok {
                                let note = json!({
                                    "content": note_content,
                                    "source": "ai",
                                    "page_index": page_idx,
                                });
                                let _ = app_inner.emit("doc-note-generated", json!({
                                    "session_id": sid, "page_index": page_idx, "note": note,
                                }));
                            }
                            let _ = app_inner.emit("doc-generate-all-progress", json!({
                                "session_id": sid, "completed": done, "total": page_count,
                            }));
                        }
                        Err(e) => {
                            log::error!("批量生成失败: page {} - {}", page_idx, e);
                            let done = completed.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
                            let _ = app_inner.emit("doc-note-error", json!({
                                "session_id": sid, "page_index": page_idx, "error": e,
                            }));
                            let _ = app_inner.emit("doc-generate-all-progress", json!({
                                "session_id": sid, "completed": done, "total": page_count,
                            }));
                        }
                    }
                }
            })
            .await;

        let final_completed = completed.load(std::sync::atomic::Ordering::Relaxed);
        let _ = app_inner.emit("doc-generate-all-done", json!({
            "session_id": sid, "success": true, "completed": final_completed,
        }));
    });

    Ok(json!({ "status": "generating", "total": page_count }))
}

/// 手动保存/编辑页面笔记
#[tauri::command]
pub async fn doc_reader_save_note(
    state: State<'_, AppState>,
    session_id: String,
    page_index: usize,
    content: String,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::dr_save_note(&conn, &session_id, page_index, &content, "manual")
}

/// 删除单页笔记
#[tauri::command]
pub async fn doc_reader_delete_note(
    state: State<'_, AppState>,
    session_id: String,
    page_index: usize,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::dr_delete_note(&conn, &session_id, page_index)
}

/// 获取最近的阅读会话列表
#[tauri::command]
pub async fn doc_reader_list_sessions(
    state: State<'_, AppState>,
    limit: Option<usize>,
) -> Result<Value, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let sessions = db::dr_list_sessions(&conn, limit.unwrap_or(20))?;
    Ok(json!({ "sessions": sessions }))
}

/// 删除阅读会话
#[tauri::command]
pub async fn doc_reader_delete_session(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::dr_delete_session(&conn, &session_id)
}

/// 将 PPTX 文件通过 PowerPoint COM 接口导出为每页 PNG，返回 base64 图片数组
#[tauri::command]
#[cfg(not(target_os = "android"))]
pub async fn doc_reader_export_ppt_slides(
    file_data: String,
    file_name: String,
) -> Result<Value, String> {
    use base64::Engine;
    use std::process::Command;

    // 1) 解码 base64 → 写入临时文件
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&file_data)
        .map_err(|e| format!("Base64 解码失败: {e}"))?;

    let tmp_dir = tempfile::tempdir().map_err(|e| format!("创建临时目录失败: {e}"))?;
    let pptx_path = tmp_dir.path().join(&file_name);
    let out_dir = tmp_dir.path().join("slides");
    std::fs::create_dir_all(&out_dir).map_err(|e| format!("创建输出目录失败: {e}"))?;
    std::fs::write(&pptx_path, &bytes).map_err(|e| format!("写入临时文件失败: {e}"))?;

    // Windows 路径已经是反斜杠，直接使用
    let pptx_path_str = pptx_path.to_string_lossy().to_string();
    let out_dir_str = out_dir.to_string_lossy().to_string();

    // 2) PowerShell 调用 PowerPoint COM，逐页 Export 为 PNG（比 SaveAs 更可靠）
    let ps_script = format!(
        r#"
$ErrorActionPreference = 'Stop'
$pptPath = '{pptx}'
$outDir = '{out}'
$ppt = New-Object -ComObject PowerPoint.Application
try {{
    $presentation = $ppt.Presentations.Open($pptPath, $true, $false, $false)
    foreach ($slide in $presentation.Slides) {{
        $idx = $slide.SlideIndex
        $outFile = Join-Path $outDir ("slide_" + $idx.ToString("D3") + ".png")
        $slide.Export($outFile, "PNG", 1920, 1080)
    }}
    $presentation.Close()
}} finally {{
    $ppt.Quit()
    [System.Runtime.Interopservices.Marshal]::ReleaseComObject($ppt) | Out-Null
}}
"#,
        pptx = pptx_path_str.replace('\'', "''"),
        out = out_dir_str.replace('\'', "''"),
    );

    let output = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &ps_script])
        .output()
        .map_err(|e| format!("PowerShell 执行失败: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        return Err(format!("PPT 导出失败: {}\n{}", stderr, stdout));
    }

    // 3) 读取生成的 PNG 文件，按文件名排序后转 base64
    let mut entries: Vec<_> = std::fs::read_dir(&out_dir)
        .map_err(|e| format!("读取输出目录失败: {e}"))?
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.path()
                .extension()
                .and_then(|x| x.to_str())
                .map(|x| x.eq_ignore_ascii_case("png"))
                .unwrap_or(false)
        })
        .collect();

    // 按文件名排序（slide_001.png, slide_002.png, ...）
    entries.sort_by(|a, b| a.file_name().cmp(&b.file_name()));

    let mut slides: Vec<String> = Vec::new();
    for entry in &entries {
        let img_bytes = std::fs::read(entry.path())
            .map_err(|e| format!("读取图片失败: {e}"))?;
        let b64 = base64::engine::general_purpose::STANDARD.encode(&img_bytes);
        slides.push(format!("data:image/png;base64,{}", b64));
    }

    if slides.is_empty() {
        return Err("PPT 导出后未找到任何图片，请确认 PowerPoint 已正常安装".to_string());
    }

    log::info!("PPT 导出完成: {} 页", slides.len());
    Ok(json!({ "slides": slides, "count": slides.len() }))
}

/// Android stub: PPT export is not supported on Android
#[tauri::command]
#[cfg(target_os = "android")]
pub async fn doc_reader_export_ppt_slides(
    _file_data: String,
    _file_name: String,
) -> Result<Value, String> {
    Err("PPT 导出功能仅在 Windows 桌面版可用".to_string())
}

/// 获取历史会话的原始文件数据（base64）
#[tauri::command]
pub async fn doc_reader_get_file(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Value, String> {
    use base64::Engine;

    // 从 DB 获取 file_path
    let file_path: String = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        let session = db::dr_get_session(&conn, &session_id)?;
        session["file_path"]
            .as_str()
            .unwrap_or("")
            .to_string()
    };

    if file_path.is_empty() {
        return Err("该会话没有关联的原始文件".to_string());
    }

    let path = std::path::Path::new(&file_path);
    if !path.exists() {
        return Err(format!("原始文件不存在: {}", file_path));
    }

    let bytes = std::fs::read(path)
        .map_err(|e| format!("读取文件失败: {e}"))?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);

    Ok(json!({
        "file_data": b64,
        "file_name": path.file_name().unwrap_or_default().to_string_lossy(),
    }))
}

// ══════════════════════════════════════════════════════════════════════════════
// Notebook Commands
// ══════════════════════════════════════════════════════════════════════════════

/// 创建笔记本
#[tauri::command]
pub async fn notebook_create(
    state: State<'_, AppState>,
    name: String,
    description: Option<String>,
    color: Option<String>,
    teacher: Option<String>,
) -> Result<Value, String> {
    let notebook_id = uuid::Uuid::new_v4().to_string();
    let desc = description.unwrap_or_default();
    let clr = color.unwrap_or_else(|| "#7C5CFC".to_string());
    let tch = teacher.unwrap_or_default();
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::nb_create(&conn, &notebook_id, &name, &desc, &clr, &tch)?;
    Ok(json!({ "notebook_id": notebook_id, "name": name }))
}

/// 获取所有笔记本列表
#[tauri::command]
pub async fn notebook_list(state: State<'_, AppState>) -> Result<Value, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let notebooks = db::nb_list(&conn)?;
    Ok(json!({ "notebooks": notebooks }))
}

/// 获取单个笔记本详情（含条目）
#[tauri::command]
pub async fn notebook_get(
    state: State<'_, AppState>,
    notebook_id: String,
) -> Result<Value, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::nb_get(&conn, &notebook_id)
}

/// 更新笔记本
#[tauri::command]
pub async fn notebook_update(
    state: State<'_, AppState>,
    notebook_id: String,
    name: String,
    description: Option<String>,
    color: Option<String>,
    teacher: Option<String>,
) -> Result<(), String> {
    let desc = description.unwrap_or_default();
    let clr = color.unwrap_or_else(|| "#7C5CFC".to_string());
    let tch = teacher.unwrap_or_default();
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::nb_update(&conn, &notebook_id, &name, &desc, &clr, &tch)
}

/// 删除笔记本
#[tauri::command]
pub async fn notebook_delete(
    state: State<'_, AppState>,
    notebook_id: String,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::nb_delete(&conn, &notebook_id)
}

/// 向笔记本添加条目
#[tauri::command]
pub async fn notebook_add_entry(
    state: State<'_, AppState>,
    notebook_id: String,
    title: String,
    content: String,
    entry_type: Option<String>,
    source_info: Option<String>,
) -> Result<Value, String> {
    let entry_id = uuid::Uuid::new_v4().to_string();
    let etype = entry_type.unwrap_or_else(|| "note".to_string());
    let src = source_info.unwrap_or_default();
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::nb_add_entry(&conn, &entry_id, &notebook_id, &title, &content, &etype, &src)?;
    Ok(json!({ "entry_id": entry_id }))
}

/// 更新笔记条目
///
/// v4 (2026-05) 双向同步：若该 entry 是学习单元绑定 entry（source_kind='agent_unit'），
/// 自动把 content 回写到 agent_unit_states.teach_pack.explanation，让学习区下次打开
/// 看到用户在笔记本里编辑的内容。
#[tauri::command]
pub async fn notebook_update_entry(
    app: AppHandle,
    state: State<'_, AppState>,
    entry_id: String,
    title: String,
    content: String,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::nb_update_entry(&conn, &entry_id, &title, &content)?;
    // 反向同步到 teach_pack.explanation
    if let Ok(Some((session_id, unit_index))) = db::nb_find_unit_binding(&conn, &entry_id) {
        if let Err(e) = db::agent_save_explanation(&conn, &session_id, unit_index, &content) {
            log::warn!(
                "[notebook_update_entry] 反向同步 teach_pack.explanation 失败 (entry_id={entry_id}): {}",
                e
            );
        } else {
            // 释放锁后通知前端 AgentTab 刷新
            drop(conn);
            let _ = app.emit(
                "agent-unit-explanation-updated",
                json!({
                    "session_id": session_id,
                    "unit_index": unit_index,
                    "entry_id": entry_id,
                }),
            );
        }
    }
    Ok(())
}

/// 删除笔记条目
#[tauri::command]
pub async fn notebook_delete_entry(
    state: State<'_, AppState>,
    entry_id: String,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::nb_delete_entry(&conn, &entry_id)
}

/// 一键排版（条目级，**异步事件版**）：立即返回 `{ entry_id, started: true }`，
/// 后台 spawn 调用 LLM；完成后通过 Tauri 事件通知前端：
///   - `note-format-done`  payload: `{ entry_id, content, char_count }`
///   - `note-format-error` payload: `{ entry_id, error }`
///
/// 这样可以：
///   1. 避免前端 IPC 在长 LLM 调用下挂死整个 invoke
///   2. UI 立即显示进度而不冻结按钮，且支持跨条目并发
///   3. 用户切换条目 / 关闭面板时不会丢任务
#[tauri::command]
pub async fn notebook_entry_auto_format(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    entry_id: String,
) -> Result<Value, String> {
    // 1) 主任务里取出条目当前内容（避免 spawn 内多次借用 state）
    let (title, current_content) = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        let entry = db::nb_get_entry(&conn, &entry_id)?;
        (
            entry["title"].as_str().unwrap_or("").to_string(),
            entry["content"].as_str().unwrap_or("").to_string(),
        )
    };
    if current_content.trim().is_empty() {
        return Err("条目内容为空，无法排版".into());
    }

    let state_inner = state.inner().clone();
    let app_inner = app_handle.clone();
    let eid = entry_id.clone();

    // 2) 立即派发后台任务，前端立即收到 `started: true` 响应
    tokio::spawn(async move {
        // 2.1) 构造 LLM 客户端（失败 → emit error 事件）
        let llm = {
            let models = config::load_models(&state_inner.config_path);
            let configs = config::to_llm_configs(&models);
            if !configs.is_empty() {
                LlmClient::from_pool(configs)
            } else {
                match LlmConfig::from_env().map(LlmClient::new) {
                    Ok(c) => c,
                    Err(e) => {
                        let _ = app_inner.emit(
                            "note-format-error",
                            json!({ "entry_id": eid, "error": e }),
                        );
                        return;
                    }
                }
            }
        };

        // 2.2) 系统提示：教 LLM 用项目自定义的围栏块语法
        let prompt = format!(
            r#"你是一个笔记排版专家。下面是用户写的原始笔记，请你**重新组织排版**，使其结构清晰、易于学习。

## 排版原则（按重要性排序）

### 1. 信息保真
保持所有原始信息，不要遗漏要点，也不要捏造没有的信息。

### 2. 编号 + 层次（**最重要**）
要让读者一眼看到「现在在第几层、第几个要点」：

- **分级标题**：`## 一级` / `### 二级` / `#### 三级`，最深 4 级
- **一级要点用数字编号**：`1.` / `2.` / `3.`（不要用 `-`）
- **二级要点用 4 空格缩进 + 数字编号**：
  ```
  1. 一级要点
      1. 二级要点
      2. 二级要点
  ```
- **三级要点才用 `-`**（避免编号嵌套过深）
- 同一节内同级编号必须连续不跳号

### 3. 强调
- **加粗**：用于关键术语、概念名称
- `==高亮==`：用于必须记住的核心结论 / 公式 / 名词（每段最多 2-3 处，不要滥用）
- *斜体*：用于书名 / 引用 / 强调语气

### 4. 公式 / 代码
- 行内公式：`$...$`；独占公式：`$$...$$`
- 代码块用 ` ``` ` + 语言标记（如 ` ```python `）

### 5. ⚠️ 禁止使用以下围栏（已废弃）
不要输出 ```flashcards``` / ```qa``` / ```mindmap``` / ```concept```
等任何「特殊语义围栏」—— 它们不会被特殊渲染，反而会让笔记杂乱。
所有结构信息一律靠**编号 + 缩进 + 标题层级**表达。

## 文档标题
《{title}》

## 原始内容
{current_content}

## 输出要求
**只输出排版后的 Markdown 内容**，不要解释、不要寒暄、不要在外层套 ```markdown``` 之类的代码围栏。"#,
            title = title,
            current_content = current_content,
        );

        let messages = vec![crate::llm::Message {
            role: "user".into(),
            content: prompt,
        }];

        // 2.3) 调 LLM
        let formatted = match llm.chat(&messages).await {
            Ok(s) => s,
            Err(e) => {
                let _ = app_inner.emit(
                    "note-format-error",
                    json!({ "entry_id": eid, "error": format!("LLM 调用失败: {e}") }),
                );
                return;
            }
        };

        // 2.4) 简单清理：去掉 LLM 偶尔会包裹的外层 ```markdown ... ```
        let cleaned = formatted.trim();
        let cleaned = if cleaned.starts_with("```markdown") || cleaned.starts_with("```md") {
            let after_first = cleaned.splitn(2, '\n').nth(1).unwrap_or(cleaned);
            if let Some(idx) = after_first.rfind("```") {
                after_first[..idx].trim().to_string()
            } else {
                after_first.to_string()
            }
        } else {
            cleaned.to_string()
        };

        // 2.5) 写回
        if let Ok(conn) = state_inner.db.lock() {
            if let Err(e) = db::nb_update_entry(&conn, &eid, &title, &cleaned) {
                let _ = app_inner.emit(
                    "note-format-error",
                    json!({ "entry_id": eid, "error": format!("写回数据库失败: {e}") }),
                );
                return;
            }
        }

        // 2.6) 通知完成
        let _ = app_inner.emit(
            "note-format-done",
            json!({
                "entry_id": eid,
                "content": cleaned,
                "char_count": cleaned.chars().count(),
            }),
        );
    });

    Ok(json!({
        "entry_id": entry_id,
        "started": true,
    }))
}

/// 获取单个笔记条目
#[tauri::command]
pub async fn notebook_get_entry(
    state: State<'_, AppState>,
    entry_id: String,
) -> Result<Value, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::nb_get_entry(&conn, &entry_id)
}

/// 批量导入PPT为长笔记: 接收多个PPT文件，解析并合并为一篇长笔记
#[tauri::command]
pub async fn notebook_import_ppt(
    state: State<'_, AppState>,
    notebook_id: String,
    files: Vec<Value>,
) -> Result<Value, String> {
    use base64::Engine;

    let mut all_content = String::new();
    let mut file_names: Vec<String> = Vec::new();

    for file_info in &files {
        let file_name = file_info["name"].as_str().unwrap_or("unknown.pptx").to_string();
        let file_data = file_info["data"].as_str().unwrap_or("");
        file_names.push(file_name.clone());

        let bytes = base64::engine::general_purpose::STANDARD
            .decode(file_data)
            .map_err(|e| format!("Base64 解码失败 ({}): {e}", file_name))?;

        let doc = parser::parse_pages(&file_name, &bytes)?;

        all_content.push_str(&format!("\n\n---\n\n# 📄 {}\n\n", file_name));
        for page in &doc.pages {
            if !page.content.trim().is_empty() {
                all_content.push_str(&format!("## 第 {} 页\n\n{}\n\n", page.page_index + 1, page.content));
            }
        }
    }

    let entry_id = uuid::Uuid::new_v4().to_string();
    let title = if file_names.len() == 1 {
        format!("PPT笔记: {}", file_names[0])
    } else {
        format!("PPT笔记: {} 等{}个文件", file_names[0], file_names.len())
    };
    let source = file_names.join(", ");

    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::nb_add_entry(&conn, &entry_id, &notebook_id, &title, &all_content, "ppt_import", &source)?;

    Ok(json!({
        "entry_id": entry_id,
        "title": title,
        "file_count": file_names.len(),
    }))
}

/// 智能文本标注: 对选中文本调用AI进行分析解释
#[tauri::command]
pub async fn notebook_annotate_text(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    notebook_id: String,
    selected_text: String,
    context: Option<String>,
) -> Result<Value, String> {
    let entry_id = uuid::Uuid::new_v4().to_string();
    let eid = entry_id.clone();
    let nbid = notebook_id.clone();
    let text = selected_text.clone();
    let ctx = context.unwrap_or_default();
    let state_inner = state.inner().clone();
    let app_inner = app_handle.clone();

    tokio::spawn(async move {
        let llm = {
            let models = config::load_models(&state_inner.config_path);
            let configs = config::to_llm_configs(&models);
            if !configs.is_empty() {
                LlmClient::from_pool(configs)
            } else {
                match LlmConfig::from_env() {
                    Ok(c) => LlmClient::new(c),
                    Err(e) => {
                        let _ = app_inner.emit("notebook-annotate-error", json!({
                            "entry_id": eid, "error": e
                        }));
                        return;
                    }
                }
            }
        };

        let prompt = format!(
            "请对以下文本进行详细的语义分析和解释。要求：\n\
             1. 提取关键概念和术语，给出准确定义\n\
             2. 分析文本的核心论点和逻辑结构\n\
             3. 补充相关背景知识和上下文\n\
             4. 用通俗易懂的语言重新解释难点\n\
             5. 如有专业术语，提供中英文对照\n\n\
             {}原文：\n```\n{}\n```\n\n\
             请用 Markdown 格式输出，包含清晰的标题和分段。",
            if ctx.is_empty() { String::new() } else { format!("上下文：{}\n\n", ctx) },
            text
        );

        let messages = vec![crate::llm::Message {
            role: "user".into(),
            content: prompt,
        }];

        match llm.chat(&messages).await {
            Ok(annotation) => {
                let title = format!("📝 标注: {}", if text.len() > 30 { &text[..30] } else { &text });
                let full_content = format!(
                    "## 原文\n\n> {}\n\n## AI 分析\n\n{}",
                    text, annotation
                );
                if let Ok(conn) = state_inner.db.lock() {
                    let _ = db::nb_add_entry(&conn, &eid, &nbid, &title, &full_content, "annotation", &text);
                }
                let _ = app_inner.emit("notebook-annotate-done", json!({
                    "entry_id": eid,
                    "notebook_id": nbid,
                    "title": title,
                    "content": full_content,
                }));
            }
            Err(e) => {
                log::error!("文本标注失败: {e}");
                let _ = app_inner.emit("notebook-annotate-error", json!({
                    "entry_id": eid, "error": e
                }));
            }
        }
    });

    Ok(json!({ "status": "generating", "entry_id": entry_id }))
}

/// 选页生成笔记到笔记本：对页码范围内容调用 LLM，以自动分区结构生成一份笔记本 section
/// （已废除 note_type 选择，任何传入值都会被忽略）
#[tauri::command]
pub async fn notebook_generate_from_pages(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    notebook_id: String,
    session_id: String,
    page_ranges: String,
    note_type: Option<String>,       // ← 保留参数以兼容旧前端，内部忽略
    page_contents: Option<String>,
) -> Result<Value, String> {
    let _ = note_type; // 显式忽略
    let entry_id = uuid::Uuid::new_v4().to_string();

    // 解析页码范围并获取内容
    let (combined_content, doc_title, page_indices) = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        let session = db::dr_get_session(&conn, &session_id)?;
        let doc_title = session["filename"].as_str().unwrap_or("").to_string();
        let page_count = session["page_count"].as_i64().unwrap_or(0) as usize;
        let indices = parse_page_ranges(&page_ranges, page_count)?;

        // 优先使用前端传入的内容（确保 PDF 页面与渲染一致）
        let combined = if let Some(ref pc) = page_contents {
            if !pc.trim().is_empty() {
                pc.clone()
            } else {
                let mut c = String::new();
                for idx in &indices {
                    let page = db::dr_get_page(&conn, &session_id, *idx)?;
                    let content = page["content"].as_str().unwrap_or("");
                    if !content.trim().is_empty() {
                        c.push_str(&format!("\n\n--- 第 {} 页 ---\n\n{}", idx + 1, content));
                    }
                }
                c
            }
        } else {
            let mut c = String::new();
            for idx in &indices {
                let page = db::dr_get_page(&conn, &session_id, *idx)?;
                let content = page["content"].as_str().unwrap_or("");
                if !content.trim().is_empty() {
                    c.push_str(&format!("\n\n--- 第 {} 页 ---\n\n{}", idx + 1, content));
                }
            }
            c
        };
        (combined, doc_title, indices)
    };

    if combined_content.trim().is_empty() {
        return Err("指定页面范围内没有可用内容".to_string());
    }

    let eid = entry_id.clone();
    let nbid = notebook_id.clone();
    let sid = session_id.clone();
    let ranges = page_ranges.clone();
    let state_inner = state.inner().clone();
    let app_inner = app_handle.clone();
    let page_start = page_indices.first().copied().map(|v| v as i64);
    let page_end = page_indices.last().copied().map(|v| v as i64);
    let page_idx_json = serde_json::to_string(&page_indices).unwrap_or_else(|_| "[]".to_string());

    tokio::spawn(async move {
        let llm = match build_llm_or_emit(&state_inner, &app_inner,
            "notebook-page-range-error", &eid).await { Some(v) => v, None => return };

        let source_label = format!("第 {} 页", ranges);
        match doc_reader::generate_auto_section(&llm, &doc_title, &source_label, &combined_content, None).await {
            Ok(note_content) => {
                // Round 3: 语义化标题（失败时回退）
                let title = match doc_reader::generate_section_title(&llm, &doc_title, &note_content, Some("页范围自动节")).await {
                    Ok(t) => doc_reader::sanitize_generated_title(&t),
                    Err(_) => format!("第{}页笔记", ranges),
                };
                let kind = if page_indices.len() > 1 { "page_range" } else { "single_page" };
                let anchor = db::NbAnchor {
                    source_session_id: sid.clone(),
                    source_page_start: page_start,
                    source_page_end: page_end,
                    source_page_indexes: page_idx_json.clone(),
                    source_kind: kind.to_string(),
                    parent_entry_id: String::new(),
                    section_role: "root_note".to_string(),
                    chat_history_json: String::new(),
                };
                if let Ok(conn) = state_inner.db.lock() {
                    let _ = db::nb_add_entry_anchored(&conn, &eid, &nbid, &title, &note_content,
                        kind, &source_label, &anchor);
                }
                // 新事件（供 notebook.js 订阅并滚动到新 section）
                let _ = app_inner.emit("notebook-section-generated", json!({
                    "entry_id": eid, "notebook_id": nbid, "parent_entry_id": "",
                    "section_role": "root_note", "source_session_id": sid,
                    "source_page_start": page_start, "source_page_end": page_end,
                }));
                // 兼容老前端
                let _ = app_inner.emit("notebook-page-range-done", json!({
                    "entry_id": eid, "notebook_id": nbid, "title": title, "content": note_content,
                }));
            }
            Err(e) => {
                log::error!("选页笔记生成失败: {e}");
                let _ = app_inner.emit("notebook-page-range-error", json!({
                    "entry_id": eid, "error": e
                }));
            }
        }
    });

    Ok(json!({ "status": "generating", "entry_id": entry_id }))
}

/// 选文生成笔记到笔记本：对选中文本调用 LLM，以自动分区结构生成一份笔记本 section
/// （已废除 note_type 选择，任何传入值都会被忽略）
#[tauri::command]
pub async fn notebook_generate_from_text(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    notebook_id: String,
    session_id: String,
    selected_text: String,
    note_type: Option<String>,        // ← 保留参数兼容旧前端，内部忽略
    page_index: Option<usize>,
    custom_prompt: Option<String>,
) -> Result<Value, String> {
    let _ = note_type;
    let entry_id = uuid::Uuid::new_v4().to_string();

    let doc_title = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        let session = db::dr_get_session(&conn, &session_id)?;
        session["filename"].as_str().unwrap_or("").to_string()
    };

    if selected_text.trim().is_empty() {
        return Err("文本内容不能为空".to_string());
    }

    let eid = entry_id.clone();
    let nbid = notebook_id.clone();
    let sid = session_id.clone();
    let text = selected_text.clone();
    let pidx = page_index;
    let cprompt = custom_prompt;
    let state_inner = state.inner().clone();
    let app_inner = app_handle.clone();

    tokio::spawn(async move {
        let llm = match build_llm_or_emit(&state_inner, &app_inner,
            "notebook-text-note-error", &eid).await { Some(v) => v, None => return };

        let source_label = match pidx {
            Some(p) => format!("选中文本（第 {} 页）", p + 1),
            None => "选中文本".to_string(),
        };
        match doc_reader::generate_auto_section(&llm, &doc_title, &source_label, &text, cprompt.as_deref()).await {
            Ok(note_content) => {
                let title_truncated: String = text.chars().take(30).collect();
                let title = format!("📝 选文笔记: {}{}", title_truncated, if text.chars().count() > 30 { "…" } else { "" });
                let source_preview = if text.chars().count() > 100 {
                    let s: String = text.chars().take(100).collect();
                    format!("{}...", s)
                } else { text.clone() };
                let page_indices_json = pidx
                    .map(|p| serde_json::to_string(&vec![p]).unwrap_or_else(|_| "[]".to_string()))
                    .unwrap_or_else(|| "[]".to_string());
                let anchor = db::NbAnchor {
                    source_session_id: sid.clone(),
                    source_page_start: pidx.map(|v| v as i64),
                    source_page_end: pidx.map(|v| v as i64),
                    source_page_indexes: page_indices_json,
                    source_kind: "text_select".to_string(),
                    parent_entry_id: String::new(),
                    section_role: "root_note".to_string(),
                    chat_history_json: String::new(),
                };
                if let Ok(conn) = state_inner.db.lock() {
                    let _ = db::nb_add_entry_anchored(&conn, &eid, &nbid, &title, &note_content,
                        "text_select", &source_preview, &anchor);
                }
                let _ = app_inner.emit("notebook-section-generated", json!({
                    "entry_id": eid, "notebook_id": nbid, "parent_entry_id": "",
                    "section_role": "root_note", "source_session_id": sid,
                    "source_page_start": pidx, "source_page_end": pidx,
                }));
                let _ = app_inner.emit("notebook-text-note-done", json!({
                    "entry_id": eid, "notebook_id": nbid, "title": title, "content": note_content,
                }));
            }
            Err(e) => {
                log::error!("选文笔记生成失败: {e}");
                let _ = app_inner.emit("notebook-text-note-error", json!({
                    "entry_id": eid, "error": e
                }));
            }
        }
    });

    Ok(json!({ "status": "generating", "entry_id": entry_id }))
}

/// 解析页码范围字符串，如 "1-5, 8, 12-15" → [0, 1, 2, 3, 4, 7, 11, 12, 13, 14]
fn parse_page_ranges(ranges: &str, page_count: usize) -> Result<Vec<usize>, String> {
    let mut indices = Vec::new();
    for part in ranges.split(',') {
        let part = part.trim();
        if part.is_empty() { continue; }
        if part.contains('-') {
            let bounds: Vec<&str> = part.split('-').collect();
            if bounds.len() != 2 {
                return Err(format!("无效的页码范围: {}", part));
            }
            let start: usize = bounds[0].trim().parse::<usize>()
                .map_err(|_| format!("无效的页码: {}", bounds[0].trim()))?;
            let end: usize = bounds[1].trim().parse::<usize>()
                .map_err(|_| format!("无效的页码: {}", bounds[1].trim()))?;
            if start == 0 || end == 0 || start > end {
                return Err(format!("无效的页码范围: {}", part));
            }
            if end > page_count {
                return Err(format!("页码 {} 超出范围（共 {} 页）", end, page_count));
            }
            for i in start..=end {
                indices.push(i - 1); // 转为0-indexed
            }
        } else {
            let page: usize = part.parse::<usize>()
                .map_err(|_| format!("无效的页码: {}", part))?;
            if page == 0 || page > page_count {
                return Err(format!("页码 {} 超出范围（共 {} 页）", page, page_count));
            }
            indices.push(page - 1);
        }
    }
    indices.sort();
    indices.dedup();
    if indices.is_empty() {
        return Err("未指定有效的页码".to_string());
    }
    Ok(indices)
}

// ══════════════════════════════════════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════════════════════════════════════

/// 统一获取 LLM 客户端；获取失败时向前端 emit 给定错误事件并返回 None
async fn build_llm_or_emit(
    state: &AppState,
    app: &AppHandle,
    error_event: &str,
    entry_id: &str,
) -> Option<LlmClient> {
    let models = config::load_models(&state.config_path);
    let configs = config::to_llm_configs(&models);
    if !configs.is_empty() {
        return Some(LlmClient::from_pool(configs));
    }
    match LlmConfig::from_env() {
        Ok(c) => Some(LlmClient::new(c)),
        Err(e) => {
            let _ = app.emit(error_event, json!({ "entry_id": entry_id, "error": e }));
            None
        }
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// Notebook: Auto-section / Append-explanation / Section-chat / Page-lookup
// ══════════════════════════════════════════════════════════════════════════════

/// 内部共享 helper：为单页生成 section，写入 DB 并 emit `notebook-section-generated`。
/// 不 emit 任何错误事件，错误向调用方原样返回，由调用方决定后续动作。
/// `notebook_generate_auto_section`（spawn 一次）/`notebook_generate_serial_next_pages`
/// （循环 await）共用此 helper，保证逻辑单点维护。
async fn generate_and_write_one_page(
    state: &AppState,
    app: &AppHandle,
    llm: &LlmClient,
    notebook_id: &str,
    session_id: &str,
    doc_title: &str,
    page_index: usize,
    page_content: &str,
    custom_prompt: Option<&str>,
    entry_id_hint: Option<String>,
) -> Result<String, String> {
    if page_content.trim().is_empty() {
        return Err(format!("第 {} 页没有可用内容", page_index + 1));
    }
    let source_label = format!("第 {} 页", page_index + 1);
    let note_content = doc_reader::generate_auto_section(
        llm, doc_title, &source_label, page_content, custom_prompt,
    ).await?;

    // 直接从首个 `## ` 行抠出 section 标题，省掉一次 LLM 调用
    let title = doc_reader::extract_section_title_from_md(&note_content)
        .unwrap_or_else(|| format!("第 {} 页笔记", page_index + 1));

    let eid = entry_id_hint.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let anchor = db::NbAnchor {
        source_session_id: session_id.to_string(),
        source_page_start: Some(page_index as i64),
        source_page_end: Some(page_index as i64),
        source_page_indexes: serde_json::to_string(&vec![page_index])
            .unwrap_or_else(|_| "[]".to_string()),
        source_kind: "single_page".to_string(),
        parent_entry_id: String::new(),
        section_role: "root_note".to_string(),
        chat_history_json: String::new(),
    };
    {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        db::nb_add_entry_anchored(
            &conn, &eid, notebook_id, &title, &note_content,
            "single_page", &source_label, &anchor,
        )?;
    }
    // 写库后立即广播；前端 `notebook-section-generated` 监听会刷新条目并滚动到新 section
    let _ = app.emit("notebook-section-generated", json!({
        "entry_id": eid,
        "notebook_id": notebook_id,
        "parent_entry_id": "",
        "section_role": "root_note",
        "source_session_id": session_id,
        "source_page_start": page_index,
        "source_page_end": page_index,
    }));
    Ok(eid)
}

/// 读取一页的内容；若已传入 page_content 则优先用它。
fn resolve_page_content(
    state: &AppState,
    session_id: &str,
    page_index: usize,
    page_content: Option<String>,
) -> Result<(String, String), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let session = db::dr_get_session(&conn, session_id)?;
    let doc_title = session["filename"].as_str().unwrap_or("").to_string();
    let content = match page_content {
        Some(c) if !c.trim().is_empty() => c,
        _ => {
            let p = db::dr_get_page(&conn, session_id, page_index)?;
            p["content"].as_str().unwrap_or("").to_string()
        }
    };
    Ok((doc_title, content))
}

/// 为单页自动生成一段笔记本 section（已废除类型选择）
#[tauri::command]
pub async fn notebook_generate_auto_section(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    notebook_id: String,
    session_id: String,
    page_index: usize,
    page_content: Option<String>,
    custom_prompt: Option<String>,
) -> Result<Value, String> {
    let entry_id = uuid::Uuid::new_v4().to_string();
    let (doc_title, content) = resolve_page_content(state.inner(), &session_id, page_index, page_content)?;
    if content.trim().is_empty() {
        return Err(format!("第 {} 页没有可用内容", page_index + 1));
    }

    let eid = entry_id.clone();
    let nbid = notebook_id.clone();
    let sid = session_id.clone();
    let state_inner = state.inner().clone();
    let app_inner = app_handle.clone();

    tokio::spawn(async move {
        let llm = match build_llm_or_emit(&state_inner, &app_inner,
            "notebook-section-error", &eid).await { Some(v) => v, None => return };

        if let Err(e) = generate_and_write_one_page(
            &state_inner, &app_inner, &llm,
            &nbid, &sid, &doc_title, page_index, &content,
            custom_prompt.as_deref(), Some(eid.clone()),
        ).await {
            log::error!("自动 section 生成失败: {e}");
            let _ = app_inner.emit("notebook-section-error", json!({
                "entry_id": eid, "error": e
            }));
        }
    });

    Ok(json!({ "status": "generating", "entry_id": entry_id }))
}

/// 为整篇文档的每一页都自动生成 section（并发）
#[tauri::command]
pub async fn notebook_generate_auto_sections_for_all(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    notebook_id: String,
    session_id: String,
) -> Result<Value, String> {
    let (doc_title, page_count) = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        let session = db::dr_get_session(&conn, &session_id)?;
        (
            session["filename"].as_str().unwrap_or("").to_string(),
            session["page_count"].as_i64().unwrap_or(0) as usize,
        )
    };

    let sid = session_id.clone();
    let nbid = notebook_id.clone();
    let state_inner = state.inner().clone();
    let app_inner = app_handle.clone();

    tokio::spawn(async move {
        let llm = match build_llm_or_emit(&state_inner, &app_inner,
            "notebook-generate-all-error", "").await { Some(v) => v, None => return };

        let mut pages: Vec<(usize, String)> = Vec::new();
        for idx in 0..page_count {
            let content = {
                if let Ok(conn) = state_inner.db.lock() {
                    db::dr_get_page(&conn, &sid, idx).ok()
                        .and_then(|p| p["content"].as_str().map(|s| s.to_string()))
                        .unwrap_or_default()
                } else { String::new() }
            };
            if !content.trim().is_empty() { pages.push((idx, content)); }
        }
        let total = pages.len();
        let completed = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let concurrency = 4usize.min(total.max(1));

        stream::iter(pages)
            .for_each_concurrent(concurrency, |(page_idx, page_content)| {
                let llm = &llm;
                let doc_title = &doc_title;
                let sid = &sid;
                let nbid = &nbid;
                let state_inner = &state_inner;
                let app_inner = &app_inner;
                let completed = &completed;
                async move {
                    let source_label = format!("第 {} 页", page_idx + 1);
                    let result = doc_reader::generate_auto_section(llm, doc_title, &source_label, &page_content, None).await;
                    match result {
                        Ok(note_content) => {
                            let eid = uuid::Uuid::new_v4().to_string();
                            let title = doc_reader::extract_section_title_from_md(&note_content)
                                .unwrap_or_else(|| format!("第 {} 页笔记", page_idx + 1));
                            let anchor = db::NbAnchor {
                                source_session_id: sid.clone(),
                                source_page_start: Some(page_idx as i64),
                                source_page_end: Some(page_idx as i64),
                                source_page_indexes: serde_json::to_string(&vec![page_idx]).unwrap_or_else(|_| "[]".to_string()),
                                source_kind: "single_page".to_string(),
                                parent_entry_id: String::new(),
                                section_role: "root_note".to_string(),
                                chat_history_json: String::new(),
                            };
                            if let Ok(conn) = state_inner.db.lock() {
                                let _ = db::nb_add_entry_anchored(&conn, &eid, nbid, &title, &note_content,
                                    "single_page", &source_label, &anchor);
                            }
                            let done = completed.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
                            let _ = app_inner.emit("notebook-section-generated", json!({
                                "entry_id": eid, "notebook_id": nbid, "parent_entry_id": "",
                                "section_role": "root_note", "source_session_id": sid,
                                "source_page_start": page_idx, "source_page_end": page_idx,
                            }));
                            let _ = app_inner.emit("notebook-generate-all-progress", json!({
                                "notebook_id": nbid, "session_id": sid, "completed": done, "total": total,
                            }));
                            // 兼容旧事件
                            let _ = app_inner.emit("doc-generate-all-progress", json!({
                                "session_id": sid, "completed": done, "total": total,
                            }));
                        }
                        Err(e) => {
                            log::error!("批量 section 生成失败: page {} - {}", page_idx, e);
                            let done = completed.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
                            let _ = app_inner.emit("notebook-generate-all-progress", json!({
                                "notebook_id": nbid, "session_id": sid, "completed": done, "total": total, "error": e,
                            }));
                        }
                    }
                }
            })
            .await;

        let final_done = completed.load(std::sync::atomic::Ordering::Relaxed);
        let _ = app_inner.emit("notebook-generate-all-done", json!({
            "notebook_id": nbid, "session_id": sid, "completed": final_done, "total": total,
        }));
        // 兼容旧事件
        let _ = app_inner.emit("doc-generate-all-done", json!({
            "session_id": sid, "success": true, "completed": final_done,
        }));
    });

    Ok(json!({ "status": "generating", "total": page_count }))
}

/// 串行生成从 `start_page` 起的 `count` 页笔记。每完成一页立即写入 DB 并 emit
/// `notebook-section-generated` + `notebook-serial-progress`，用户能看到笔记
/// 一页一页地出现。失败页跳过、不阻塞后续页。
#[tauri::command]
pub async fn notebook_generate_serial_next_pages(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    notebook_id: String,
    session_id: String,
    start_page: usize,
    count: usize,
) -> Result<Value, String> {
    let (doc_title, page_count) = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        let session = db::dr_get_session(&conn, &session_id)?;
        (
            session["filename"].as_str().unwrap_or("").to_string(),
            session["page_count"].as_i64().unwrap_or(0) as usize,
        )
    };
    if page_count == 0 {
        return Err("文档没有可用页".into());
    }
    let end_page = (start_page + count).min(page_count);
    if start_page >= end_page {
        return Err("没有可生成的页".into());
    }
    let total = end_page - start_page;

    let sid = session_id.clone();
    let nbid = notebook_id.clone();
    let state_inner = state.inner().clone();
    let app_inner = app_handle.clone();

    tokio::spawn(async move {
        let llm = match build_llm_or_emit(&state_inner, &app_inner,
            "notebook-serial-error", "").await { Some(v) => v, None => return };

        let mut completed = 0usize;
        for offset in 0..total {
            let page_idx = start_page + offset;
            // 复用 resolve_page_content：和单页生成读同一份页内容
            let content = match resolve_page_content(&state_inner, &sid, page_idx, None) {
                Ok((_dt, c)) => c,
                Err(_) => String::new(),
            };
            if content.trim().is_empty() {
                let _ = app_inner.emit("notebook-serial-progress", json!({
                    "notebook_id": nbid, "session_id": sid,
                    "completed": completed, "total": total,
                    "page_index": page_idx, "skipped": true,
                }));
                continue;
            }

            // 嵌套调用单页生成的核心 helper —— 与 `notebook_generate_auto_section`
            // 共享同一段 generate→DB→emit 逻辑（不再重写）。完成时 helper 已内部
            // emit 了 `notebook-section-generated`，前端会立即刷新条目列表，
            // 这就是"一页生成完立即写入笔记本"的关键。
            match generate_and_write_one_page(
                &state_inner, &app_inner, &llm,
                &nbid, &sid, &doc_title, page_idx, &content, None, None,
            ).await {
                Ok(eid) => {
                    completed += 1;
                    let _ = app_inner.emit("notebook-serial-progress", json!({
                        "notebook_id": nbid, "session_id": sid,
                        "completed": completed, "total": total,
                        "page_index": page_idx, "entry_id": eid,
                    }));
                }
                Err(e) => {
                    log::error!("串行生成失败: page {} - {}", page_idx, e);
                    let _ = app_inner.emit("notebook-serial-progress", json!({
                        "notebook_id": nbid, "session_id": sid,
                        "completed": completed, "total": total,
                        "page_index": page_idx, "error": e,
                    }));
                }
            }
            // 让出执行权，确保前面的 emit 已经被前端处理（避免被同一 tick 内的下一次 LLM 调用淹没）
            tokio::task::yield_now().await;
        }

        let _ = app_inner.emit("notebook-serial-done", json!({
            "notebook_id": nbid, "session_id": sid,
            "completed": completed, "total": total,
            "start_page": start_page, "end_page": end_page,
        }));
    });

    Ok(json!({ "status": "generating", "total": total, "start_page": start_page, "end_page": end_page }))
}

/// 针对已有笔记 section 追加一份「深入讲解」子 section
#[tauri::command]
pub async fn notebook_append_explanation(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    parent_entry_id: String,
    user_hint: Option<String>,
) -> Result<Value, String> {
    let (notebook_id, doc_title, parent_section_md, original_content, anchor_base) = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        let parent = db::nb_get_entry(&conn, &parent_entry_id)?;
        let notebook_id = parent["notebook_id"].as_str().unwrap_or("").to_string();
        let parent_md = parent["content"].as_str().unwrap_or("").to_string();
        let session_id = parent["source_session_id"].as_str().unwrap_or("").to_string();
        let page_start = parent["source_page_start"].as_i64();
        let page_end = parent["source_page_end"].as_i64();
        let page_indexes = parent["source_page_indexes"].as_str().unwrap_or("").to_string();

        // 原始内容 = 锚定页的 doc_pages 内容（若存在）
        let mut original = String::new();
        if !session_id.is_empty() {
            if let (Some(ps), Some(pe)) = (page_start, page_end) {
                for idx in ps..=pe {
                    if let Ok(p) = db::dr_get_page(&conn, &session_id, idx as usize) {
                        if let Some(c) = p["content"].as_str() {
                            original.push_str(&format!("\n\n--- 第 {} 页 ---\n\n{}", idx + 1, c));
                        }
                    }
                }
            }
        }
        let doc_title = if !session_id.is_empty() {
            db::dr_get_session(&conn, &session_id).ok()
                .and_then(|s| s["filename"].as_str().map(|v| v.to_string()))
                .unwrap_or_default()
        } else { String::new() };

        let anchor_base = db::NbAnchor {
            source_session_id: session_id,
            source_page_start: page_start,
            source_page_end: page_end,
            source_page_indexes: page_indexes,
            source_kind: "explain".to_string(),
            parent_entry_id: parent_entry_id.clone(),
            section_role: "deep_explain".to_string(),
            chat_history_json: String::new(),
        };
        (notebook_id, doc_title, parent_md, original, anchor_base)
    };

    let eid = uuid::Uuid::new_v4().to_string();
    let eid2 = eid.clone();
    let nbid = notebook_id.clone();
    let state_inner = state.inner().clone();
    let app_inner = app_handle.clone();
    let parent_id = parent_entry_id.clone();

    tokio::spawn(async move {
        let llm = match build_llm_or_emit(&state_inner, &app_inner,
            "notebook-section-error", &eid2).await { Some(v) => v, None => return };

        match doc_reader::generate_deep_explanation(&llm, &doc_title,
            &parent_section_md, &original_content, user_hint.as_deref()).await {
            Ok(explain_md) => {
                // Round 3: 给追加讲解也起一个知识性标题
                let title = match doc_reader::generate_section_title(&llm, &doc_title, &explain_md, Some("追加讲解子节")).await {
                    Ok(t) => doc_reader::sanitize_generated_title(&t),
                    Err(_) => "追加讲解".to_string(),
                };
                if let Ok(conn) = state_inner.db.lock() {
                    let _ = db::nb_add_entry_anchored(&conn, &eid2, &nbid, &title, &explain_md,
                        "explain", &format!("追加于 {}", parent_id), &anchor_base);
                }
                let _ = app_inner.emit("notebook-section-generated", json!({
                    "entry_id": eid2, "notebook_id": nbid,
                    "parent_entry_id": parent_id,
                    "section_role": "deep_explain",
                    "source_session_id": anchor_base.source_session_id,
                    "source_page_start": anchor_base.source_page_start,
                    "source_page_end": anchor_base.source_page_end,
                }));
            }
            Err(e) => {
                log::error!("追加讲解失败: {e}");
                let _ = app_inner.emit("notebook-section-error", json!({
                    "entry_id": eid2, "error": e
                }));
            }
        }
    });

    Ok(json!({ "status": "generating", "entry_id": eid }))
}

/// 对某 section 进行嵌入式聊天；返回助手回复并写回 chat_history_json
#[tauri::command]
pub async fn notebook_section_chat(
    state: State<'_, AppState>,
    entry_id: String,
    question: String,
) -> Result<Value, String> {
    if question.trim().is_empty() {
        return Err("问题不能为空".to_string());
    }

    let (doc_title, section_md, source_md, mut history) = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        let entry = db::nb_get_entry(&conn, &entry_id)?;
        let section_md = entry["content"].as_str().unwrap_or("").to_string();
        let session_id = entry["source_session_id"].as_str().unwrap_or("").to_string();
        let page_start = entry["source_page_start"].as_i64();
        let page_end = entry["source_page_end"].as_i64();
        let history_json = entry["chat_history_json"].as_str().unwrap_or("").to_string();

        let mut source_md = String::new();
        if !session_id.is_empty() {
            if let (Some(ps), Some(pe)) = (page_start, page_end) {
                for idx in ps..=pe {
                    if let Ok(p) = db::dr_get_page(&conn, &session_id, idx as usize) {
                        if let Some(c) = p["content"].as_str() {
                            source_md.push_str(&format!("\n\n--- 第 {} 页 ---\n\n{}", idx + 1, c));
                        }
                    }
                }
            }
        }
        let doc_title = if !session_id.is_empty() {
            db::dr_get_session(&conn, &session_id).ok()
                .and_then(|s| s["filename"].as_str().map(|v| v.to_string()))
                .unwrap_or_default()
        } else { String::new() };

        let history: Vec<(String, String)> = if history_json.trim().is_empty() {
            Vec::new()
        } else {
            serde_json::from_str::<Vec<Value>>(&history_json).ok().map(|arr| {
                arr.into_iter().filter_map(|v| {
                    let r = v["role"].as_str()?.to_string();
                    let c = v["content"].as_str()?.to_string();
                    Some((r, c))
                }).collect()
            }).unwrap_or_default()
        };
        (doc_title, section_md, source_md, history)
    };

    let llm = {
        let models = config::load_models(&state.config_path);
        let configs = config::to_llm_configs(&models);
        if !configs.is_empty() { LlmClient::from_pool(configs) }
        else { LlmClient::new(LlmConfig::from_env()?) }
    };

    let answer = doc_reader::section_chat(&llm, &doc_title, &section_md, &source_md, &question, &history).await?;

    history.push(("user".to_string(), question));
    history.push(("assistant".to_string(), answer.clone()));
    let history_value: Vec<Value> = history.iter().map(|(r, c)| json!({ "role": r, "content": c })).collect();
    let history_json = serde_json::to_string(&history_value).unwrap_or_else(|_| "[]".to_string());

    {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        db::nb_update_chat_history(&conn, &entry_id, &history_json)?;
    }

    Ok(json!({ "answer": answer, "history": history_value }))
}

/// Round 6: 让聊天直接操控笔记内容
/// action:
///   - "append"      → 把 content 追加到 entry.content（带分隔横线）
///   - "replace"     → 用 content 替换 entry.content
///   - "prepend"     → 把 content 插到 entry.content 前
///   - "spawn_child" → 在同笔记本下新建一个 chat_append 子 section，parent 指向 entry_id
///   - "clear_chat"  → 清空 entry 的 chat_history_json
#[tauri::command]
pub async fn notebook_apply_chat_action(
    app: AppHandle,
    state: State<'_, AppState>,
    entry_id: String,
    action: String,
    content: String,
    title: Option<String>,
) -> Result<Value, String> {
    let action = action.trim().to_lowercase();
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let entry = db::nb_get_entry(&conn, &entry_id)?;
    let cur_title = entry["title"].as_str().unwrap_or("").to_string();
    let cur_content = entry["content"].as_str().unwrap_or("").to_string();
    let notebook_id = entry["notebook_id"].as_str().unwrap_or("").to_string();

    match action.as_str() {
        "append" => {
            let new_content = if cur_content.trim().is_empty() {
                content.clone()
            } else {
                format!("{}\n\n---\n\n{}", cur_content.trim_end(), content.trim())
            };
            db::nb_update_entry(&conn, &entry_id, &cur_title, &new_content)?;
            drop(conn);
            let _ = app.emit("notebook-entry-updated", json!({
                "entry_id": entry_id, "action": "append"
            }));
            Ok(json!({ "status": "ok", "action": "append", "entry_id": entry_id }))
        }
        "prepend" => {
            let new_content = if cur_content.trim().is_empty() {
                content.clone()
            } else {
                format!("{}\n\n---\n\n{}", content.trim(), cur_content.trim_start())
            };
            db::nb_update_entry(&conn, &entry_id, &cur_title, &new_content)?;
            drop(conn);
            let _ = app.emit("notebook-entry-updated", json!({
                "entry_id": entry_id, "action": "prepend"
            }));
            Ok(json!({ "status": "ok", "action": "prepend", "entry_id": entry_id }))
        }
        "replace" => {
            db::nb_update_entry(&conn, &entry_id, &cur_title, &content)?;
            drop(conn);
            let _ = app.emit("notebook-entry-updated", json!({
                "entry_id": entry_id, "action": "replace"
            }));
            Ok(json!({ "status": "ok", "action": "replace", "entry_id": entry_id }))
        }
        "spawn_child" => {
            let new_id = uuid::Uuid::new_v4().to_string();
            let title_str = title
                .as_deref()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| {
                    // 取 content 第一行作为兜底标题
                    content
                        .lines()
                        .find(|l| !l.trim().is_empty())
                        .unwrap_or("AI 补充")
                        .trim_start_matches(|c: char| c == '#' || c.is_whitespace())
                        .chars()
                        .take(30)
                        .collect::<String>()
                });
            let mut anchor = db::NbAnchor::default();
            anchor.source_session_id = entry["source_session_id"]
                .as_str()
                .unwrap_or("")
                .to_string();
            anchor.source_page_start = entry["source_page_start"].as_i64();
            anchor.source_page_end = entry["source_page_end"].as_i64();
            anchor.source_kind = "chat_append".to_string();
            anchor.parent_entry_id = entry_id.clone();
            anchor.section_role = "chat_append".to_string();
            db::nb_add_entry_anchored(
                &conn,
                &new_id,
                &notebook_id,
                &title_str,
                &content,
                "note",
                "AI 对话生成",
                &anchor,
            )?;
            drop(conn);
            let _ = app.emit("notebook-entry-updated", json!({
                "entry_id": new_id, "parent_entry_id": entry_id,
                "action": "spawn_child", "notebook_id": notebook_id
            }));
            Ok(json!({
                "status": "ok", "action": "spawn_child",
                "entry_id": new_id, "parent_entry_id": entry_id
            }))
        }
        "clear_chat" => {
            db::nb_update_chat_history(&conn, &entry_id, "[]")?;
            Ok(json!({ "status": "ok", "action": "clear_chat", "entry_id": entry_id }))
        }
        other => Err(format!("不支持的动作：{}", other)),
    }
}

/// 查询某笔记本中锚定到指定 session 某一页的所有条目（用于翻页联动滚动）
#[tauri::command]
pub async fn notebook_get_entries_for_page(
    state: State<'_, AppState>,
    notebook_id: String,
    session_id: String,
    page_index: i64,
) -> Result<Value, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let entries = db::nb_entries_for_page(&conn, &notebook_id, &session_id, page_index)?;
    Ok(json!({ "entries": entries }))
}

/// 返回笔记本的结构化大纲（按 source_session_id 分组，root_note 嵌套其 deep_explain / chat_append 子项）。
/// 输出形如：
/// { "notebook": {...}, "zones": [ { "session_id", "doc_title", "entry_count", "page_range": [start,end],
///   "roots": [ { "entry": {...}, "children": [ {...}, ... ] }, ... ],
///   "orphan_children": [...] } ], "total_entries": N }
#[tauri::command]
pub async fn notebook_get_outline(
    state: State<'_, AppState>,
    notebook_id: String,
) -> Result<Value, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let nb = db::nb_get(&conn, &notebook_id)?;
    let entries = db::nb_list_entries(&conn, &notebook_id)?;

    // 先按 source_session_id 分组
    use std::collections::BTreeMap;
    let mut zones: BTreeMap<String, Vec<Value>> = BTreeMap::new();
    for e in entries.iter() {
        let sid = e["source_session_id"].as_str().unwrap_or("").to_string();
        zones.entry(sid).or_default().push(e.clone());
    }

    // 解析文档标题
    let mut zone_list: Vec<Value> = Vec::new();
    for (sid, items) in zones.into_iter() {
        let doc_title = if sid.is_empty() {
            "未锚定到文档".to_string()
        } else {
            db::dr_get_session(&conn, &sid).ok()
                .and_then(|s| s["filename"].as_str().map(|v| v.to_string()))
                .unwrap_or_else(|| "已删除的文档".to_string())
        };

        // 组织父子关系：root_note 作为顶层，其它挂到 parent_entry_id
        let mut roots: Vec<Value> = Vec::new();
        let mut children_map: BTreeMap<String, Vec<Value>> = BTreeMap::new();
        for it in items.iter() {
            let parent = it["parent_entry_id"].as_str().unwrap_or("").to_string();
            if parent.is_empty() {
                roots.push(it.clone());
            } else {
                children_map.entry(parent).or_default().push(it.clone());
            }
        }

        // 计算页码范围
        let mut min_page: Option<i64> = None;
        let mut max_page: Option<i64> = None;
        for it in items.iter() {
            if let Some(s) = it["source_page_start"].as_i64() {
                min_page = Some(min_page.map_or(s, |m| m.min(s)));
            }
            if let Some(e) = it["source_page_end"].as_i64() {
                max_page = Some(max_page.map_or(e, |m| m.max(e)));
            }
        }

        // 组装
        let mut root_nodes: Vec<Value> = Vec::new();
        for r in roots.iter() {
            let rid = r["entry_id"].as_str().unwrap_or("").to_string();
            let children = children_map.remove(&rid).unwrap_or_default();
            root_nodes.push(json!({
                "entry": r.clone(),
                "children": children,
            }));
        }
        // 没有父的孤儿（父已被删）
        let mut orphans: Vec<Value> = Vec::new();
        for (_, v) in children_map.into_iter() {
            for c in v { orphans.push(c); }
        }

        zone_list.push(json!({
            "session_id": sid,
            "doc_title": doc_title,
            "entry_count": items.len(),
            "page_range": [min_page, max_page],
            "roots": root_nodes,
            "orphan_children": orphans,
        }));
    }

    // 排序：有 session 的在前，按 doc_title
    zone_list.sort_by(|a, b| {
        let a_sid = a["session_id"].as_str().unwrap_or("");
        let b_sid = b["session_id"].as_str().unwrap_or("");
        match (a_sid.is_empty(), b_sid.is_empty()) {
            (true, false) => std::cmp::Ordering::Greater,
            (false, true) => std::cmp::Ordering::Less,
            _ => a["doc_title"].as_str().unwrap_or("").cmp(b["doc_title"].as_str().unwrap_or("")),
        }
    });

    let total_entries = zone_list.iter()
        .map(|z| z["entry_count"].as_u64().unwrap_or(0))
        .sum::<u64>();

    Ok(json!({
        "notebook": nb,
        "zones": zone_list,
        "total_entries": total_entries,
    }))
}

// ══════════════════════════════════════════════════════════════════════════════
// Round 3: Notebook 知识区一键排版
// ══════════════════════════════════════════════════════════════════════════════

/// 判断某标题是否像"系统自动生成的标签式标题"，需要被重写。
fn is_bad_auto_title(title: &str) -> bool {
    let t = title.trim();
    if t.is_empty() || t == "无标题" { return true; }
    // emoji / 页码 / 系统字样
    for bad in [
        "📖", "📄", "💡", "📝", "🔖", "🔹",
        "第 ", "第", "自动笔记", "追加讲解", "嵌入问答",
        "来源：", "来源:", "Page ",
    ] {
        if t.starts_with(bad) { return true; }
    }
    if t.contains("· 自动笔记") || t.contains("页笔记") || t.contains("页 · ") { return true; }
    // 看起来像 "第 X 页"
    if t.chars().any(|c| c == '页') && t.chars().filter(|c| c.is_ascii_digit()).count() >= 1 {
        if t.starts_with("第") || t.contains("第 ") { return true; }
    }
    false
}

/// 一键排版笔记本知识区：重写 bad title，并按 (session_id, page_start, 父子关系) 稳定重排。
/// （不调用 LLM 做 zone 聚合，只做基于 **现有锚点** 的稳定重排 + bad-title 重写；这让命令是可预期的、
/// 无需等待长时间 LLM 调用。若需更进一步的语义重分区，可在后续扩展。）
#[tauri::command]
pub async fn notebook_relayout_knowledge_zones(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    notebook_id: String,
) -> Result<Value, String> {
    // Snapshot: 读出所有 entries + doc titles
    let (mut entries, doc_titles): (Vec<Value>, std::collections::HashMap<String, String>) = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        let entries = db::nb_list_entries(&conn, &notebook_id)?;
        let mut tm = std::collections::HashMap::new();
        for e in entries.iter() {
            let sid = e["source_session_id"].as_str().unwrap_or("").to_string();
            if !sid.is_empty() && !tm.contains_key(&sid) {
                if let Ok(s) = db::dr_get_session(&conn, &sid) {
                    tm.insert(sid, s["filename"].as_str().unwrap_or("").to_string());
                }
            }
        }
        (entries, tm)
    };
    let total = entries.len();
    if total == 0 {
        return Ok(json!({ "status": "empty", "relabeled": 0, "reordered": 0 }));
    }

    // 找出所有 bad-title 的 entry
    let to_relabel: Vec<(String, String, String)> = entries.iter().filter_map(|e| {
        let eid = e["entry_id"].as_str().unwrap_or("").to_string();
        let title = e["title"].as_str().unwrap_or("").to_string();
        let content = e["content"].as_str().unwrap_or("").to_string();
        if is_bad_auto_title(&title) { Some((eid, title, content)) } else { None }
    }).collect();

    let app_inner = app_handle.clone();
    let _ = app_inner.emit("notebook-relayout-progress", json!({
        "notebook_id": notebook_id, "stage": "start",
        "total_entries": total, "to_relabel": to_relabel.len(),
    }));

    let mut relabeled = 0usize;
    if !to_relabel.is_empty() {
        // LLM 批量重写标题（并发，限制 4）
        let llm = {
            let models = config::load_models(&state.config_path);
            let configs = config::to_llm_configs(&models);
            if !configs.is_empty() { LlmClient::from_pool(configs) }
            else { LlmClient::new(LlmConfig::from_env()?) }
        };
        let state_inner = state.inner().clone();
        let nb_ref = notebook_id.clone();
        let app_ref = app_handle.clone();
        let dt_ref = doc_titles.clone();

        let results: Vec<(String, Option<String>)> = stream::iter(to_relabel.into_iter().map(|(eid, _old, content)| {
            let llm = &llm;
            let dt_ref = &dt_ref;
            let entries_ref = &entries;
            async move {
                let doc_title = entries_ref.iter()
                    .find(|e| e["entry_id"].as_str() == Some(&eid))
                    .and_then(|e| e["source_session_id"].as_str())
                    .and_then(|s| dt_ref.get(s).cloned())
                    .unwrap_or_default();
                let role = entries_ref.iter()
                    .find(|e| e["entry_id"].as_str() == Some(&eid))
                    .and_then(|e| e["section_role"].as_str())
                    .map(|s| s.to_string());
                let t = doc_reader::generate_section_title(llm, &doc_title, &content, role.as_deref()).await.ok();
                (eid, t.map(|s| doc_reader::sanitize_generated_title(&s)))
            }
        })).buffer_unordered(4).collect().await;

        for (eid, new_title) in results {
            if let Some(t) = new_title {
                if !t.is_empty() && t != "未命名" {
                    if let Ok(conn) = state_inner.db.lock() {
                        let _ = db::nb_update_entry_title(&conn, &eid, &t);
                    }
                    // 回填到内存 entries 供排序使用
                    if let Some(e) = entries.iter_mut().find(|e| e["entry_id"].as_str() == Some(&eid)) {
                        e["title"] = Value::String(t);
                    }
                    relabeled += 1;
                    let _ = app_ref.emit("notebook-relayout-progress", json!({
                        "notebook_id": nb_ref, "stage": "relabel",
                        "relabeled": relabeled,
                    }));
                }
            }
        }
    }

    // 稳定重排：先按 session_id（空放最后），再按 page_start 升序，父 section 先于其子 section
    // 具体算法：把 roots 取出并按 (session_id, page_start) 排序；子 entry 挂在父后面（保留原相对顺序）
    let mut roots: Vec<&Value> = entries.iter().filter(|e| {
        e["parent_entry_id"].as_str().unwrap_or("").is_empty()
    }).collect();
    roots.sort_by(|a, b| {
        let a_sid = a["source_session_id"].as_str().unwrap_or("");
        let b_sid = b["source_session_id"].as_str().unwrap_or("");
        let a_key: (u8, &str) = if a_sid.is_empty() { (1, "") } else { (0, a_sid) };
        let b_key: (u8, &str) = if b_sid.is_empty() { (1, "") } else { (0, b_sid) };
        let ord1 = a_key.cmp(&b_key);
        if ord1 != std::cmp::Ordering::Equal { return ord1; }
        let a_p = a["source_page_start"].as_i64().unwrap_or(i64::MAX);
        let b_p = b["source_page_start"].as_i64().unwrap_or(i64::MAX);
        let ord2 = a_p.cmp(&b_p);
        if ord2 != std::cmp::Ordering::Equal { return ord2; }
        a["created_at"].as_str().unwrap_or("").cmp(b["created_at"].as_str().unwrap_or(""))
    });

    // 子 entry map
    let mut children_map: std::collections::BTreeMap<String, Vec<&Value>> = std::collections::BTreeMap::new();
    for e in entries.iter() {
        let p = e["parent_entry_id"].as_str().unwrap_or("").to_string();
        if !p.is_empty() {
            children_map.entry(p).or_default().push(e);
        }
    }
    // 子保持原有 sort_order 顺序
    for v in children_map.values_mut() {
        v.sort_by_key(|e| e["sort_order"].as_i64().unwrap_or(0));
    }

    let mut new_pairs: Vec<(String, i64)> = Vec::with_capacity(total);
    let mut order: i64 = 0;
    for root in roots.iter() {
        let rid = root["entry_id"].as_str().unwrap_or("").to_string();
        new_pairs.push((rid.clone(), order));
        order += 1;
        if let Some(children) = children_map.remove(&rid) {
            for c in children {
                let cid = c["entry_id"].as_str().unwrap_or("").to_string();
                new_pairs.push((cid, order));
                order += 1;
            }
        }
    }
    // 孤儿（parent 已删）
    for (_, children) in children_map.iter() {
        for c in children {
            let cid = c["entry_id"].as_str().unwrap_or("").to_string();
            new_pairs.push((cid, order));
            order += 1;
        }
    }

    let reordered;
    {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        reordered = new_pairs.len();
        db::nb_update_sort_orders(&conn, &new_pairs)?;
    }

    let _ = app_handle.emit("notebook-relayout-done", json!({
        "notebook_id": notebook_id, "relabeled": relabeled, "reordered": reordered,
    }));

    Ok(json!({
        "status": "ok",
        "relabeled": relabeled,
        "reordered": reordered,
    }))
}

// ══════════════════════════════════════════════════════════════════════════════
// Learning Outline v1：重构学习路径
//   Step 1: 对每条 entry 并发抽取教学元信息 → 写入 notebook_entries.meta_json / learning_role / difficulty
//   Step 2: 基于全局元信息让 LLM 规划整本学习大纲 → notebook_outlines + entry.zone_id/zone_order/entry_order
// ══════════════════════════════════════════════════════════════════════════════

fn build_llm(state: &AppState) -> Result<LlmClient, String> {
    let models = config::load_models(&state.config_path);
    let configs = config::to_llm_configs(&models);
    if !configs.is_empty() {
        Ok(LlmClient::from_pool(configs))
    } else {
        Ok(LlmClient::new(LlmConfig::from_env()?))
    }
}

/// 把内容裁到合理长度，供 prompt 使用（最多 ~3500 字符）
fn trim_content_for_prompt(content: &str) -> String {
    const MAX: usize = 3500;
    if content.chars().count() > MAX {
        content.chars().take(MAX).collect::<String>() + "\n…（已截断）"
    } else {
        content.to_string()
    }
}

/// 构建整本笔记本的学习大纲（两步）并落库。
/// 返回：{ status, total, meta_extracted, zones, thesis, outline }
#[tauri::command]
pub async fn notebook_build_learning_outline(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    notebook_id: String,
) -> Result<Value, String> {
    // ── Snapshot: 读出所有 entries + 文档标题 ─────────────────────────────
    let (entries, doc_titles, nb_name): (Vec<Value>, std::collections::HashMap<String, String>, String) = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        let nb = db::nb_get(&conn, &notebook_id)?;
        let entries = db::nb_list_entries(&conn, &notebook_id)?;
        let mut tm = std::collections::HashMap::new();
        for e in entries.iter() {
            let sid = e["source_session_id"].as_str().unwrap_or("").to_string();
            if !sid.is_empty() && !tm.contains_key(&sid) {
                if let Ok(s) = db::dr_get_session(&conn, &sid) {
                    tm.insert(sid, s["filename"].as_str().unwrap_or("").to_string());
                }
            }
        }
        let nm = nb["notebook"]["name"].as_str().unwrap_or("").to_string();
        (entries, tm, nm)
    };

    let total = entries.len();
    if total == 0 {
        return Ok(json!({ "status": "empty", "total": 0, "meta_extracted": 0, "zones": 0 }));
    }

    let _ = app_handle.emit("notebook-outline-progress", json!({
        "notebook_id": notebook_id, "stage": "start", "total_entries": total,
    }));

    let llm = build_llm(state.inner())?;

    // ── Step 1: 并发抽取每条 entry 的教学元信息（限流 4） ────────────────
    // 预先把需要的字段拷贝成 owned 数据，避免在 stream::iter 的闭包里跨 await 借用 entries
    let extract_inputs: Vec<(String, String, String, String)> = entries.iter().map(|e| {
        let eid = e["entry_id"].as_str().unwrap_or("").to_string();
        let title = e["title"].as_str().unwrap_or("").to_string();
        let content = trim_content_for_prompt(e["content"].as_str().unwrap_or(""));
        let sid = e["source_session_id"].as_str().unwrap_or("").to_string();
        let doc_title = doc_titles.get(&sid).cloned().unwrap_or_default();
        (eid, title, content, doc_title)
    }).collect();

    let extracted: Vec<(String, Option<Value>)> = stream::iter(extract_inputs.into_iter().map(|(eid, title, content, doc_title)| {
        let llm_cloned = llm.clone();
        async move {
            let v: Option<Value> = doc_reader::extract_entry_meta(&llm_cloned, &doc_title, &title, &content).await.ok();
            (eid, v)
        }
    }))
    .buffer_unordered(4)
    .collect()
    .await;

    // 把抽取结果落库 + 组装 metas_json
    let mut metas_for_prompt: Vec<Value> = Vec::with_capacity(total);
    let mut meta_extracted = 0usize;
    let mut progress_i = 0usize;
    // 构建 entry_id → entry 快速查表
    let entry_index: std::collections::HashMap<String, &Value> = entries.iter()
        .map(|e| (e["entry_id"].as_str().unwrap_or("").to_string(), e)).collect();

    for (eid, meta_opt) in extracted.into_iter() {
        progress_i += 1;
        let entry = match entry_index.get(&eid) { Some(v) => *v, None => continue };
        let original_title = entry["title"].as_str().unwrap_or("").to_string();
        let mut semantic_title = original_title.clone();
        let mut learning_role = entry["section_role"].as_str().unwrap_or("").to_string();
        let mut difficulty: i64 = 2;

        let meta_value: Value = match meta_opt {
            Some(v) => {
                if let Some(s) = v.get("semantic_title").and_then(|x| x.as_str()) {
                    let cleaned = doc_reader::sanitize_generated_title(s);
                    if !cleaned.is_empty() && cleaned != "未命名" { semantic_title = cleaned; }
                }
                if let Some(r) = v.get("learning_role").and_then(|x| x.as_str()) {
                    if !r.is_empty() { learning_role = r.to_string(); }
                }
                if let Some(d) = v.get("difficulty").and_then(|x| x.as_i64()) {
                    difficulty = d.clamp(1, 5);
                }
                meta_extracted += 1;
                v
            }
            None => {
                // 兜底：用原始数据构造一个最小 meta
                json!({
                    "summary": "",
                    "keypoints": [],
                    "topics": [],
                    "prerequisites_hint": [],
                    "learning_role": if learning_role.is_empty() { "foundation".to_string() } else { learning_role.clone() },
                    "difficulty": 2,
                    "semantic_title": semantic_title,
                })
            }
        };

        // 落库 meta_json / learning_role / difficulty
        let meta_db = db::NbEntryLearningMeta {
            meta_json: serde_json::to_string(&meta_value).unwrap_or_default(),
            learning_role: learning_role.clone(),
            difficulty,
        };
        if let Ok(conn) = state.db.lock() {
            let _ = db::nb_update_entry_meta(&conn, &eid, &meta_db);
            // 若 LLM 已建议新标题且原标题是自动/系统的，则顺便落库新标题
            if semantic_title != original_title && doc_reader::title_looks_auto(&original_title) {
                let _ = db::nb_update_entry_title(&conn, &eid, &semantic_title);
            }
        }

        // 用于 Step 2 的 prompt 载荷
        metas_for_prompt.push(json!({
            "entry_id": eid,
            "original_title": original_title,
            "semantic_title": semantic_title,
            "summary": meta_value.get("summary").cloned().unwrap_or(Value::String(String::new())),
            "keypoints": meta_value.get("keypoints").cloned().unwrap_or(json!([])),
            "topics": meta_value.get("topics").cloned().unwrap_or(json!([])),
            "prerequisites_hint": meta_value.get("prerequisites_hint").cloned().unwrap_or(json!([])),
            "learning_role": learning_role,
            "difficulty": difficulty,
            "source_session_id": entry["source_session_id"].clone(),
            "source_page_start": entry["source_page_start"].clone(),
            "parent_entry_id": entry["parent_entry_id"].clone(),
            "section_role": entry["section_role"].clone(),
        }));

        let _ = app_handle.emit("notebook-outline-progress", json!({
            "notebook_id": notebook_id, "stage": "extract",
            "done": progress_i, "total": total, "meta_extracted": meta_extracted,
        }));
    }

    // ── Step 2: 生成整本学习大纲（策略 2+3：压缩 → 检测 → 分块兜底） ────
    let _ = app_handle.emit("notebook-outline-progress", json!({
        "notebook_id": notebook_id, "stage": "plan", "total": total,
    }));

    // 安全 token 上限：为 system prompt + 输出预留空间，输入 metas 不超过此值
    const SAFE_INPUT_TOKENS: usize = 50_000;
    // 分块大小：每块最多处理的 entry 数
    const CHUNK_SIZE: usize = 18;

    // 策略 2：先尝试压缩 metas（去掉 keypoints / prerequisites_hint / source_* 等重字段）
    let compressed = doc_reader::compress_metas_for_prompt(&metas_for_prompt);
    let compressed_json = serde_json::to_string(&compressed)
        .map_err(|e| format!("序列化压缩 metas 失败: {e}"))?;
    let estimated_tokens = doc_reader::estimate_tokens(&compressed_json);

    log::info!(
        "relayout Step 2: {} entries, compressed_json={} chars, ~{} tokens (limit={})",
        total, compressed_json.len(), estimated_tokens, SAFE_INPUT_TOKENS
    );

    let outline_val = if estimated_tokens <= SAFE_INPUT_TOKENS {
        // ── 路径 A：压缩后在安全范围内，直接单次调用 ──────────────────────
        doc_reader::build_learning_outline(&llm, &nb_name, &compressed_json).await?
    } else {
        // ── 路径 B：仍然超限，启用分块规划 + 合并（策略 3） ────────────────
        log::info!("relayout: compressed metas still too large (~{} tokens), falling back to chunked planning", estimated_tokens);

        let _ = app_handle.emit("notebook-outline-progress", json!({
            "notebook_id": notebook_id, "stage": "plan_chunked", "total": total,
        }));

        // 分块
        let chunks: Vec<Vec<Value>> = compressed.chunks(CHUNK_SIZE)
            .map(|c| c.to_vec())
            .collect();
        let total_chunks = chunks.len();

        // 并发处理各分块（限流 2，避免 rate limit）
        let chunk_results: Vec<(usize, Result<Value, String>)> = stream::iter(
            chunks.into_iter().enumerate().map(|(i, chunk)| {
                let llm_c = llm.clone();
                let nb = nb_name.clone();
                async move {
                    let cj = serde_json::to_string(&chunk).unwrap_or_else(|_| "[]".to_string());
                    let res = doc_reader::build_chunk_outline(&llm_c, &nb, &cj, i, total_chunks).await;
                    (i, res)
                }
            })
        )
        .buffer_unordered(2)
        .collect()
        .await;

        // 收集各分块结果，构建合并用的摘要
        let mut chunk_summaries: Vec<Value> = Vec::with_capacity(total_chunks);
        // 收集各分块的 entry→zone 映射，用于合并时保留细节
        let mut all_chunk_entries: Vec<Value> = Vec::new();

        for (i, res) in chunk_results {
            match res {
                Ok(val) => {
                    // 提取摘要：zones 的 title/summary + entry_ids
                    let zones = val.get("zones").and_then(|z| z.as_array()).cloned().unwrap_or_default();
                    let zone_summaries: Vec<Value> = zones.iter().map(|z| {
                        let entries = z.get("entries").and_then(|e| e.as_array()).cloned().unwrap_or_default();
                        let entry_ids: Vec<Value> = entries.iter()
                            .filter_map(|e| e.get("entry_id").cloned())
                            .collect();
                        json!({
                            "zone_id": z.get("zone_id").cloned().unwrap_or(Value::Null),
                            "title": z.get("title").cloned().unwrap_or(Value::Null),
                            "summary": z.get("summary").cloned().unwrap_or(Value::Null),
                            "learning_goal": z.get("learning_goal").cloned().unwrap_or(Value::Null),
                            "entry_count": entries.len(),
                            "entry_ids": entry_ids,
                            "entries": entries,
                        })
                    }).collect();

                    chunk_summaries.push(json!({
                        "chunk_index": i,
                        "zones": zone_summaries,
                        "entry_order": val.get("entry_order").cloned().unwrap_or(json!([])),
                    }));

                    // 保留完整 entries 细节用于后续落库
                    for z in zones.iter() {
                        if let Some(ents) = z.get("entries").and_then(|e| e.as_array()) {
                            all_chunk_entries.extend(ents.iter().cloned());
                        }
                    }
                }
                Err(e) => {
                    log::warn!("relayout chunk {} failed: {}", i, e);
                    // 跳过失败的分块，合并阶段会把遗漏的 entry 放到 __unassigned__
                }
            }
        }

        // 收集所有 entry_id 用于合并
        let all_entry_ids: Vec<String> = metas_for_prompt.iter()
            .filter_map(|m| m.get("entry_id").and_then(|v| v.as_str()).map(|s| s.to_string()))
            .collect();
        let all_ids_json = serde_json::to_string(&all_entry_ids)
            .unwrap_or_else(|_| "[]".to_string());
        let summaries_json = serde_json::to_string(&chunk_summaries)
            .unwrap_or_else(|_| "[]".to_string());

        let _ = app_handle.emit("notebook-outline-progress", json!({
            "notebook_id": notebook_id, "stage": "plan_merge", "total": total,
        }));

        // 合并各分块
        let mut merged = doc_reader::merge_chunk_outlines(&llm, &nb_name, &summaries_json, &all_ids_json).await?;

        // 把分块阶段的 entries 细节（new_title / learning_role / difficulty）回填到合并结果中
        let chunk_entry_map: std::collections::HashMap<String, &Value> = all_chunk_entries.iter()
            .filter_map(|e| e.get("entry_id").and_then(|v| v.as_str()).map(|s| (s.to_string(), e)))
            .collect();

        if let Some(zones) = merged.get_mut("zones").and_then(|z| z.as_array_mut()) {
            for zone in zones.iter_mut() {
                if let Some(entries) = zone.get_mut("entries").and_then(|e| e.as_array_mut()) {
                    for entry in entries.iter_mut() {
                        let eid = entry.get("entry_id").and_then(|v| v.as_str()).unwrap_or("");
                        if let Some(chunk_entry) = chunk_entry_map.get(eid) {
                            // 回填分块阶段的细节（如果合并阶段没有提供）
                            if entry.get("new_title").and_then(|v| v.as_str()).unwrap_or("").is_empty() {
                                if let Some(nt) = chunk_entry.get("new_title") {
                                    entry.as_object_mut().map(|o| o.insert("new_title".to_string(), nt.clone()));
                                }
                            }
                            if entry.get("learning_role").is_none() {
                                if let Some(lr) = chunk_entry.get("learning_role") {
                                    entry.as_object_mut().map(|o| o.insert("learning_role".to_string(), lr.clone()));
                                }
                            }
                            if entry.get("difficulty").is_none() {
                                if let Some(d) = chunk_entry.get("difficulty") {
                                    entry.as_object_mut().map(|o| o.insert("difficulty".to_string(), d.clone()));
                                }
                            }
                        }
                    }
                }
            }
        }

        merged
    };

    // 规范化输出 —— 确保核心字段齐全
    let outline_normalized = normalize_learning_outline(&outline_val, &metas_for_prompt);

    // ── 落库：entry 的 zone 归属 + 学习顺序 + 标题（new_title 若存在且不同） ──
    let mut zone_updates: Vec<(String, String, i64, i64)> = Vec::new();
    let mut title_updates: Vec<(String, String)> = Vec::new();

    if let Some(zones) = outline_normalized.get("zones").and_then(|z| z.as_array()) {
        let entry_order_map: std::collections::HashMap<String, i64> = outline_normalized
            .get("entry_order")
            .and_then(|eo| eo.as_array())
            .map(|arr| {
                arr.iter().enumerate()
                    .filter_map(|(i, v)| v.as_str().map(|s| (s.to_string(), i as i64)))
                    .collect()
            })
            .unwrap_or_default();

        for zone in zones.iter() {
            let zid = zone.get("zone_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
            if zid.is_empty() { continue; }
            if let Some(ents) = zone.get("entries").and_then(|x| x.as_array()) {
                for (zorder, ent) in ents.iter().enumerate() {
                    let eid = match ent.get("entry_id").and_then(|v| v.as_str()) {
                        Some(s) if !s.is_empty() => s.to_string(),
                        _ => continue,
                    };
                    let eorder = *entry_order_map.get(&eid).unwrap_or(&(zone_updates.len() as i64));
                    zone_updates.push((eid.clone(), zid.clone(), zorder as i64, eorder));

                    if let Some(nt) = ent.get("new_title").and_then(|v| v.as_str()) {
                        let clean = doc_reader::sanitize_generated_title(nt);
                        if !clean.is_empty() && clean != "未命名" {
                            if let Some(orig) = entry_index.get(&eid) {
                                let orig_title = orig["title"].as_str().unwrap_or("");
                                if clean != orig_title && doc_reader::title_looks_auto(orig_title) {
                                    title_updates.push((eid, clean));
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // 未被 outline 覆盖到的 entry 放到"未分区"并排到末尾
    let covered: std::collections::HashSet<String> = zone_updates.iter().map(|(e, _, _, _)| e.clone()).collect();
    let mut tail_order = zone_updates.iter().map(|(_, _, _, o)| *o).max().unwrap_or(-1) + 1;
    for e in entries.iter() {
        let eid = e["entry_id"].as_str().unwrap_or("").to_string();
        if !covered.contains(&eid) && !eid.is_empty() {
            zone_updates.push((eid.clone(), "__unassigned__".to_string(), 0, tail_order));
            tail_order += 1;
        }
    }

    {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        // 落库 zone 归属 + 学习顺序
        if !zone_updates.is_empty() {
            db::nb_update_entry_zones(&conn, &zone_updates)?;
        }
        // 落库标题
        for (eid, t) in title_updates.iter() {
            let _ = db::nb_update_entry_title(&conn, eid, t);
        }
        // 落库 outline JSON
        let oj = serde_json::to_string(&outline_normalized).unwrap_or_else(|_| "{}".to_string());
        db::nb_outline_upsert(&conn, &notebook_id, &oj, 1)?;
    }

    let zones_count = outline_normalized.get("zones").and_then(|z| z.as_array()).map(|a| a.len()).unwrap_or(0);
    let thesis = outline_normalized.get("thesis").and_then(|t| t.as_str()).unwrap_or("").to_string();

    let _ = app_handle.emit("notebook-outline-progress", json!({
        "notebook_id": notebook_id, "stage": "done",
        "total": total, "meta_extracted": meta_extracted,
        "zones": zones_count, "thesis": thesis,
    }));
    let _ = app_handle.emit("notebook-outline-done", json!({
        "notebook_id": notebook_id,
        "total": total, "meta_extracted": meta_extracted, "zones": zones_count,
    }));

    Ok(json!({
        "status": "ok",
        "total": total,
        "meta_extracted": meta_extracted,
        "zones": zones_count,
        "thesis": thesis,
        "outline": outline_normalized,
        "title_updates": title_updates.len(),
    }))
}

/// 规范化 LLM 输出的学习大纲：
///   - 确保 zones 里的 zone_id 唯一；缺省时自动补 z1/z2…
///   - 确保 entry_order 覆盖所有 entry_id（不足则在尾部补齐）
///   - 确保 links/recap_questions 是数组
fn normalize_learning_outline(raw: &Value, metas: &[Value]) -> Value {
    let mut thesis = raw.get("thesis").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if thesis.is_empty() { thesis = "本笔记的学习主线".to_string(); }
    let learning_path = raw.get("learning_path").cloned().unwrap_or(json!([
        "foundation", "mechanism", "comparison", "misconception", "application"
    ]));

    let mut zones: Vec<Value> = raw.get("zones").and_then(|v| v.as_array())
        .cloned().unwrap_or_default();

    // 补全 zone_id
    for (i, z) in zones.iter_mut().enumerate() {
        let zid_empty = z.get("zone_id").and_then(|v| v.as_str()).map(|s| s.is_empty()).unwrap_or(true);
        if zid_empty {
            if let Some(obj) = z.as_object_mut() {
                obj.insert("zone_id".to_string(), Value::String(format!("z{}", i + 1)));
            }
        }
        // 确保必要字段存在
        if let Some(obj) = z.as_object_mut() {
            obj.entry("title").or_insert_with(|| Value::String(format!("知识区 {}", i + 1)));
            obj.entry("summary").or_insert_with(|| Value::String(String::new()));
            obj.entry("learning_goal").or_insert_with(|| Value::String(String::new()));
            obj.entry("prerequisite_zone_ids").or_insert_with(|| json!([]));
            obj.entry("entries").or_insert_with(|| json!([]));
            obj.entry("recap_questions").or_insert_with(|| json!([]));
        }
    }

    // 若 zones 全空，则把所有 entry 放入单一 "综合" zone
    if zones.is_empty() {
        let all_entries: Vec<Value> = metas.iter().map(|m| json!({
            "entry_id": m.get("entry_id").cloned().unwrap_or(Value::Null),
            "new_title": m.get("semantic_title").cloned().unwrap_or(Value::Null),
            "learning_role": m.get("learning_role").cloned().unwrap_or(Value::String("foundation".into())),
            "difficulty": m.get("difficulty").cloned().unwrap_or(json!(2)),
            "prerequisite_entry_ids": json!([]),
        })).collect();
        zones.push(json!({
            "zone_id": "z1",
            "title": "综合笔记",
            "summary": "自动合并未能分区的笔记内容。",
            "learning_goal": "通览本笔记的核心内容。",
            "prerequisite_zone_ids": [],
            "entries": all_entries,
            "recap_questions": [],
        }));
    }

    // 构建 entry_order：优先使用 LLM 输出；不足则按 zones 顺序补齐
    let mut order: Vec<String> = raw.get("entry_order").and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect())
        .unwrap_or_default();

    let all_ids: std::collections::HashSet<String> = metas.iter()
        .filter_map(|m| m.get("entry_id").and_then(|v| v.as_str().map(|s| s.to_string())))
        .collect();
    let ordered_set: std::collections::HashSet<String> = order.iter().cloned().collect();

    // 去掉不存在的 id
    order.retain(|e| all_ids.contains(e));
    // 补充未出现在 order 中的 id（按 zones 内出现顺序）
    let mut appended: std::collections::HashSet<String> = order.iter().cloned().collect();
    for z in zones.iter() {
        if let Some(ents) = z.get("entries").and_then(|v| v.as_array()) {
            for ent in ents.iter() {
                if let Some(eid) = ent.get("entry_id").and_then(|v| v.as_str()) {
                    if all_ids.contains(eid) && !appended.contains(eid) {
                        order.push(eid.to_string());
                        appended.insert(eid.to_string());
                    }
                }
            }
        }
    }
    // 残余（既不在 order 也不在 zones）
    for eid in all_ids.iter() {
        if !appended.contains(eid) {
            order.push(eid.clone());
            appended.insert(eid.clone());
        }
    }
    let _ = ordered_set; // 保留引用，避免编译器未用警告

    let links = raw.get("links").cloned().unwrap_or(json!([]));

    json!({
        "thesis": thesis,
        "learning_path": learning_path,
        "zones": zones,
        "entry_order": order,
        "links": links,
        "version": 1,
    })
}

/// 读取笔记本的学习大纲。
/// 返回：{ notebook, outline, entries_by_zone, total }，前端直接消费此结构即可。
#[tauri::command]
pub async fn notebook_get_learning_outline(
    state: State<'_, AppState>,
    notebook_id: String,
) -> Result<Value, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let nb = db::nb_get(&conn, &notebook_id)?;
    let entries = db::nb_list_entries(&conn, &notebook_id)?;

    let outline_row = db::nb_outline_get(&conn, &notebook_id)?;
    let outline_val = outline_row.clone()
        .and_then(|v| v.get("outline").cloned())
        .unwrap_or(Value::Null);

    // 按 zone_id 分桶 entries
    use std::collections::BTreeMap;
    let mut by_zone: BTreeMap<String, Vec<Value>> = BTreeMap::new();
    for e in entries.iter() {
        let zid = e.get("zone_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
        by_zone.entry(zid).or_default().push(e.clone());
    }
    for v in by_zone.values_mut() {
        v.sort_by_key(|e| e.get("zone_order").and_then(|x| x.as_i64()).unwrap_or(0));
    }

    // 当 outline 为空，返回一个可用但最小的 fallback（让前端仍可渲染"综合"单区）
    let outline_ready = !outline_val.is_null();

    Ok(json!({
        "notebook": nb.get("notebook").cloned().unwrap_or(Value::Null),
        "outline": outline_val,
        "outline_ready": outline_ready,
        "entries_by_zone": by_zone,
        "all_entries": entries,
        "total": by_zone.values().map(|v| v.len()).sum::<usize>(),
        "meta": outline_row.map(|v| json!({
            "version": v.get("version").cloned().unwrap_or(Value::Null),
            "updated_at": v.get("updated_at").cloned().unwrap_or(Value::Null),
        })),
    }))
}

/// 获取指定 entry 的跨节关联 section（根据 outline.links）。
/// 返回：{ entry, outgoing: [...], incoming: [...] }
/// outgoing/incoming 每项形如：{ kind, note, entry: {完整 entry 行} }
#[tauri::command]
pub async fn notebook_get_related_sections(
    state: State<'_, AppState>,
    entry_id: String,
) -> Result<Value, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let entry = db::nb_get_entry(&conn, &entry_id)?;
    let notebook_id = entry["notebook_id"].as_str().unwrap_or("").to_string();
    if notebook_id.is_empty() {
        return Err("无效的 entry".to_string());
    }

    let outline_row = db::nb_outline_get(&conn, &notebook_id)?;
    let outline_val = outline_row
        .and_then(|v| v.get("outline").cloned())
        .unwrap_or(Value::Null);

    let all_entries = db::nb_list_entries(&conn, &notebook_id)?;
    let entry_map: std::collections::HashMap<String, Value> = all_entries.iter()
        .map(|e| (e["entry_id"].as_str().unwrap_or("").to_string(), e.clone()))
        .collect();

    let mut outgoing: Vec<Value> = Vec::new();
    let mut incoming: Vec<Value> = Vec::new();

    if let Some(links) = outline_val.get("links").and_then(|v| v.as_array()) {
        for link in links.iter() {
            let from = link.get("from").and_then(|v| v.as_str()).unwrap_or("");
            let to = link.get("to").and_then(|v| v.as_str()).unwrap_or("");
            let kind = link.get("kind").and_then(|v| v.as_str()).unwrap_or("extend").to_string();
            let note = link.get("note").and_then(|v| v.as_str()).unwrap_or("").to_string();
            if from == entry_id {
                if let Some(tgt) = entry_map.get(to) {
                    outgoing.push(json!({ "kind": kind, "note": note, "entry": tgt }));
                }
            } else if to == entry_id {
                if let Some(src) = entry_map.get(from) {
                    incoming.push(json!({ "kind": kind, "note": note, "entry": src }));
                }
            }
        }
    }

    // 同 zone 兄弟 section（按 zone_order 相邻的前后各一条）
    let zid = entry.get("zone_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let mut siblings: Vec<Value> = all_entries.iter()
        .filter(|e| e.get("zone_id").and_then(|v| v.as_str()).unwrap_or("") == zid && !zid.is_empty())
        .cloned().collect();
    siblings.sort_by_key(|e| e.get("zone_order").and_then(|x| x.as_i64()).unwrap_or(0));
    let self_idx = siblings.iter().position(|e| e["entry_id"].as_str() == Some(&entry_id));
    let prev_sibling = self_idx.and_then(|i| i.checked_sub(1)).and_then(|i| siblings.get(i)).cloned();
    let next_sibling = self_idx.and_then(|i| siblings.get(i + 1)).cloned();

    Ok(json!({
        "entry": entry,
        "outgoing": outgoing,
        "incoming": incoming,
        "prev_sibling": prev_sibling,
        "next_sibling": next_sibling,
    }))
}

// ══════════════════════════════════════════════════════════════════════════════
// 通用应用偏好 KV (app_prefs.json)
// ══════════════════════════════════════════════════════════════════════════════

fn read_prefs_file(path: &std::path::Path) -> Value {
    match std::fs::read_to_string(path) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_else(|_| json!({})),
        Err(_) => json!({}),
    }
}

fn write_prefs_file(path: &std::path::Path, v: &Value) -> Result<(), String> {
    let s = serde_json::to_string_pretty(v).map_err(|e| e.to_string())?;
    std::fs::write(path, s).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn app_prefs_get(state: State<'_, AppState>, key: String) -> Result<Value, String> {
    let all = read_prefs_file(&state.prefs_path);
    Ok(all.get(&key).cloned().unwrap_or(Value::Null))
}

#[tauri::command]
pub async fn app_prefs_set(state: State<'_, AppState>, key: String, value: Value) -> Result<(), String> {
    let mut all = read_prefs_file(&state.prefs_path);
    if !all.is_object() { all = json!({}); }
    all.as_object_mut().unwrap().insert(key, value);
    write_prefs_file(&state.prefs_path, &all)
}

// ══════════════════════════════════════════════════════════════════════════════
// RAG 知识库命令 — embedding 索引构建 / 状态查询 / 检索增强答疑
// ══════════════════════════════════════════════════════════════════════════════
//
// 设计思路：
// - embedding 模型独立于 chat 池，从 llm_models.json 中筛 kind == "embedding"
//   的第一条启用项；没有则报错让用户先去设置页配置。
// - 索引构建走后台 tokio::spawn，事件流：
//     rag-build-progress  { session_id, completed, total }
//     rag-build-done      { session_id, success, total_chunks?, dim?, error? }
//   命令本身立即返回 { status: 'building' | 'ready' }，UI 不阻塞。
// - rag_chat：阻塞返回；前端 ChatTab 直接 await。
//   返回 { answer, sources: [{ chunk_id, page_start, page_end, snippet, score }] }。

/// 从 llm_models.json 中构造 embedding 客户端。
/// 优先：app_prefs 中 `rag.embedding_model_index` 指向的那一条；不存在或越界 → 第一条 embedding 模型。
fn build_embedding_client(state: &State<'_, AppState>) -> Result<LlmClient, String> {
    let models = config::load_models(&state.config_path);
    let configs = config::to_embedding_configs(&models);
    if configs.is_empty() {
        return Err("尚未配置 embedding 模型。请到「设置 → LLM 模型」添加一条用途为 embedding 的模型（如 OpenAI text-embedding-3-small / 火山 doubao-embedding）。".to_string());
    }
    // 取第一条；多 embedding 模型选择留作后续扩展（前端可在 RAG 区下拉切）
    let prefs = read_prefs_file(&state.prefs_path);
    let want_idx = prefs
        .get("rag.embedding_model_index")
        .and_then(|v| v.as_i64())
        .unwrap_or(-1);
    let pick = if want_idx >= 0 && (want_idx as usize) < configs.len() {
        configs[want_idx as usize].clone()
    } else {
        configs[0].clone()
    };
    Ok(LlmClient::new(pick))
}

/// 触发某本书的索引构建（异步）。已 building 的会被 ignore。
#[tauri::command]
pub async fn rag_index_session(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    rebuild: Option<bool>,
) -> Result<Value, String> {
    let rebuild = rebuild.unwrap_or(false);

    // 检查当前 status：已 ready 且不重建 → 直接返回
    {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        if let Some(meta) = db::rag_get_meta(&conn, &session_id)? {
            let status = meta.get("status").and_then(|v| v.as_str()).unwrap_or("");
            if status == "ready" && !rebuild {
                return Ok(json!({
                    "status": "ready",
                    "chunk_count": meta.get("chunk_count").cloned().unwrap_or(json!(0)),
                    "model": meta.get("model").cloned().unwrap_or(Value::Null),
                    "dim": meta.get("dim").cloned().unwrap_or(json!(0)),
                }));
            }
            if status == "building" && !rebuild {
                return Ok(json!({ "status": "building" }));
            }
        }
    }

    // 构造 embedding 客户端（失败立即返回，不入后台）
    let llm = build_embedding_client(&state)?;

    let sid = session_id.clone();
    let app_inner = app_handle.clone();
    let db_arc = state.db.clone();

    tokio::spawn(async move {
        // 进度回调通过 emit
        let app_for_progress = app_inner.clone();
        let sid_for_progress = sid.clone();
        let progress_fn = move |done: usize, total: usize| {
            let _ = app_for_progress.emit(
                "rag-build-progress",
                json!({ "session_id": sid_for_progress, "completed": done, "total": total }),
            );
        };

        let result = rag::index_session(
            db_arc.clone(),
            &llm,
            &sid,
            rebuild,
            Some(&progress_fn),
        )
        .await;

        match result {
            Ok(total_chunks) => {
                // 顺便把最终 dim 读回来发给前端
                let dim = if let Ok(conn) = db_arc.lock() {
                    db::rag_get_meta(&conn, &sid)
                        .ok()
                        .flatten()
                        .and_then(|m| m.get("dim").and_then(|v| v.as_i64()))
                        .unwrap_or(0)
                } else {
                    0
                };
                let _ = app_inner.emit(
                    "rag-build-done",
                    json!({
                        "session_id": sid,
                        "success": true,
                        "total_chunks": total_chunks,
                        "dim": dim,
                    }),
                );
            }
            Err(e) => {
                log::error!("RAG[{}] 索引失败: {}", sid, e);
                let _ = app_inner.emit(
                    "rag-build-done",
                    json!({
                        "session_id": sid,
                        "success": false,
                        "error": e,
                    }),
                );
            }
        }
    });

    Ok(json!({ "status": "building" }))
}

/// 查询某本书的 RAG 索引状态。
/// 返回：{ status: 'none' | 'pending' | 'building' | 'ready' | 'failed', chunk_count, model, dim, error, updated_at }
#[tauri::command]
pub async fn rag_index_status(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Value, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    match db::rag_get_meta(&conn, &session_id)? {
        Some(v) => Ok(v),
        None => Ok(json!({
            "session_id": session_id,
            "status": "none",
            "chunk_count": 0,
            "model": "",
            "dim": 0,
            "error": "",
            "updated_at": "",
        })),
    }
}

/// 清空某本书的 RAG 索引（chunks + meta）。
#[tauri::command]
pub async fn rag_clear_session(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Value, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::rag_clear_session(&conn, &session_id)?;
    Ok(json!({ "ok": true }))
}

/// RAG 答疑：query → embed → top-k 检索 → 拼上下文 → chat。
///
/// 返回 `{ answer, sources, retrieved_count }`。
/// 当索引不存在或为空时，自动 fallback 为单页 chat（与 doc_reader_chat 一致），
/// 并把 sources 设为空数组、retrieved_count = 0。
#[tauri::command]
pub async fn rag_chat(
    state: State<'_, AppState>,
    session_id: String,
    question: String,
    page_index: Option<usize>,
    page_content: Option<String>,
    history: Option<Vec<(String, String)>>,
    top_k: Option<usize>,
) -> Result<Value, String> {
    if question.trim().is_empty() {
        return Err("问题不能为空".to_string());
    }

    let top_k = top_k.unwrap_or(rag::DEFAULT_TOP_K);

    // 取文档信息 + 当前页内容
    let (doc_title, current_page_text) = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        let session = db::dr_get_session(&conn, &session_id)?;
        let doc_title = session["filename"].as_str().unwrap_or("").to_string();

        let content = if let Some(ref pc) = page_content {
            if !pc.trim().is_empty() {
                pc.clone()
            } else if let Some(idx) = page_index {
                let page = db::dr_get_page(&conn, &session_id, idx)?;
                page["content"].as_str().unwrap_or("").to_string()
            } else {
                String::new()
            }
        } else if let Some(idx) = page_index {
            let page = db::dr_get_page(&conn, &session_id, idx)?;
            page["content"].as_str().unwrap_or("").to_string()
        } else {
            String::new()
        };
        (doc_title, content)
    };

    // 索引状态：没有 / 失败 → fallback 单页 chat
    let index_ready = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        match db::rag_get_meta(&conn, &session_id)? {
            Some(m) => {
                let s = m.get("status").and_then(|v| v.as_str()).unwrap_or("");
                let cnt = m.get("chunk_count").and_then(|v| v.as_i64()).unwrap_or(0);
                s == "ready" && cnt > 0
            }
            None => false,
        }
    };

    let chat_llm = {
        let models = config::load_models(&state.config_path);
        let configs = config::to_llm_configs(&models);
        if !configs.is_empty() {
            LlmClient::from_pool(configs)
        } else {
            LlmConfig::from_env().map(LlmClient::new).map_err(|e| e.to_string())?
        }
    };

    let hist = history.unwrap_or_default();

    if !index_ready {
        // Fallback：和 doc_reader_chat 一样，把当前页喂给 LLM
        let answer = doc_reader::chat_with_doc(
            &chat_llm,
            &doc_title,
            &current_page_text,
            page_index,
            &question,
            &hist,
        )
        .await?;
        return Ok(json!({
            "answer": answer,
            "sources": [],
            "retrieved_count": 0,
            "fallback": "no_index",
            "page_index": page_index,
        }));
    }

    // 走 RAG：构造 embedding client（独立于 chat）
    let embed_llm = build_embedding_client(&state)?;

    let retrieved = rag::retrieve(
        state.db.clone(),
        &embed_llm,
        &session_id,
        &question,
        top_k,
    )
    .await?;

    // 把 sources 序列化成前端能消费的形态（和 build_context_for_chat 内部一致）
    let sources: Vec<Value> = retrieved
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

    let answer = rag::rag_answer(
        &chat_llm,
        &doc_title,
        page_index,
        &current_page_text,
        &retrieved,
        &question,
        &hist,
    )
    .await?;

    Ok(json!({
        "answer": answer,
        "sources": sources,
        "retrieved_count": retrieved.len(),
        "page_index": page_index,
    }))
}

// ══════════════════════════════════════════════════════════════════════════════
// RAG 流式聊天 — 实时 token 推送 + 自动追问建议
// ══════════════════════════════════════════════════════════════════════════════
//
// 事件协议（按调用 turn_id 区分多 turn 并发）:
//   chat-stream-start    { turn_id, session_id, sources: [...], retrieved_count, mode, fallback? }
//   chat-stream-token    { turn_id, delta }                          // 每个增量 token
//   chat-stream-done     { turn_id, full_answer }                    // 流结束（成功）
//   chat-stream-error    { turn_id, error }                          // 任意阶段失败
//   chat-stream-followups{ turn_id, followups: [string,string,string] }   // 答完后异步推送

/// RAG 流式聊天。命令立即返回 `{turn_id}`，前端 listen 上面四种事件。
///
/// `mode` 取值：
///   - "quick" : 不走 RAG（不检索），仅基于当前页 1-3 句话回答
///   - "deep"  : 走 RAG top_k 检索 + 全面回答（默认）
///   - "cite"  : 走 RAG 但用更严格的 prompt 强制每句都引用页码
///
/// `with_followups` 默认 true，结束后会再调一次 LLM 异步生成 3 个追问。
#[tauri::command]
pub async fn rag_chat_stream(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    question: String,
    page_index: Option<usize>,
    page_content: Option<String>,
    history: Option<Vec<(String, String)>>,
    mode: Option<String>,
    top_k: Option<usize>,
    with_followups: Option<bool>,
) -> Result<Value, String> {
    if question.trim().is_empty() {
        return Err("问题不能为空".to_string());
    }
    let mode = mode.unwrap_or_else(|| "deep".to_string());
    let top_k = top_k.unwrap_or(rag::DEFAULT_TOP_K);
    let with_followups = with_followups.unwrap_or(true);
    let turn_id = uuid::Uuid::new_v4().to_string();

    // 取文档信息 + 当前页内容
    let (doc_title, current_page_text) = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        let session = db::dr_get_session(&conn, &session_id)?;
        let doc_title = session["filename"].as_str().unwrap_or("").to_string();
        let content = if let Some(ref pc) = page_content {
            if !pc.trim().is_empty() {
                pc.clone()
            } else if let Some(idx) = page_index {
                let p = db::dr_get_page(&conn, &session_id, idx)?;
                p["content"].as_str().unwrap_or("").to_string()
            } else {
                String::new()
            }
        } else if let Some(idx) = page_index {
            let p = db::dr_get_page(&conn, &session_id, idx)?;
            p["content"].as_str().unwrap_or("").to_string()
        } else {
            String::new()
        };
        (doc_title, content)
    };

    // chat client（轮询）
    let chat_llm = {
        let models = config::load_models(&state.config_path);
        let configs = config::to_llm_configs(&models);
        if !configs.is_empty() {
            LlmClient::from_pool(configs)
        } else {
            LlmConfig::from_env().map(LlmClient::new).map_err(|e| e.to_string())?
        }
    };

    // 索引就绪检测：未 ready 或为空 → 仅基于当前页生成(不检索)
    let index_ready = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        match db::rag_get_meta(&conn, &session_id)? {
            Some(m) => {
                let s = m.get("status").and_then(|v| v.as_str()).unwrap_or("");
                let cnt = m.get("chunk_count").and_then(|v| v.as_i64()).unwrap_or(0);
                s == "ready" && cnt > 0
            }
            None => false,
        }
    };
    // mode 参数保留接收以向后兼容,但内部行为统一:有索引就走 RAG,没就 fallback。
    // 不再区分 quick/deep/cite。
    let _ = mode;
    let fallback_no_index = !index_ready;

    let hist = history.unwrap_or_default();

    // 检索:索引就绪才走;否则空 vec(LLM 仅看当前页 + 问题)
    let retrieved: Vec<rag::RetrievedChunk> = if !index_ready {
        Vec::new()
    } else {
        match build_embedding_client(&state) {
            Ok(embed_llm) => {
                rag::retrieve(state.db.clone(), &embed_llm, &session_id, &question, top_k)
                    .await
                    .unwrap_or_else(|e| {
                        log::warn!("retrieve 失败 → 仅基于当前页: {e}");
                        Vec::new()
                    })
            }
            Err(e) => {
                log::warn!("build_embedding_client 失败 → 仅基于当前页: {e}");
                Vec::new()
            }
        }
    };

    let sources: Vec<Value> = retrieved
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

    // 立即发 start 事件，前端可以先把 sources 占位渲染上
    let retrieved_count = retrieved.len();
    let fallback_for_response = if fallback_no_index { Some("no_index".to_string()) } else { None };
    let sources_for_response = sources.clone();

    let _ = app_handle.emit(
        "chat-stream-start",
        json!({
            "turn_id": turn_id,
            "session_id": session_id,
            "sources": sources.clone(),
            "retrieved_count": retrieved_count,
            "fallback": fallback_for_response.clone(),
        }),
    );

    // 后台执行流式
    let turn_id_for_task = turn_id.clone();
    let app_for_task = app_handle.clone();
    let doc_title_for_task = doc_title.clone();
    let current_page_for_task = current_page_text.clone();
    let question_for_task = question.clone();
    let chat_llm_for_task = chat_llm.clone();
    let _ = session_id; // 仅在 emit 中用过，不需要进 spawn

    tokio::spawn(async move {
        let app_for_token = app_for_task.clone();
        let turn_id_for_token = turn_id_for_task.clone();
        let on_token = move |delta: &str| {
            let _ = app_for_token.emit(
                "chat-stream-token",
                json!({ "turn_id": turn_id_for_token, "delta": delta }),
            );
        };

        // 推 reasoning 状态:思考开始/结束。前端用这个切"思考中…" UI
        let app_for_reasoning = app_for_task.clone();
        let turn_id_for_reasoning = turn_id_for_task.clone();
        let on_reasoning = move |ph: crate::llm::ReasoningPhase| {
            let phase_str = match ph {
                crate::llm::ReasoningPhase::Start => "start",
                crate::llm::ReasoningPhase::End => "end",
            };
            let _ = app_for_reasoning.emit(
                "chat-stream-reasoning",
                json!({ "turn_id": turn_id_for_reasoning, "phase": phase_str }),
            );
        };

        let result = rag::rag_answer_stream(
            &chat_llm_for_task,
            &doc_title_for_task,
            page_index,
            &current_page_for_task,
            &retrieved,
            &question_for_task,
            &hist,
            "default",
            on_token,
            on_reasoning,
        )
        .await;

        match result {
            Ok(full) => {
                let _ = app_for_task.emit(
                    "chat-stream-done",
                    json!({ "turn_id": turn_id_for_task, "full_answer": full.clone() }),
                );
                // 异步生成追问（不阻塞 done 事件）
                if with_followups && !full.trim().is_empty() {
                    let llm2 = chat_llm_for_task.clone();
                    let app2 = app_for_task.clone();
                    let turn2 = turn_id_for_task.clone();
                    let doc2 = doc_title_for_task.clone();
                    let q2 = question_for_task.clone();
                    tokio::spawn(async move {
                        let fps = rag::generate_followups(&llm2, &doc2, &q2, &full).await;
                        if !fps.is_empty() {
                            let _ = app2.emit(
                                "chat-stream-followups",
                                json!({ "turn_id": turn2, "followups": fps }),
                            );
                        }
                    });
                }
            }
            Err(e) => {
                log::error!("rag_chat_stream[{}] 失败: {}", turn_id_for_task, e);
                let _ = app_for_task.emit(
                    "chat-stream-error",
                    json!({ "turn_id": turn_id_for_task, "error": e }),
                );
            }
        }
        let _ = (); // 占位
    });

    Ok(json!({
        "turn_id": turn_id,
        "sources": sources_for_response,
        "retrieved_count": retrieved_count,
        "fallback": fallback_for_response,
    }))
}

// ══════════════════════════════════════════════════════════════════════════════
// Knowledge Points 命令组（方案 B + A）
//
// 流程：
//   ① rag_index_session（已实现，前置依赖）确保有 rag_chunks
//   ② kp_detect → 切语义边界，写 doc_knowledge_points（status='detected'）
//   ③ kp_refine_titles → LLM 一次性批量打标题（status='titled'）
//   ④ kp_list → UI 列表
//   ⑤ notebook_generate_from_kp(s) → 选定 KP 走 generate_auto_section 入笔记本
//
// 事件：
//   - kp-detect-done { session_id, total }
//   - kp-titles-progress { session_id, completed, total }
//   - kp-titles-done    { session_id, success, total, error? }
//   - kp-notes-progress { session_id, notebook_id, completed, total, kp_id, error? }
//   - kp-notes-done     { session_id, notebook_id, completed, total }
// ══════════════════════════════════════════════════════════════════════════════

/// 把若干 chunk 文本拼成喂给 LLM 的源文。每段前打 `--- 第 N 页 ---` 帮助 LLM
/// 在生成结果里准确引用页码。
fn assemble_kp_source_text(chunks: &[(i64, i64, i64, String)]) -> String {
    let mut s = String::new();
    let mut prev_page: i64 = -1;
    for (_ci, ps, _pe, text) in chunks {
        if *ps != prev_page {
            if !s.is_empty() {
                s.push_str("\n\n");
            }
            s.push_str(&format!("--- 第 {} 页 ---\n\n", *ps + 1));
            prev_page = *ps;
        }
        s.push_str(text.trim());
        s.push_str("\n\n");
    }
    s
}

/// 取一个 KP 的代表性预览片段（首块前 300 字 + 末块前 300 字），用于 LLM 标题输入。
fn kp_snippet_for_title(chunks: &[(i64, i64, i64, String)]) -> String {
    if chunks.is_empty() {
        return String::new();
    }
    const HEAD: usize = 300;
    let first = &chunks[0].3;
    let last = &chunks[chunks.len() - 1].3;
    let head: String = first.chars().take(HEAD).collect();
    if chunks.len() == 1 {
        return head;
    }
    let tail: String = last.chars().take(HEAD).collect();
    format!("{} …（中略）… {}", head, tail)
}

/// 命令 ② —— 检测知识点边界
///
/// 入参 `toc_page_starts`：可选，前端从 PDF outline / docx headings 提取的章节首页（0-based）。
/// 若不传则纯按语义切分（方案 B 单独工作）。
#[tauri::command]
pub async fn kp_detect(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    toc_page_starts: Option<Vec<i64>>,
) -> Result<Value, String> {
    let toc = toc_page_starts.unwrap_or_default();
    // 1. 加载 chunks
    let chunks = {
        let conn = state.db.lock().map_err(|e| format!("DB 锁失败: {e}"))?;
        db::rag_load_chunks(&conn, &session_id)?
    };
    if chunks.is_empty() {
        return Err("尚未构建 RAG 索引（rag_chunks 为空）—— 请先在「聊天」面板中构建知识库".to_string());
    }
    if chunks[0].embedding.is_empty() {
        return Err("RAG chunks 缺少向量字段 —— 请重建索引".to_string());
    }

    // 2. 跑检测
    let kps = knowledge_points::detect_kps(&chunks, &toc);
    let total = kps.len();
    log::info!("KP[{}]: 检测完成 {} 个知识点（TOC 切点 {} 个）", session_id, total, toc.len());

    // 3. 写库：先清旧
    {
        let conn = state.db.lock().map_err(|e| format!("DB 锁失败: {e}"))?;
        db::kp_clear_session(&conn, &session_id)?;
        // 先把所有需要 borrow 的 owned 字符串预生成，确保 lifetime 跨过 insert
        let owned: Vec<(String, String, String)> = kps
            .iter()
            .map(|k| {
                let kp_id = format!("{}::kp::{}", session_id, k.kp_index);
                let ids_json = knowledge_points::chunk_indexes_to_json(&k.chunk_indexes);
                let title_placeholder = format!(
                    "知识点 {} (P{}-{})",
                    k.kp_index + 1, k.page_start + 1, k.page_end + 1
                );
                (kp_id, ids_json, title_placeholder)
            })
            .collect();
        let inserts: Vec<db::KpInsert> = kps
            .iter()
            .zip(owned.iter())
            .map(|(k, (kp_id, ids_json, title_ph))| db::KpInsert {
                kp_id: kp_id.as_str(),
                session_id: &session_id,
                kp_index: k.kp_index,
                title: title_ph.as_str(),
                summary: k.preview.as_str(),
                page_start: k.page_start,
                page_end: k.page_end,
                chunk_ids_json: ids_json.as_str(),
                char_count: k.char_count,
            })
            .collect();
        db::kp_insert_batch(&conn, &inserts)?;
    }

    // 4. emit done
    let _ = app_handle.emit("kp-detect-done", json!({
        "session_id": session_id,
        "total": total,
    }));

    Ok(json!({ "status": "ok", "total": total }))
}

/// 命令 ③ —— 一次性批量为所有"未命名"KP 打标题（LLM）
#[tauri::command]
pub async fn kp_refine_titles(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    force: Option<bool>,
) -> Result<Value, String> {
    let force = force.unwrap_or(false);

    // 1. 取需要打标题的 KP（status='detected' 或 force=true）
    let (doc_title, todo_kps): (String, Vec<db::KpRow>) = {
        let conn = state.db.lock().map_err(|e| format!("DB 锁失败: {e}"))?;
        let session = db::dr_get_session(&conn, &session_id)?;
        let dt = session["filename"].as_str().unwrap_or("").to_string();
        let all = db::kp_list(&conn, &session_id)?;
        let todo: Vec<db::KpRow> = all
            .into_iter()
            .filter(|k| force || k.status == "detected")
            .collect();
        (dt, todo)
    };
    if todo_kps.is_empty() {
        return Ok(json!({ "status": "ok", "total": 0, "skipped": true }));
    }
    let total_for_response = todo_kps.len();

    let sid_for_task = session_id.clone();
    let state_inner = state.inner().clone();
    let app_inner = app_handle.clone();

    tokio::spawn(async move {
        // 2. 拿 LLM
        let llm = match build_llm_or_emit(&state_inner, &app_inner, "kp-titles-done", "").await {
            Some(v) => v,
            None => return,
        };

        // 3. 为每个 KP 拼 snippet
        // 由于 chunk_ids JSON 是 chunk_index 数组，需要 IN 查询取 text
        let mut inputs_owned: Vec<(i64, i64, i64, String)> = Vec::with_capacity(todo_kps.len()); // (kp_index, page_start, page_end, snippet)
        let mut kp_index_to_id: std::collections::HashMap<i64, String> = std::collections::HashMap::new();
        for kp in &todo_kps {
            let chunk_idxs = knowledge_points::chunk_indexes_from_json(&kp.chunk_ids);
            let texts = match state_inner.db.lock() {
                Ok(conn) => db::kp_load_chunk_texts(&conn, &sid_for_task, &chunk_idxs).unwrap_or_default(),
                Err(_) => Vec::new(),
            };
            let snippet = kp_snippet_for_title(&texts);
            inputs_owned.push((kp.kp_index, kp.page_start, kp.page_end, snippet));
            kp_index_to_id.insert(kp.kp_index, kp.kp_id.clone());
        }

        // 4. 构造 borrow 视图喂给 refine_kp_titles
        let inputs: Vec<doc_reader::KpTitleInput> = inputs_owned
            .iter()
            .map(|(ki, ps, pe, s)| doc_reader::KpTitleInput {
                kp_index: *ki,
                page_start: *ps,
                page_end: *pe,
                snippet: s.as_str(),
            })
            .collect();

        let total = inputs.len();
        let _ = app_inner.emit("kp-titles-progress", json!({
            "session_id": sid_for_task, "completed": 0, "total": total,
        }));

        match doc_reader::refine_kp_titles(&llm, &doc_title, &inputs).await {
            Ok(outs) => {
                // 5. 写回 DB
                let mut written = 0usize;
                if let Ok(conn) = state_inner.db.lock() {
                    for o in &outs {
                        if let Some(kpid) = kp_index_to_id.get(&o.kp_index) {
                            let title = doc_reader::sanitize_generated_title(&o.title);
                            let summary = o.summary.trim().to_string();
                            if !title.is_empty() && db::kp_update_title(&conn, kpid, &title, &summary).is_ok() {
                                written += 1;
                            }
                        }
                    }
                }
                let _ = app_inner.emit("kp-titles-progress", json!({
                    "session_id": sid_for_task, "completed": written, "total": total,
                }));
                let _ = app_inner.emit("kp-titles-done", json!({
                    "session_id": sid_for_task, "success": true, "total": written,
                }));
            }
            Err(e) => {
                log::error!("KP 标题生成失败: {e}");
                let _ = app_inner.emit("kp-titles-done", json!({
                    "session_id": sid_for_task, "success": false, "error": e,
                }));
            }
        }
    });

    Ok(json!({ "status": "generating", "total": total_for_response }))
}

/// 命令 ④ —— 列出 session 全部知识点
#[tauri::command]
pub async fn kp_list(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Value, String> {
    let conn = state.db.lock().map_err(|e| format!("DB 锁失败: {e}"))?;
    let rows = db::kp_list(&conn, &session_id)?;
    Ok(serde_json::to_value(rows).map_err(|e| e.to_string())?)
}

/// 命令 ⑤a —— 单个 KP → 写入笔记本的一个 section
#[tauri::command]
pub async fn notebook_generate_from_kp(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    notebook_id: String,
    kp_id: String,
) -> Result<Value, String> {
    let entry_id = uuid::Uuid::new_v4().to_string();

    // 1. 取 KP / chunks / doc_title
    let (doc_title, kp_row, source_text, source_label) = {
        let conn = state.db.lock().map_err(|e| format!("DB 锁失败: {e}"))?;
        let kp = db::kp_get(&conn, &kp_id)?;
        let session = db::dr_get_session(&conn, &kp.session_id)?;
        let doc_title = session["filename"].as_str().unwrap_or("").to_string();
        let chunk_idxs = knowledge_points::chunk_indexes_from_json(&kp.chunk_ids);
        let texts = db::kp_load_chunk_texts(&conn, &kp.session_id, &chunk_idxs)?;
        let src = assemble_kp_source_text(&texts);
        let label = if kp.page_start == kp.page_end {
            format!("第 {} 页", kp.page_start + 1)
        } else {
            format!("第 {}-{} 页（{}）", kp.page_start + 1, kp.page_end + 1, if kp.title.is_empty() { "知识点".to_string() } else { kp.title.clone() })
        };
        (doc_title, kp, src, label)
    };

    if source_text.trim().is_empty() {
        return Err("该知识点对应的 chunks 文本为空".to_string());
    }

    let eid = entry_id.clone();
    let nbid = notebook_id.clone();
    let sid = kp_row.session_id.clone();
    let kpid_for_task = kp_id.clone();
    let kp_title_hint = kp_row.title.clone();
    let kp_summary = kp_row.summary.clone();
    let page_start = kp_row.page_start;
    let page_end = kp_row.page_end;
    let chunk_idxs_json = kp_row.chunk_ids.clone();
    let state_inner = state.inner().clone();
    let app_inner = app_handle.clone();

    tokio::spawn(async move {
        let llm = match build_llm_or_emit(&state_inner, &app_inner, "notebook-section-error", &eid).await {
            Some(v) => v,
            None => return,
        };

        // 把已有 KP 标题/摘要作为 hint，让 LLM 生成时不偏题
        let hint = if !kp_title_hint.is_empty() || !kp_summary.is_empty() {
            Some(format!(
                "本知识点已有的主题倾向：{}\n摘要：{}",
                if kp_title_hint.is_empty() { "未命名" } else { &kp_title_hint },
                if kp_summary.is_empty() { "（无）" } else { &kp_summary }
            ))
        } else {
            None
        };

        // 收集本次生成结果，最后统一 emit 进度/完成事件，
        // 让前端 KP 面板的 kp-notes-progress / kp-notes-done 监听器能够及时收到反馈。
        let result_error: Option<String> = match doc_reader::generate_auto_section(&llm, &doc_title, &source_label, &source_text, hint.as_deref()).await {
            Ok(note_content) => {
                let title = doc_reader::extract_section_title_from_md(&note_content)
                    .filter(|t| !t.is_empty())
                    .or_else(|| if kp_title_hint.is_empty() { None } else { Some(kp_title_hint.clone()) })
                    .unwrap_or_else(|| format!("第 {}-{} 页知识点", page_start + 1, page_end + 1));

                // 把 chunk 覆盖的页范围（连续）写进 page_indexes，便于回查
                let mut page_indexes: Vec<i64> = (page_start..=page_end).collect();
                page_indexes.dedup();
                let page_indexes_json = serde_json::to_string(&page_indexes).unwrap_or_else(|_| "[]".to_string());

                let anchor = db::NbAnchor {
                    source_session_id: sid.clone(),
                    source_page_start: Some(page_start),
                    source_page_end: Some(page_end),
                    source_page_indexes: page_indexes_json,
                    source_kind: "knowledge_point".to_string(),
                    parent_entry_id: String::new(),
                    section_role: "root_note".to_string(),
                    chat_history_json: String::new(),
                };
                let mut write_err: Option<String> = None;
                if let Ok(conn) = state_inner.db.lock() {
                    if let Err(e) = db::nb_add_entry_anchored(
                        &conn, &eid, &nbid, &title, &note_content,
                        "knowledge_point", &source_label, &anchor,
                    ) {
                        log::error!("KP 笔记写入失败: {e}");
                        let _ = app_inner.emit("notebook-section-error", json!({
                            "entry_id": eid.clone(), "error": e.clone(),
                        }));
                        write_err = Some(e);
                    } else {
                        let _ = db::kp_mark_note_generated(&conn, &kpid_for_task, &eid);
                    }
                }
                if write_err.is_none() {
                    let _ = app_inner.emit("notebook-section-generated", json!({
                        "entry_id": eid.clone(), "notebook_id": nbid.clone(), "parent_entry_id": "",
                        "section_role": "root_note", "source_session_id": sid.clone(),
                        "source_page_start": page_start, "source_page_end": page_end,
                        "source_kind": "knowledge_point", "kp_id": kpid_for_task.clone(),
                    }));
                    log::info!("KP 笔记生成完成 kp={} entry={} chunks={}", kpid_for_task, eid, chunk_idxs_json);
                }
                write_err
            }
            Err(e) => {
                log::error!("KP 笔记生成失败: {e}");
                let _ = app_inner.emit("notebook-section-error", json!({
                    "entry_id": eid.clone(), "error": e.clone(),
                }));
                Some(e)
            }
        };

        // 单 KP 路径也走 kp-notes-progress / kp-notes-done，保持与批量路径一致，
        // 这样前端面板就能正确从 generating 回到 idle / error。
        let mut progress = json!({
            "session_id": sid.clone(),
            "notebook_id": nbid.clone(),
            "completed": 1,
            "total": 1,
            "kp_id": kpid_for_task.clone(),
        });
        if let Some(err) = &result_error {
            progress["error"] = json!(err);
        }
        let _ = app_inner.emit("kp-notes-progress", progress);
        let _ = app_inner.emit("kp-notes-done", json!({
            "session_id": sid,
            "notebook_id": nbid,
            "completed": 1,
            "total": 1,
        }));
    });

    Ok(json!({ "status": "generating", "entry_id": entry_id }))
}

/// 命令 ⑤b —— 批量为多个 KP 生成笔记（串行，避免 LLM 限流）
///
/// `kp_ids` 为空表示"为该 session 全部 KP 生成"。已写过的（status='note_generated'）
/// 默认跳过，可用 `force=true` 强制重写。
#[tauri::command]
pub async fn notebook_generate_from_kps_all(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    notebook_id: String,
    session_id: String,
    kp_ids: Option<Vec<String>>,
    force: Option<bool>,
) -> Result<Value, String> {
    let force = force.unwrap_or(false);

    // 取目标 KP 列表
    let (doc_title, targets): (String, Vec<db::KpRow>) = {
        let conn = state.db.lock().map_err(|e| format!("DB 锁失败: {e}"))?;
        let session = db::dr_get_session(&conn, &session_id)?;
        let doc_title = session["filename"].as_str().unwrap_or("").to_string();
        let all = db::kp_list(&conn, &session_id)?;
        let selected: Vec<db::KpRow> = match &kp_ids {
            Some(ids) if !ids.is_empty() => {
                let set: std::collections::HashSet<&String> = ids.iter().collect();
                all.into_iter().filter(|k| set.contains(&k.kp_id)).collect()
            }
            _ => all,
        };
        let filtered: Vec<db::KpRow> = selected
            .into_iter()
            .filter(|k| force || k.status != "note_generated")
            .collect();
        (doc_title, filtered)
    };

    let total = targets.len();
    if total == 0 {
        return Ok(json!({ "status": "ok", "total": 0 }));
    }

    let nbid = notebook_id.clone();
    let sid = session_id.clone();
    let state_inner = state.inner().clone();
    let app_inner = app_handle.clone();

    tokio::spawn(async move {
        let llm = match build_llm_or_emit(&state_inner, &app_inner, "kp-notes-done", "").await {
            Some(v) => v,
            None => return,
        };

        let mut completed = 0usize;
        for kp in targets {
            let eid = uuid::Uuid::new_v4().to_string();

            // 取 chunks
            let (source_text, source_label) = {
                let chunk_idxs = knowledge_points::chunk_indexes_from_json(&kp.chunk_ids);
                let texts = match state_inner.db.lock() {
                    Ok(conn) => db::kp_load_chunk_texts(&conn, &sid, &chunk_idxs).unwrap_or_default(),
                    Err(_) => Vec::new(),
                };
                let src = assemble_kp_source_text(&texts);
                let label = if kp.page_start == kp.page_end {
                    format!("第 {} 页（{}）", kp.page_start + 1, if kp.title.is_empty() { "知识点".to_string() } else { kp.title.clone() })
                } else {
                    format!("第 {}-{} 页（{}）", kp.page_start + 1, kp.page_end + 1, if kp.title.is_empty() { "知识点".to_string() } else { kp.title.clone() })
                };
                (src, label)
            };

            if source_text.trim().is_empty() {
                completed += 1;
                let _ = app_inner.emit("kp-notes-progress", json!({
                    "session_id": sid, "notebook_id": nbid, "completed": completed, "total": total,
                    "kp_id": kp.kp_id, "error": "源文本为空",
                }));
                continue;
            }

            let hint = if !kp.title.is_empty() || !kp.summary.is_empty() {
                Some(format!(
                    "本知识点已有的主题倾向：{}\n摘要：{}",
                    if kp.title.is_empty() { "未命名" } else { &kp.title },
                    if kp.summary.is_empty() { "（无）" } else { &kp.summary }
                ))
            } else {
                None
            };

            match doc_reader::generate_auto_section(&llm, &doc_title, &source_label, &source_text, hint.as_deref()).await {
                Ok(note_content) => {
                    let title = doc_reader::extract_section_title_from_md(&note_content)
                        .filter(|t| !t.is_empty())
                        .or_else(|| if kp.title.is_empty() { None } else { Some(kp.title.clone()) })
                        .unwrap_or_else(|| format!("第 {}-{} 页知识点", kp.page_start + 1, kp.page_end + 1));

                    let page_indexes: Vec<i64> = (kp.page_start..=kp.page_end).collect();
                    let page_indexes_json = serde_json::to_string(&page_indexes).unwrap_or_else(|_| "[]".to_string());
                    let anchor = db::NbAnchor {
                        source_session_id: sid.clone(),
                        source_page_start: Some(kp.page_start),
                        source_page_end: Some(kp.page_end),
                        source_page_indexes: page_indexes_json,
                        source_kind: "knowledge_point".to_string(),
                        parent_entry_id: String::new(),
                        section_role: "root_note".to_string(),
                        chat_history_json: String::new(),
                    };
                    let mut ok = true;
                    if let Ok(conn) = state_inner.db.lock() {
                        if let Err(e) = db::nb_add_entry_anchored(
                            &conn, &eid, &nbid, &title, &note_content,
                            "knowledge_point", &source_label, &anchor,
                        ) {
                            log::error!("KP 批量写入失败: {e}");
                            ok = false;
                        } else {
                            let _ = db::kp_mark_note_generated(&conn, &kp.kp_id, &eid);
                        }
                    }
                    completed += 1;
                    if ok {
                        let _ = app_inner.emit("notebook-section-generated", json!({
                            "entry_id": eid, "notebook_id": nbid, "parent_entry_id": "",
                            "section_role": "root_note", "source_session_id": sid,
                            "source_page_start": kp.page_start, "source_page_end": kp.page_end,
                            "source_kind": "knowledge_point", "kp_id": kp.kp_id,
                        }));
                    }
                    let _ = app_inner.emit("kp-notes-progress", json!({
                        "session_id": sid, "notebook_id": nbid, "completed": completed, "total": total,
                        "kp_id": kp.kp_id,
                    }));
                }
                Err(e) => {
                    log::error!("KP 批量生成失败: {e}");
                    completed += 1;
                    let _ = app_inner.emit("kp-notes-progress", json!({
                        "session_id": sid, "notebook_id": nbid, "completed": completed, "total": total,
                        "kp_id": kp.kp_id, "error": e,
                    }));
                }
            }
        }

        let _ = app_inner.emit("kp-notes-done", json!({
            "session_id": sid, "notebook_id": nbid, "completed": completed, "total": total,
        }));
    });

    Ok(json!({ "status": "generating", "total": total }))
}

/// 命令 ⑥ —— 一站式：自动检测 + 自动命名 + 生成所有知识点笔记 → 拼成一份大 markdown
///
/// 设计目标（来自用户反馈）：
/// 1. 单按钮触发，不再让用户手动 detect / 命名 / 选笔记本 / 逐条点击
/// 2. 输出到剪贴板，让用户自由粘贴到任何位置（不强制写入笔记本）
/// 3. 后台 spawn，**不依赖任何 UI 组件**，离开阅读器、切换 tab 都不会打断
///
/// 全部进度走两个全局事件：
///   - `kp-clipboard-progress` { session_id, stage, completed, total, message }
///       stage ∈ "preparing" | "detecting" | "titling" | "generating"
///   - `kp-clipboard-done`     { session_id, success, total?, completed?, markdown?, error? }
///
/// 完成后由前端负责把 `markdown` 写入剪贴板（在 App 顶层全局监听器里做），
/// 这样任何路由下的用户都能拿到结果。
#[tauri::command]
pub async fn kp_generate_to_clipboard(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    force: Option<bool>,
) -> Result<Value, String> {
    let force = force.unwrap_or(false);
    let sid = session_id.clone();
    let state_inner = state.inner().clone();
    let app_inner = app_handle.clone();

    tokio::spawn(async move {
        // ── helpers ──────────────────────────────────────────────────────────
        let emit_progress = |stage: &str, completed: usize, total: usize, message: &str| {
            let _ = app_inner.emit("kp-clipboard-progress", json!({
                "session_id": sid,
                "stage": stage,
                "completed": completed,
                "total": total,
                "message": message,
            }));
        };
        let emit_done_err = |err: String| {
            let _ = app_inner.emit("kp-clipboard-done", json!({
                "session_id": sid,
                "success": false,
                "error": err,
            }));
        };

        // ── 0. 加载 chunks，校验 RAG ─────────────────────────────────────────
        emit_progress("preparing", 0, 0, "正在加载已有索引…");
        let chunks = match state_inner.db.lock() {
            Ok(conn) => match db::rag_load_chunks(&conn, &sid) {
                Ok(c) => c,
                Err(e) => { emit_done_err(format!("加载 chunks 失败: {e}")); return; }
            },
            Err(e) => { emit_done_err(format!("DB 锁失败: {e}")); return; }
        };
        if chunks.is_empty() {
            emit_done_err("尚未构建 RAG 索引（rag_chunks 为空）—— 请先在「聊天」面板中构建知识库".to_string());
            return;
        }
        if chunks[0].embedding.is_empty() {
            emit_done_err("RAG chunks 缺少向量字段 —— 请重建索引".to_string());
            return;
        }

        // ── 1. 取已有 KP；为空或 force 时检测 ────────────────────────────────
        let mut kps: Vec<db::KpRow> = match state_inner.db.lock() {
            Ok(conn) => db::kp_list(&conn, &sid).unwrap_or_default(),
            Err(_) => Vec::new(),
        };
        if kps.is_empty() || force {
            emit_progress("detecting", 0, 0, "切分语义边界（本地向量计算）…");
            let detected = knowledge_points::detect_kps(&chunks, &[]);
            if let Ok(conn) = state_inner.db.lock() {
                let _ = db::kp_clear_session(&conn, &sid);
                let owned: Vec<(String, String, String)> = detected.iter()
                    .map(|k| {
                        let kp_id = format!("{}::kp::{}", sid, k.kp_index);
                        let ids_json = knowledge_points::chunk_indexes_to_json(&k.chunk_indexes);
                        let title_ph = format!(
                            "知识点 {} (P{}-{})",
                            k.kp_index + 1, k.page_start + 1, k.page_end + 1
                        );
                        (kp_id, ids_json, title_ph)
                    }).collect();
                let inserts: Vec<db::KpInsert> = detected.iter().zip(owned.iter())
                    .map(|(k, (kid, ids, t))| db::KpInsert {
                        kp_id: kid.as_str(),
                        session_id: &sid,
                        kp_index: k.kp_index,
                        title: t.as_str(),
                        summary: k.preview.as_str(),
                        page_start: k.page_start,
                        page_end: k.page_end,
                        chunk_ids_json: ids.as_str(),
                        char_count: k.char_count,
                    }).collect();
                let _ = db::kp_insert_batch(&conn, &inserts);
            }
            kps = match state_inner.db.lock() {
                Ok(conn) => db::kp_list(&conn, &sid).unwrap_or_default(),
                Err(_) => Vec::new(),
            };
        }

        if kps.is_empty() {
            emit_done_err("未检测到任何知识点（文档过短或 chunks 异常）".to_string());
            return;
        }

        // ── 2. 取 LLM ────────────────────────────────────────────────────────
        let llm = match build_llm_or_emit(&state_inner, &app_inner, "kp-clipboard-done", "").await {
            Some(v) => v,
            None => return, // build_llm_or_emit 已 emit 错误事件
        };

        // ── 3. 取 doc_title（用于 prompt 上下文） ───────────────────────────
        let doc_title = match state_inner.db.lock() {
            Ok(conn) => db::dr_get_session(&conn, &sid).ok()
                .and_then(|s| s["filename"].as_str().map(String::from))
                .unwrap_or_default(),
            Err(_) => String::new(),
        };

        // ── 4. 命名（status='detected' 的 KP；force 时全部重命名） ─────────
        let needs_title: Vec<db::KpRow> = kps.iter()
            .filter(|k| force || k.status == "detected")
            .cloned()
            .collect();
        if !needs_title.is_empty() {
            emit_progress(
                "titling", 0, needs_title.len(),
                &format!("LLM 命名 {} 个知识点…", needs_title.len()),
            );
            let mut inputs_owned: Vec<(i64, i64, i64, String)> = Vec::with_capacity(needs_title.len());
            let mut kp_index_to_id: std::collections::HashMap<i64, String> = std::collections::HashMap::new();
            for kp in &needs_title {
                let chunk_idxs = knowledge_points::chunk_indexes_from_json(&kp.chunk_ids);
                let texts = match state_inner.db.lock() {
                    Ok(conn) => db::kp_load_chunk_texts(&conn, &sid, &chunk_idxs).unwrap_or_default(),
                    Err(_) => Vec::new(),
                };
                let snippet = kp_snippet_for_title(&texts);
                inputs_owned.push((kp.kp_index, kp.page_start, kp.page_end, snippet));
                kp_index_to_id.insert(kp.kp_index, kp.kp_id.clone());
            }
            let inputs: Vec<doc_reader::KpTitleInput> = inputs_owned.iter()
                .map(|(ki, ps, pe, s)| doc_reader::KpTitleInput {
                    kp_index: *ki,
                    page_start: *ps,
                    page_end: *pe,
                    snippet: s.as_str(),
                })
                .collect();
            match doc_reader::refine_kp_titles(&llm, &doc_title, &inputs).await {
                Ok(outs) => {
                    if let Ok(conn) = state_inner.db.lock() {
                        for o in &outs {
                            if let Some(kpid) = kp_index_to_id.get(&o.kp_index) {
                                let title = doc_reader::sanitize_generated_title(&o.title);
                                let summary = o.summary.trim().to_string();
                                if !title.is_empty() {
                                    let _ = db::kp_update_title(&conn, kpid, &title, &summary);
                                }
                            }
                        }
                    }
                }
                Err(e) => {
                    // 命名失败不致命，可以用 placeholder 标题继续生成
                    log::warn!("KP 命名失败但继续生成: {e}");
                }
            }
            // 重读最新数据
            kps = match state_inner.db.lock() {
                Ok(conn) => db::kp_list(&conn, &sid).unwrap_or_default(),
                Err(_) => Vec::new(),
            };
        }

        // ── 5. 选目标 KP（默认跳过已生成；force 强制重写） ─────────────────
        let targets: Vec<db::KpRow> = kps.iter()
            .filter(|k| force || k.status != "note_generated")
            .cloned()
            .collect();
        let total = targets.len();
        if total == 0 {
            emit_done_err("没有需要生成的知识点（全部已成笔记）。如需重写请使用 force=true".to_string());
            return;
        }

        // ── 6. 串行生成 + 拼接 markdown ─────────────────────────────────────
        let mut buffer = String::new();
        let mut completed = 0usize;
        // 顶部加一段元信息 header，帮助用户在剪贴板里识别
        buffer.push_str(&format!(
            "<!-- doc-reader · 知识点笔记 · 来源：{} -->\n\n",
            if doc_title.is_empty() { "（未命名）" } else { &doc_title }
        ));

        for kp in &targets {
            emit_progress(
                "generating", completed, total,
                &format!(
                    "生成第 {}/{} 段：{}",
                    completed + 1,
                    total,
                    if kp.title.is_empty() { "（未命名）" } else { kp.title.as_str() }
                ),
            );

            let chunk_idxs = knowledge_points::chunk_indexes_from_json(&kp.chunk_ids);
            let texts = match state_inner.db.lock() {
                Ok(conn) => db::kp_load_chunk_texts(&conn, &sid, &chunk_idxs).unwrap_or_default(),
                Err(_) => Vec::new(),
            };
            let source_text = assemble_kp_source_text(&texts);
            if source_text.trim().is_empty() {
                completed += 1;
                continue;
            }
            let source_label = if kp.page_start == kp.page_end {
                format!(
                    "第 {} 页（{}）",
                    kp.page_start + 1,
                    if kp.title.is_empty() { "知识点" } else { kp.title.as_str() }
                )
            } else {
                format!(
                    "第 {}-{} 页（{}）",
                    kp.page_start + 1,
                    kp.page_end + 1,
                    if kp.title.is_empty() { "知识点" } else { kp.title.as_str() }
                )
            };
            let hint = if !kp.title.is_empty() || !kp.summary.is_empty() {
                Some(format!(
                    "本知识点已有的主题倾向：{}\n摘要：{}",
                    if kp.title.is_empty() { "未命名" } else { kp.title.as_str() },
                    if kp.summary.is_empty() { "（无）" } else { kp.summary.as_str() },
                ))
            } else {
                None
            };

            match doc_reader::generate_auto_section(&llm, &doc_title, &source_label, &source_text, hint.as_deref()).await {
                Ok(note_md) => {
                    let inferred_title = doc_reader::extract_section_title_from_md(&note_md)
                        .filter(|t| !t.is_empty())
                        .or_else(|| if kp.title.is_empty() { None } else { Some(kp.title.clone()) })
                        .unwrap_or_else(|| format!("第 {}-{} 页知识点", kp.page_start + 1, kp.page_end + 1));

                    if !buffer.trim_end().is_empty() && completed > 0 {
                        buffer.push_str("\n\n---\n\n");
                    }
                    if note_md.trim_start().starts_with('#') {
                        buffer.push_str(note_md.trim());
                    } else {
                        buffer.push_str(&format!("# {}\n\n{}", inferred_title.trim(), note_md.trim()));
                    }
                    buffer.push('\n');
                }
                Err(e) => {
                    log::error!("KP 生成失败 kp={} err={e}", kp.kp_id);
                    if completed > 0 {
                        buffer.push_str("\n\n---\n\n");
                    }
                    buffer.push_str(&format!(
                        "# {}\n\n*[生成失败：{}]*\n",
                        if kp.title.is_empty() {
                            format!("第 {}-{} 页知识点", kp.page_start + 1, kp.page_end + 1)
                        } else { kp.title.clone() },
                        e
                    ));
                }
            }
            completed += 1;
            emit_progress(
                "generating", completed, total,
                &format!("已完成 {}/{}", completed, total),
            );
        }

        // ── 7. 完成 —— 携带完整 markdown 给前端写剪贴板 ────────────────────
        let _ = app_inner.emit("kp-clipboard-done", json!({
            "session_id": sid,
            "success": true,
            "total": total,
            "completed": completed,
            "markdown": buffer,
        }));
    });

    Ok(json!({ "status": "generating" }))
}

// ══════════════════════════════════════════════════════════════════════════════
// 学习 Agent（DESIGN.md §13 v2 Auto-Pilot）
// ══════════════════════════════════════════════════════════════════════════════
//
// 命令一览：
//   agent_get_state              : 取整个 session 的 Agent 状态（路线图 + 各单元教学/答题）
//   agent_plan_generate          : 生成或重建路线图（1 req）。返回 outline 含 skip_pages + units[]
//   agent_teach_unit_stream      : 流式生成单元教学。立即返回 turn_id；后端 spawn 异步：
//                                   - 推送 agent-teach-token { turn_id, delta }
//                                   - 完成时 agent-teach-done  { turn_id, full_explanation, questions[], unit_index }
//                                   - 失败时 agent-teach-error { turn_id, error }
//                                   讲解和题目通过 <<<QUESTIONS>>> 分隔符切分。
//   agent_submit_answers         : 提交单元答案。选择题前端比对（0 req）；简答题批量送 LLM（最多 1 req）。
//   agent_advance                : 推进单元（next / retry / pause）。
//                                   next 时把本单元 explanation append 到全书笔记
//                                   （复用 dr_save_note + merge_note_by_page，
//                                   按本单元 pages 中位数页码作为锚点）。
//   agent_reset                  : 清空路线图 + 全部单元状态。

/// 路线图抽样：
/// - **前 6 页全取**（通常版权 / 目录 / 致谢 / 课程介绍都在这里，让 LLM 看清才能正确填 skip_pages）
/// - 中段每 N 页取 1 页（page_total / 6 为步长，最多 8 个抽样）
/// - 末 2 页全取
///
/// 单页限 400 字（保证 prompt 不爆）。
fn agent_collect_outline_samples(
    conn: &rusqlite::Connection,
    session_id: &str,
    page_total: usize,
) -> Vec<(usize, String)> {
    if page_total == 0 {
        return Vec::new();
    }
    let mut indices: std::collections::BTreeSet<usize> = std::collections::BTreeSet::new();
    // 前 6 页（识别版权 / 目录 / 致谢 / 课程介绍）
    for i in 0..page_total.min(6) {
        indices.insert(i);
    }
    // 末 2 页（识别索引 / 参考文献 / 后记）
    if page_total >= 2 {
        indices.insert(page_total - 1);
        indices.insert(page_total - 2);
    }
    // 中段：每 step 页取一个
    if page_total > 8 {
        let step = (page_total / 8).max(1);
        let mut idx = 6;
        while idx < page_total - 2 {
            indices.insert(idx);
            idx += step;
        }
    }

    let mut out: Vec<(usize, String)> = Vec::new();
    for idx in indices {
        if let Ok(page) = db::dr_get_page(conn, session_id, idx) {
            let content = page["content"].as_str().unwrap_or("");
            let trimmed: String = content.chars().take(400).collect();
            if !trimmed.trim().is_empty() {
                out.push((idx, trimmed));
            }
        }
    }
    out
}

/// 把某 unit 的所有页内容拼接为单元原文（用于喂给教学 LLM）。
///
/// `unit.pages` 是 1-based 页码数组，可能不连续；本函数转 0-based 取 `doc_pages.content`。
/// 单页限 1500 字，单元总文本限 6000 字（避免 prompt 爆）。
fn agent_collect_unit_text(
    conn: &rusqlite::Connection,
    session_id: &str,
    unit: &Value,
) -> String {
    let pages = match unit.get("pages").and_then(|x| x.as_array()) {
        Some(arr) => arr.clone(),
        None => return String::new(),
    };
    let mut out = String::new();
    let mut total_chars = 0usize;
    const PAGE_CAP: usize = 1500;
    const UNIT_CAP: usize = 6000;

    for p in pages {
        let p1 = match p.as_i64() {
            Some(n) if n >= 1 => n as usize,
            _ => continue,
        };
        let zero_based = p1 - 1;
        if let Ok(page) = db::dr_get_page(conn, session_id, zero_based) {
            let content = page["content"].as_str().unwrap_or("");
            let chunk: String = content.chars().take(PAGE_CAP).collect();
            if chunk.trim().is_empty() {
                continue;
            }
            if !out.is_empty() {
                out.push_str("\n\n");
            }
            out.push_str(&format!("### 第 {} 页\n{}", p1, chunk.trim()));
            total_chars += chunk.chars().count();
            if total_chars >= UNIT_CAP {
                break;
            }
        }
    }
    out
}

/// 取整个 session 的 Agent 状态（路线图 + 所有页状态）。
/// 没有路线图时 plan = null；前端需要先调 `agent_plan_generate`。
#[tauri::command]
pub async fn agent_get_state(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Value, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::agent_get_state(&conn, &session_id)
}

/// 取学习单元的笔记本 entry_id（v4 学习↔笔记绑定）。
///
/// 用途：前端 AgentTab 需要打开"在笔记本中查看"按钮时获取 entry_id；
/// 也用于双向同步：前端编辑讲解时调 `notebook_update_entry(entry_id, ...)`。
///
/// 返回 `{ entry_id, notebook_id, exists }`。若该 unit 还没生成讲解，entry_id 仍按
/// deterministic 规则返回（前端可据此预先准备 UI），但 exists=false 表示尚未真正写入 DB。
#[tauri::command]
pub async fn agent_get_unit_entry_id(
    state: State<'_, AppState>,
    session_id: String,
    unit_index: usize,
) -> Result<Value, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let entry_id = db::study_unit_entry_id(&session_id, unit_index);
    let notebook_id = db::study_notebook_id(&session_id);
    let exists: bool = conn
        .query_row(
            "SELECT 1 FROM notebook_entries WHERE entry_id = ?1",
            rusqlite::params![entry_id],
            |_| Ok(true),
        )
        .unwrap_or(false);
    Ok(json!({
        "entry_id": entry_id,
        "notebook_id": notebook_id,
        "exists": exists,
    }))
}

/// 生成 wizard 问题（LLM 动态出 3-5 道单选题让用户表达学习偏好）。
///
/// 前端流程：用户点"开始学习" → 调本命令 → 拿到问题列表展示卡片式 UI →
/// 用户作答 → 把 Q/A 拼成多行文本传给 `agent_plan_generate(user_preferences)`。
///
/// 不在后端持久化（前端按需调用）；问题是 doc-specific 的，每次都重新生成。
#[tauri::command]
pub async fn agent_clarify_questions(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Value, String> {
    let (doc_title, samples) = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        let session = db::dr_get_session(&conn, &session_id)?;
        let doc_title = session["filename"].as_str().unwrap_or("").to_string();
        let page_total = session["page_count"].as_i64().unwrap_or(0) as usize;
        if page_total == 0 {
            return Err("当前资料无可解析页面".to_string());
        }
        let samples = agent_collect_outline_samples(&conn, &session_id, page_total);
        (doc_title, samples)
    };

    if samples.is_empty() {
        return Err("抽样到的页面均为空".to_string());
    }

    let llm = {
        let models = config::load_models(&state.config_path);
        let configs = config::to_llm_configs(&models);
        if !configs.is_empty() {
            LlmClient::from_pool(configs)
        } else {
            LlmConfig::from_env()
                .map(LlmClient::new)
                .map_err(|e| e.to_string())?
        }
    };

    agent::generate_clarify_questions(&llm, &doc_title, &samples).await
}

/// 生成或重建路线图。
/// `force = true` 时覆盖现有路线图（同时清空所有页状态，因为路线变了，旧教学包可能不再适用）。
///
/// `user_preferences`: 可选的 wizard 回答（自由文本）。前端用 `agent_clarify_questions`
/// 拿到动态题目，让用户作答后把 "Q1: ... → A: ..." 这种多行文本传过来。后端拼到
/// outline prompt 里。
///
/// v7 (2026-05) 自动归档（force=true 路径）后 emit `agent-archive-changed`，
/// 让 ArchiveListPanel 即时刷新档案列表。
#[tauri::command]
pub async fn agent_plan_generate(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    force: Option<bool>,
    user_preferences: Option<String>,
) -> Result<Value, String> {
    let force = force.unwrap_or(false);

    // 缓存命中：未指定 force 且已有 plan，直接返回
    if !force {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        let existing = db::agent_get_state(&conn, &session_id)?;
        if !existing["plan"].is_null() {
            return Ok(json!({
                "status": "cached",
                "plan": existing["plan"].clone(),
            }));
        }
    }

    // 取 session 信息 + 抽样
    let (doc_title, page_total, samples) = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        let session = db::dr_get_session(&conn, &session_id)?;
        let doc_title = session["filename"].as_str().unwrap_or("").to_string();
        let page_total = session["page_count"].as_i64().unwrap_or(0) as usize;
        if page_total == 0 {
            return Err("当前资料无可解析页面，无法生成学习路线图".to_string());
        }
        let samples = agent_collect_outline_samples(&conn, &session_id, page_total);
        (doc_title, page_total, samples)
    };

    if samples.is_empty() {
        return Err("抽样到的页面均为空，无法生成路线图".to_string());
    }

    // 构造 LLM
    let llm = {
        let models = config::load_models(&state.config_path);
        let configs = config::to_llm_configs(&models);
        if !configs.is_empty() {
            LlmClient::from_pool(configs)
        } else {
            LlmConfig::from_env().map(LlmClient::new).map_err(|e| e.to_string())?
        }
    };

    let outline = agent::generate_outline(
        &llm,
        &doc_title,
        page_total,
        &samples,
        user_preferences.as_deref(),
    )
    .await?;
    let outline_str = serde_json::to_string(&outline)
        .map_err(|e| format!("序列化路线图失败: {e}"))?;

    // force = true 时：
    //   1) **先自动归档**当前学习流（如果有的话）—— 保证"重新学习"不会撤销保存
    //   2) 再清空旧单元状态
    //   3) 写入新 plan
    //   4) vibe 事件带上 previous_archive_id，前端可"点回去复习"
    let previous_archive_id = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        if force {
            db::agent_auto_archive_if_active(&conn, &session_id, "plan_regenerate")
        } else {
            None
        }
    };
    {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        if force {
            conn.execute(
                "DELETE FROM agent_unit_states WHERE session_id = ?1",
                rusqlite::params![session_id],
            )
            .map_err(|e| format!("清空单元状态失败: {e}"))?;
        }
        db::agent_save_plan(&conn, &session_id, &outline_str, page_total)?;
        // v6 (2026-05) #3: vibe 事件 —— 路线图生成
        //   outline 是 serde_json::Value（agent::generate_outline 的返回），
        //   通过 .get()/.as_xxx() 安全取字段。
        let unit_count = outline
            .get("units")
            .and_then(|u| u.as_array())
            .map(|a| a.len() as i64)
            .unwrap_or(0);
        let thesis = outline
            .get("thesis")
            .and_then(|t| t.as_str())
            .unwrap_or("")
            .to_string();
        db::vibe_event_append(
            &conn,
            &session_id,
            "plan_generated",
            None,
            previous_archive_id.as_deref().unwrap_or(""),
            &json!({
                "doc_title": doc_title,
                "page_total": page_total,
                "unit_count": unit_count,
                "thesis": thesis,
                "force": force,
                "previous_archive_id": previous_archive_id,
                "user_preferences": user_preferences,
            }),
        );
    }

    // v7 (2026-05) 释放 db 锁后 emit archive-changed：force=true + 有归档时通知前端
    if let Some(ref aid) = previous_archive_id {
        let _ = app.emit(
            "agent-archive-changed",
            json!({
                "session_id": session_id,
                "archive_id": aid,
                "reason": "saved",
            }),
        );
    }

    Ok(json!({
        "status": "generated",
        "plan": {
            "outline": outline,
            "page_total": page_total,
            "current_unit": 0,
            "current_phase": "idle",
        },
    }))
}

/// 流式生成单元教学（讲解 + 题目）。
///
/// 立即返回 `{ turn_id, unit_index, needs_quiz }`，前端 listen 三种事件：
///   - `agent-teach-token { turn_id, delta }`        : 讲解段增量（前端实时 markdown 渲染）
///   - `agent-teach-done  { turn_id, unit_index,
///                          full_explanation, questions[], needs_quiz }` : 流结束
///   - `agent-teach-error { turn_id, error }`        : 失败
///
/// 后端在 `agent-teach-done` 之前已经完成持久化（save_teach_pack +
/// set_phase=probing 或 reviewing），前端只需 refresh 即可拿到最终状态。
#[tauri::command]
pub async fn agent_teach_unit_stream(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    unit_index: usize,
) -> Result<Value, String> {
    // ★ Prefetch 短路：如果该单元已被 prefetch_unit 生成过 teach_pack，
    //   直接把 phase 推到 probing/reviewing 并发个事件让前端 refresh，不再走 LLM。
    //   返回 status=cached。
    {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        if let Some(tp) = db::agent_get_teach_pack(&conn, &session_id, unit_index)? {
            let has = tp
                .get("explanation")
                .and_then(|x| x.as_str())
                .map(|s| !s.trim().is_empty())
                .unwrap_or(false);
            if has {
                let q_count = tp
                    .get("questions")
                    .and_then(|x| x.as_array())
                    .map(|a| a.len())
                    .unwrap_or(0);
                let next_phase = if q_count > 0 { "probing" } else { "reviewing" };
                db::agent_set_phase(&conn, &session_id, unit_index, next_phase)?;
                drop(conn);
                let _ = app_handle.emit(
                    "agent-teach-cached",
                    json!({
                        "session_id": session_id,
                        "unit_index": unit_index,
                        "phase": next_phase,
                    }),
                );
                return Ok(json!({
                    "status": "cached",
                    "unit_index": unit_index,
                    "phase": next_phase,
                }));
            }
        }
    }

    // 取 outline + 该 unit + 拼接 unit 文本 + 上下文轨迹（thesis / 历史 / 下一单元）
    let (doc_title, unit_value, pages_text, thesis, prev_units, next_unit_title, total_units) = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        let session = db::dr_get_session(&conn, &session_id)?;
        let doc_title = session["filename"].as_str().unwrap_or("").to_string();

        let st = db::agent_get_state(&conn, &session_id)?;
        let outline = &st["plan"]["outline"];
        let thesis = outline["thesis"].as_str().unwrap_or("").to_string();
        let units = outline["units"].as_array().cloned()
            .ok_or_else(|| "路线图缺少 units 字段".to_string())?;
        let total = units.len();
        let unit = units
            .get(unit_index)
            .cloned()
            .ok_or_else(|| format!("unit_index={unit_index} 越界（共 {total} 个单元）"))?;
        let prev: Vec<Value> = units.iter().take(unit_index).cloned().collect();
        let next_title = units
            .get(unit_index + 1)
            .and_then(|u| u.get("title"))
            .and_then(|x| x.as_str())
            .map(|s| s.to_string());
        let text = agent_collect_unit_text(&conn, &session_id, &unit);
        (doc_title, unit, text, thesis, prev, next_title, total)
    };

    if pages_text.trim().is_empty() {
        return Err("当前单元覆盖的页文本均为空".to_string());
    }

    let needs_quiz = unit_value
        .get("needs_quiz")
        .and_then(|x| x.as_bool())
        .unwrap_or(true);

    // 推进 phase: → teaching
    {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        db::agent_set_phase(&conn, &session_id, unit_index, "teaching")?;
    }

    // 构造 LLM
    let llm = {
        let models = config::load_models(&state.config_path);
        let configs = config::to_llm_configs(&models);
        if !configs.is_empty() {
            LlmClient::from_pool(configs)
        } else {
            LlmConfig::from_env().map(LlmClient::new).map_err(|e| e.to_string())?
        }
    };

    let messages = agent::build_teach_unit_messages(
        &doc_title,
        &unit_value,
        &pages_text,
        &thesis,
        &prev_units,
        next_unit_title.as_deref(),
        (unit_index + 1, total_units),
    );
    let turn_id = uuid::Uuid::new_v4().to_string();

    // 立即广播 start（前端可在收到时切到 "讲解中" UI）
    let _ = app_handle.emit(
        "agent-teach-start",
        json!({
            "turn_id": turn_id,
            "session_id": session_id,
            "unit_index": unit_index,
            "needs_quiz": needs_quiz,
            "unit_title": unit_value.get("title").and_then(|x| x.as_str()).unwrap_or(""),
        }),
    );

    // 后台流式
    let turn_id_for_task = turn_id.clone();
    let app_for_task = app_handle.clone();
    let session_id_for_task = session_id.clone();
    let db_for_task = state.db.clone();
    let unit_value_for_task = unit_value.clone();
    let doc_title_for_task = doc_title.clone();

    tokio::spawn(async move {
        // v3：不再用 splitter / `<<<QUESTIONS>>>` 分隔符。题目以 ```quiz``` 围栏内嵌在
        // 每个知识点末尾。流式期间直接 emit raw delta（前端 markdown 渲染时能即时看到
        // 围栏框架；最终 finish 后用 regex 抽题，并把围栏从 explanation 中剥离）。
        let raw_buf = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
        let raw_buf_for_token = raw_buf.clone();

        let app_for_token = app_for_task.clone();
        let turn_id_for_token = turn_id_for_task.clone();
        let on_token = move |delta: &str| {
            {
                let mut s = raw_buf_for_token.lock().unwrap();
                s.push_str(delta);
            }
            if !delta.is_empty() {
                let _ = app_for_token.emit(
                    "agent-teach-token",
                    json!({ "turn_id": turn_id_for_token, "delta": delta }),
                );
            }
        };

        // 思考状态（reasoning）：和 ChatTab 一致透传
        let app_for_reasoning = app_for_task.clone();
        let turn_id_for_reasoning = turn_id_for_task.clone();
        let on_reasoning = move |ph: crate::llm::ReasoningPhase| {
            let phase_str = match ph {
                crate::llm::ReasoningPhase::Start => "start",
                crate::llm::ReasoningPhase::End => "end",
            };
            let _ = app_for_reasoning.emit(
                "agent-teach-reasoning",
                json!({ "turn_id": turn_id_for_reasoning, "phase": phase_str }),
            );
        };

        let result = llm.chat_stream(&messages, on_token, on_reasoning).await;

        match result {
            Ok(_full_text) => {
                // 从累积的 raw markdown 中抽 ```quiz``` 围栏 → questions；同时拿到去掉
                // 围栏后的 clean explanation。如果该单元 needs_quiz=false，仍然抽（虽然
                // 提示词要求不输出），但万一 LLM 输出了，前端也不会显示作答区。
                let raw_md = {
                    let s = raw_buf.lock().unwrap();
                    s.clone()
                };
                let (explanation, mut questions) = agent::extract_quizzes_from_md(&raw_md);
                if !needs_quiz {
                    questions = Vec::new();
                }

                // 持久化教学包 + 推进 phase
                let teach_pack = json!({
                    "explanation": explanation,
                    "questions": questions,
                    "unit_title": unit_value_for_task.get("title").and_then(|x| x.as_str()).unwrap_or(""),
                });
                let teach_pack_str = serde_json::to_string(&teach_pack).unwrap_or_default();

                if let Ok(conn) = db_for_task.lock() {
                    let _ = db::agent_save_teach_pack(
                        &conn, &session_id_for_task, unit_index, &teach_pack_str,
                    );
                    // 关键：`save_teach_pack` 只改 unit_states.status，前端读的是
                    // agent_plans.current_phase；流开始时把 current_phase 设成了 "teaching"，
                    // 这里必须显式推进到 "probing" 或 "reviewing"，否则前端永远卡在讲解结束态。
                    let next_phase = if questions.is_empty() { "reviewing" } else { "probing" };
                    let _ = db::agent_set_phase(
                        &conn, &session_id_for_task, unit_index, next_phase,
                    );

                    // v4 (2026-05): 同步讲解到学习笔记本 entry（学习↔笔记深度绑定）
                    // 从 unit_value 抽 title + pages 作为 entry 锚点
                    let unit_title = unit_value_for_task
                        .get("title")
                        .and_then(|x| x.as_str())
                        .unwrap_or("")
                        .to_string();
                    let pages_arr: Vec<i64> = unit_value_for_task
                        .get("pages")
                        .and_then(|x| x.as_array())
                        .map(|arr| {
                            arr.iter()
                                .filter_map(|v| v.as_i64())
                                .collect()
                        })
                        .unwrap_or_default();
                    let page_start = pages_arr.first().copied();
                    let page_end = pages_arr.last().copied();
                    let page_indexes_json = serde_json::to_string(&pages_arr)
                        .unwrap_or_else(|_| "[]".to_string());
                    let entry_result = db::agent_upsert_unit_entry(
                        &conn,
                        &session_id_for_task,
                        unit_index,
                        &doc_title_for_task,
                        &unit_title,
                        &explanation,
                        page_start,
                        page_end,
                        &page_indexes_json,
                    );
                    if let Err(e) = &entry_result {
                        log::warn!("[agent_teach] 同步学习单元 entry 失败（不影响讲解）: {}", e);
                    }
                    drop(conn);
                    if let Ok(eid) = entry_result {
                        // 通知前端 NoteTab 刷新笔记本列表
                        let _ = app_for_task.emit(
                            "notebook-entry-updated",
                            json!({ "entry_id": eid, "action": "agent_unit_sync" }),
                        );
                    }
                }

                let _ = app_for_task.emit(
                    "agent-teach-done",
                    json!({
                        "turn_id": turn_id_for_task,
                        "unit_index": unit_index,
                        "full_explanation": teach_pack["explanation"],
                        "questions": teach_pack["questions"],
                        "needs_quiz": needs_quiz && !questions.is_empty(),
                    }),
                );

                // ── done 钩子：异步生成 3 条「智能追问建议」，不阻塞主流 ─────────
                // 拿 explanation 的纯讲解部分（不含题目段）传给 followups generator。
                // 失败时只 warn 不报错，前端 followups 拿不到就只显示预设 chip。
                if !explanation.trim().is_empty() {
                    let llm_for_fp = llm.clone();
                    let app_for_fp = app_for_task.clone();
                    let doc_title_for_fp = doc_title_for_task.clone();
                    let unit_title_for_fp = unit_value_for_task
                        .get("title")
                        .and_then(|x| x.as_str())
                        .unwrap_or("")
                        .to_string();
                    let explanation_for_fp = explanation.clone();
                    tokio::spawn(async move {
                        let fps = agent::generate_unit_followups(
                            &llm_for_fp,
                            &doc_title_for_fp,
                            &unit_title_for_fp,
                            &explanation_for_fp,
                        )
                        .await;
                        if !fps.is_empty() {
                            let _ = app_for_fp.emit(
                                "agent-teach-followups",
                                json!({
                                    "unit_index": unit_index,
                                    "followups": fps,
                                }),
                            );
                        }
                    });

                    // v5 (2026-05) B2: 异步生成本单元的训练 pack（学习↔训练同步）
                    // LLM 自主决定题型分布（含代码题判定），完成后 emit training-pack-ready
                    // 让前端「练习本单元」按钮 ready。失败只 warn 不阻塞。
                    let llm_for_pack = llm.clone();
                    let app_for_pack = app_for_task.clone();
                    let db_for_pack = db_for_task.clone();
                    let session_id_for_pack = session_id_for_task.clone();
                    let doc_title_for_pack = doc_title_for_task.clone();
                    let unit_title_for_pack = unit_value_for_task
                        .get("title")
                        .and_then(|x| x.as_str())
                        .unwrap_or("")
                        .to_string();
                    let explanation_for_pack = explanation.clone();
                    tokio::spawn(async move {
                        spawn_unit_pack_gen(
                            &llm_for_pack,
                            &db_for_pack,
                            &app_for_pack,
                            &session_id_for_pack,
                            unit_index,
                            &doc_title_for_pack,
                            &unit_title_for_pack,
                            &explanation_for_pack,
                        )
                        .await;
                    });
                }
            }
            Err(e) => {
                log::error!("agent_teach_unit_stream[{}] 失败: {}", turn_id_for_task, e);
                let _ = app_for_task.emit(
                    "agent-teach-error",
                    json!({ "turn_id": turn_id_for_task, "error": e }),
                );
            }
        }
    });

    Ok(json!({
        "turn_id": turn_id,
        "unit_index": unit_index,
        "needs_quiz": needs_quiz,
    }))
}

/// 用户提交单元答案。
///
/// `answers`: `[{question_id, user_answer}]`
///
/// 行为：
///   1. 从 DB 取本单元 teach_pack 的 questions（含正确答案 / rubric）
///   2. 选择题：前端比对（answer 字符串等值比较，case-insensitive trim），0 req
///   3. 简答题：批量送 `agent::grade_subjective`（最多 1 req）
///   4. 拼合后 `agent::merge_grade_results` → 持久化 answers_json
///   5. phase 推到 reviewing
#[tauri::command]
pub async fn agent_submit_answers(
    state: State<'_, AppState>,
    session_id: String,
    unit_index: usize,
    answers: Vec<Value>,
) -> Result<Value, String> {
    // 取 teach_pack 与 doc_title
    let (doc_title, teach_pack) = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        let session = db::dr_get_session(&conn, &session_id)?;
        let doc_title = session["filename"].as_str().unwrap_or("").to_string();
        let tp = db::agent_get_teach_pack(&conn, &session_id, unit_index)?
            .ok_or_else(|| "尚未生成本单元教学包，无法判分".to_string())?;
        (doc_title, tp)
    };

    // 统一判分：拉所有题（核心 + 全部知识点的加题）。前端单元末一键提交时
    // 把 userAnswers + extraUserAnswers 合并打包，所有题走同一套评分流程，
    // 结果持久化到 answers_json，重启 / 翻屏后判分状态仍在。
    let questions = agent::extract_all_questions(&teach_pack);
    if questions.is_empty() {
        return Err("本单元教学包没有题目".to_string());
    }

    let user_answers: Vec<(String, String)> = answers
        .iter()
        .filter_map(|v| {
            let id = v.get("question_id").and_then(|x| x.as_str())?.to_string();
            let ans = v
                .get("user_answer")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string();
            Some((id, ans))
        })
        .collect();

    let mut objective_judgements: Vec<(String, bool)> = Vec::new();
    let mut subjective_items: Vec<Value> = Vec::new();

    for q in &questions {
        let qid = q.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string();
        if qid.is_empty() {
            continue;
        }
        let qtype = q.get("type").and_then(|x| x.as_str()).unwrap_or("short");
        let user_ans = user_answers
            .iter()
            .find(|(id, _)| id == &qid)
            .map(|(_, a)| a.clone())
            .unwrap_or_default();

        if qtype == "choice" {
            let correct = q.get("answer").and_then(|x| x.as_str()).unwrap_or("");
            let ok = !user_ans.is_empty()
                && user_ans.trim().eq_ignore_ascii_case(correct.trim());
            objective_judgements.push((qid, ok));
        } else {
            let prompt = q.get("prompt").and_then(|x| x.as_str()).unwrap_or("");
            let reference = q.get("answer").and_then(|x| x.as_str()).unwrap_or("");
            let rubric = q.get("rubric").and_then(|x| x.as_str()).unwrap_or("");
            subjective_items.push(json!({
                "question_id": qid,
                "prompt": prompt,
                "reference_answer": reference,
                "rubric": rubric,
                "user_answer": user_ans,
            }));
        }
    }

    let grade_results: Vec<Value> = if subjective_items.is_empty() {
        Vec::new()
    } else {
        let llm = {
            let models = config::load_models(&state.config_path);
            let configs = config::to_llm_configs(&models);
            if !configs.is_empty() {
                LlmClient::from_pool(configs)
            } else {
                LlmConfig::from_env().map(LlmClient::new).map_err(|e| e.to_string())?
            }
        };
        agent::grade_subjective(&llm, &doc_title, &subjective_items).await?
    };

    let merged = agent::merge_grade_results(
        &questions,
        &user_answers,
        &grade_results,
        &objective_judgements,
    );
    let merged_str = serde_json::to_string(&merged)
        .map_err(|e| format!("序列化判分结果失败: {e}"))?;

    {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        db::agent_save_answers(&conn, &session_id, unit_index, &merged_str)?;
        db::agent_set_phase(&conn, &session_id, unit_index, "reviewing")?;
    }

    Ok(json!({
        "status": "graded",
        "unit_index": unit_index,
        "results": merged,
    }))
}

/// 推进 / 重置单元阶段。
///
/// `action`:
///   - "next"     : 把当前单元 explanation 追加到全书笔记（按 unit.pages 中位数页码作锚点），
///                  然后 unit_index+=1，phase=idle（前端会自动触发下一单元 teach_stream）。
///                  最后一单元后 phase=done。
///   - "retry"    : 清空当前单元教学包，phase=teaching；前端会立即重新调 teach_unit_stream。
///   - "pause"    : phase=idle（保留 current_unit，下次进入续上）
#[tauri::command]
pub async fn agent_advance(
    state: State<'_, AppState>,
    session_id: String,
    action: String,
) -> Result<Value, String> {
    let action = action.as_str();
    if !matches!(action, "next" | "retry" | "pause") {
        return Err(format!("未知 action: {action}"));
    }

    let (current_unit, units, teach_pack_opt) = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        let st = db::agent_get_state(&conn, &session_id)?;
        let cp = st["plan"]["current_unit"].as_i64().unwrap_or(0) as usize;
        let units = st["plan"]["outline"]["units"].as_array().cloned().unwrap_or_default();
        let tp = db::agent_get_teach_pack(&conn, &session_id, cp)?;
        (cp, units, tp)
    };

    if units.is_empty() {
        return Err("尚未生成路线图".to_string());
    }

    match action {
        "pause" => {
            let conn = state.db.lock().map_err(|e| e.to_string())?;
            db::agent_set_phase(&conn, &session_id, current_unit, "idle")?;
            // v6 (2026-05) #3: vibe 事件 —— pause
            db::vibe_event_append(
                &conn,
                &session_id,
                "unit_paused",
                Some(current_unit as i64),
                "",
                &json!({}),
            );
            return Ok(json!({ "status": "paused", "current_unit": current_unit }));
        }
        "retry" => {
            // 清空当前单元教学包 + 把 phase 设回 'idle'，让前端 Auto-Pilot useEffect
            // 在下一帧自动触发 agent_teach_unit_stream 重新生成。
            let conn = state.db.lock().map_err(|e| e.to_string())?;
            conn.execute(
                "UPDATE agent_unit_states SET teach_pack_json = '', answers_json = '', status = 'pending'
                 WHERE session_id = ?1 AND unit_index = ?2",
                rusqlite::params![session_id, current_unit as i64],
            )
            .map_err(|e| format!("清空教学包失败: {e}"))?;
            db::agent_set_phase(&conn, &session_id, current_unit, "idle")?;
            // v6 (2026-05) #3: vibe 事件 —— retry 重生成
            db::vibe_event_append(
                &conn,
                &session_id,
                "unit_retried",
                Some(current_unit as i64),
                "",
                &json!({}),
            );
            return Ok(json!({ "status": "retry", "current_unit": current_unit }));
        }
        "next" => {
            // v6 (2026-05) #3+ 行为变更：
            //   旧实现把 explanation 通过 merge_note_by_page 写入 dr_save_note(page=0)，
            //   和用户「课堂笔记」共用同一行，互相覆盖；重新生成路线图时旧锚点页会被覆盖。
            //   新实现：append-only 写到 agent_stream_notes 表。课堂笔记完全不动。
            if let Some(tp) = teach_pack_opt.as_ref() {
                if let Some(expl) = tp.get("explanation").and_then(|x| x.as_str()) {
                    if !expl.trim().is_empty() {
                        let unit = units.get(current_unit).cloned().unwrap_or(Value::Null);
                        // 锚点页码 = pages 中位数（仅用于展示和排序，非主键）
                        let anchor_page: i64 = unit
                            .get("pages")
                            .and_then(|x| x.as_array())
                            .and_then(|arr| {
                                let nums: Vec<i64> = arr
                                    .iter()
                                    .filter_map(|v| v.as_i64())
                                    .filter(|n| *n >= 1)
                                    .collect();
                                nums.get(nums.len() / 2).copied()
                            })
                            .unwrap_or(1);
                        let title = unit
                            .get("title")
                            .and_then(|x| x.as_str())
                            .unwrap_or("")
                            .to_string();

                        let conn = state.db.lock().map_err(|e| e.to_string())?;
                        db::agent_stream_note_append(
                            &conn,
                            &session_id,
                            "", // 当前 active 学习流；auto_archive 时再批量打标签
                            current_unit as i64,
                            anchor_page,
                            &title,
                            expl.trim(),
                        );
                    }
                }
            }
        }
        _ => {}
    }

    let next_unit = current_unit + 1;
    if next_unit >= units.len() {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        db::agent_set_phase(&conn, &session_id, current_unit, "done")?;
        return Ok(json!({
            "status": "done",
            "current_unit": current_unit,
        }));
    }
    // 关键：进入下一单元前检测它是否已经 prefetch 就绪。
    //   - 已就绪 + 有题  → 直接 phase=probing，跳过前端 teach_stream
    //   - 已就绪 + 无题  → phase=reviewing（无题单元，等用户点继续）
    //   - 未就绪        → phase=idle，前端 Auto-Pilot 触发 teach_stream
    let (next_phase, prefetched) = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        let next_tp = db::agent_get_teach_pack(&conn, &session_id, next_unit)?;
        match next_tp.as_ref() {
            Some(tp) => {
                let has_explanation = tp
                    .get("explanation")
                    .and_then(|x| x.as_str())
                    .map(|s| !s.trim().is_empty())
                    .unwrap_or(false);
                let q_count = tp
                    .get("questions")
                    .and_then(|x| x.as_array())
                    .map(|a| a.len())
                    .unwrap_or(0);
                if has_explanation && q_count > 0 {
                    ("probing", true)
                } else if has_explanation {
                    ("reviewing", true)
                } else {
                    ("idle", false)
                }
            }
            None => ("idle", false),
        }
    };
    {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        db::agent_set_phase(&conn, &session_id, next_unit, next_phase)?;
        // v6 (2026-05) #3: vibe 事件 —— next 推进
        let unit_title = units
            .get(current_unit)
            .and_then(|u| u.get("title"))
            .and_then(|t| t.as_str())
            .unwrap_or("")
            .to_string();
        db::vibe_event_append(
            &conn,
            &session_id,
            "unit_advanced",
            Some(current_unit as i64),
            "",
            &json!({
                "from_unit": current_unit,
                "to_unit": next_unit,
                "from_unit_title": unit_title,
                "next_phase": next_phase,
                "prefetched": prefetched,
            }),
        );
    }
    Ok(json!({
        "status": "advanced",
        "current_unit": next_unit,
        "prefetched": prefetched,
        "phase": next_phase,
    }))
}

// ══════════════════════════════════════════════════════════════════════════════
// Agent 预生成（prefetch）— 后端在用户翻页阅读时静默生成后续单元
// ══════════════════════════════════════════════════════════════════════════════
//
// 与 `agent_teach_unit_stream` 的差异：
//   - 不 emit token 事件（前端不渲染到主区，避免污染当前单元）
//   - 不动 `current_phase`（current_unit 仍在用户实际所在单元）
//   - 完成时只发一个汇总事件：`agent-prefetch-done` / `agent-prefetch-error`
//   - 已有 teach_pack 时直接跳过（status=cached）
//   - 同样会触发 followups 异步生成（done 后给该单元加 3 条智能追问建议）
//
// 调度由前端控制：进入新单元 / 单元完成时，前端串行 prefetch 下 N 个未生成单元。

/// 静默预生成某单元的教学内容（不发 token，不切 phase）。
///
/// 用法：前端在路线图就绪后，串行调这个命令 prefetch 后续单元；
///       后端 done 后持久化到 `unit_states[i].teach_pack_json`，
///       前端通过 `agent-prefetch-done` 事件触发 `agent_get_state` 刷新。
#[tauri::command]
pub async fn agent_prefetch_unit(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    unit_index: usize,
) -> Result<Value, String> {
    // ① 已缓存 → 跳过
    {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        if let Some(tp) = db::agent_get_teach_pack(&conn, &session_id, unit_index)? {
            let has = tp
                .get("explanation")
                .and_then(|x| x.as_str())
                .map(|s| !s.trim().is_empty())
                .unwrap_or(false);
            if has {
                return Ok(json!({
                    "status": "cached",
                    "unit_index": unit_index,
                }));
            }
        }
    }

    // ② 加载上下文（同 agent_teach_unit_stream）
    let (doc_title, unit_value, pages_text, thesis, prev_units, next_unit_title, total_units) = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        let session = db::dr_get_session(&conn, &session_id)?;
        let doc_title = session["filename"].as_str().unwrap_or("").to_string();

        let st = db::agent_get_state(&conn, &session_id)?;
        let outline = &st["plan"]["outline"];
        let thesis = outline["thesis"].as_str().unwrap_or("").to_string();
        let units = outline["units"]
            .as_array()
            .cloned()
            .ok_or_else(|| "路线图缺少 units 字段".to_string())?;
        let total = units.len();
        let unit = units
            .get(unit_index)
            .cloned()
            .ok_or_else(|| format!("unit_index={unit_index} 越界（共 {total} 个单元）"))?;
        let prev: Vec<Value> = units.iter().take(unit_index).cloned().collect();
        let next_title = units
            .get(unit_index + 1)
            .and_then(|u| u.get("title"))
            .and_then(|x| x.as_str())
            .map(|s| s.to_string());
        let text = agent_collect_unit_text(&conn, &session_id, &unit);
        (doc_title, unit, text, thesis, prev, next_title, total)
    };

    if pages_text.trim().is_empty() {
        return Err("当前单元覆盖的页文本均为空".to_string());
    }

    let needs_quiz = unit_value
        .get("needs_quiz")
        .and_then(|x| x.as_bool())
        .unwrap_or(true);

    let llm = {
        let models = config::load_models(&state.config_path);
        let configs = config::to_llm_configs(&models);
        if !configs.is_empty() {
            LlmClient::from_pool(configs)
        } else {
            LlmConfig::from_env().map(LlmClient::new).map_err(|e| e.to_string())?
        }
    };

    let messages = agent::build_teach_unit_messages(
        &doc_title,
        &unit_value,
        &pages_text,
        &thesis,
        &prev_units,
        next_unit_title.as_deref(),
        (unit_index + 1, total_units),
    );

    // 立即广播 prefetch-start（前端可显示"后台生成中…"小标记）
    let _ = app_handle.emit(
        "agent-prefetch-start",
        json!({
            "session_id": session_id,
            "unit_index": unit_index,
            "unit_title": unit_value.get("title").and_then(|x| x.as_str()).unwrap_or(""),
        }),
    );

    let app_for_task = app_handle.clone();
    let session_id_for_task = session_id.clone();
    let db_for_task = state.db.clone();
    let unit_value_for_task = unit_value.clone();
    let doc_title_for_task = doc_title.clone();

    tokio::spawn(async move {
        // raw_buf 累积 token，但**不 emit**（这就是 prefetch 和 stream 的关键差异）
        let raw_buf = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
        let raw_buf_for_token = raw_buf.clone();
        let on_token = move |delta: &str| {
            let mut s = raw_buf_for_token.lock().unwrap();
            s.push_str(delta);
        };
        let on_reasoning = |_: crate::llm::ReasoningPhase| {};

        let result = llm.chat_stream(&messages, on_token, on_reasoning).await;

        match result {
            Ok(_full_text) => {
                let raw_md = {
                    let s = raw_buf.lock().unwrap();
                    s.clone()
                };
                let (explanation, mut questions) = agent::extract_quizzes_from_md(&raw_md);
                if !needs_quiz {
                    questions = Vec::new();
                }

                let teach_pack = json!({
                    "explanation": explanation,
                    "questions": questions,
                    "unit_title": unit_value_for_task.get("title").and_then(|x| x.as_str()).unwrap_or(""),
                });
                let teach_pack_str = serde_json::to_string(&teach_pack).unwrap_or_default();

                if let Ok(conn) = db_for_task.lock() {
                    let _ = db::agent_save_teach_pack(
                        &conn, &session_id_for_task, unit_index, &teach_pack_str,
                    );
                    // 注意：**不调** agent_set_phase —— prefetch 不能改 current_phase

                    // v4 (2026-05): prefetch 也同步到学习笔记本 entry，让用户翻到这个单元前就能看到笔记
                    let unit_title = unit_value_for_task
                        .get("title")
                        .and_then(|x| x.as_str())
                        .unwrap_or("")
                        .to_string();
                    let pages_arr: Vec<i64> = unit_value_for_task
                        .get("pages")
                        .and_then(|x| x.as_array())
                        .map(|arr| arr.iter().filter_map(|v| v.as_i64()).collect())
                        .unwrap_or_default();
                    let page_start = pages_arr.first().copied();
                    let page_end = pages_arr.last().copied();
                    let page_indexes_json = serde_json::to_string(&pages_arr)
                        .unwrap_or_else(|_| "[]".to_string());
                    let entry_result = db::agent_upsert_unit_entry(
                        &conn,
                        &session_id_for_task,
                        unit_index,
                        &doc_title_for_task,
                        &unit_title,
                        &explanation,
                        page_start,
                        page_end,
                        &page_indexes_json,
                    );
                    if let Err(e) = &entry_result {
                        log::warn!("[agent_prefetch] 同步学习单元 entry 失败: {}", e);
                    }
                    drop(conn);
                    if let Ok(eid) = entry_result {
                        let _ = app_for_task.emit(
                            "notebook-entry-updated",
                            json!({ "entry_id": eid, "action": "agent_unit_sync" }),
                        );
                    }
                }

                let _ = app_for_task.emit(
                    "agent-prefetch-done",
                    json!({
                        "session_id": session_id_for_task,
                        "unit_index": unit_index,
                        "needs_quiz": needs_quiz && !questions.is_empty(),
                    }),
                );

                // 异步生成本单元追问建议（不阻塞 done）
                if !explanation.trim().is_empty() {
                    let llm_for_fp = llm.clone();
                    let app_for_fp = app_for_task.clone();
                    let doc_title_for_fp = doc_title_for_task.clone();
                    let unit_title_for_fp = unit_value_for_task
                        .get("title")
                        .and_then(|x| x.as_str())
                        .unwrap_or("")
                        .to_string();
                    let explanation_for_fp = explanation.clone();
                    tokio::spawn(async move {
                        let fps = agent::generate_unit_followups(
                            &llm_for_fp,
                            &doc_title_for_fp,
                            &unit_title_for_fp,
                            &explanation_for_fp,
                        )
                        .await;
                        if !fps.is_empty() {
                            let _ = app_for_fp.emit(
                                "agent-teach-followups",
                                json!({
                                    "unit_index": unit_index,
                                    "followups": fps,
                                }),
                            );
                        }
                    });

                    // v5 (2026-05) B2: 异步生成本单元的训练 pack（学习↔训练同步）
                    let llm_for_pack = llm.clone();
                    let app_for_pack = app_for_task.clone();
                    let db_for_pack = db_for_task.clone();
                    let session_id_for_pack = session_id_for_task.clone();
                    let doc_title_for_pack = doc_title_for_task.clone();
                    let unit_title_for_pack = unit_value_for_task
                        .get("title")
                        .and_then(|x| x.as_str())
                        .unwrap_or("")
                        .to_string();
                    let explanation_for_pack = explanation.clone();
                    tokio::spawn(async move {
                        spawn_unit_pack_gen(
                            &llm_for_pack,
                            &db_for_pack,
                            &app_for_pack,
                            &session_id_for_pack,
                            unit_index,
                            &doc_title_for_pack,
                            &unit_title_for_pack,
                            &explanation_for_pack,
                        )
                        .await;
                    });
                }
            }
            Err(e) => {
                log::error!("agent_prefetch_unit[u{}] 失败: {}", unit_index, e);
                let _ = app_for_task.emit(
                    "agent-prefetch-error",
                    json!({
                        "session_id": session_id_for_task,
                        "unit_index": unit_index,
                        "error": e,
                    }),
                );
            }
        }
    });

    Ok(json!({
        "status": "started",
        "unit_index": unit_index,
    }))
}

// ══════════════════════════════════════════════════════════════════════════════
// Agent 追问（流式）— 模仿 RAG chat 的追问形态，但限定在"当前单元上下文"内
// ══════════════════════════════════════════════════════════════════════════════
//
// 事件协议：
//   agent-followup-token { turn_id, unit_index, delta }
//   agent-followup-done  { turn_id, unit_index, full }
//   agent-followup-error { turn_id, unit_index, error }
//
// 不持久化（追问是辅助性内容，重置 / 刷新可丢失）。前端在本次会话内缓存。

/// 学生在 ChipBar 上点击追问 → 流式回答。
///
/// `prev_followups`: 本单元已经完成的追问轮次 [(q, a)]，让 LLM 看见连续上下文。
///                   前端从本地 state 拿，后端不存。
#[tauri::command]
pub async fn agent_followup_stream(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    unit_index: usize,
    question: String,
    prev_followups: Option<Vec<(String, String)>>,
) -> Result<Value, String> {
    if question.trim().is_empty() {
        return Err("追问内容不能为空".to_string());
    }

    // 取上下文：doc_title + unit_title + 当前单元的 explanation
    let (doc_title, unit_title, unit_explanation) = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        let session = db::dr_get_session(&conn, &session_id)?;
        let doc_title = session["filename"].as_str().unwrap_or("").to_string();

        let st = db::agent_get_state(&conn, &session_id)?;
        let unit_title = st["plan"]["outline"]["units"]
            .as_array()
            .and_then(|arr| arr.get(unit_index))
            .and_then(|u| u.get("title"))
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string();

        let teach_pack = db::agent_get_teach_pack(&conn, &session_id, unit_index)?;
        let explanation = teach_pack
            .as_ref()
            .and_then(|tp| tp.get("explanation"))
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string();

        (doc_title, unit_title, explanation)
    };

    if unit_explanation.trim().is_empty() {
        return Err("本单元尚未生成讲解，无法追问".to_string());
    }

    // best-effort RAG 检索：有 embedding 模型 + 索引就绪才走，否则空 vec
    //（与 rag_chat_stream 同源；失败一律降级为"仅基于单元讲解"）。
    let retrieved: Vec<rag::RetrievedChunk> = {
        let index_ready = {
            match state.db.lock() {
                Ok(conn) => matches!(
                    db::rag_get_meta(&conn, &session_id),
                    Ok(Some(ref m)) if m.get("status").and_then(|s| s.as_str()) == Some("ready")
                ),
                Err(_) => false,
            }
        };
        if !index_ready {
            Vec::new()
        } else {
            match build_embedding_client(&state) {
                Ok(embed_llm) => {
                    rag::retrieve(state.db.clone(), &embed_llm, &session_id, &question, 5)
                        .await
                        .unwrap_or_else(|e| {
                            log::warn!("[agent_followup] retrieve 失败 → 仅基于单元讲解: {e}");
                            Vec::new()
                        })
                }
                Err(e) => {
                    log::warn!("[agent_followup] build_embedding_client 失败 → 仅基于单元讲解: {e}");
                    Vec::new()
                }
            }
        }
    };

    let prev = prev_followups.unwrap_or_default();
    let messages = agent::build_unit_followup_messages(
        &doc_title,
        &unit_title,
        &unit_explanation,
        &prev,
        &retrieved,
        &question,
    );

    let llm = {
        let models = config::load_models(&state.config_path);
        let configs = config::to_llm_configs(&models);
        if !configs.is_empty() {
            LlmClient::from_pool(configs)
        } else {
            LlmConfig::from_env().map(LlmClient::new).map_err(|e| e.to_string())?
        }
    };

    let turn_id = uuid::Uuid::new_v4().to_string();
    let turn_id_for_task = turn_id.clone();
    let app_for_task = app_handle.clone();

    tokio::spawn(async move {
        let app_for_token = app_for_task.clone();
        let turn_id_for_token = turn_id_for_task.clone();
        let on_token = move |delta: &str| {
            let _ = app_for_token.emit(
                "agent-followup-token",
                json!({
                    "turn_id": turn_id_for_token,
                    "unit_index": unit_index,
                    "delta": delta,
                }),
            );
        };
        // reasoning 透传（"思考中…"）
        let app_for_reasoning = app_for_task.clone();
        let turn_id_for_reasoning = turn_id_for_task.clone();
        let on_reasoning = move |ph: crate::llm::ReasoningPhase| {
            let phase_str = match ph {
                crate::llm::ReasoningPhase::Start => "start",
                crate::llm::ReasoningPhase::End => "end",
            };
            let _ = app_for_reasoning.emit(
                "agent-followup-reasoning",
                json!({
                    "turn_id": turn_id_for_reasoning,
                    "unit_index": unit_index,
                    "phase": phase_str,
                }),
            );
        };

        let result = llm.chat_stream(&messages, on_token, on_reasoning).await;
        match result {
            Ok(full) => {
                let _ = app_for_task.emit(
                    "agent-followup-done",
                    json!({
                        "turn_id": turn_id_for_task,
                        "unit_index": unit_index,
                        "full": full,
                    }),
                );
            }
            Err(e) => {
                log::error!("agent_followup_stream[{}] 失败: {}", turn_id_for_task, e);
                let _ = app_for_task.emit(
                    "agent-followup-error",
                    json!({
                        "turn_id": turn_id_for_task,
                        "unit_index": unit_index,
                        "error": e,
                    }),
                );
            }
        }
    });

    Ok(json!({ "turn_id": turn_id, "unit_index": unit_index }))
}

// ══════════════════════════════════════════════════════════════════════════════
// Agent 知识点加题（用户在某知识点屏点 "+ 再来 N 道" 按钮触发）
// ══════════════════════════════════════════════════════════════════════════════
//
// 流程：
//   1. 前端传 unit_index / k_idx / k_title / k_body / existing_prompts / count
//   2. 后端调 LLM chat_stream，prompt 要求 JSONL（每题一行 JSON）
//   3. 边收 token 边按行 partial-parse —— 解析出一题就 emit 一次：
//      `agent-extra-quiz-token { turn_id, k_idx, question }`
//   4. 流结束：把所有新题写入 teach_pack.extra_questions[k_idx]，重存 DB
//   5. emit `agent-extra-quiz-done { turn_id, k_idx, questions, count }`
//   6. 失败：emit `agent-extra-quiz-error { turn_id, k_idx, error }`
//
// 数据存储：teach_pack 增加可选字段 `extra_questions: { [k_idx 字符串]: Question[] }`
//          老数据没这个字段也兼容（前端读到 undefined 即视为空）。

/// 学生在某个知识点屏点"+ 再来 N 道"加题按钮 → 流式生成更多题。
#[tauri::command]
pub async fn agent_generate_extra_quizzes_stream(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    unit_index: usize,
    k_idx: u32,
    k_title: String,
    k_body: String,
    existing_prompts: Vec<String>,
    count: u32,
) -> Result<Value, String> {
    if k_body.trim().is_empty() {
        return Err("知识点正文为空，无法命题".to_string());
    }
    let count = count.clamp(1, 6); // 防呆：单次 1-6 题

    // 上限闸门：每个知识点最多 MAX_EXTRAS_PER_KIDX 道加题（含历史累积）。
    // 同时把 count 裁到 "剩余可生成数"，避免溢出。
    let max_per_k = db::MAX_EXTRAS_PER_KIDX;

    // 取上下文：doc_title + unit_title
    let (doc_title, unit_title) = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        let session = db::dr_get_session(&conn, &session_id)?;
        let doc_title = session["filename"].as_str().unwrap_or("").to_string();

        let st = db::agent_get_state(&conn, &session_id)?;
        let unit_title = st["plan"]["outline"]["units"]
            .as_array()
            .and_then(|arr| arr.get(unit_index))
            .and_then(|u| u.get("title"))
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string();
        (doc_title, unit_title)
    };

    let llm = {
        let models = config::load_models(&state.config_path);
        let configs = config::to_llm_configs(&models);
        if !configs.is_empty() {
            LlmClient::from_pool(configs)
        } else {
            LlmConfig::from_env().map(LlmClient::new).map_err(|e| e.to_string())?
        }
    };

    let turn_id = uuid::Uuid::new_v4().to_string();
    let turn_id_for_task = turn_id.clone();
    let app_for_task = app_handle.clone();
    let session_id_for_task = session_id.clone();
    let db_for_task = state.db.clone();

    // ── 计算下一个全局 qE 序号起点 ──────────────────────────────
    // BUG 修复（2026-05）：之前 LLM 每次都从 qE1 编号，多次点"再来 N 道"导致 id
    // 跟第一批冲突 → 前端 token 事件按 id 去重把第二批全砍了 → 用户感知"超过 3
    // 道就丢失"。这里在 spawn 前查 DB 当前 extra_questions[k_idx] 的长度作为
    // 起点 n_start，emit 时 rewrite id 为 `k{k_idx}qE{n_start + i}`，保证全局唯一。
    let n_start: usize = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        match db::agent_get_teach_pack(&conn, &session_id, unit_index) {
            Ok(Some(tp)) => tp
                .get("extra_questions")
                .and_then(|v| v.as_object())
                .and_then(|m| m.get(&k_idx.to_string()))
                .and_then(|x| x.as_array())
                .map(|arr| arr.len())
                .unwrap_or(0),
            _ => 0,
        }
    };

    // 上限闸门：已达 max 直接拒绝；否则把 count 裁到剩余空位。
    if n_start >= max_per_k {
        return Err(format!(
            "本知识点加题已达上限（{}/{} 道），无法继续生成。可在单元结束后查看本单元判分，或继续学习其他知识点。",
            n_start, max_per_k
        ));
    }
    let count = (count as usize).min(max_per_k - n_start) as u32;

    // 在闸门后才构造 messages，让 LLM 也只生成"剩余可用"数量。
    let messages = agent::build_more_quizzes_messages(
        &doc_title,
        &unit_title,
        k_idx,
        &k_title,
        &k_body,
        &existing_prompts,
        count,
    );

    tokio::spawn(async move {
        // 流式累积 buffer：每收到 token，按 \n 切，每行尝试 JSON parse → emit。
        // 用 Arc<Mutex<...>> 让 on_token 闭包能写、外部 task 也能读最终残留。
        let buf = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
        let questions = std::sync::Arc::new(std::sync::Mutex::new(Vec::<Value>::new()));
        // qE 全局递增计数器：从 n_start + 1 开始，每接受一道题 +1
        let n_counter = std::sync::Arc::new(std::sync::Mutex::new(n_start));

        let buf_for_token = buf.clone();
        let questions_for_token = questions.clone();
        let app_for_token = app_for_task.clone();
        let turn_id_for_token = turn_id_for_task.clone();
        let n_counter_for_token = n_counter.clone();
        let on_token = move |delta: &str| {
            let mut buffer = buf_for_token.lock().unwrap();
            buffer.push_str(delta);
            // 提取所有完整行（以 \n 结尾的行）
            // 残留（最后一段没有换行的不完整 JSON）保留在 buffer 中
            let mut lines_to_process: Vec<String> = Vec::new();
            while let Some(idx) = buffer.find('\n') {
                let line: String = buffer.drain(..=idx).collect();
                lines_to_process.push(line);
            }
            drop(buffer);

            for raw_line in lines_to_process {
                let line = raw_line.trim();
                if line.is_empty() {
                    continue;
                }
                // 尝试 JSON parse；失败就忽略（可能是 LLM 输出了围栏 / 注释）
                if let Ok(mut val) = serde_json::from_str::<Value>(line) {
                    // 必须含 id + prompt 才认为是有效题目
                    if val.get("id").and_then(|x| x.as_str()).is_some()
                        && val.get("prompt").and_then(|x| x.as_str()).is_some()
                    {
                        // **rewrite id**：用全局递增的 qE 序号覆盖 LLM 给的 id，
                        // 确保多次"再来 N 道"间不冲突。
                        // 同时做兜底：超过 MAX_EXTRAS_PER_KIDX 的题丢弃（防 LLM 多吐）。
                        let next_n = {
                            let mut g = n_counter_for_token.lock().unwrap();
                            if *g >= db::MAX_EXTRAS_PER_KIDX {
                                continue; // 跳过本行，不写不 emit
                            }
                            *g += 1;
                            *g
                        };
                        let new_id = format!("k{}qE{}", k_idx, next_n);
                        if let Some(obj) = val.as_object_mut() {
                            obj.insert("id".to_string(), Value::String(new_id));
                        }
                        questions_for_token.lock().unwrap().push(val.clone());
                        let _ = app_for_token.emit(
                            "agent-extra-quiz-token",
                            json!({
                                "turn_id": turn_id_for_token,
                                "unit_index": unit_index,
                                "k_idx": k_idx,
                                "question": val,
                            }),
                        );
                    }
                }
            }
        };
        // reasoning 透传（"思考中…"）
        let app_for_reasoning = app_for_task.clone();
        let turn_id_for_reasoning = turn_id_for_task.clone();
        let on_reasoning = move |ph: crate::llm::ReasoningPhase| {
            let phase_str = match ph {
                crate::llm::ReasoningPhase::Start => "start",
                crate::llm::ReasoningPhase::End => "end",
            };
            let _ = app_for_reasoning.emit(
                "agent-extra-quiz-reasoning",
                json!({
                    "turn_id": turn_id_for_reasoning,
                    "unit_index": unit_index,
                    "k_idx": k_idx,
                    "phase": phase_str,
                }),
            );
        };

        let result = llm.chat_stream(&messages, on_token, on_reasoning).await;
        match result {
            Ok(_full) => {
                // 收尾：buffer 残留可能还有最后一行（LLM 没补 \n 就结束了）
                {
                    let mut buffer = buf.lock().unwrap();
                    let tail = buffer.trim().to_string();
                    buffer.clear();
                    drop(buffer);
                    if !tail.is_empty() {
                        if let Ok(mut val) = serde_json::from_str::<Value>(&tail) {
                            if val.get("id").and_then(|x| x.as_str()).is_some()
                                && val.get("prompt").and_then(|x| x.as_str()).is_some()
                            {
                                // 同样 rewrite tail 题的 id（保持序号连续）；超 max 跳过 tail 但
                                // 仍走后续持久化+done emit（已经有合法的 questions 收集结果）。
                                let next_n_opt = {
                                    let mut g = n_counter.lock().unwrap();
                                    if *g >= db::MAX_EXTRAS_PER_KIDX {
                                        None
                                    } else {
                                        *g += 1;
                                        Some(*g)
                                    }
                                };
                                if let Some(next_n) = next_n_opt {
                                    let new_id = format!("k{}qE{}", k_idx, next_n);
                                    if let Some(obj) = val.as_object_mut() {
                                        obj.insert("id".to_string(), Value::String(new_id));
                                    }
                                    questions.lock().unwrap().push(val.clone());
                                    let _ = app_for_task.emit(
                                        "agent-extra-quiz-token",
                                        json!({
                                            "turn_id": turn_id_for_task,
                                            "unit_index": unit_index,
                                            "k_idx": k_idx,
                                            "question": val,
                                        }),
                                    );
                                }
                            }
                        }
                    }
                }

                let new_questions = {
                    let g = questions.lock().unwrap();
                    g.clone()
                };

                // 持久化：把新题追加到 teach_pack.extra_questions[k_idx]
                if let Ok(conn) = db_for_task.lock() {
                    if let Ok(Some(mut tp)) =
                        db::agent_get_teach_pack(&conn, &session_id_for_task, unit_index)
                    {
                        let extra = tp
                            .as_object_mut()
                            .and_then(|m| {
                                if !m.contains_key("extra_questions") {
                                    m.insert("extra_questions".to_string(), json!({}));
                                }
                                m.get_mut("extra_questions")
                            })
                            .and_then(|v| v.as_object_mut());
                        if let Some(extra_map) = extra {
                            let key = k_idx.to_string();
                            // 取已有 + 追加；保持顺序
                            let mut merged: Vec<Value> = extra_map
                                .get(&key)
                                .and_then(|x| x.as_array())
                                .cloned()
                                .unwrap_or_default();
                            for q in &new_questions {
                                merged.push(q.clone());
                            }
                            // 兜底 trim：超过 max 从最旧（头部）开始丢。
                            // 正常路径上闸门已防住；这里防御历史脏数据 + LLM 多吐组合。
                            if merged.len() > db::MAX_EXTRAS_PER_KIDX {
                                let drop_n = merged.len() - db::MAX_EXTRAS_PER_KIDX;
                                merged.drain(0..drop_n);
                            }
                            extra_map.insert(key, Value::Array(merged));
                            let tp_str = serde_json::to_string(&tp).unwrap_or_default();
                            let _ = db::agent_save_teach_pack(
                                &conn,
                                &session_id_for_task,
                                unit_index,
                                &tp_str,
                            );
                        }
                    }
                }

                let _ = app_for_task.emit(
                    "agent-extra-quiz-done",
                    json!({
                        "turn_id": turn_id_for_task,
                        "unit_index": unit_index,
                        "k_idx": k_idx,
                        "questions": new_questions,
                        "count": new_questions.len(),
                    }),
                );
            }
            Err(e) => {
                log::error!("agent_generate_extra_quizzes_stream[{}] 失败: {}", turn_id_for_task, e);
                let _ = app_for_task.emit(
                    "agent-extra-quiz-error",
                    json!({
                        "turn_id": turn_id_for_task,
                        "unit_index": unit_index,
                        "k_idx": k_idx,
                        "error": e,
                    }),
                );
            }
        }
    });

    Ok(json!({ "turn_id": turn_id, "unit_index": unit_index, "k_idx": k_idx, "count": count }))
}

/// 清空 Agent 状态（保留 doc_session / 笔记）。
///
/// v6 (2026-05) #3+ 重大行为变更：
///   - **不再无声丢失学习流**：重置前**自动归档**当前 plan + units（如果非空）
///   - 用户后续可在「档案」面板找回这次学习
///   - vibe timeline 也保留（不再清空），让历史轨迹可追溯
///
/// v7 (2026-05) 自动归档后 emit `agent-archive-changed`，让 ArchiveListPanel 等
/// 监听方即时刷新档案列表（之前依赖手动刷新或下次进入面板才能看到新档案）。
#[tauri::command]
pub async fn agent_reset(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Value, String> {
    let archive_id = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        // 1) 先自动归档（无 plan 则跳过；失败仅 warn）
        let archive_id = db::agent_auto_archive_if_active(&conn, &session_id, "agent_reset");
        // 2) 真正重置 active 区
        db::agent_reset(&conn, &session_id)?;
        // v5 (2026-05) B2: 重置学习流时一并清空预生成的训练 pack（用户重置时希望全新出题）
        if let Err(e) = db::tup_delete(&conn, &session_id, None) {
            log::warn!("[agent_reset] tup_delete 失败: {e}");
        }
        // v6 #3+: vibe timeline 不清空，只追加 reset 事件（带 archive_id 让前端可跳转）
        db::vibe_event_append(
            &conn,
            &session_id,
            "agent_reset",
            None,
            archive_id.as_deref().unwrap_or(""),
            &json!({ "archived_to": archive_id }),
        );
        archive_id
    };
    // 释放锁后 emit 事件，避免前端事件处理回调里再调命令时死锁
    if let Some(ref aid) = archive_id {
        let _ = app.emit(
            "agent-archive-changed",
            json!({
                "session_id": session_id,
                "archive_id": aid,
                "reason": "saved",
            }),
        );
    }
    Ok(json!({
        "status": "reset",
        "archived_to": archive_id,
    }))
}

// ════════════════════════════════════════════════════════════════════════════
// 学习流档案命令：保留学习历史，"重新生成"前可归档当前进度
// ════════════════════════════════════════════════════════════════════════════

/// 把当前 active 学习流（plan + 全部 unit_states + stream_notes）打包为档案。
/// 调用前必须有已生成的 plan，否则返回错误。
///
/// v6 (2026-05) #3++ 修复：原版只写 archive 记录，**未给 stream_notes 打 tag** —— 前端
/// "恢复前自动备份"流程因此把当前学习流笔记留在 archive_id='' 区，restore 时被
/// `agent_archive_restore` 的 DELETE 步误清。这里和 `agent_auto_archive_if_active`
/// 的行为对齐：写完档案立即把 active 笔记打 tag 到新档案。
///
/// v7 (2026-05) 健壮性：
///   - "同一学习流只保留一份档案"由 db::agent_archive_save 内部统一实现
///   - 操作完成后 emit `agent-archive-changed` 事件，让前端 UI（ArchiveListPanel /
///     AgentTab / StreamNotesView / TrainingTab）即时刷新，不依赖 onRestored 回调。
#[tauri::command]
pub async fn agent_archive_save(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    name: Option<String>,
    flow_config_json: Option<String>,
    clarify_qa_json: Option<String>,
) -> Result<Value, String> {
    let archive_id = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        let archive_id = db::agent_archive_save(
            &conn,
            &session_id,
            name.as_deref().unwrap_or(""),
            flow_config_json.as_deref().unwrap_or(""),
            clarify_qa_json.as_deref().unwrap_or(""),
        )?;
        // 把当前 active 的学习流笔记一并归档（archive_id='' → 该新 archive_id）
        if let Err(e) = db::agent_stream_notes_tag_archive(&conn, &session_id, &archive_id) {
            log::warn!("[agent_archive_save] tag stream_notes 失败: {e}");
        }
        archive_id
    };
    // 释放锁后 emit 事件，避免前端事件处理回头调命令时死锁
    let _ = app.emit(
        "agent-archive-changed",
        json!({
            "session_id": session_id,
            "archive_id": archive_id,
            "reason": "saved",
        }),
    );
    Ok(json!({ "archive_id": archive_id }))
}

/// 列出某 session 的所有档案（按创建时间倒序，含摘要）。
#[tauri::command]
pub async fn agent_archive_list(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Value, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::agent_archive_list(&conn, &session_id)
}

/// 把档案恢复到 active 区（覆盖式）。
/// 前端在调用前应先弹窗"是否先把当前归档"，自行决定是否额外调一次 archive_save。
///
/// v7 (2026-05) 操作完成后 emit `agent-archive-changed`（reason="restored"），
/// 让 AgentTab / StreamNotesView / TrainingTab 即时 refresh，避免恢复后看到旧数据。
#[tauri::command]
pub async fn agent_archive_restore(
    app: AppHandle,
    state: State<'_, AppState>,
    archive_id: String,
) -> Result<Value, String> {
    // 先在锁内查 session_id，再做 restore
    let session_id: String = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        let row: rusqlite::Result<String> = conn.query_row(
            "SELECT session_id FROM agent_flow_archives WHERE archive_id = ?1",
            rusqlite::params![archive_id.as_str()],
            |r| r.get(0),
        );
        let session_id = row.map_err(|e| format!("查询档案失败: {e}"))?;
        db::agent_archive_restore(&conn, &archive_id)?;
        session_id
    };
    let _ = app.emit(
        "agent-archive-changed",
        json!({
            "session_id": session_id,
            "archive_id": archive_id,
            "reason": "restored",
        }),
    );
    Ok(json!({ "status": "restored", "session_id": session_id }))
}

/// 删除指定档案。
///
/// v7 (2026-05) 操作完成后 emit `agent-archive-changed`（reason="deleted"），
/// 让 ArchiveListPanel 列表自动刷新。
#[tauri::command]
pub async fn agent_archive_delete(
    app: AppHandle,
    state: State<'_, AppState>,
    archive_id: String,
) -> Result<Value, String> {
    let session_id: String = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        let row: rusqlite::Result<String> = conn.query_row(
            "SELECT session_id FROM agent_flow_archives WHERE archive_id = ?1",
            rusqlite::params![archive_id.as_str()],
            |r| r.get(0),
        );
        // 删除前先取 session_id；查不到（已被别处删）就给空串，事件仍会 emit
        let session_id = row.unwrap_or_default();
        db::agent_archive_delete(&conn, &archive_id)?;
        session_id
    };
    let _ = app.emit(
        "agent-archive-changed",
        json!({
            "session_id": session_id,
            "archive_id": archive_id,
            "reason": "deleted",
        }),
    );
    Ok(json!({ "status": "deleted" }))
}

/// 重命名档案。
///
/// v7 (2026-05) 操作完成后 emit `agent-archive-changed`（reason="renamed"），
/// 让 ArchiveListPanel 等监听方刷新名称显示。
#[tauri::command]
pub async fn agent_archive_rename(
    app: AppHandle,
    state: State<'_, AppState>,
    archive_id: String,
    new_name: String,
) -> Result<Value, String> {
    let session_id: String = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        let row: rusqlite::Result<String> = conn.query_row(
            "SELECT session_id FROM agent_flow_archives WHERE archive_id = ?1",
            rusqlite::params![archive_id.as_str()],
            |r| r.get(0),
        );
        let session_id = row.unwrap_or_default();
        db::agent_archive_rename(&conn, &archive_id, &new_name)?;
        session_id
    };
    let _ = app.emit(
        "agent-archive-changed",
        json!({
            "session_id": session_id,
            "archive_id": archive_id,
            "reason": "renamed",
        }),
    );
    Ok(json!({ "status": "renamed" }))
}

// ══════════════════════════════════════════════════════════════════════════════
// 训练模块命令（DESIGN.md §15）
// ══════════════════════════════════════════════════════════════════════════════

/// 取软件工程预设技能树定义（前端用来展示分类 / 名称 / 描述）。
/// 这是静态数据，与 session 无关；前端 mount 时拉一次 cache 即可。
#[tauri::command]
pub async fn training_get_skill_tree() -> Result<Value, String> {
    let tree = training::se_skill_tree();
    Ok(serde_json::to_value(&tree).map_err(|e| e.to_string())?)
}

/// 调用户配置的 Piston endpoint 跑代码。
///
/// 失败会返回 Err，前端可以选择 fallback 到"提交后由 LLM 模拟评分"。
///
/// v6 (2026-05) #3++ 修订（emkc.org 公共 API 已于 2026/2/15 改为白名单）：
///   endpoint 不再硬编码，从 `app_prefs.json` 的 `code_runner.endpoint` 读取。
///   未配置时返回明确指引让用户去设置面板填。
#[tauri::command]
pub async fn training_code_run(
    state: State<'_, AppState>,
    language: String,
    source: String,
    stdin: Option<String>,
    version: Option<String>,
) -> Result<Value, String> {
    let stdin_str = stdin.unwrap_or_default();
    let endpoint = read_code_runner_endpoint(&state.prefs_path);
    let result = training::piston_execute(
        &endpoint,
        &language,
        &source,
        &stdin_str,
        version.as_deref(),
    )
    .await?;
    Ok(serde_json::to_value(result).map_err(|e| e.to_string())?)
}

/// v9 (2026-05) 单题语言翻译：把一道代码题就地翻译到另一种语言。
///
/// 用户在做某道代码题时（如 Python）可临时切到 Rust，无需退出训练会话重新生成
/// 整个题集。LLM 翻译 prompt / starter_code / answer / tests / rubric，保留题意 +
/// 难度 + 考察重点；id / type / skills / difficulty 强制继承原题。
///
/// 输入：原题 JSON + 目标语言（如 "rust" / "javascript"）
/// 输出：翻译后的新题 JSON（前端就地替换当前题，attempt 状态会被清空）
///
/// 注：本命令**不持久化**翻译结果。前端如果想保留语言切换，需要自行在本会话内
/// 维护新题。退出训练会话再进入会回到原题集语言。
#[tauri::command]
pub async fn training_translate_question(
    state: State<'_, AppState>,
    question: Value,
    target_language: String,
) -> Result<Value, String> {
    if target_language.trim().is_empty() {
        return Err("目标语言不能为空".to_string());
    }
    // 仅 code/debug 题支持翻译
    let q_type = question
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if q_type != "code" && q_type != "debug" {
        return Err(format!("仅支持翻译 code/debug 题，当前题型：{q_type}"));
    }
    // 同语言不翻译（节省一次 LLM 调用）
    let cur_lang = question
        .get("language")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if cur_lang.eq_ignore_ascii_case(&target_language) {
        return Err(format!("当前题已是 {target_language}，无需翻译"));
    }

    let llm = {
        let models = config::load_models(&state.config_path);
        let configs = config::to_llm_configs(&models);
        if !configs.is_empty() {
            LlmClient::from_pool(configs)
        } else {
            LlmConfig::from_env().map(LlmClient::new).map_err(|e| e.to_string())?
        }
    };

    let translated =
        training::translate_question_to_language(&llm, &question, target_language.trim()).await?;
    Ok(translated)
}

/// 从 app_prefs 读 code_runner.endpoint，返回 trim 后的字符串（空串表示未配置）。
fn read_code_runner_endpoint(prefs_path: &std::path::Path) -> String {
    let prefs = read_prefs_file(prefs_path);
    prefs
        .get("code_runner.endpoint")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string()
}

// ════════════════════════════════════════════════════════════════════════════
// v6 (2026-05) #3++ Docker / Piston 容器管理（一键部署本地代码运行时）
// ════════════════════════════════════════════════════════════════════════════

/// 综合状态诊断：docker 安装 / daemon 运行 / piston 容器状态。
/// 返回字段见 `runtime::diagnose`。前端 mount 时和操作后调用刷新 UI。
#[tauri::command]
pub async fn docker_diagnose() -> Result<Value, String> {
    // diagnose 内部跑 docker CLI（同步阻塞）。包到 spawn_blocking 不阻塞 tauri 异步运行时
    let v = tauri::async_runtime::spawn_blocking(crate::runtime::diagnose)
        .await
        .map_err(|e| format!("诊断任务异常: {e}"))?;
    Ok(v)
}

/// 一键启动 piston 容器（自动 pull 镜像 + run；已存在则 start）。
/// 启动成功后**自动写入 endpoint 到 app_prefs**，下次跑代码题就直接通了。
#[tauri::command]
pub async fn piston_container_start(state: State<'_, AppState>) -> Result<Value, String> {
    let r = tauri::async_runtime::spawn_blocking(crate::runtime::container_start)
        .await
        .map_err(|e| format!("启动任务异常: {e}"))?;

    // 启动成功 → 自动把默认 endpoint 写到 prefs
    if r.success {
        let endpoint = crate::runtime::default_endpoint();
        let mut all = read_prefs_file(&state.prefs_path);
        if !all.is_object() {
            all = json!({});
        }
        all.as_object_mut()
            .unwrap()
            .insert("code_runner.endpoint".to_string(), Value::String(endpoint.clone()));
        if let Err(e) = write_prefs_file(&state.prefs_path, &all) {
            log::warn!("[piston_container_start] 写入 endpoint 失败: {e}");
        }
    }

    Ok(json!({
        "success": r.success,
        "exit_code": r.exit_code,
        "stdout": r.stdout,
        "stderr": r.stderr,
        "endpoint": crate::runtime::default_endpoint(),
    }))
}

/// 停止 piston 容器。容器和已装运行时保留（下次 start 即恢复）。
#[tauri::command]
pub async fn piston_container_stop() -> Result<Value, String> {
    let r = tauri::async_runtime::spawn_blocking(crate::runtime::container_stop)
        .await
        .map_err(|e| format!("停止任务异常: {e}"))?;
    Ok(json!({
        "success": r.success,
        "exit_code": r.exit_code,
        "stdout": r.stdout,
        "stderr": r.stderr,
    }))
}

/// 强制重建 piston 容器（rm -f 旧的 + docker run 新的）。
/// 用于：容器端口映射缺失 / 容器持续崩溃 / 想用最新参数重建。
/// 警告：会丢失容器内已装的运行时。重建后需要重新装 python 等。
#[tauri::command]
pub async fn piston_container_recreate(state: State<'_, AppState>) -> Result<Value, String> {
    let r = tauri::async_runtime::spawn_blocking(crate::runtime::container_recreate)
        .await
        .map_err(|e| format!("重建任务异常: {e}"))?;

    // 重建成功 → 自动写 endpoint
    if r.success {
        let endpoint = crate::runtime::default_endpoint();
        let mut all = read_prefs_file(&state.prefs_path);
        if !all.is_object() {
            all = json!({});
        }
        all.as_object_mut()
            .unwrap()
            .insert("code_runner.endpoint".to_string(), Value::String(endpoint.clone()));
        if let Err(e) = write_prefs_file(&state.prefs_path, &all) {
            log::warn!("[piston_container_recreate] 写入 endpoint 失败: {e}");
        }
    }

    Ok(json!({
        "success": r.success,
        "exit_code": r.exit_code,
        "stdout": r.stdout,
        "stderr": r.stderr,
        "endpoint": crate::runtime::default_endpoint(),
    }))
}

/// 强制重新下载 piston 镜像（`docker pull`）。
///
/// 适用场景：容器启动报 `chown: cannot access '/piston': No such file or directory`
/// 这类错误通常是 Docker Desktop 把镜像下载/解压过程中断了，本地缓存损坏。
/// 单独 pull 一次能把镜像层修好；用户随后再点「重建容器」即可。
///
/// 不会影响正在运行的容器（pull 只会更新本地镜像缓存，不会触碰已有容器）。
#[tauri::command]
pub async fn piston_pull_image() -> Result<Value, String> {
    let r = tauri::async_runtime::spawn_blocking(crate::runtime::pull_image)
        .await
        .map_err(|e| format!("拉镜像任务异常: {e}"))?;
    Ok(json!({
        "success": r.success,
        "exit_code": r.exit_code,
        "stdout": r.stdout,
        "stderr": r.stderr,
        "image": crate::runtime::PISTON_IMAGE,
    }))
}

/// 读取容器最近 N 行日志（用于排查 piston 进程崩溃）。
#[tauri::command]
pub async fn piston_container_logs(tail: Option<usize>) -> Result<Value, String> {
    let n = tail.unwrap_or(50);
    let r = tauri::async_runtime::spawn_blocking(move || crate::runtime::container_logs(n))
        .await
        .map_err(|e| format!("日志任务异常: {e}"))?;
    Ok(json!({
        "success": r.success,
        "stdout": r.stdout,
        "stderr": r.stderr,
    }))
}

/// 查看容器端口绑定（`docker port`）。空输出 = 容器没绑端口。
#[tauri::command]
pub async fn piston_container_ports() -> Result<Value, String> {
    let r = tauri::async_runtime::spawn_blocking(crate::runtime::container_ports)
        .await
        .map_err(|e| format!("端口任务异常: {e}"))?;
    Ok(json!({
        "success": r.success,
        "stdout": r.stdout,
        "stderr": r.stderr,
    }))
}

/// 在已运行的容器里安装一个语言运行时（默认装最新版）。
/// language 例：python / javascript / rust / java / go
///
/// 实现走 Piston HTTP API（POST /api/v2/packages）—— 不再 docker exec 调 cli，
/// 因为 Piston 3.1.1 起容器内已不再带 cli 文件（`/piston/cli/index.js`），
/// 只能通过 HTTP 装包。
#[tauri::command]
pub async fn piston_install_runtime(
    state: State<'_, AppState>,
    language: String,
    version: Option<String>,
) -> Result<Value, String> {
    let endpoint = read_or_default_runner_endpoint(&state.prefs_path);
    let r = crate::runtime::install_runtime(&endpoint, &language, version.as_deref()).await;
    Ok(json!({
        "success": r.success,
        "exit_code": r.exit_code,
        "stdout": r.stdout,
        "stderr": r.stderr,
    }))
}

/// 列出容器内已装运行时（语言 + 版本）。
///
/// 走 GET /api/v2/runtimes，理由同 install。
#[tauri::command]
pub async fn piston_list_runtimes(state: State<'_, AppState>) -> Result<Value, String> {
    let endpoint = read_or_default_runner_endpoint(&state.prefs_path);
    crate::runtime::list_runtimes(&endpoint).await
}

/// 读 prefs 的 code_runner.endpoint；空则退回到默认 endpoint（http://localhost:2000/...）。
/// 给 piston_install_runtime / piston_list_runtimes 用 ——
/// 它们要求 endpoint 一定要有值，没有也得有个能用的兜底。
fn read_or_default_runner_endpoint(prefs_path: &std::path::Path) -> String {
    let v = read_code_runner_endpoint(prefs_path);
    if v.is_empty() {
        crate::runtime::default_endpoint()
    } else {
        v
    }
}

/// 测试当前配置的 code-runner endpoint：分层诊断（TCP 探测 → HTTP 实际跑代码）。
///
/// 返回 `{ ok: bool, endpoint: string, message: string, steps: [...] }`。
/// `steps` 是诊断步骤的细节，前端可以选择展开看每一步成败。
///
/// 用于「设置 → 代码运行」里的"测试连接"按钮。
#[tauri::command]
pub async fn code_runner_test(
    state: State<'_, AppState>,
    endpoint_override: Option<String>,
) -> Result<Value, String> {
    let endpoint = endpoint_override
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| read_code_runner_endpoint(&state.prefs_path));

    if endpoint.is_empty() {
        return Ok(json!({
            "ok": false,
            "endpoint": "",
            "message": "尚未配置 endpoint",
            "steps": [],
        }));
    }

    let mut steps: Vec<Value> = Vec::new();

    // ── 步骤 1：URL 解析 + TCP 端口探测 ─────────────────────────────────────
    let (host, port) = parse_host_port(&endpoint);
    if host.is_empty() {
        return Ok(json!({
            "ok": false,
            "endpoint": endpoint,
            "message": "URL 格式错误：无法解析 host",
            "steps": steps,
        }));
    }
    let probe_addr = format!("{host}:{port}");
    let tcp_ok = tcp_probe(&probe_addr, std::time::Duration::from_secs(3)).await;
    steps.push(json!({
        "step": "tcp_probe",
        "label": format!("TCP 连接 {probe_addr}"),
        "ok": tcp_ok.is_ok(),
        "detail": match &tcp_ok {
            Ok(_) => "端口可达".to_string(),
            Err(e) => format!("端口不可达：{e}"),
        },
    }));
    if let Err(_e) = tcp_ok {
        // TCP 都不通就别试 HTTP 了，给出有针对性的提示
        let is_local = is_localhost(&host);
        let hint = if is_local {
            "\n常见原因（localhost）：\n  · Piston 容器没有运行 → 到「Docker 一键部署」启动\n  · Docker Desktop 没启动\n  · 端口 2000 被其他程序占用（PowerShell: Get-NetTCPConnection -LocalPort 2000）"
        } else {
            "\n常见原因：\n  · 节点已下线 / 防火墙挡住\n  · DNS 解析失败"
        };
        return Ok(json!({
            "ok": false,
            "endpoint": endpoint,
            "message": format!("TCP 端口 {probe_addr} 不可达。{hint}"),
            "steps": steps,
        }));
    }

    // ── 步骤 2：HTTP 实际运行代码 ───────────────────────────────────────────
    match training::piston_execute(&endpoint, "python", "print('ok')", "", None).await {
        Ok(r) => {
            steps.push(json!({
                "step": "http_run",
                "label": "HTTP 跑 print('ok')",
                "ok": r.success,
                "detail": if r.success {
                    format!("{}ms · stdout={:?}", r.time_ms, r.stdout.trim())
                } else {
                    format!("{}ms · stderr={:?}", r.time_ms, r.stderr.trim())
                },
            }));
            Ok(json!({
                "ok": r.success,
                "endpoint": endpoint,
                "message": if r.success {
                    format!("连接成功 · {}ms · stdout={:?}", r.time_ms, r.stdout.trim())
                } else if r.stderr.contains("not installed") || r.stderr.contains("ENOENT") {
                    "节点可达，但容器内未安装 python 运行时。请到「Docker 一键部署」点击「Python」按钮安装。".to_string()
                } else {
                    format!("节点可达但运行失败：{}", r.stderr.trim())
                },
                "steps": steps,
            }))
        }
        Err(e) => {
            steps.push(json!({
                "step": "http_run",
                "label": "HTTP 跑 print('ok')",
                "ok": false,
                "detail": e.clone(),
            }));
            Ok(json!({
                "ok": false,
                "endpoint": endpoint,
                "message": e,
                "steps": steps,
            }))
        }
    }
}

/// 解析 endpoint URL 的 host:port。失败返回 ("", 0)。
fn parse_host_port(endpoint: &str) -> (String, u16) {
    let after_scheme = endpoint.split("://").collect::<Vec<_>>();
    let (scheme, rest) = if after_scheme.len() == 2 {
        (after_scheme[0].to_lowercase(), after_scheme[1])
    } else {
        ("http".to_string(), after_scheme[0])
    };
    let host_with_port = rest
        .split(|c: char| c == '/' || c == '?' || c == '#')
        .next()
        .unwrap_or("");
    if host_with_port.is_empty() {
        return (String::new(), 0);
    }
    // IPv6 [::1]:2000
    if let Some(stripped) = host_with_port.strip_prefix('[') {
        if let Some(end) = stripped.find(']') {
            let host = &stripped[..end];
            let after = &stripped[end + 1..];
            let port = after
                .strip_prefix(':')
                .and_then(|p| p.parse().ok())
                .unwrap_or_else(|| default_port(&scheme));
            return (host.to_string(), port);
        }
    }
    // 普通 host[:port]
    let mut parts = host_with_port.rsplitn(2, ':');
    let last = parts.next().unwrap_or("");
    let head = parts.next();
    if let (Some(h), Ok(p)) = (head, last.parse::<u16>()) {
        (h.to_string(), p)
    } else {
        (host_with_port.to_string(), default_port(&scheme))
    }
}

fn default_port(scheme: &str) -> u16 {
    match scheme {
        "https" => 443,
        _ => 80,
    }
}

fn is_localhost(host: &str) -> bool {
    let h = host.to_lowercase();
    matches!(h.as_str(), "localhost" | "::1" | "0.0.0.0")
        || host.parse::<std::net::Ipv4Addr>().map(|ip| ip.is_loopback()).unwrap_or(false)
}

/// TCP 连接探测：使用 std::net::TcpStream::connect_timeout（不依赖 tokio net feature）
async fn tcp_probe(addr: &str, timeout_dur: std::time::Duration) -> Result<(), String> {
    let addr_owned = addr.to_string();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        use std::net::ToSocketAddrs;
        let socket_addrs = addr_owned
            .to_socket_addrs()
            .map_err(|e| format!("地址解析失败: {e}"))?
            .collect::<Vec<_>>();
        if socket_addrs.is_empty() {
            return Err("地址解析为空".to_string());
        }
        let mut last_err = String::new();
        for sa in socket_addrs {
            match std::net::TcpStream::connect_timeout(&sa, timeout_dur) {
                Ok(_) => return Ok(()),
                Err(e) => last_err = format!("{e}"),
            }
        }
        Err(last_err)
    })
    .await
    .map_err(|e| format!("blocking 任务异常: {e}"))?
}

/// 生成训练题集。
///
/// `unit_index` = Some 时基于该单元的 explanation 命题；None 时基于全文（路线图概要）。
/// `types` 不传时默认 `["choice", "short", "code"]`。
/// `count` 默认 6；`difficulty` 1-5，默认 3。
/// `language` 代码题语言，默认 "python"。
#[tauri::command]
/// v4 (2026-05) P3.3 命题来源扩展（参数顺序为：unit_indexes 多单元 / entry_id 笔记本条目）。
pub async fn training_generate_pack(
    state: State<'_, AppState>,
    session_id: String,
    unit_index: Option<usize>,
    unit_indexes: Option<Vec<usize>>,
    entry_id: Option<String>,
    types: Option<Vec<String>>,
    count: Option<u32>,
    difficulty: Option<u8>,
    language: Option<String>,
) -> Result<Value, String> {
    let types = types.unwrap_or_else(|| vec!["choice".into(), "short".into(), "code".into()]);
    let count = count.unwrap_or(6).clamp(1, 12);
    let difficulty = difficulty.unwrap_or(3).clamp(1, 5);
    let language = language.unwrap_or_else(|| "python".into());

    // 取命题素材：按优先级 entry_id > unit_indexes > unit_index > outline summary
    let (doc_title, unit_title, material) = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        let session = db::dr_get_session(&conn, &session_id)?;
        let doc_title = session["filename"].as_str().unwrap_or("").to_string();

        // (1) 优先：单个 notebook entry 内容
        if let Some(eid) = entry_id.as_deref() {
            let entry: Value = db::nb_get_entry(&conn, eid)?;
            if entry.is_null() {
                return Err(format!("找不到 entry: {eid}"));
            }
            let title = entry
                .get("title")
                .and_then(|x: &Value| x.as_str())
                .unwrap_or("")
                .to_string();
            let content = entry
                .get("content")
                .and_then(|x: &Value| x.as_str())
                .unwrap_or("")
                .to_string();
            if content.trim().is_empty() {
                return Err(format!("笔记本条目 '{title}' 内容为空，无法命题"));
            }
            (doc_title, Some(format!("[笔记本条目] {title}")), content)
        } else {
            let st = db::agent_get_state(&conn, &session_id)?;
            // (2) 多单元混合
            if let Some(idxs) = unit_indexes.as_ref() {
                if idxs.is_empty() {
                    return Err("unit_indexes 不能为空".into());
                }
                let units_arr = st["plan"]["outline"]["units"].as_array().cloned().unwrap_or_default();
                let mut titles: Vec<String> = Vec::new();
                let mut blocks: Vec<String> = Vec::new();
                for &idx in idxs {
                    let t = units_arr
                        .get(idx)
                        .and_then(|u| u.get("title"))
                        .and_then(|x| x.as_str())
                        .unwrap_or("")
                        .to_string();
                    let exp = db::agent_get_teach_pack(&conn, &session_id, idx)?
                        .and_then(|tp| tp.get("explanation").cloned())
                        .and_then(|v| v.as_str().map(String::from))
                        .unwrap_or_default();
                    if exp.is_empty() {
                        return Err(format!(
                            "单元 {idx} ({t}) 还没生成讲解，无法跨单元命题"
                        ));
                    }
                    titles.push(format!("单元 {} · {}", idx + 1, t));
                    blocks.push(format!("## 单元 {} · {}\n{}", idx + 1, t, exp));
                }
                let combined_title = titles.join(" | ");
                let combined_material = blocks.join("\n\n---\n\n");
                (doc_title, Some(combined_title), combined_material)
            }
            // (3) 单个单元（原行为）
            else if let Some(idx) = unit_index {
                let unit_title = st["plan"]["outline"]["units"]
                    .as_array()
                    .and_then(|arr| arr.get(idx))
                    .and_then(|u| u.get("title"))
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string();
                let explanation = db::agent_get_teach_pack(&conn, &session_id, idx)?
                    .and_then(|tp| tp.get("explanation").cloned())
                    .and_then(|v| v.as_str().map(String::from))
                    .unwrap_or_default();
                if explanation.is_empty() {
                    return Err(format!(
                        "单元 {} 还没生成讲解，无法基于此命题。请先在学习板块完成该单元。",
                        idx
                    ));
                }
                (doc_title, Some(unit_title), explanation)
            }
            // (4) 无指定 → outline 综述
            else {
                let thesis = st["plan"]["outline"]["thesis"]
                    .as_str()
                    .unwrap_or("")
                    .to_string();
                let units = st["plan"]["outline"]["units"]
                    .as_array()
                    .map(|arr| {
                        arr.iter()
                            .map(|u| {
                                let t = u.get("title").and_then(|x| x.as_str()).unwrap_or("");
                                let s = u.get("summary").and_then(|x| x.as_str()).unwrap_or("");
                                format!("- {}: {}", t, s)
                            })
                            .collect::<Vec<_>>()
                            .join("\n")
                    })
                    .unwrap_or_default();
                let material = format!("【主题】\n{}\n\n【单元概要】\n{}", thesis, units);
                (doc_title, None, material)
            }
        }
    };

    let llm = {
        let models = config::load_models(&state.config_path);
        let configs = config::to_llm_configs(&models);
        if !configs.is_empty() {
            LlmClient::from_pool(configs)
        } else {
            LlmConfig::from_env().map(LlmClient::new).map_err(|e| e.to_string())?
        }
    };

    let pack = training::generate_training_pack(
        &llm,
        &doc_title,
        unit_title.as_deref(),
        &material,
        &types,
        count,
        difficulty,
        Some(&language),
    )
    .await?;

    // v4 (2026-05) 把 LLM 自由命名的 skill_meta upsert 到全局 user_skills 表。
    // 让 SkillsPage 能立即看到本次新出现的 skill。
    {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        // 题目中 skills[] 出现的所有 skill_id 都要 ensure（即使 skill_meta 缺失也得有一行）
        let mut all_skill_ids: std::collections::BTreeSet<String> =
            std::collections::BTreeSet::new();
        for q in &pack.questions {
            if let Some(arr) = q.get("skills").and_then(|x| x.as_array()) {
                for s in arr {
                    if let Some(s) = s.as_str() {
                        if !s.trim().is_empty() {
                            all_skill_ids.insert(s.to_string());
                        }
                    }
                }
            }
        }
        for sid in &all_skill_ids {
            let meta = pack.skill_meta.get(sid);
            let name = meta
                .and_then(|m| m.get("name"))
                .and_then(|x| x.as_str())
                .unwrap_or("");
            let cat = meta
                .and_then(|m| m.get("category"))
                .and_then(|x| x.as_str())
                .unwrap_or("");
            let desc = meta
                .and_then(|m| m.get("description"))
                .and_then(|x| x.as_str())
                .unwrap_or("");
            if let Err(e) = db::user_skill_ensure(&conn, sid, name, cat, desc) {
                log::warn!("[training_generate_pack] user_skill_ensure({sid}) 失败: {e}");
            }
        }
    }

    Ok(json!({
        "questions": pack.questions,
        "count": pack.questions.len(),
        "skill_meta": pack.skill_meta,
        "unit_index": unit_index,
        "language": language,
        "difficulty": difficulty,
    }))
}

// ════════════════════════════════════════════════════════════════════════════
// v5 (2026-05) B2: 学习↔训练同步生成 pack
// ════════════════════════════════════════════════════════════════════════════

/// 后台生成单元训练 pack 的辅助函数（被 agent_teach_unit_stream / agent_prefetch_unit 的
/// done handler 异步调用）。失败只 warn 不报错。
///
/// 流程：
///   1. 调 LLM `generate_unit_auto_pack`（自主决定题型分布，含代码题判定）
///   2. 持久化到 `training_unit_packs` 表
///   3. ensure 题目 skills[] 中出现的 skill_id 到 user_skills 表
///   4. emit `training-pack-ready` 事件 { session_id, unit_index, count }
async fn spawn_unit_pack_gen(
    llm: &LlmClient,
    db: &Arc<Mutex<rusqlite::Connection>>,
    app: &AppHandle,
    session_id: &str,
    unit_index: usize,
    doc_title: &str,
    unit_title: &str,
    explanation: &str,
) {
    // 已经存在则跳过（避免 prefetch + teach_stream 重复调用浪费 LLM）
    {
        let conn = match db.lock() {
            Ok(c) => c,
            Err(e) => {
                log::warn!("[unit_pack_gen u{unit_index}] db lock 失败: {e}");
                return;
            }
        };
        if let Ok(Some(_)) = db::tup_get(&conn, session_id, unit_index) {
            log::debug!("[unit_pack_gen u{unit_index}] 已存在，跳过生成");
            return;
        }
    }

    let pack = match training::generate_unit_auto_pack(llm, doc_title, unit_title, explanation, 6, 3).await {
        Ok(p) => p,
        Err(e) => {
            log::warn!("[unit_pack_gen u{unit_index}] LLM 生成失败: {e}");
            return;
        }
    };

    if pack.questions.is_empty() {
        log::warn!("[unit_pack_gen u{unit_index}] LLM 返回空题集");
        return;
    }

    // 持久化 + ensure skills
    let pack_value = json!({
        "questions": pack.questions,
        "skill_meta": pack.skill_meta,
        "unit_index": unit_index,
    });
    let pack_str = match serde_json::to_string(&pack_value) {
        Ok(s) => s,
        Err(e) => {
            log::warn!("[unit_pack_gen u{unit_index}] 序列化失败: {e}");
            return;
        }
    };
    let count = pack.questions.len();
    {
        let conn = match db.lock() {
            Ok(c) => c,
            Err(e) => {
                log::warn!("[unit_pack_gen u{unit_index}] db lock 失败: {e}");
                return;
            }
        };
        if let Err(e) = db::tup_save(&conn, session_id, unit_index, &pack_str) {
            log::warn!("[unit_pack_gen u{unit_index}] 持久化失败: {e}");
            return;
        }
        // ensure skills（与 training_generate_pack 一致）
        let mut all_skill_ids: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
        for q in &pack.questions {
            if let Some(arr) = q.get("skills").and_then(|x| x.as_array()) {
                for s in arr {
                    if let Some(s) = s.as_str() {
                        if !s.trim().is_empty() {
                            all_skill_ids.insert(s.to_string());
                        }
                    }
                }
            }
        }
        for sid in &all_skill_ids {
            let meta = pack.skill_meta.get(sid);
            let name = meta.and_then(|m| m.get("name")).and_then(|x| x.as_str()).unwrap_or("");
            let cat = meta.and_then(|m| m.get("category")).and_then(|x| x.as_str()).unwrap_or("");
            let desc = meta.and_then(|m| m.get("description")).and_then(|x| x.as_str()).unwrap_or("");
            if let Err(e) = db::user_skill_ensure(&conn, sid, name, cat, desc) {
                log::warn!("[unit_pack_gen u{unit_index}] user_skill_ensure({sid}) 失败: {e}");
            }
        }
    }

    let _ = app.emit(
        "training-pack-ready",
        json!({
            "session_id": session_id,
            "unit_index": unit_index,
            "question_count": count,
        }),
    );
    log::info!("[unit_pack_gen u{unit_index}] 完成，{count} 道题");
}

/// 取某单元已 pre-generated 的训练 pack（学习区跳转时用）。
///
/// 返回：`{ session_id, unit_index, pack: { questions, skill_meta, ... }, generated_at }`
/// 不存在时返回 `null`（前端检测到 null 走 training_generate_pack 路径）。
#[tauri::command]
pub async fn training_get_unit_pack(
    state: State<'_, AppState>,
    session_id: String,
    unit_index: usize,
) -> Result<Value, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    match db::tup_get(&conn, &session_id, unit_index)? {
        Some(v) => Ok(v),
        None => Ok(Value::Null),
    }
}

/// 列出某 session 已生成的所有单元 pack（前端 ready 状态指示）。
#[tauri::command]
pub async fn training_list_unit_packs(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Vec<Value>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::tup_list_session(&conn, &session_id)
}

/// 提交一道题的答案 → LLM 评分 → 写训练记录 + 更新技能掌握度。
///
/// 入参：
///   - `question`: 完整题目对象（前端从生成阶段保留）
///   - `user_answer`: 用户最终答案
///   - `code_result`: 可选的代码运行结果（前端如果跑过 Piston 就传过来）
///
/// 返回评分对象 + 更新后的技能进度增量信息。
#[tauri::command]
pub async fn training_submit_attempt(
    state: State<'_, AppState>,
    session_id: String,
    unit_index: Option<i64>,
    question: Value,
    user_answer: String,
    code_result: Option<Value>,
) -> Result<Value, String> {
    let question_id = question
        .get("id")
        .and_then(|x| x.as_str())
        .ok_or_else(|| "题目缺少 id".to_string())?
        .to_string();

    // 反序列化代码运行结果（前端若提供）
    let code_run_typed: Option<training::CodeRunResult> = code_result
        .as_ref()
        .and_then(|v| serde_json::from_value(v.clone()).ok());

    let llm = {
        let models = config::load_models(&state.config_path);
        let configs = config::to_llm_configs(&models);
        if !configs.is_empty() {
            LlmClient::from_pool(configs)
        } else {
            LlmConfig::from_env().map(LlmClient::new).map_err(|e| e.to_string())?
        }
    };

    let grade = training::grade_attempt(&llm, &question, &user_answer, code_run_typed.as_ref()).await;
    let score = grade.get("score").and_then(|x| x.as_i64()).unwrap_or(0);
    let is_correct = grade
        .get("is_correct")
        .and_then(|x| x.as_bool())
        .unwrap_or(score >= 80);

    // 抽取题目关联 skills
    let skills: Vec<String> = question
        .get("skills")
        .and_then(|x| x.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();

    // 写 DB（attempt + skill_mastery 增量）
    let attempt_id = uuid::Uuid::new_v4().to_string();
    let q_str = serde_json::to_string(&question).unwrap_or("{}".into());
    let g_str = serde_json::to_string(&grade).unwrap_or("{}".into());
    let s_str = serde_json::to_string(&skills).unwrap_or("[]".into());
    let cr_str = code_result
        .as_ref()
        .map(|v| serde_json::to_string(v).unwrap_or_default());
    let cr_str_ref = cr_str.as_deref();

    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::training_save_attempt(
        &conn,
        &attempt_id,
        &session_id,
        unit_index,
        &question_id,
        &q_str,
        &user_answer,
        cr_str_ref,
        &g_str,
        &s_str,
        score,
        is_correct,
    )?;

    // 技能掌握度更新：答对每个 skill +0.05；答错 -0.02
    let delta = if is_correct { 0.05 } else { -0.02 };
    for sk_id in &skills {
        // 保证 user_skills 表里有这个 skill_id（LLM 命名的可能是首次出现）
        let _ = db::user_skill_ensure(&conn, sk_id, "", "", "");
        db::skill_mastery_bump(&conn, &session_id, sk_id, delta, is_correct)?;
    }

    // v6 (2026-05) #3: vibe 事件 —— 训练答题
    let q_type = question
        .get("type")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let q_prompt = question
        .get("prompt")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .chars()
        .take(120)
        .collect::<String>();
    db::vibe_event_append(
        &conn,
        &session_id,
        "training_attempt",
        unit_index,
        &attempt_id,
        &json!({
            "question_id": question_id,
            "type": q_type,
            "prompt_preview": q_prompt,
            "score": score,
            "is_correct": is_correct,
            "skills": skills,
        }),
    );

    Ok(json!({
        "attempt_id": attempt_id,
        "grade": grade,
        "score": score,
        "is_correct": is_correct,
        "skills_updated": skills,
        "delta_per_skill": delta,
    }))
}

/// 批量提交训练答案（v4 2026-05）：一次评分 N 题。
///
/// 与 `training_submit_attempt` 的差异：
/// - 接收 `items: Vec<{ question, user_answer, code_result? }>`
/// - 后端用 `training::batch_grade_attempts` 一次性评分：
///   - choice / fill / sequence 规则化判（不调 LLM）
///   - short / code / debug 按 type 分桶 + 单次 LLM 调用
/// - DB 写入 + skill mastery bump 仍逐题处理（保证幂等 & 精确）
///
/// 返回 `[{ attempt_id, grade, score, is_correct, skills_updated }, ...]`，
/// 数组长度严格等于 items.len()，顺序对齐。
#[tauri::command]
pub async fn training_submit_batch(
    state: State<'_, AppState>,
    session_id: String,
    unit_index: Option<i64>,
    items: Vec<Value>,
) -> Result<Value, String> {
    if items.is_empty() {
        return Ok(json!([]));
    }

    // 解析输入
    let mut batch_inputs: Vec<training::BatchGradeItem> = Vec::with_capacity(items.len());
    let mut question_ids: Vec<String> = Vec::with_capacity(items.len());
    let mut user_answers: Vec<String> = Vec::with_capacity(items.len());
    let mut code_result_raws: Vec<Option<Value>> = Vec::with_capacity(items.len());
    for it in &items {
        let q = it.get("question").cloned().ok_or_else(|| "item 缺少 question".to_string())?;
        let qid = q
            .get("id")
            .and_then(|x| x.as_str())
            .ok_or_else(|| "题目缺少 id".to_string())?
            .to_string();
        let ua = it
            .get("user_answer")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string();
        let cr_raw = it.get("code_result").cloned();
        let cr_typed: Option<training::CodeRunResult> =
            cr_raw.as_ref().and_then(|v| serde_json::from_value(v.clone()).ok());
        batch_inputs.push(training::BatchGradeItem {
            question: q,
            user_answer: ua.clone(),
            code_result: cr_typed,
        });
        question_ids.push(qid);
        user_answers.push(ua);
        code_result_raws.push(cr_raw);
    }

    let llm = {
        let models = config::load_models(&state.config_path);
        let configs = config::to_llm_configs(&models);
        if !configs.is_empty() {
            LlmClient::from_pool(configs)
        } else {
            LlmConfig::from_env().map(LlmClient::new).map_err(|e| e.to_string())?
        }
    };

    // 一次性评分（最多一次 / 几次 LLM 调用）
    let grades = training::batch_grade_attempts(&llm, &batch_inputs).await;

    // 写 DB
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let mut output: Vec<Value> = Vec::with_capacity(items.len());
    for (i, grade) in grades.iter().enumerate() {
        let score = grade.get("score").and_then(|x| x.as_i64()).unwrap_or(0);
        let is_correct = grade
            .get("is_correct")
            .and_then(|x| x.as_bool())
            .unwrap_or(score >= 80);
        let skills: Vec<String> = batch_inputs[i]
            .question
            .get("skills")
            .and_then(|x| x.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default();

        let attempt_id = uuid::Uuid::new_v4().to_string();
        let q_str = serde_json::to_string(&batch_inputs[i].question).unwrap_or("{}".into());
        let g_str = serde_json::to_string(grade).unwrap_or("{}".into());
        let s_str = serde_json::to_string(&skills).unwrap_or("[]".into());
        let cr_str = code_result_raws[i]
            .as_ref()
            .map(|v| serde_json::to_string(v).unwrap_or_default());
        let cr_str_ref = cr_str.as_deref();

        db::training_save_attempt(
            &conn,
            &attempt_id,
            &session_id,
            unit_index,
            &question_ids[i],
            &q_str,
            &user_answers[i],
            cr_str_ref,
            &g_str,
            &s_str,
            score,
            is_correct,
        )?;

        let delta = if is_correct { 0.05 } else { -0.02 };
        for sk_id in &skills {
            let _ = db::user_skill_ensure(&conn, sk_id, "", "", "");
            db::skill_mastery_bump(&conn, &session_id, sk_id, delta, is_correct)?;
        }

        output.push(json!({
            "attempt_id": attempt_id,
            "grade": grade,
            "score": score,
            "is_correct": is_correct,
            "skills_updated": skills,
            "delta_per_skill": delta,
        }));
    }

    Ok(json!(output))
}

/// 取最近 N 条训练历史。
#[tauri::command]
pub async fn training_get_history(
    state: State<'_, AppState>,
    session_id: String,
    limit: Option<i64>,
) -> Result<Value, String> {
    let limit = limit.unwrap_or(50).clamp(1, 200);
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let attempts = db::training_list_attempts(&conn, &session_id, limit)?;
    let stats = db::training_stats(&conn, &session_id)?;
    Ok(json!({
        "attempts": attempts,
        "stats": stats,
    }))
}

/// 取技能树总览：包含预设节点 + 学生当前进度（合并）。
#[tauri::command]
pub async fn training_skill_overview(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Value, String> {
    let tree = training::se_skill_tree();
    let progress = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        db::skill_mastery_list(&conn, &session_id)?
    };
    // 把 progress 索引到 skill_id
    let mut progress_map = std::collections::HashMap::new();
    for p in &progress {
        if let Some(id) = p.get("skill_id").and_then(|x| x.as_str()) {
            progress_map.insert(id.to_string(), p.clone());
        }
    }
    // 合并：每个 tree 节点附带 mastery / practice_count / correct_count
    let nodes: Vec<Value> = tree
        .iter()
        .map(|node| {
            let p = progress_map.get(&node.id);
            json!({
                "id": node.id,
                "name": node.name,
                "category": node.category,
                "description": node.description,
                "max_difficulty": node.max_difficulty,
                "mastery": p.and_then(|x| x.get("mastery")).and_then(|x| x.as_f64()).unwrap_or(0.0),
                "practice_count": p.and_then(|x| x.get("practice_count")).and_then(|x| x.as_i64()).unwrap_or(0),
                "correct_count": p.and_then(|x| x.get("correct_count")).and_then(|x| x.as_i64()).unwrap_or(0),
                "last_practiced_at": p.and_then(|x| x.get("last_practiced_at")).cloned().unwrap_or(Value::Null),
            })
        })
        .collect();

    // 按 category 分组（保留原始顺序，因为 tree 已经按教学顺序排好）
    let mut categories: Vec<String> = Vec::new();
    let mut grouped: std::collections::HashMap<String, Vec<Value>> = std::collections::HashMap::new();
    for n in &nodes {
        let cat = n.get("category").and_then(|x| x.as_str()).unwrap_or("").to_string();
        if !grouped.contains_key(&cat) {
            categories.push(cat.clone());
        }
        grouped.entry(cat).or_default().push(n.clone());
    }
    let groups: Vec<Value> = categories
        .iter()
        .map(|c| {
            json!({
                "category": c,
                "skills": grouped.get(c).cloned().unwrap_or_default(),
            })
        })
        .collect();

    // 总体统计
    let total = nodes.len();
    let unlocked = nodes
        .iter()
        .filter(|n| n.get("practice_count").and_then(|x| x.as_i64()).unwrap_or(0) > 0)
        .count();
    let total_mastery: f64 = nodes
        .iter()
        .map(|n| n.get("mastery").and_then(|x| x.as_f64()).unwrap_or(0.0))
        .sum();
    let avg_mastery = if total > 0 { total_mastery / total as f64 } else { 0.0 };

    Ok(json!({
        "groups": groups,
        "summary": {
            "total_skills": total,
            "unlocked_skills": unlocked,
            "avg_mastery": avg_mastery,
        },
    }))
}

// ════════════════════════════════════════════════════════════════════════════
// v4 (2026-05) user_skills 全局技能字典管理（前端 SkillsPage 用）
// ════════════════════════════════════════════════════════════════════════════

/// 列出所有用户技能（含跨会话聚合统计）。
#[tauri::command]
pub async fn skills_list(state: State<'_, AppState>) -> Result<Vec<Value>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::user_skills_list(&conn)
}

/// 重命名 / 编辑某个 skill。空字符串表示不改该字段（保持原值）。
#[tauri::command]
pub async fn skills_update(
    state: State<'_, AppState>,
    skill_id: String,
    name: Option<String>,
    category: Option<String>,
    description: Option<String>,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::user_skill_update(
        &conn,
        &skill_id,
        name.as_deref(),
        category.as_deref(),
        description.as_deref(),
    )
}

/// 合并两个 skill：把 from_id 的所有 mastery 数据合并进 to_id，删除 from_id。
#[tauri::command]
pub async fn skills_merge(
    state: State<'_, AppState>,
    from_id: String,
    to_id: String,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::user_skill_merge(&conn, &from_id, &to_id)
}

/// 删除一个 skill（连带删除 skill_mastery；training_attempts 历史保留）。
#[tauri::command]
pub async fn skills_delete(
    state: State<'_, AppState>,
    skill_id: String,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::user_skill_delete(&conn, &skill_id)
}

/// v6 (2026-05) #3++ 用 LLM 把所有 user_skills 重新归类成多级层级路径，
/// 写回 `category` 字段（约定分隔符 ` / `，前后带空格）。
///
/// 用户诉求："知识技能没有上限，让 LLM 归类分支包含关系，前端做成树形"。
/// 实现策略：保留单层 `category` 字段不动 schema —— 让它装下"领域 / 子领域 / ..."这种路径串。
/// 前端解析这个路径渲染成树。
///
/// 不会动 skill_id / name / description；不会新建 / 删除 skill；只改 category。
#[tauri::command]
pub async fn skills_reorganize_tree(
    state: State<'_, AppState>,
) -> Result<Value, String> {
    // 1) 拉当前所有 skills
    let skills = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        db::user_skills_list(&conn)?
    };
    if skills.is_empty() {
        return Ok(json!({ "updated": 0, "tree_size": 0 }));
    }

    // 2) 构造给 LLM 的简表 —— 只传必要字段，省 token
    let brief: Vec<Value> = skills
        .iter()
        .map(|s| {
            json!({
                "skill_id": s.get("skill_id").and_then(|x| x.as_str()).unwrap_or(""),
                "name": s.get("name").and_then(|x| x.as_str()).unwrap_or(""),
                "category": s.get("category").and_then(|x| x.as_str()).unwrap_or(""),
                "description": s.get("description").and_then(|x| x.as_str()).unwrap_or(""),
            })
        })
        .collect();
    let payload = serde_json::to_string(&brief).map_err(|e| e.to_string())?;

    // 3) LLM 客户端
    let llm = build_llm(&state)?;

    let system = "你是知识架构师，擅长把零散技能组织成多级层级目录。\
仔细阅读 skill_id / name / description，按内容自然归类成「领域 → 子领域 → 具体技能」的路径。\
不要预设固定层级数量；该深就深、该浅就浅。同语义的归到一起，不要重复造类别。\
只输出 JSON，不要 markdown，不要解释。";

    let user = format!(
        r#"输入技能列表（JSON 数组）：
{payload}

请为每一个 skill_id 输出新的 category 路径。约定：
- 分隔符严格用 " / "（空格-斜杠-空格）
- 路径长度 1~4 段，按内容深浅决定
- 用中文，简洁通用（避免书名 / 章节号等耦合具体资料的字眼）
- 同类技能必须落到同一父路径下

输出 JSON 形如：
{{
  "skills": [
    {{ "skill_id": "frontend.react.hooks", "category": "前端 / React / Hooks" }},
    {{ "skill_id": "algo.sort.quick", "category": "算法与数据结构 / 排序" }}
  ]
}}

只输出 JSON。"#
    );

    let resp = llm.chat_json(system, &user, 2).await.map_err(|e| e.to_string())?;
    let updates = resp
        .get("skills")
        .and_then(|x| x.as_array())
        .cloned()
        .unwrap_or_default();
    if updates.is_empty() {
        return Err("LLM 没有返回 skills 字段，重组失败".into());
    }

    // 4) 写回 —— 只更新 category（用 user_skill_update 的 None 表示其它字段不动）
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let mut updated = 0usize;
    let mut tree_paths = std::collections::BTreeSet::<String>::new();
    for u in updates {
        let sid = u.get("skill_id").and_then(|x| x.as_str()).unwrap_or("");
        let cat = u
            .get("category")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if sid.is_empty() || cat.is_empty() {
            continue;
        }
        if let Err(e) = db::user_skill_update(&conn, sid, None, Some(&cat), None) {
            log::warn!("[skills_reorganize_tree] 更新 {sid} 失败: {e}");
            continue;
        }
        updated += 1;
        tree_paths.insert(cat);
    }

    Ok(json!({
        "updated": updated,
        "tree_size": tree_paths.len(),
    }))
}

// ══════════════════════════════════════════════════════════════════════════════
// v6 (2026-05) #3 vibelearning 统一 session 事件流：查询 API
// ══════════════════════════════════════════════════════════════════════════════
//
// 前端 VibeHistoryPanel 调用此命令拉取 session 内所有 vibe 事件，
// 按时间序渲染成 timeline。事件由 agent_* / training_* 命令在执行成功后埋点写入。
//
// `limit = 0` 或缺省时取最近 5000 条（按 ts 升序）。

/// 拉取一个 session 的 vibe 事件 timeline
#[tauri::command]
pub async fn vibe_get_timeline(
    state: State<'_, AppState>,
    session_id: String,
    limit: Option<i64>,
) -> Result<Value, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let events = db::vibe_events_list(&conn, &session_id, limit.unwrap_or(0))?;
    let count = events.len();
    Ok(json!({
        "events": events,
        "count": count,
    }))
}

// ══════════════════════════════════════════════════════════════════════════════
// v6 (2026-05) #3+ 学习流笔记查询
// ══════════════════════════════════════════════════════════════════════════════
//
// 前端 NoteTab 的「学习流」子标签调用此命令拉取按单元切片的笔记。
//   - archive_id 缺省 / 空串 → 当前 active 学习流
//   - archive_id 非空 → 某次归档的学习流（用于复习模式）

/// 列出某 session 的学习流笔记（按时间升序）
#[tauri::command]
pub async fn agent_stream_notes_list(
    state: State<'_, AppState>,
    session_id: String,
    archive_id: Option<String>,
) -> Result<Value, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let aid = archive_id.as_deref();
    let notes = db::agent_stream_notes_list(&conn, &session_id, aid)?;
    let count = notes.len();
    Ok(json!({
        "notes": notes,
        "count": count,
        "archive_id": aid.unwrap_or(""),
    }))
}


// ══════════════════════════════════════════════════════════════════════════════
// 通用：用系统默认浏览器打开外部 URL
// ══════════════════════════════════════════════════════════════════════════════
//
// 背景：Tauri webview 默认会拦截 `<a target="_blank">` 跳转，且没有目标窗口
// 可弹，于是用户点了像「下载 Docker Desktop」这样的链接看起来"没反应"。
//
// 该命令把 URL 交给操作系统的默认 handler：
//   - Windows：`cmd /c start "" "<url>"`（首个空字符串是 `start` 的 window title）
//   - macOS：  `open "<url>"`
//   - Linux：  `xdg-open "<url>"`
//   - Android：暂不支持（Tauri 移动端 webview 自身能处理 _blank，前端会走 fallback）
//
// 安全：仅允许 http/https 协议；防止被滥用打开本地路径或自定义 scheme。
#[tauri::command]
pub async fn open_external_url(url: String) -> Result<(), String> {
    let trimmed = url.trim();
    if !(trimmed.starts_with("http://") || trimmed.starts_with("https://")) {
        return Err(format!("仅允许 http/https 链接：{}", trimmed));
    }

    #[cfg(target_os = "windows")]
    {
        // 用 cmd 的 start 命令；第一个空标题是必需的，否则带空格的 URL 会被当成窗口标题。
        // /C 让 cmd 执行完就退出，不弹窗（再加 CREATE_NO_WINDOW 标记彻底隐藏黑窗）。
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        std::process::Command::new("cmd")
            .args(["/C", "start", "", trimmed])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| format!("打开浏览器失败: {e}"))?;
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(trimmed)
            .spawn()
            .map_err(|e| format!("打开浏览器失败: {e}"))?;
        return Ok(());
    }

    #[cfg(all(unix, not(target_os = "macos"), not(target_os = "android")))]
    {
        std::process::Command::new("xdg-open")
            .arg(trimmed)
            .spawn()
            .map_err(|e| format!("打开浏览器失败: {e}"))?;
        return Ok(());
    }

    #[cfg(target_os = "android")]
    {
        let _ = trimmed;
        Err("移动端请使用前端 fallback".to_string())
    }
}
