use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager};

#[derive(Clone)]
pub struct AppState {
    /// 数据库连接
    pub db: Arc<Mutex<Connection>>,
    /// 模型配置文件路径 (llm_models.json)
    pub config_path: PathBuf,
    /// 上传文件存储目录
    pub uploads_dir: PathBuf,
}

pub fn init_db(app_handle: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let app_dir = app_handle
        .path()
        .app_data_dir()
        .expect("failed to get app data dir");
    std::fs::create_dir_all(&app_dir)?;
    let db_path = app_dir.join("doc_reader.db");

    let conn = Connection::open(&db_path)?;
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")?;

    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS doc_sessions (
            session_id TEXT PRIMARY KEY,
            filename TEXT NOT NULL,
            page_count INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_doc_sessions_created ON doc_sessions (created_at DESC);

        CREATE TABLE IF NOT EXISTS doc_pages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            page_index INTEGER NOT NULL,
            content TEXT NOT NULL,
            word_count INTEGER NOT NULL DEFAULT 0,
            FOREIGN KEY (session_id) REFERENCES doc_sessions(session_id) ON DELETE CASCADE,
            UNIQUE (session_id, page_index)
        );

        CREATE TABLE IF NOT EXISTS doc_page_notes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            page_index INTEGER NOT NULL,
            content TEXT NOT NULL,
            source TEXT NOT NULL DEFAULT 'ai',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY (session_id) REFERENCES doc_sessions(session_id) ON DELETE CASCADE,
            UNIQUE (session_id, page_index)
        );

        CREATE TABLE IF NOT EXISTS notebooks (
            notebook_id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            color TEXT NOT NULL DEFAULT '#7C5CFC',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_notebooks_updated ON notebooks (updated_at DESC);

        CREATE TABLE IF NOT EXISTS notebook_entries (
            entry_id TEXT PRIMARY KEY,
            notebook_id TEXT NOT NULL,
            title TEXT NOT NULL DEFAULT '',
            content TEXT NOT NULL,
            entry_type TEXT NOT NULL DEFAULT 'note',
            source_info TEXT NOT NULL DEFAULT '',
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY (notebook_id) REFERENCES notebooks(notebook_id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_nb_entries_notebook ON notebook_entries (notebook_id, sort_order);",
    )?;

    // 迁移: 添加 file_path 列
    let _ = conn.execute("ALTER TABLE doc_sessions ADD COLUMN file_path TEXT NOT NULL DEFAULT ''", []);

    let config_path = app_dir.join("llm_models.json");
    let uploads_dir = app_dir.join("uploads");
    std::fs::create_dir_all(&uploads_dir).ok();
    log::info!("Database initialized at {:?}", db_path);
    log::info!("模型配置文件路径: {:?}", config_path);
    log::info!("上传文件目录: {:?}", uploads_dir);
    app_handle.manage(AppState {
        db: Arc::new(Mutex::new(conn)),
        config_path,
        uploads_dir,
    });
    Ok(())
}

// ══════════════════════════════════════════════════════════════════════════════
// Doc Reader CRUD
// ══════════════════════════════════════════════════════════════════════════════

/// 创建阅读会话
pub fn dr_save_session(
    conn: &Connection,
    session_id: &str,
    filename: &str,
    page_count: usize,
    file_path: &str,
) -> Result<(), String> {
    let now = chrono::Local::now().to_rfc3339();
    conn.execute(
        "INSERT INTO doc_sessions (session_id, filename, page_count, created_at, file_path)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![session_id, filename, page_count as i64, now, file_path],
    )
    .map_err(|e| format!("保存阅读会话失败: {e}"))?;
    Ok(())
}

/// 批量保存页面内容
pub fn dr_save_pages(
    conn: &Connection,
    session_id: &str,
    pages: &[crate::parser::ParsedPage],
) -> Result<(), String> {
    let mut stmt = conn
        .prepare(
            "INSERT INTO doc_pages (session_id, page_index, content, word_count)
             VALUES (?1, ?2, ?3, ?4)",
        )
        .map_err(|e| format!("准备插入页面语句失败: {e}"))?;
    for page in pages {
        stmt.execute(params![
            session_id,
            page.page_index as i64,
            page.content,
            page.word_count as i64,
        ])
        .map_err(|e| format!("保存页面 {} 失败: {e}", page.page_index))?;
    }
    Ok(())
}

/// 获取会话信息
pub fn dr_get_session(conn: &Connection, session_id: &str) -> Result<Value, String> {
    let mut stmt = conn
        .prepare(
            "SELECT session_id, filename, page_count, created_at, COALESCE(file_path, '') as file_path
             FROM doc_sessions WHERE session_id = ?1",
        )
        .map_err(|e| format!("查询会话失败: {e}"))?;
    let row = stmt
        .query_row(params![session_id], |r| {
            Ok(json!({
                "session_id": r.get::<_, String>(0)?,
                "filename": r.get::<_, String>(1)?,
                "page_count": r.get::<_, i64>(2)?,
                "created_at": r.get::<_, String>(3)?,
                "file_path": r.get::<_, String>(4)?,
            }))
        })
        .map_err(|e| format!("会话不存在: {e}"))?;
    Ok(row)
}

/// 获取单页内容
pub fn dr_get_page(conn: &Connection, session_id: &str, page_index: usize) -> Result<Value, String> {
    let mut stmt = conn
        .prepare(
            "SELECT page_index, content, word_count FROM doc_pages
             WHERE session_id = ?1 AND page_index = ?2",
        )
        .map_err(|e| format!("查询页面失败: {e}"))?;
    let row = stmt
        .query_row(params![session_id, page_index as i64], |r| {
            Ok(json!({
                "page_index": r.get::<_, i64>(0)?,
                "content": r.get::<_, String>(1)?,
                "word_count": r.get::<_, i64>(2)?,
            }))
        })
        .map_err(|e| format!("页面不存在: {e}"))?;
    Ok(row)
}

/// 获取所有页面摘要（不含完整内容，用于缩略图列表）
pub fn dr_get_pages_summary(conn: &Connection, session_id: &str) -> Result<Vec<Value>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT p.page_index, p.word_count,
                    CASE WHEN n.id IS NOT NULL THEN 1 ELSE 0 END as has_note
             FROM doc_pages p
             LEFT JOIN doc_page_notes n ON p.session_id = n.session_id AND p.page_index = n.page_index
             WHERE p.session_id = ?1
             ORDER BY p.page_index",
        )
        .map_err(|e| format!("查询页面列表失败: {e}"))?;
    let rows = stmt
        .query_map(params![session_id], |r| {
            Ok(json!({
                "page_index": r.get::<_, i64>(0)?,
                "word_count": r.get::<_, i64>(1)?,
                "has_note": r.get::<_, i64>(2)? == 1,
            }))
        })
        .map_err(|e| format!("遍历页面失败: {e}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("收集页面失败: {e}"))
}

/// 保存/更新页面笔记
pub fn dr_save_note(
    conn: &Connection,
    session_id: &str,
    page_index: usize,
    content: &str,
    source: &str,
) -> Result<(), String> {
    let now = chrono::Local::now().to_rfc3339();
    conn.execute(
        "INSERT INTO doc_page_notes (session_id, page_index, content, source, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5)
         ON CONFLICT(session_id, page_index) DO UPDATE SET
            content = excluded.content,
            source = excluded.source,
            updated_at = excluded.updated_at",
        params![session_id, page_index as i64, content, source, now],
    )
    .map_err(|e| format!("保存页面笔记失败: {e}"))?;
    Ok(())
}

/// 获取单页笔记
pub fn dr_get_note(conn: &Connection, session_id: &str, page_index: usize) -> Result<Option<Value>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT page_index, content, source, created_at, updated_at
             FROM doc_page_notes WHERE session_id = ?1 AND page_index = ?2",
        )
        .map_err(|e| format!("查询笔记失败: {e}"))?;
    let result = stmt.query_row(params![session_id, page_index as i64], |r| {
        Ok(json!({
            "page_index": r.get::<_, i64>(0)?,
            "content": r.get::<_, String>(1)?,
            "source": r.get::<_, String>(2)?,
            "created_at": r.get::<_, String>(3)?,
            "updated_at": r.get::<_, String>(4)?,
        }))
    });
    match result {
        Ok(v) => Ok(Some(v)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(format!("查询笔记失败: {e}")),
    }
}

/// 获取会话所有笔记
pub fn dr_get_all_notes(conn: &Connection, session_id: &str) -> Result<Vec<Value>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT page_index, content, source, created_at, updated_at
             FROM doc_page_notes WHERE session_id = ?1 ORDER BY page_index",
        )
        .map_err(|e| format!("查询笔记列表失败: {e}"))?;
    let rows = stmt
        .query_map(params![session_id], |r| {
            Ok(json!({
                "page_index": r.get::<_, i64>(0)?,
                "content": r.get::<_, String>(1)?,
                "source": r.get::<_, String>(2)?,
                "created_at": r.get::<_, String>(3)?,
                "updated_at": r.get::<_, String>(4)?,
            }))
        })
        .map_err(|e| format!("遍历笔记失败: {e}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("收集笔记失败: {e}"))
}

/// 删除单页笔记
pub fn dr_delete_note(conn: &Connection, session_id: &str, page_index: usize) -> Result<(), String> {
    conn.execute(
        "DELETE FROM doc_page_notes WHERE session_id = ?1 AND page_index = ?2",
        params![session_id, page_index as i64],
    )
    .map_err(|e| format!("删除笔记失败: {e}"))?;
    Ok(())
}

/// 删除整个阅读会话（级联删除页面和笔记）
pub fn dr_delete_session(conn: &Connection, session_id: &str) -> Result<(), String> {
    conn.execute(
        "DELETE FROM doc_sessions WHERE session_id = ?1",
        params![session_id],
    )
    .map_err(|e| format!("删除会话失败: {e}"))?;
    Ok(())
}

/// 获取最近的阅读会话列表（含笔记数量）
pub fn dr_list_sessions(conn: &Connection, limit: usize) -> Result<Vec<Value>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT s.session_id, s.filename, s.page_count, s.created_at,
                    (SELECT COUNT(*) FROM doc_page_notes n WHERE n.session_id = s.session_id) as note_count
             FROM doc_sessions s
             ORDER BY s.created_at DESC
             LIMIT ?1",
        )
        .map_err(|e| format!("查询会话列表失败: {e}"))?;
    let rows = stmt
        .query_map(params![limit as i64], |r| {
            Ok(json!({
                "session_id": r.get::<_, String>(0)?,
                "filename": r.get::<_, String>(1)?,
                "page_count": r.get::<_, i64>(2)?,
                "created_at": r.get::<_, String>(3)?,
                "note_count": r.get::<_, i64>(4)?,
            }))
        })
        .map_err(|e| format!("遍历会话失败: {e}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("收集会话失败: {e}"))
}

// ══════════════════════════════════════════════════════════════════════════════
// Notebook CRUD
// ══════════════════════════════════════════════════════════════════════════════

/// 创建笔记本
pub fn nb_create(
    conn: &Connection,
    notebook_id: &str,
    name: &str,
    description: &str,
    color: &str,
) -> Result<(), String> {
    let now = chrono::Local::now().to_rfc3339();
    conn.execute(
        "INSERT INTO notebooks (notebook_id, name, description, color, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
        params![notebook_id, name, description, color, now],
    )
    .map_err(|e| format!("创建笔记本失败: {e}"))?;
    Ok(())
}

/// 获取所有笔记本列表
pub fn nb_list(conn: &Connection) -> Result<Vec<Value>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT n.notebook_id, n.name, n.description, n.color, n.created_at, n.updated_at,
                    (SELECT COUNT(*) FROM notebook_entries e WHERE e.notebook_id = n.notebook_id) as entry_count
             FROM notebooks n
             ORDER BY n.updated_at DESC",
        )
        .map_err(|e| format!("查询笔记本列表失败: {e}"))?;
    let rows = stmt
        .query_map([], |r| {
            Ok(json!({
                "notebook_id": r.get::<_, String>(0)?,
                "name": r.get::<_, String>(1)?,
                "description": r.get::<_, String>(2)?,
                "color": r.get::<_, String>(3)?,
                "created_at": r.get::<_, String>(4)?,
                "updated_at": r.get::<_, String>(5)?,
                "entry_count": r.get::<_, i64>(6)?,
            }))
        })
        .map_err(|e| format!("遍历笔记本失败: {e}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("收集笔记本失败: {e}"))
}

/// 获取单个笔记本详情（含条目列表）
pub fn nb_get(conn: &Connection, notebook_id: &str) -> Result<Value, String> {
    let mut stmt = conn
        .prepare(
            "SELECT notebook_id, name, description, color, created_at, updated_at
             FROM notebooks WHERE notebook_id = ?1",
        )
        .map_err(|e| format!("查询笔记本失败: {e}"))?;
    let notebook = stmt
        .query_row(params![notebook_id], |r| {
            Ok(json!({
                "notebook_id": r.get::<_, String>(0)?,
                "name": r.get::<_, String>(1)?,
                "description": r.get::<_, String>(2)?,
                "color": r.get::<_, String>(3)?,
                "created_at": r.get::<_, String>(4)?,
                "updated_at": r.get::<_, String>(5)?,
            }))
        })
        .map_err(|e| format!("笔记本不存在: {e}"))?;

    let entries = nb_list_entries(conn, notebook_id)?;

    Ok(json!({
        "notebook": notebook,
        "entries": entries,
    }))
}

/// 更新笔记本名称/描述
pub fn nb_update(
    conn: &Connection,
    notebook_id: &str,
    name: &str,
    description: &str,
    color: &str,
) -> Result<(), String> {
    let now = chrono::Local::now().to_rfc3339();
    conn.execute(
        "UPDATE notebooks SET name = ?2, description = ?3, color = ?4, updated_at = ?5
         WHERE notebook_id = ?1",
        params![notebook_id, name, description, color, now],
    )
    .map_err(|e| format!("更新笔记本失败: {e}"))?;
    Ok(())
}

/// 删除笔记本（级联删除所有条目）
pub fn nb_delete(conn: &Connection, notebook_id: &str) -> Result<(), String> {
    conn.execute(
        "DELETE FROM notebooks WHERE notebook_id = ?1",
        params![notebook_id],
    )
    .map_err(|e| format!("删除笔记本失败: {e}"))?;
    Ok(())
}

/// 添加笔记本条目
pub fn nb_add_entry(
    conn: &Connection,
    entry_id: &str,
    notebook_id: &str,
    title: &str,
    content: &str,
    entry_type: &str,
    source_info: &str,
) -> Result<(), String> {
    let now = chrono::Local::now().to_rfc3339();
    // sort_order = 当前最大值 + 1
    let max_order: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(sort_order), -1) FROM notebook_entries WHERE notebook_id = ?1",
            params![notebook_id],
            |r| r.get(0),
        )
        .unwrap_or(-1);
    conn.execute(
        "INSERT INTO notebook_entries (entry_id, notebook_id, title, content, entry_type, source_info, sort_order, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
        params![entry_id, notebook_id, title, content, entry_type, source_info, max_order + 1, now],
    )
    .map_err(|e| format!("添加笔记条目失败: {e}"))?;
    // 更新笔记本时间戳
    conn.execute(
        "UPDATE notebooks SET updated_at = ?2 WHERE notebook_id = ?1",
        params![notebook_id, now],
    )
    .map_err(|e| format!("更新笔记本时间戳失败: {e}"))?;
    Ok(())
}

/// 更新笔记本条目
pub fn nb_update_entry(
    conn: &Connection,
    entry_id: &str,
    title: &str,
    content: &str,
) -> Result<(), String> {
    let now = chrono::Local::now().to_rfc3339();
    conn.execute(
        "UPDATE notebook_entries SET title = ?2, content = ?3, updated_at = ?4
         WHERE entry_id = ?1",
        params![entry_id, title, content, now],
    )
    .map_err(|e| format!("更新笔记条目失败: {e}"))?;
    Ok(())
}

/// 删除笔记本条目
pub fn nb_delete_entry(conn: &Connection, entry_id: &str) -> Result<(), String> {
    conn.execute(
        "DELETE FROM notebook_entries WHERE entry_id = ?1",
        params![entry_id],
    )
    .map_err(|e| format!("删除笔记条目失败: {e}"))?;
    Ok(())
}

/// 获取笔记本所有条目
pub fn nb_list_entries(conn: &Connection, notebook_id: &str) -> Result<Vec<Value>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT entry_id, notebook_id, title, content, entry_type, source_info, sort_order, created_at, updated_at
             FROM notebook_entries WHERE notebook_id = ?1 ORDER BY sort_order",
        )
        .map_err(|e| format!("查询笔记条目失败: {e}"))?;
    let rows = stmt
        .query_map(params![notebook_id], |r| {
            Ok(json!({
                "entry_id": r.get::<_, String>(0)?,
                "notebook_id": r.get::<_, String>(1)?,
                "title": r.get::<_, String>(2)?,
                "content": r.get::<_, String>(3)?,
                "entry_type": r.get::<_, String>(4)?,
                "source_info": r.get::<_, String>(5)?,
                "sort_order": r.get::<_, i64>(6)?,
                "created_at": r.get::<_, String>(7)?,
                "updated_at": r.get::<_, String>(8)?,
            }))
        })
        .map_err(|e| format!("遍历笔记条目失败: {e}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("收集笔记条目失败: {e}"))
}

/// 获取单个笔记条目
pub fn nb_get_entry(conn: &Connection, entry_id: &str) -> Result<Value, String> {
    let mut stmt = conn
        .prepare(
            "SELECT entry_id, notebook_id, title, content, entry_type, source_info, sort_order, created_at, updated_at
             FROM notebook_entries WHERE entry_id = ?1",
        )
        .map_err(|e| format!("查询笔记条目失败: {e}"))?;
    let row = stmt
        .query_row(params![entry_id], |r| {
            Ok(json!({
                "entry_id": r.get::<_, String>(0)?,
                "notebook_id": r.get::<_, String>(1)?,
                "title": r.get::<_, String>(2)?,
                "content": r.get::<_, String>(3)?,
                "entry_type": r.get::<_, String>(4)?,
                "source_info": r.get::<_, String>(5)?,
                "sort_order": r.get::<_, i64>(6)?,
                "created_at": r.get::<_, String>(7)?,
                "updated_at": r.get::<_, String>(8)?,
            }))
        })
        .map_err(|e| format!("笔记条目不存在: {e}"))?;
    Ok(row)
}
