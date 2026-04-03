use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};
use futures::stream::{self, StreamExt};

use crate::config;
use crate::db::{self, AppState};
use crate::doc_reader;
use crate::llm::{LlmClient, LlmConfig};
use crate::parser;

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
    log::info!("test_llm_model: 测试模型 '{}' ({}) provider={} base={}",
        model.name, model.model, model.provider, model.api_base);
    let cfg = LlmConfig {
        provider: model.provider,
        api_key: model.api_key,
        api_base: model.api_base,
        model: model.model.clone(),
        use_proxy: model.use_proxy,
    };
    let client = LlmClient::new(cfg);
    let messages = vec![crate::llm::Message {
        role: "user".into(),
        content: "Hi, reply with just 'ok'.".into(),
    }];
    match client.chat(&messages).await {
        Ok(reply) => Ok(json!({
            "success": true,
            "model": model.model,
            "reply": reply.chars().take(100).collect::<String>(),
        })),
        Err(e) => Ok(json!({
            "success": false,
            "model": model.model,
            "error": e,
        })),
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
    _app_handle: AppHandle,
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
) -> Result<Value, String> {
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

        match doc_reader::generate_page_note(&llm, &doc_title, page_index, &page_content, &ntype, cprompt.as_deref()).await {
            Ok(note_content) => {
                let save_ok = if let Ok(conn) = state_inner.db.lock() {
                    db::dr_save_note(&conn, &sid, page_index, &note_content, "ai").is_ok()
                } else {
                    false
                };
                if save_ok {
                    let note = serde_json::json!({
                        "content": note_content,
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
                    match doc_reader::generate_page_note(llm, doc_title, page_idx, &page_content, ntype, None).await {
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
) -> Result<Value, String> {
    let notebook_id = uuid::Uuid::new_v4().to_string();
    let desc = description.unwrap_or_default();
    let clr = color.unwrap_or_else(|| "#7C5CFC".to_string());
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::nb_create(&conn, &notebook_id, &name, &desc, &clr)?;
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
) -> Result<(), String> {
    let desc = description.unwrap_or_default();
    let clr = color.unwrap_or_else(|| "#7C5CFC".to_string());
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::nb_update(&conn, &notebook_id, &name, &desc, &clr)
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
#[tauri::command]
pub async fn notebook_update_entry(
    state: State<'_, AppState>,
    entry_id: String,
    title: String,
    content: String,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::nb_update_entry(&conn, &entry_id, &title, &content)
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

/// 选页生成笔记到笔记本：从指定页码范围读取内容，调用LLM生成综合笔记
#[tauri::command]
pub async fn notebook_generate_from_pages(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    notebook_id: String,
    session_id: String,
    page_ranges: String,
    note_type: Option<String>,
    page_contents: Option<String>,
) -> Result<Value, String> {
    let entry_id = uuid::Uuid::new_v4().to_string();

    // 解析页码范围并获取内容
    let (combined_content, doc_title) = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        let session = db::dr_get_session(&conn, &session_id)?;
        let doc_title = session["filename"].as_str().unwrap_or("").to_string();

        // 优先使用前端传入的内容（确保 PDF 页面与渲染一致）
        let combined = if let Some(ref pc) = page_contents {
            if !pc.trim().is_empty() {
                pc.clone()
            } else {
                let page_indices = parse_page_ranges(&page_ranges, session["page_count"].as_i64().unwrap_or(0) as usize)?;
                let mut c = String::new();
                for idx in &page_indices {
                    let page = db::dr_get_page(&conn, &session_id, *idx)?;
                    let content = page["content"].as_str().unwrap_or("");
                    if !content.trim().is_empty() {
                        c.push_str(&format!("\n\n--- 第 {} 页 ---\n\n{}", idx + 1, content));
                    }
                }
                c
            }
        } else {
            let page_indices = parse_page_ranges(&page_ranges, session["page_count"].as_i64().unwrap_or(0) as usize)?;
            let mut c = String::new();
            for idx in &page_indices {
                let page = db::dr_get_page(&conn, &session_id, *idx)?;
                let content = page["content"].as_str().unwrap_or("");
                if !content.trim().is_empty() {
                    c.push_str(&format!("\n\n--- 第 {} 页 ---\n\n{}", idx + 1, content));
                }
            }
            c
        };
        (combined, doc_title)
    };

    if combined_content.trim().is_empty() {
        return Err("指定页面范围内没有可用内容".to_string());
    }

    let eid = entry_id.clone();
    let nbid = notebook_id.clone();
    let ranges = page_ranges.clone();
    let ntype = note_type.unwrap_or_else(|| "note".to_string());
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
                        let _ = app_inner.emit("notebook-page-range-error", json!({
                            "entry_id": eid, "error": e
                        }));
                        return;
                    }
                }
            }
        };

        match doc_reader::generate_pages_note(&llm, &doc_title, &ranges, &combined_content, &ntype).await {
            Ok(note_content) => {
                let title = format!("📖 第{}页笔记", ranges);
                let source = format!("第{}页", ranges);
                if let Ok(conn) = state_inner.db.lock() {
                    let _ = db::nb_add_entry(&conn, &eid, &nbid, &title, &note_content, "page_range", &source);
                }
                let _ = app_inner.emit("notebook-page-range-done", json!({
                    "entry_id": eid,
                    "notebook_id": nbid,
                    "title": title,
                    "content": note_content,
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

/// 选文生成笔记到笔记本：对选中文本调用LLM生成笔记
#[tauri::command]
pub async fn notebook_generate_from_text(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    notebook_id: String,
    session_id: String,
    selected_text: String,
    note_type: Option<String>,
    page_index: Option<usize>,
    custom_prompt: Option<String>,
) -> Result<Value, String> {
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
    let text = selected_text.clone();
    let ntype = note_type.unwrap_or_else(|| "note".to_string());
    let pidx = page_index;
    let cprompt = custom_prompt;
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
                        let _ = app_inner.emit("notebook-text-note-error", json!({
                            "entry_id": eid, "error": e
                        }));
                        return;
                    }
                }
            }
        };

        match doc_reader::generate_text_note(&llm, &doc_title, &text, &ntype, pidx, cprompt.as_deref()).await {
            Ok(note_content) => {
                let title_truncated: String = text.chars().take(30).collect();
                let title = format!("📝 选文笔记: {}{}", title_truncated, if text.chars().count() > 30 { "…" } else { "" });
                let source = if text.chars().count() > 100 {
                    let s: String = text.chars().take(100).collect();
                    format!("{}...", s)
                } else { text.clone() };
                if let Ok(conn) = state_inner.db.lock() {
                    let _ = db::nb_add_entry(&conn, &eid, &nbid, &title, &note_content, "text_select", &source);
                }
                let _ = app_inner.emit("notebook-text-note-done", json!({
                    "entry_id": eid,
                    "notebook_id": nbid,
                    "title": title,
                    "content": note_content,
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
