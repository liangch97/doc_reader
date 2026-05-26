use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::path::Path;
use uuid::Uuid;

/// === Helpers ============================================================

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn new_id() -> String {
    Uuid::new_v4().to_string()
}

/// 从文件名（或路径）猜测 resource.kind
pub fn guess_kind_from_filename(filename: &str) -> &'static str {
    let lower = filename.to_lowercase();
    let ext = Path::new(&lower)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    match ext {
        "pdf" => "pdf",
        "docx" | "doc" => "docx",
        "pptx" | "ppt" => "pptx",
        "epub" => "epub",
        "mobi" => "mobi",
        "azw3" => "azw3",
        "cbz" => "cbz",
        "txt" | "md" | "markdown" => "txt",
        "html" | "htm" => "html",
        _ => "unknown",
    }
}

pub fn stem(filename: &str) -> String {
    Path::new(filename)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(filename)
        .to_string()
}

/// === Migration: doc_sessions → resources ================================
/// 幂等：仅当 resources 表中尚无对应 doc_session_id 行时插入
pub fn migrate_legacy_sessions_to_resources(conn: &Connection) -> Result<(), Box<dyn std::error::Error>> {
    let mut stmt = conn.prepare(
        "SELECT session_id, filename, file_path, page_count, created_at FROM doc_sessions",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2).unwrap_or_default(),
            r.get::<_, i64>(3).unwrap_or(0),
            r.get::<_, String>(4)?,
        ))
    })?;

    let mut inserted = 0usize;
    for row in rows {
        let (session_id, filename, file_path, page_count, created_at) = row?;
        let exists: Option<String> = conn
            .query_row(
                "SELECT resource_id FROM resources WHERE doc_session_id = ?1 LIMIT 1",
                params![session_id],
                |r| r.get(0),
            )
            .optional()?;
        if exists.is_some() {
            continue;
        }
        let resource_id = new_id();
        let kind = guess_kind_from_filename(&filename);
        let title = stem(&filename);
        conn.execute(
            "INSERT INTO resources
             (resource_id, kind, title, author, filename, file_path, file_size, cover_path,
              page_count, has_text, doc_session_id, created_at, updated_at)
             VALUES (?1, ?2, ?3, '', ?4, ?5, 0, '', ?6, 1, ?7, ?8, ?8)",
            params![resource_id, kind, title, filename, file_path, page_count, session_id, created_at],
        )?;
        inserted += 1;
    }
    if inserted > 0 {
        log::info!("migrate_legacy_sessions_to_resources: 登记 {} 条 legacy session 为 resources", inserted);
    }
    Ok(())
}

/// === Migration: 为已有 EPUB / MOBI / AZW3 资料补建空 doc_session ============
///
/// 历史：早期 import 流程对流式电子书不建 session（parser 不支持文本抽取），
/// 导致老资料 `doc_session_id = ''` → 前端 AI 笔记 / 聊天 `aiAvailable=false`。
/// 新版 `resource_import` 已修，但旧数据需要 migration 一次性补回。
///
/// 幂等：只对 `doc_session_id` 为空 / NULL 且 `kind in (epub, mobi, azw3)` 的行操作。
/// 给一个 `page_count = 4096` sentinel，spine index 不会越界；不写 `doc_pages`，
/// 后端 `doc_reader_generate_note` 在前端传入 `page_content` 时不查 `doc_pages` 表。
pub fn migrate_bookish_resources_attach_session(
    conn: &Connection,
) -> Result<(), Box<dyn std::error::Error>> {
    let mut stmt = conn.prepare(
        "SELECT resource_id, filename, file_path FROM resources
         WHERE (doc_session_id IS NULL OR doc_session_id = '')
           AND kind IN ('epub', 'mobi', 'azw3')",
    )?;
    let rows: Vec<(String, String, String)> = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2).unwrap_or_default(),
            ))
        })?
        .filter_map(|r| r.ok())
        .collect();
    drop(stmt);

    let mut attached = 0usize;
    for (resource_id, filename, file_path) in rows {
        let sid = new_id();
        crate::db::dr_save_session(conn, &sid, &filename, 4096, &file_path)
            .map_err(|e| -> Box<dyn std::error::Error> { e.into() })?;
        let now = now_iso();
        conn.execute(
            "UPDATE resources SET doc_session_id=?1, updated_at=?2 WHERE resource_id=?3",
            params![sid, now, resource_id],
        )?;
        attached += 1;
    }
    if attached > 0 {
        log::info!(
            "migrate_bookish_resources_attach_session: 为 {} 条流式电子书补建空 session",
            attached
        );
    }
    Ok(())
}

/// === resources ==========================================================

pub fn resource_create(
    conn: &Connection,
    kind: &str,
    title: &str,
    author: &str,
    filename: &str,
    file_path: &str,
    file_size: i64,
    page_count: i64,
    has_text: bool,
    doc_session_id: &str,
) -> Result<String, String> {
    let id = new_id();
    let now = now_iso();
    conn.execute(
        "INSERT INTO resources
         (resource_id, kind, title, author, filename, file_path, file_size, cover_path,
          page_count, has_text, doc_session_id, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, '', ?8, ?9, ?10, ?11, ?11)",
        params![
            id, kind, title, author, filename, file_path, file_size, page_count,
            if has_text { 1 } else { 0 }, doc_session_id, now
        ],
    )
    .map_err(|e| format!("创建资料失败: {e}"))?;
    Ok(id)
}

pub fn resource_update_meta(
    conn: &Connection,
    resource_id: &str,
    title: Option<&str>,
    author: Option<&str>,
    cover_path: Option<&str>,
) -> Result<(), String> {
    let now = now_iso();
    if let Some(t) = title {
        conn.execute(
            "UPDATE resources SET title=?1, updated_at=?2 WHERE resource_id=?3",
            params![t, now, resource_id],
        ).map_err(|e| e.to_string())?;
    }
    if let Some(a) = author {
        conn.execute(
            "UPDATE resources SET author=?1, updated_at=?2 WHERE resource_id=?3",
            params![a, now, resource_id],
        ).map_err(|e| e.to_string())?;
    }
    if let Some(c) = cover_path {
        conn.execute(
            "UPDATE resources SET cover_path=?1, updated_at=?2 WHERE resource_id=?3",
            params![c, now, resource_id],
        ).map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn resource_delete(conn: &Connection, resource_id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM resources WHERE resource_id=?1", params![resource_id])
        .map_err(|e| format!("删除资料失败: {e}"))?;
    Ok(())
}

fn row_to_resource(r: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    Ok(json!({
        "resource_id":     r.get::<_, String>(0)?,
        "kind":            r.get::<_, String>(1)?,
        "title":           r.get::<_, String>(2)?,
        "author":          r.get::<_, String>(3)?,
        "filename":        r.get::<_, String>(4)?,
        "file_path":       r.get::<_, String>(5)?,
        "file_size":       r.get::<_, i64>(6)?,
        "cover_path":      r.get::<_, String>(7)?,
        "page_count":      r.get::<_, i64>(8)?,
        "has_text":        r.get::<_, i64>(9)? != 0,
        "doc_session_id":  r.get::<_, String>(10)?,
        "created_at":      r.get::<_, String>(11)?,
        "updated_at":      r.get::<_, String>(12)?,
    }))
}

const RESOURCE_COLS: &str = "resource_id, kind, title, author, filename, file_path, file_size, cover_path, page_count, has_text, doc_session_id, created_at, updated_at";

pub fn resource_get(conn: &Connection, resource_id: &str) -> Result<Option<Value>, String> {
    let sql = format!("SELECT {} FROM resources WHERE resource_id=?1", RESOURCE_COLS);
    conn.query_row(&sql, params![resource_id], row_to_resource)
        .optional()
        .map_err(|e| e.to_string())
}

pub fn resource_list(conn: &Connection, kind: Option<&str>, limit: i64) -> Result<Vec<Value>, String> {
    let cols = RESOURCE_COLS;
    let (sql, has_kind) = match kind {
        Some(_) => (
            format!("SELECT {} FROM resources WHERE kind=?1 ORDER BY updated_at DESC LIMIT ?2", cols),
            true,
        ),
        None => (
            format!("SELECT {} FROM resources ORDER BY updated_at DESC LIMIT ?1", cols),
            false,
        ),
    };
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let mapped: Result<Vec<Value>, _> = if has_kind {
        stmt.query_map(params![kind.unwrap(), limit], row_to_resource)
            .map_err(|e| e.to_string())?
            .collect()
    } else {
        stmt.query_map(params![limit], row_to_resource)
            .map_err(|e| e.to_string())?
            .collect()
    };
    mapped.map_err(|e| e.to_string())
}

/// === courses ============================================================

pub fn course_create(
    conn: &Connection,
    name: &str,
    description: &str,
    cover_color: &str,
    cover_emoji: &str,
) -> Result<String, String> {
    let id = new_id();
    let now = now_iso();
    conn.execute(
        "INSERT INTO courses
         (course_id, name, description, cover_color, cover_emoji, notebook_id, outline_id,
          sort_order, archived, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, '', '', 0, 0, ?6, ?6)",
        params![id, name, description, cover_color, cover_emoji, now],
    )
    .map_err(|e| format!("创建课程失败: {e}"))?;
    Ok(id)
}

pub fn course_update(
    conn: &Connection,
    course_id: &str,
    name: Option<&str>,
    description: Option<&str>,
    cover_color: Option<&str>,
    cover_emoji: Option<&str>,
    notebook_id: Option<&str>,
    outline_id: Option<&str>,
    sort_order: Option<i64>,
    archived: Option<bool>,
) -> Result<(), String> {
    let now = now_iso();
    let mut sets: Vec<String> = Vec::new();
    let mut args: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
    macro_rules! push {
        ($field:literal, $val:expr) => {
            if let Some(v) = $val {
                sets.push(format!("{}=?", $field));
                args.push(Box::new(v.to_string()));
            }
        };
    }
    push!("name", name);
    push!("description", description);
    push!("cover_color", cover_color);
    push!("cover_emoji", cover_emoji);
    push!("notebook_id", notebook_id);
    push!("outline_id", outline_id);
    if let Some(v) = sort_order {
        sets.push("sort_order=?".into());
        args.push(Box::new(v));
    }
    if let Some(v) = archived {
        sets.push("archived=?".into());
        args.push(Box::new(if v { 1i64 } else { 0i64 }));
    }
    if sets.is_empty() {
        return Ok(());
    }
    sets.push("updated_at=?".into());
    args.push(Box::new(now));
    args.push(Box::new(course_id.to_string()));
    let sql = format!("UPDATE courses SET {} WHERE course_id=?", sets.join(", "));
    let refs: Vec<&dyn rusqlite::ToSql> = args.iter().map(|b| b.as_ref()).collect();
    conn.execute(&sql, refs.as_slice())
        .map_err(|e| format!("更新课程失败: {e}"))?;
    Ok(())
}

pub fn course_delete(conn: &Connection, course_id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM courses WHERE course_id=?1", params![course_id])
        .map_err(|e| format!("删除课程失败: {e}"))?;
    Ok(())
}

fn row_to_course(r: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    Ok(json!({
        "course_id":   r.get::<_, String>(0)?,
        "name":        r.get::<_, String>(1)?,
        "description": r.get::<_, String>(2)?,
        "cover_color": r.get::<_, String>(3)?,
        "cover_emoji": r.get::<_, String>(4)?,
        "notebook_id": r.get::<_, String>(5)?,
        "outline_id":  r.get::<_, String>(6)?,
        "sort_order":  r.get::<_, i64>(7)?,
        "archived":    r.get::<_, i64>(8)? != 0,
        "created_at":  r.get::<_, String>(9)?,
        "updated_at":  r.get::<_, String>(10)?,
    }))
}

const COURSE_COLS: &str = "course_id, name, description, cover_color, cover_emoji, notebook_id, outline_id, sort_order, archived, created_at, updated_at";

pub fn course_get(conn: &Connection, course_id: &str) -> Result<Option<Value>, String> {
    let sql = format!("SELECT {} FROM courses WHERE course_id=?1", COURSE_COLS);
    conn.query_row(&sql, params![course_id], row_to_course)
        .optional()
        .map_err(|e| e.to_string())
}

pub fn course_list(conn: &Connection, include_archived: bool) -> Result<Vec<Value>, String> {
    let cols = COURSE_COLS;
    let sql = if include_archived {
        format!("SELECT {} FROM courses ORDER BY sort_order, updated_at DESC", cols)
    } else {
        format!("SELECT {} FROM courses WHERE archived=0 ORDER BY sort_order, updated_at DESC", cols)
    };
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let mapped: Result<Vec<Value>, _> = stmt
        .query_map([], row_to_course)
        .map_err(|e| e.to_string())?
        .collect();
    mapped.map_err(|e| e.to_string())
}

/// === course_resources ===================================================

pub fn course_attach_resource(
    conn: &Connection,
    course_id: &str,
    resource_id: &str,
    category: &str,
    sort_order: i64,
) -> Result<(), String> {
    let now = now_iso();
    conn.execute(
        "INSERT OR REPLACE INTO course_resources
         (course_id, resource_id, category, sort_order, added_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![course_id, resource_id, category, sort_order, now],
    )
    .map_err(|e| format!("挂接资料失败: {e}"))?;
    Ok(())
}

pub fn course_detach_resource(
    conn: &Connection,
    course_id: &str,
    resource_id: &str,
) -> Result<(), String> {
    conn.execute(
        "DELETE FROM course_resources WHERE course_id=?1 AND resource_id=?2",
        params![course_id, resource_id],
    )
    .map_err(|e| format!("解除资料失败: {e}"))?;
    Ok(())
}

pub fn course_list_resources(conn: &Connection, course_id: &str) -> Result<Vec<Value>, String> {
    let sql = format!(
        "SELECT cr.category, cr.sort_order, cr.added_at, {} \
         FROM course_resources cr \
         JOIN resources r ON r.resource_id = cr.resource_id \
         WHERE cr.course_id=?1 \
         ORDER BY cr.category, cr.sort_order",
        RESOURCE_COLS.split(", ").map(|c| format!("r.{}", c)).collect::<Vec<_>>().join(", ")
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![course_id], |r| {
            let category: String = r.get(0)?;
            let sort_order: i64 = r.get(1)?;
            let added_at: String = r.get(2)?;
            // 后续 13 列对应 RESOURCE_COLS
            let resource = json!({
                "resource_id":     r.get::<_, String>(3)?,
                "kind":            r.get::<_, String>(4)?,
                "title":           r.get::<_, String>(5)?,
                "author":          r.get::<_, String>(6)?,
                "filename":        r.get::<_, String>(7)?,
                "file_path":       r.get::<_, String>(8)?,
                "file_size":       r.get::<_, i64>(9)?,
                "cover_path":      r.get::<_, String>(10)?,
                "page_count":      r.get::<_, i64>(11)?,
                "has_text":        r.get::<_, i64>(12)? != 0,
                "doc_session_id":  r.get::<_, String>(13)?,
                "created_at":      r.get::<_, String>(14)?,
                "updated_at":      r.get::<_, String>(15)?,
            });
            Ok(json!({
                "category": category,
                "sort_order": sort_order,
                "added_at": added_at,
                "resource": resource,
            }))
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

pub fn course_set_resource_category(
    conn: &Connection,
    course_id: &str,
    resource_id: &str,
    category: &str,
    sort_order: i64,
) -> Result<(), String> {
    conn.execute(
        "UPDATE course_resources SET category=?1, sort_order=?2 WHERE course_id=?3 AND resource_id=?4",
        params![category, sort_order, course_id, resource_id],
    )
    .map_err(|e| format!("更新分类失败: {e}"))?;
    Ok(())
}

/// === reading_progress ===================================================

pub fn progress_upsert(
    conn: &Connection,
    resource_id: &str,
    cfi: &str,
    page_index: i64,
    percent: f64,
    add_seconds: i64,
) -> Result<(), String> {
    let now = now_iso();
    conn.execute(
        "INSERT INTO reading_progress
         (resource_id, cfi, page_index, percent, total_reading_seconds, last_read_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(resource_id) DO UPDATE SET
            cfi=excluded.cfi,
            page_index=excluded.page_index,
            percent=excluded.percent,
            total_reading_seconds=reading_progress.total_reading_seconds + ?5,
            last_read_at=excluded.last_read_at",
        params![resource_id, cfi, page_index, percent, add_seconds, now],
    )
    .map_err(|e| format!("写入进度失败: {e}"))?;
    Ok(())
}

pub fn progress_get(conn: &Connection, resource_id: &str) -> Result<Option<Value>, String> {
    conn.query_row(
        "SELECT cfi, page_index, percent, total_reading_seconds, last_read_at
         FROM reading_progress WHERE resource_id=?1",
        params![resource_id],
        |r| {
            Ok(json!({
                "resource_id": resource_id,
                "cfi": r.get::<_, String>(0)?,
                "page_index": r.get::<_, i64>(1)?,
                "percent": r.get::<_, f64>(2)?,
                "total_reading_seconds": r.get::<_, i64>(3)?,
                "last_read_at": r.get::<_, String>(4)?,
            }))
        },
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// === annotations ========================================================

pub fn annotation_create(
    conn: &Connection,
    resource_id: &str,
    kind: &str,
    color: &str,
    cfi_start: &str,
    cfi_end: &str,
    page_index: i64,
    text_offset_start: i64,
    text_offset_end: i64,
    selected_text: &str,
    note_content: &str,
    // PDF 批注专用：页面归一化矩形 JSON 字符串（`[{"x":..,"y":..,"w":..,"h":..}, ...]`）。
    // 为空字符串表示非 PDF 批注（cfi_* 走原有逻辑）。
    pdf_rects: &str,
) -> Result<String, String> {
    let id = new_id();
    let now = now_iso();
    conn.execute(
        "INSERT INTO annotations
         (annotation_id, resource_id, kind, color, cfi_start, cfi_end, page_index,
          text_offset_start, text_offset_end, selected_text, note_content, pdf_rects, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13)",
        params![
            id, resource_id, kind, color, cfi_start, cfi_end, page_index,
            text_offset_start, text_offset_end, selected_text, note_content, pdf_rects, now
        ],
    )
    .map_err(|e| format!("创建批注失败: {e}"))?;
    Ok(id)
}

pub fn annotation_update(
    conn: &Connection,
    annotation_id: &str,
    color: Option<&str>,
    note_content: Option<&str>,
) -> Result<(), String> {
    let now = now_iso();
    if let Some(c) = color {
        conn.execute(
            "UPDATE annotations SET color=?1, updated_at=?2 WHERE annotation_id=?3",
            params![c, now, annotation_id],
        ).map_err(|e| e.to_string())?;
    }
    if let Some(n) = note_content {
        conn.execute(
            "UPDATE annotations SET note_content=?1, updated_at=?2 WHERE annotation_id=?3",
            params![n, now, annotation_id],
        ).map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn annotation_delete(conn: &Connection, annotation_id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM annotations WHERE annotation_id=?1", params![annotation_id])
        .map_err(|e| format!("删除批注失败: {e}"))?;
    Ok(())
}

pub fn annotation_list(conn: &Connection, resource_id: &str) -> Result<Vec<Value>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT annotation_id, kind, color, cfi_start, cfi_end, page_index,
                    text_offset_start, text_offset_end, selected_text, note_content,
                    COALESCE(pdf_rects, '') as pdf_rects,
                    created_at, updated_at
             FROM annotations WHERE resource_id=?1
             ORDER BY page_index, created_at",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![resource_id], |r| {
            Ok(json!({
                "annotation_id":     r.get::<_, String>(0)?,
                "resource_id":       resource_id,
                "kind":              r.get::<_, String>(1)?,
                "color":             r.get::<_, String>(2)?,
                "cfi_start":         r.get::<_, String>(3)?,
                "cfi_end":           r.get::<_, String>(4)?,
                "page_index":        r.get::<_, i64>(5)?,
                "text_offset_start": r.get::<_, i64>(6)?,
                "text_offset_end":   r.get::<_, i64>(7)?,
                "selected_text":     r.get::<_, String>(8)?,
                "note_content":      r.get::<_, String>(9)?,
                "pdf_rects":         r.get::<_, String>(10)?,
                "created_at":        r.get::<_, String>(11)?,
                "updated_at":        r.get::<_, String>(12)?,
            }))
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// === bookmarks ==========================================================

pub fn bookmark_create(
    conn: &Connection,
    resource_id: &str,
    cfi: &str,
    page_index: i64,
    label: &str,
) -> Result<String, String> {
    let id = new_id();
    let now = now_iso();
    conn.execute(
        "INSERT INTO bookmarks (bookmark_id, resource_id, cfi, page_index, label, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![id, resource_id, cfi, page_index, label, now],
    )
    .map_err(|e| format!("创建书签失败: {e}"))?;
    Ok(id)
}

pub fn bookmark_delete(conn: &Connection, bookmark_id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM bookmarks WHERE bookmark_id=?1", params![bookmark_id])
        .map_err(|e| format!("删除书签失败: {e}"))?;
    Ok(())
}

pub fn bookmark_list(conn: &Connection, resource_id: &str) -> Result<Vec<Value>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT bookmark_id, cfi, page_index, label, created_at
             FROM bookmarks WHERE resource_id=?1 ORDER BY page_index, created_at",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![resource_id], |r| {
            Ok(json!({
                "bookmark_id":  r.get::<_, String>(0)?,
                "resource_id":  resource_id,
                "cfi":          r.get::<_, String>(1)?,
                "page_index":   r.get::<_, i64>(2)?,
                "label":        r.get::<_, String>(3)?,
                "created_at":   r.get::<_, String>(4)?,
            }))
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}
