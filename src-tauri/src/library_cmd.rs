//! v2 commands — courses / resources / progress / annotations / bookmarks
//!
//! 这些命令都通过 `library_db` 模块与 SQLite 交互。前端使用 `lib/tauri.ts`
//! 调用相应的 invoke 名字。

use serde_json::Value;
use tauri::State;

use crate::db::AppState;
use crate::library_db as ldb;

fn lock<'a>(state: &'a State<AppState>) -> std::sync::MutexGuard<'a, rusqlite::Connection> {
    state.db.lock().expect("db lock poisoned")
}

// ──────────── courses ────────────────────────────────────────────────────

#[tauri::command]
pub async fn course_create(
    state: State<'_, AppState>,
    name: String,
    description: Option<String>,
    cover_color: Option<String>,
    cover_emoji: Option<String>,
) -> Result<String, String> {
    let conn = lock(&state);
    ldb::course_create(
        &conn,
        &name,
        description.as_deref().unwrap_or(""),
        cover_color.as_deref().unwrap_or("#7C5CFC"),
        cover_emoji.as_deref().unwrap_or("📚"),
    )
}

#[tauri::command]
pub async fn course_list(
    state: State<'_, AppState>,
    include_archived: Option<bool>,
) -> Result<Vec<Value>, String> {
    let conn = lock(&state);
    ldb::course_list(&conn, include_archived.unwrap_or(false))
}

#[tauri::command]
pub async fn course_get(
    state: State<'_, AppState>,
    course_id: String,
) -> Result<Option<Value>, String> {
    let conn = lock(&state);
    ldb::course_get(&conn, &course_id)
}

#[tauri::command]
pub async fn course_update(
    state: State<'_, AppState>,
    course_id: String,
    name: Option<String>,
    description: Option<String>,
    cover_color: Option<String>,
    cover_emoji: Option<String>,
    notebook_id: Option<String>,
    outline_id: Option<String>,
    sort_order: Option<i64>,
    archived: Option<bool>,
) -> Result<(), String> {
    let conn = lock(&state);
    ldb::course_update(
        &conn,
        &course_id,
        name.as_deref(),
        description.as_deref(),
        cover_color.as_deref(),
        cover_emoji.as_deref(),
        notebook_id.as_deref(),
        outline_id.as_deref(),
        sort_order,
        archived,
    )
}

#[tauri::command]
pub async fn course_delete(state: State<'_, AppState>, course_id: String) -> Result<(), String> {
    let conn = lock(&state);
    ldb::course_delete(&conn, &course_id)
}

#[tauri::command]
pub async fn course_attach_resource(
    state: State<'_, AppState>,
    course_id: String,
    resource_id: String,
    category: Option<String>,
    sort_order: Option<i64>,
) -> Result<(), String> {
    let conn = lock(&state);
    ldb::course_attach_resource(
        &conn,
        &course_id,
        &resource_id,
        category.as_deref().unwrap_or("main"),
        sort_order.unwrap_or(0),
    )
}

#[tauri::command]
pub async fn course_detach_resource(
    state: State<'_, AppState>,
    course_id: String,
    resource_id: String,
) -> Result<(), String> {
    let conn = lock(&state);
    ldb::course_detach_resource(&conn, &course_id, &resource_id)
}

#[tauri::command]
pub async fn course_list_resources(
    state: State<'_, AppState>,
    course_id: String,
) -> Result<Vec<Value>, String> {
    let conn = lock(&state);
    ldb::course_list_resources(&conn, &course_id)
}

#[tauri::command]
pub async fn course_set_resource_category(
    state: State<'_, AppState>,
    course_id: String,
    resource_id: String,
    category: String,
    sort_order: Option<i64>,
) -> Result<(), String> {
    let conn = lock(&state);
    ldb::course_set_resource_category(
        &conn,
        &course_id,
        &resource_id,
        &category,
        sort_order.unwrap_or(0),
    )
}

// ──────────── resources ──────────────────────────────────────────────────

#[tauri::command]
pub async fn resource_create(
    state: State<'_, AppState>,
    kind: String,
    title: String,
    author: Option<String>,
    filename: String,
    file_path: String,
    file_size: Option<i64>,
    page_count: Option<i64>,
    has_text: Option<bool>,
    doc_session_id: Option<String>,
) -> Result<String, String> {
    let conn = lock(&state);
    ldb::resource_create(
        &conn,
        &kind,
        &title,
        author.as_deref().unwrap_or(""),
        &filename,
        &file_path,
        file_size.unwrap_or(0),
        page_count.unwrap_or(0),
        has_text.unwrap_or(false),
        doc_session_id.as_deref().unwrap_or(""),
    )
}

#[tauri::command]
pub async fn resource_list(
    state: State<'_, AppState>,
    kind: Option<String>,
    limit: Option<i64>,
) -> Result<Vec<Value>, String> {
    let conn = lock(&state);
    ldb::resource_list(&conn, kind.as_deref(), limit.unwrap_or(500))
}

#[tauri::command]
pub async fn resource_get(
    state: State<'_, AppState>,
    resource_id: String,
) -> Result<Option<Value>, String> {
    let conn = lock(&state);
    ldb::resource_get(&conn, &resource_id)
}

#[tauri::command]
pub async fn resource_update_meta(
    state: State<'_, AppState>,
    resource_id: String,
    title: Option<String>,
    author: Option<String>,
    cover_path: Option<String>,
) -> Result<(), String> {
    let conn = lock(&state);
    ldb::resource_update_meta(
        &conn,
        &resource_id,
        title.as_deref(),
        author.as_deref(),
        cover_path.as_deref(),
    )
}

/// 把前端提取到的封面字节（base64）落盘到 `uploads/covers/<resource_id>.<ext>`，
/// 并 update `resources.cover_path`。
///
/// 用途：MOBI/AZW3 等 PalmDB 二进制格式 Rust 端没轻量解析库，前端用 foliate-js
/// 的 `book.getCover()` 拿 Blob，转 base64 通过这个 command 写盘。EPUB 走 Rust
/// 端 `epub_cover::extract_epub_cover`，不需要这条路径。
#[tauri::command]
pub async fn resource_save_cover(
    state: State<'_, AppState>,
    resource_id: String,
    file_data: String,
    ext: String,
) -> Result<String, String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&file_data)
        .map_err(|e| format!("Base64 解码失败: {e}"))?;
    let safe_ext = ext.trim_start_matches('.').to_lowercase();
    // 仅允许常见图片扩展，避免任意写
    if !matches!(safe_ext.as_str(), "jpg" | "jpeg" | "png" | "gif" | "webp" | "bmp") {
        return Err(format!("不支持的封面扩展: {safe_ext}"));
    }
    let covers_dir = state.uploads_dir.join("covers");
    std::fs::create_dir_all(&covers_dir).map_err(|e| format!("创建 covers/ 失败: {e}"))?;
    let cover_path = covers_dir.join(format!("{resource_id}.{safe_ext}"));
    std::fs::write(&cover_path, &bytes).map_err(|e| format!("写封面失败: {e}"))?;
    let cover_path_str = cover_path.to_string_lossy().to_string();
    let conn = lock(&state);
    ldb::resource_update_meta(&conn, &resource_id, None, None, Some(&cover_path_str))?;
    Ok(cover_path_str)
}

#[tauri::command]
pub async fn resource_delete(
    state: State<'_, AppState>,
    resource_id: String,
) -> Result<(), String> {
    let conn = lock(&state);
    ldb::resource_delete(&conn, &resource_id)
}

#[tauri::command]
pub async fn resource_guess_kind(filename: String) -> Result<String, String> {
    Ok(ldb::guess_kind_from_filename(&filename).to_string())
}

/// 读取 resource.file_path 指向的二进制文件，返回 base64
/// 前端可以解码后转 Blob 喂给 foliate-js
#[tauri::command]
pub async fn resource_read_file(
    state: State<'_, AppState>,
    resource_id: String,
) -> Result<Value, String> {
    use base64::Engine;
    let file_path: String = {
        let conn = lock(&state);
        let r = ldb::resource_get(&conn, &resource_id)?
            .ok_or_else(|| format!("resource not found: {resource_id}"))?;
        r["file_path"].as_str().unwrap_or("").to_string()
    };
    if file_path.is_empty() {
        return Err("该资料没有关联的文件路径".into());
    }
    let path = std::path::Path::new(&file_path);
    if !path.exists() {
        return Err(format!("文件不存在: {file_path}"));
    }
    let bytes = std::fs::read(path).map_err(|e| format!("读取文件失败: {e}"))?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(serde_json::json!({
        "file_data": b64,
        "file_name": path.file_name().unwrap_or_default().to_string_lossy(),
        "file_size": bytes.len(),
    }))
}

// ──────────── reading_progress ───────────────────────────────────────────

#[tauri::command]
pub async fn progress_upsert(
    state: State<'_, AppState>,
    resource_id: String,
    cfi: Option<String>,
    page_index: Option<i64>,
    percent: Option<f64>,
    add_seconds: Option<i64>,
) -> Result<(), String> {
    let conn = lock(&state);
    ldb::progress_upsert(
        &conn,
        &resource_id,
        cfi.as_deref().unwrap_or(""),
        page_index.unwrap_or(0),
        percent.unwrap_or(0.0),
        add_seconds.unwrap_or(0),
    )
}

#[tauri::command]
pub async fn progress_get(
    state: State<'_, AppState>,
    resource_id: String,
) -> Result<Option<Value>, String> {
    let conn = lock(&state);
    ldb::progress_get(&conn, &resource_id)
}

// ──────────── annotations ────────────────────────────────────────────────

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn annotation_create(
    state: State<'_, AppState>,
    resource_id: String,
    kind: String,
    color: Option<String>,
    cfi_start: Option<String>,
    cfi_end: Option<String>,
    page_index: Option<i64>,
    text_offset_start: Option<i64>,
    text_offset_end: Option<i64>,
    selected_text: String,
    note_content: Option<String>,
    // PDF 批注专用：归一化矩形 JSON（见 library_db.annotation_create 文档）
    pdf_rects: Option<String>,
) -> Result<String, String> {
    let conn = lock(&state);
    ldb::annotation_create(
        &conn,
        &resource_id,
        &kind,
        color.as_deref().unwrap_or("yellow"),
        cfi_start.as_deref().unwrap_or(""),
        cfi_end.as_deref().unwrap_or(""),
        page_index.unwrap_or(-1),
        text_offset_start.unwrap_or(-1),
        text_offset_end.unwrap_or(-1),
        &selected_text,
        note_content.as_deref().unwrap_or(""),
        pdf_rects.as_deref().unwrap_or(""),
    )
}

#[tauri::command]
pub async fn annotation_update(
    state: State<'_, AppState>,
    annotation_id: String,
    color: Option<String>,
    note_content: Option<String>,
) -> Result<(), String> {
    let conn = lock(&state);
    ldb::annotation_update(
        &conn,
        &annotation_id,
        color.as_deref(),
        note_content.as_deref(),
    )
}

#[tauri::command]
pub async fn annotation_delete(
    state: State<'_, AppState>,
    annotation_id: String,
) -> Result<(), String> {
    let conn = lock(&state);
    ldb::annotation_delete(&conn, &annotation_id)
}

#[tauri::command]
pub async fn annotation_list(
    state: State<'_, AppState>,
    resource_id: String,
) -> Result<Vec<Value>, String> {
    let conn = lock(&state);
    ldb::annotation_list(&conn, &resource_id)
}

// ──────────── bookmarks ──────────────────────────────────────────────────

#[tauri::command]
pub async fn bookmark_create(
    state: State<'_, AppState>,
    resource_id: String,
    cfi: Option<String>,
    page_index: Option<i64>,
    label: Option<String>,
) -> Result<String, String> {
    let conn = lock(&state);
    ldb::bookmark_create(
        &conn,
        &resource_id,
        cfi.as_deref().unwrap_or(""),
        page_index.unwrap_or(-1),
        label.as_deref().unwrap_or(""),
    )
}

#[tauri::command]
pub async fn bookmark_delete(
    state: State<'_, AppState>,
    bookmark_id: String,
) -> Result<(), String> {
    let conn = lock(&state);
    ldb::bookmark_delete(&conn, &bookmark_id)
}

#[tauri::command]
pub async fn bookmark_list(
    state: State<'_, AppState>,
    resource_id: String,
) -> Result<Vec<Value>, String> {
    let conn = lock(&state);
    ldb::bookmark_list(&conn, &resource_id)
}

// ──────────── import (file → resource + optional doc_session) ─────────────

/// 一次性导入：保存原始文件 → 注册 resource → 若 parser 支持则同时建 doc_session（用于 PPTX/DOCX/PDF 文本 fallback）
#[tauri::command]
pub async fn resource_import(
    state: State<'_, AppState>,
    file_name: String,
    file_data: String,
    course_id: Option<String>,
    category: Option<String>,
) -> Result<Value, String> {
    use base64::Engine;

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&file_data)
        .map_err(|e| format!("Base64 解码失败: {e}"))?;

    let kind = ldb::guess_kind_from_filename(&file_name);
    let ext = std::path::Path::new(&file_name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("bin")
        .to_lowercase();

    // 文件落盘：uploads_dir/<uuid>.<ext>
    let resource_id = uuid::Uuid::new_v4().to_string();
    let saved_name = format!("{}.{}", resource_id, ext);
    let file_path = state.uploads_dir.join(&saved_name);
    std::fs::write(&file_path, &bytes).map_err(|e| format!("保存上传文件失败: {e}"))?;
    let file_path_str = file_path.to_string_lossy().to_string();

    // EPUB 封面提取（失败则忽略）
    let mut cover_path: String = String::new();
    if matches!(kind, "epub") {
        let covers_dir = state.uploads_dir.join("covers");
        if let Some(p) = crate::epub_cover::extract_epub_cover(&bytes, &covers_dir, &resource_id) {
            cover_path = p.to_string_lossy().to_string();
        }
    }

    // 若是 parser 支持的格式，顺便建 doc_session（供 AI 抽取文本/PPTX 文本视图使用）
    let mut doc_session_id: Option<String> = None;
    let mut page_count: Option<i64> = None;
    let mut has_text = false;
    let parsable = matches!(kind, "pdf" | "docx" | "pptx" | "html");
    // EPUB / MOBI / AZW3 等流式书籍：parser 不支持文本抽取，但我们仍要建一个
    // 「空 doc_session」，让前端 AI 笔记 / 聊天能用「视野内真实文本（visibleContent）」
    // 调 LLM —— foliate 在 relocate 时会把 detail.range.toString() 透传到后端 generate_note
    // 的 page_content 参数。后端在 page_content 非空时不再查 doc_pages，外键也只到 session_id。
    // page_count 给一个充分大的 sentinel（4096）让 spine index 不会越界。
    let bookish = matches!(kind, "epub" | "mobi" | "azw3");
    if parsable {
        if let Ok(doc) = crate::parser::parse_pages(&file_name, &bytes) {
            let sid = uuid::Uuid::new_v4().to_string();
            {
                let conn = lock(&state);
                crate::db::dr_save_session(&conn, &sid, &file_name, doc.pages.len(), &file_path_str)?;
                crate::db::dr_save_pages(&conn, &sid, &doc.pages)?;
            }
            page_count = Some(doc.pages.len() as i64);
            has_text = !doc.pages.is_empty();
            doc_session_id = Some(sid);
        }
    } else if bookish {
        let sid = uuid::Uuid::new_v4().to_string();
        {
            let conn = lock(&state);
            crate::db::dr_save_session(&conn, &sid, &file_name, 4096, &file_path_str)?;
        }
        page_count = Some(0);
        has_text = false;
        doc_session_id = Some(sid);
    }

    // 写 resources（直接用 INSERT，便于复用 resource_id）
    {
        let conn = lock(&state);
        let now = chrono::Utc::now().to_rfc3339();
        conn.execute(
            "INSERT INTO resources (resource_id, kind, title, author, filename, file_path, file_size, cover_path, page_count, has_text, doc_session_id, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12)",
            rusqlite::params![
                &resource_id,
                kind,
                ldb::stem(&file_name),
                "",                                              // author 默认为空串（NOT NULL）
                &file_name,
                &file_path_str,
                bytes.len() as i64,
                &cover_path,
                page_count.unwrap_or(0),                          // NOT NULL DEFAULT 0
                if has_text { 1 } else { 0 },
                doc_session_id.as_deref().unwrap_or(""),          // NOT NULL DEFAULT ''
                &now,
            ],
        ).map_err(|e| format!("写入 resources 失败: {e}"))?;

        if let Some(cid) = course_id.as_deref() {
            ldb::course_attach_resource(
                &conn,
                cid,
                &resource_id,
                category.as_deref().unwrap_or("main"),
                0,
            )?;
        }
    }

    Ok(serde_json::json!({
        "resource_id": resource_id,
        "kind": kind,
        "file_name": file_name,
        "file_path": file_path_str,
        "file_size": bytes.len(),
        "page_count": page_count,
        "has_text": has_text,
        "doc_session_id": doc_session_id,
    }))
}
