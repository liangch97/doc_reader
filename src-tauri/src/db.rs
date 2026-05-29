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
    /// 应用偏好文件路径 (app_prefs.json) — 通用 KV 持久化
    pub prefs_path: PathBuf,
}

/// 幂等地给老表加列：SQLite 不支持 `ADD COLUMN IF NOT EXISTS`，用 PRAGMA
/// table_info 检测后再 ALTER。`ddl` 形如 `"TEXT NOT NULL DEFAULT ''"`。
fn ensure_column_exists(
    conn: &Connection,
    table: &str,
    column: &str,
    ddl: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({})", table))?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(1))?;
    let exists = rows.flatten().any(|name| name == column);
    drop(stmt);
    if !exists {
        conn.execute(
            &format!("ALTER TABLE {} ADD COLUMN {} {}", table, column, ddl),
            [],
        )?;
    }
    Ok(())
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

    // 迁移: notebook_entries 新增结构化锚点 / 父子关系 / section 角色 / 嵌入式聊天历史
    // 这些 ALTER 对已存在列会返回错误，忽略即可（幂等）
    let _ = conn.execute("ALTER TABLE notebook_entries ADD COLUMN source_session_id TEXT NOT NULL DEFAULT ''", []);
    let _ = conn.execute("ALTER TABLE notebook_entries ADD COLUMN source_page_start INTEGER", []);
    let _ = conn.execute("ALTER TABLE notebook_entries ADD COLUMN source_page_end INTEGER", []);
    let _ = conn.execute("ALTER TABLE notebook_entries ADD COLUMN source_page_indexes TEXT NOT NULL DEFAULT ''", []);
    let _ = conn.execute("ALTER TABLE notebook_entries ADD COLUMN source_kind TEXT NOT NULL DEFAULT ''", []);
    let _ = conn.execute("ALTER TABLE notebook_entries ADD COLUMN parent_entry_id TEXT NOT NULL DEFAULT ''", []);
    let _ = conn.execute("ALTER TABLE notebook_entries ADD COLUMN section_role TEXT NOT NULL DEFAULT 'root_note'", []);
    let _ = conn.execute("ALTER TABLE notebook_entries ADD COLUMN chat_history_json TEXT NOT NULL DEFAULT ''", []);
    let _ = conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_nb_entries_anchor
         ON notebook_entries (notebook_id, source_session_id, source_page_start)",
        [],
    );

    // === 学习路径派生字段（Learning Outline v1）===
    // zone_id: 所属知识区 id（由 outline 规划），空表示未分区
    // zone_order: 所在 zone 内的学习顺序（0 起）
    // entry_order: 笔记本范围内的学习全局序号（跨 zone，0 起）
    // learning_role: foundation / mechanism / comparison / misconception / application / example / recap
    // difficulty: 1..5
    // meta_json: 每条 entry 的 LLM 抽取元信息（summary/keypoints/topics/prerequisites_hint 等）
    let _ = conn.execute("ALTER TABLE notebook_entries ADD COLUMN zone_id TEXT NOT NULL DEFAULT ''", []);
    let _ = conn.execute("ALTER TABLE notebook_entries ADD COLUMN zone_order INTEGER NOT NULL DEFAULT 0", []);
    let _ = conn.execute("ALTER TABLE notebook_entries ADD COLUMN entry_order INTEGER NOT NULL DEFAULT 0", []);
    let _ = conn.execute("ALTER TABLE notebook_entries ADD COLUMN learning_role TEXT NOT NULL DEFAULT ''", []);
    let _ = conn.execute("ALTER TABLE notebook_entries ADD COLUMN difficulty INTEGER NOT NULL DEFAULT 0", []);
    let _ = conn.execute("ALTER TABLE notebook_entries ADD COLUMN meta_json TEXT NOT NULL DEFAULT ''", []);
    let _ = conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_nb_entries_learning
         ON notebook_entries (notebook_id, entry_order)",
        [],
    );

    // === 笔记本附加元信息（v3）===
    let _ = conn.execute("ALTER TABLE notebooks ADD COLUMN teacher TEXT NOT NULL DEFAULT ''", []);

    // === 笔记本学习大纲表 ===
    // outline_json 包含：thesis / learning_path / zones / entry_order / links / recap_questions
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS notebook_outlines (
            notebook_id TEXT PRIMARY KEY,
            outline_json TEXT NOT NULL,
            version INTEGER NOT NULL DEFAULT 1,
            updated_at TEXT NOT NULL,
            FOREIGN KEY (notebook_id) REFERENCES notebooks(notebook_id) ON DELETE CASCADE
        );",
    )?;

    // ════════════════════════════════════════════════════════════════
    // v2 (DESIGN.md §6) — 课程 / 资料 / 进度 / 批注 / 书签
    // ════════════════════════════════════════════════════════════════
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS courses (
            course_id     TEXT PRIMARY KEY,
            name          TEXT NOT NULL,
            description   TEXT NOT NULL DEFAULT '',
            cover_color   TEXT NOT NULL DEFAULT '#7C5CFC',
            cover_emoji   TEXT NOT NULL DEFAULT '📚',
            notebook_id   TEXT NOT NULL DEFAULT '',
            outline_id    TEXT NOT NULL DEFAULT '',
            sort_order    INTEGER NOT NULL DEFAULT 0,
            archived      INTEGER NOT NULL DEFAULT 0,
            created_at    TEXT NOT NULL,
            updated_at    TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_courses_updated ON courses (updated_at DESC);

        CREATE TABLE IF NOT EXISTS resources (
            resource_id     TEXT PRIMARY KEY,
            kind            TEXT NOT NULL,
            title           TEXT NOT NULL,
            author          TEXT NOT NULL DEFAULT '',
            filename        TEXT NOT NULL,
            file_path       TEXT NOT NULL,
            file_size       INTEGER NOT NULL DEFAULT 0,
            cover_path      TEXT NOT NULL DEFAULT '',
            page_count      INTEGER NOT NULL DEFAULT 0,
            has_text        INTEGER NOT NULL DEFAULT 0,
            doc_session_id  TEXT NOT NULL DEFAULT '',
            created_at      TEXT NOT NULL,
            updated_at      TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_resources_kind ON resources (kind);
        CREATE INDEX IF NOT EXISTS idx_resources_updated ON resources (updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_resources_session ON resources (doc_session_id);

        CREATE TABLE IF NOT EXISTS course_resources (
            course_id    TEXT NOT NULL,
            resource_id  TEXT NOT NULL,
            category     TEXT NOT NULL DEFAULT 'main',
            sort_order   INTEGER NOT NULL DEFAULT 0,
            added_at     TEXT NOT NULL,
            PRIMARY KEY (course_id, resource_id),
            FOREIGN KEY (course_id) REFERENCES courses(course_id) ON DELETE CASCADE,
            FOREIGN KEY (resource_id) REFERENCES resources(resource_id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_cr_course ON course_resources (course_id, sort_order);
        CREATE INDEX IF NOT EXISTS idx_cr_resource ON course_resources (resource_id);

        CREATE TABLE IF NOT EXISTS reading_progress (
            resource_id            TEXT PRIMARY KEY,
            cfi                    TEXT NOT NULL DEFAULT '',
            page_index             INTEGER NOT NULL DEFAULT 0,
            percent                REAL NOT NULL DEFAULT 0,
            total_reading_seconds  INTEGER NOT NULL DEFAULT 0,
            last_read_at           TEXT NOT NULL,
            FOREIGN KEY (resource_id) REFERENCES resources(resource_id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS annotations (
            annotation_id      TEXT PRIMARY KEY,
            resource_id        TEXT NOT NULL,
            kind               TEXT NOT NULL,
            color              TEXT NOT NULL DEFAULT 'yellow',
            cfi_start          TEXT NOT NULL DEFAULT '',
            cfi_end            TEXT NOT NULL DEFAULT '',
            page_index         INTEGER NOT NULL DEFAULT -1,
            text_offset_start  INTEGER NOT NULL DEFAULT -1,
            text_offset_end    INTEGER NOT NULL DEFAULT -1,
            selected_text      TEXT NOT NULL,
            note_content       TEXT NOT NULL DEFAULT '',
            created_at         TEXT NOT NULL,
            updated_at         TEXT NOT NULL,
            FOREIGN KEY (resource_id) REFERENCES resources(resource_id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_annotations_resource ON annotations (resource_id, page_index);

        CREATE TABLE IF NOT EXISTS bookmarks (
            bookmark_id   TEXT PRIMARY KEY,
            resource_id   TEXT NOT NULL,
            cfi           TEXT NOT NULL DEFAULT '',
            page_index    INTEGER NOT NULL DEFAULT -1,
            label         TEXT NOT NULL DEFAULT '',
            created_at    TEXT NOT NULL,
            FOREIGN KEY (resource_id) REFERENCES resources(resource_id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_bookmarks_resource ON bookmarks (resource_id);",
    )?;

    // === 把已有的 doc_sessions 自动登记为 resources（幂等迁移）===
    crate::library_db::migrate_legacy_sessions_to_resources(&conn)?;

    // === 老 EPUB/MOBI/AZW3 资料补建空 doc_session（幂等迁移）===
    // 解锁这些资料的 AI 笔记 / 聊天功能；新导入流程已自动处理。
    crate::library_db::migrate_bookish_resources_attach_session(&conn)?;

    // === annotations 表 PDF 批注扩展：pdf_rects 字段（幂等）===
    // 用归一化（0..1 相对页面尺寸）的矩形数组 JSON 存储 PDF selection 覆盖框，
    // 解锁 PDF 高亮、AI 批注的持久化；EPUB 仍走 cfi_* 字段不受影响。
    ensure_column_exists(&conn, "annotations", "pdf_rects", "TEXT NOT NULL DEFAULT ''")?;

    // === Migration: 修复 teach_pack.extra_questions 重复 qE id（幂等）===
    // 历史 bug：早期 prompt 让 LLM 每次"再来 N 道"都从 qE1 开始编号 → DB 里
    // 同一 k_idx 下出现重复 id → 前端按 id 去重砍掉重复 → 用户感知"题目丢失"。
    // 启动时扫描修复，仅对真正存在重复的 unit 写回（首次清理后再启动 noop）。
    if let Err(e) = migrate_dedupe_extra_quiz_ids(&conn) {
        log::warn!("migrate_dedupe_extra_quiz_ids 失败: {}", e);
    }

    // v4 (2026-05) 学习 ↔ 笔记深度绑定：agent_unit_states 加 notebook_entry_id 字段
    // 每个学习单元在生成讲解后自动 upsert 一个 notebook entry（source_kind='agent_unit'），
    // 前端可以编辑该 entry，编辑写回 teach_pack.explanation 实现双向同步。
    let _ = conn.execute(
        "ALTER TABLE agent_unit_states ADD COLUMN notebook_entry_id TEXT NOT NULL DEFAULT ''",
        [],
    );

    // v10 (2026-05) 学习流断点续传：agent_unit_states 加 partial_explanation 字段
    // 流式讲解过程中（agent_teach_unit_stream / agent_prefetch_unit）每隔约 1s
    // 把当前累积的 raw markdown 写到这一列；流自然结束（done）会清空，流意外
    // 失败（网络中断 / app 崩溃）时该列保留最后一次落盘的内容。
    //
    // 前端首次加载 / 刷新后通过 agent_get_state 看到 partial_explanation 非空 +
    // current_phase=teaching/idle 即识别为「中断态」，给用户一个「继续生成」按钮。
    // 调用 agent_teach_unit_stream(resume=true) 时后端把 partial 注入 LLM 的
    // assistant turn，让模型从断点接着续写。
    ensure_column_exists(
        &conn,
        "agent_unit_states",
        "partial_explanation",
        "TEXT NOT NULL DEFAULT ''",
    )?;

    // ════════════════════════════════════════════════════════════════════════
    // RAG 知识库：每本书一个本地向量索引
    // ════════════════════════════════════════════════════════════════════════
    // - rag_chunks    每本书切块后的文本 + 向量（BLOB，小端 f32 序列）
    // - rag_meta      索引级元信息（总块数 / 模型 / 维度 / 完成时间）
    //
    // 设计要点：
    //   * 完全本地，不依赖 sqlite-vec 等扩展（rusqlite bundled 没带）；
    //     召回时全表扫描算 cosine，几千块级别 < 50ms，够用。
    //   * 跟 doc_sessions 级联删除，资料删了向量自动清。
    //   * `embedding` 列是 BLOB 而不是 JSON 数组，内存/磁盘 4× 小、解析快。
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS rag_chunks (
            chunk_id      TEXT PRIMARY KEY,
            session_id    TEXT NOT NULL,
            chunk_index   INTEGER NOT NULL,
            page_start    INTEGER NOT NULL,
            page_end      INTEGER NOT NULL,
            text          TEXT NOT NULL,
            token_count   INTEGER NOT NULL DEFAULT 0,
            embedding     BLOB NOT NULL,
            model         TEXT NOT NULL DEFAULT '',
            created_at    TEXT NOT NULL,
            FOREIGN KEY (session_id) REFERENCES doc_sessions(session_id) ON DELETE CASCADE,
            UNIQUE (session_id, chunk_index)
        );
        CREATE INDEX IF NOT EXISTS idx_rag_chunks_session ON rag_chunks (session_id);

        CREATE TABLE IF NOT EXISTS rag_meta (
            session_id    TEXT PRIMARY KEY,
            status        TEXT NOT NULL DEFAULT 'pending',
            chunk_count   INTEGER NOT NULL DEFAULT 0,
            model         TEXT NOT NULL DEFAULT '',
            dim           INTEGER NOT NULL DEFAULT 0,
            error         TEXT NOT NULL DEFAULT '',
            updated_at    TEXT NOT NULL,
            FOREIGN KEY (session_id) REFERENCES doc_sessions(session_id) ON DELETE CASCADE
        );",
    )?;

    // ════════════════════════════════════════════════════════════════════════
    // 知识点（Knowledge Point）：基于 RAG chunks 的语义边界自动切分
    // ════════════════════════════════════════════════════════════════════════
    // - 单个知识点 = 一组连续的 chunks（同主题），可跨多页
    // - chunk_ids 列存 JSON 数组（按 chunk_index 升序），便于回查原文
    // - status: detected (仅切好) / titled (LLM 已生成标题) / note_generated (已写入 notebook)
    // - notebook_entry_id：成功生成笔记后回填，方便 UI 检查/跳转
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS doc_knowledge_points (
            kp_id              TEXT PRIMARY KEY,
            session_id         TEXT NOT NULL,
            kp_index           INTEGER NOT NULL,
            title              TEXT NOT NULL DEFAULT '',
            summary            TEXT NOT NULL DEFAULT '',
            page_start         INTEGER NOT NULL,
            page_end           INTEGER NOT NULL,
            chunk_ids          TEXT NOT NULL DEFAULT '[]',
            char_count         INTEGER NOT NULL DEFAULT 0,
            status             TEXT NOT NULL DEFAULT 'detected',
            notebook_entry_id  TEXT NOT NULL DEFAULT '',
            created_at         TEXT NOT NULL,
            updated_at         TEXT NOT NULL,
            FOREIGN KEY (session_id) REFERENCES doc_sessions(session_id) ON DELETE CASCADE,
            UNIQUE (session_id, kp_index)
        );
        CREATE INDEX IF NOT EXISTS idx_kp_session ON doc_knowledge_points (session_id);",
    )?;

    // ════════════════════════════════════════════════════════════════════════
    // 学习 Agent（DESIGN.md §13 v2 Auto-Pilot）
    // ════════════════════════════════════════════════════════════════════════
    // agent_plans       : 整本书路线图。outline 包含 thesis / skip_pages[] /
    //                     units[{id,title,pages[],key_points[],needs_quiz,difficulty}]。
    //                     current_unit 指向当前单元（不是页）。
    // agent_unit_states : 每个学习单元的教学包 + 答题 + 反馈
    //
    // 单元（unit）= Agent 自主拆出的"学习粒度"，可跨多页；版权/目录等无价值页
    // 由 outline.skip_pages 标记，不进入循环。
    //
    // 设计原则：
    //   - 仅追加表（`current_page` 字段保留语义为 current_unit_index 兼容历史）
    //   - 不写笔记本表；agent_advance("next") 仍走 dr_save_note 原子追加
    //   - FK CASCADE：doc_session 删除时自动清空
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS agent_plans (
            session_id     TEXT PRIMARY KEY,
            outline_json   TEXT NOT NULL DEFAULT '',
            page_total     INTEGER NOT NULL DEFAULT 0,
            current_page   INTEGER NOT NULL DEFAULT 0,
            current_phase  TEXT NOT NULL DEFAULT 'idle',
            created_at     TEXT NOT NULL,
            updated_at     TEXT NOT NULL,
            FOREIGN KEY (session_id) REFERENCES doc_sessions(session_id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS agent_unit_states (
            session_id      TEXT NOT NULL,
            unit_index      INTEGER NOT NULL,
            teach_pack_json TEXT NOT NULL DEFAULT '',
            answers_json    TEXT NOT NULL DEFAULT '',
            status          TEXT NOT NULL DEFAULT 'pending',
            retries         INTEGER NOT NULL DEFAULT 0,
            updated_at      TEXT NOT NULL,
            PRIMARY KEY (session_id, unit_index),
            FOREIGN KEY (session_id) REFERENCES doc_sessions(session_id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_agent_unit_states_session
            ON agent_unit_states (session_id);

        -- 学习流档案（agent flow archive）
        --
        -- 每条记录是某 session 在某时刻的学习流快照：完整的 plan + 所有
        -- unit_states 序列化为 snapshot_json。用户在重新生成路线图前可把
        -- 当前进度归档；以后从档案列表点恢复，可把档案内容写回 active 区。
        --
        -- 字段：
        --   - archive_id        : UUID，主键
        --   - session_id        : 资料 session
        --   - name              : 用户友好名（如 第一遍精读）
        --   - snapshot_json     : 整流快照 JSON（plan + unit_states）
        --   - flow_config_json  : 该流的配置（难度/范围/目标，wizard 答案）
        --   - clarify_qa_json   : wizard 问答原文 JSON 数组
        --   - created_at        : 创建时间
        --
        -- FK CASCADE：doc_session 删除时档案一并清空。
        CREATE TABLE IF NOT EXISTS agent_flow_archives (
            archive_id        TEXT PRIMARY KEY,
            session_id        TEXT NOT NULL,
            name              TEXT NOT NULL DEFAULT '',
            snapshot_json     TEXT NOT NULL DEFAULT '',
            flow_config_json  TEXT NOT NULL DEFAULT '',
            clarify_qa_json   TEXT NOT NULL DEFAULT '',
            created_at        TEXT NOT NULL,
            FOREIGN KEY (session_id) REFERENCES doc_sessions(session_id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_agent_flow_archives_session
            ON agent_flow_archives (session_id);

        -- 训练模块（DESIGN.md §15）
        --
        -- training_attempts: 每次答题一行。
        --   - question_json：完整题目（含 prompt / choices / tests / answer / rubric）
        --   - user_answer：用户最终提交的答案（代码 / 选项字母 / 文本）
        --   - code_run_json：代码题的 Piston 运行结果（仅 code/debug 类型）
        --   - grade_json：LLM 评分（score / is_correct / feedback / missed_points）
        --   - skills_json：题目关联的 skill_id 列表（用于聚合到 skill_mastery）
        CREATE TABLE IF NOT EXISTS training_attempts (
            attempt_id     TEXT PRIMARY KEY,
            session_id     TEXT NOT NULL,
            unit_index     INTEGER,
            question_id    TEXT NOT NULL,
            question_json  TEXT NOT NULL,
            user_answer    TEXT NOT NULL DEFAULT '',
            code_run_json  TEXT,
            grade_json     TEXT NOT NULL DEFAULT '',
            skills_json    TEXT NOT NULL DEFAULT '[]',
            score          INTEGER NOT NULL DEFAULT 0,
            is_correct     INTEGER NOT NULL DEFAULT 0,
            created_at     TEXT NOT NULL,
            FOREIGN KEY (session_id) REFERENCES doc_sessions(session_id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_training_attempts_session
            ON training_attempts (session_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_training_attempts_question
            ON training_attempts (session_id, question_id);

        -- v5 (2026-05) B2: 学习↔训练同步生成 pack
        --
        -- 每个学习单元生成讲解后，后端异步调 LLM 生成对应训练题集，
        -- 持久化到本表。前端在「训练」面板检测到该 unit 已有 pack 时，
        -- 直接跳过 LLM 生成步骤进入答题；无 pack 则走原 training_generate_pack 路径。
        --
        -- 字段：
        --   - pack_json: 完整题集 JSON（generate_training_pack 输出的 questions[] +
        --                meta；前端 startSession 直接消费）
        --   - generated_at: 生成时间（ISO 8601）
        CREATE TABLE IF NOT EXISTS training_unit_packs (
            session_id    TEXT NOT NULL,
            unit_index    INTEGER NOT NULL,
            pack_json     TEXT NOT NULL,
            generated_at  TEXT NOT NULL,
            PRIMARY KEY (session_id, unit_index),
            FOREIGN KEY (session_id) REFERENCES doc_sessions(session_id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_training_unit_packs_session
            ON training_unit_packs (session_id);

        -- skill_mastery: 每个 (session, skill) 一行，聚合该会话下学生在该技能上的掌握度。
        --   - mastery：0.0-1.0 浮点。每答对一道关联题 +0.05，封顶 1.0；答错 -0.02 不低于 0
        --   - practice_count：累计练习题数（包含答错的）
        --   - correct_count：累计答对题数
        CREATE TABLE IF NOT EXISTS skill_mastery (
            session_id        TEXT NOT NULL,
            skill_id          TEXT NOT NULL,
            mastery           REAL NOT NULL DEFAULT 0.0,
            practice_count    INTEGER NOT NULL DEFAULT 0,
            correct_count     INTEGER NOT NULL DEFAULT 0,
            last_practiced_at TEXT,
            PRIMARY KEY (session_id, skill_id),
            FOREIGN KEY (session_id) REFERENCES doc_sessions(session_id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_skill_mastery_session
            ON skill_mastery (session_id);

        -- v4 (2026-05) user_skills: 全局技能字典（session 无关）。
        --   - LLM 出题时自由命名 skill_id（如 'frontend.react.hooks'），后端按需 upsert
        --   - 用户在 SkillsPage 里可以重命名 name / 合并 / 删除
        --   - mastery 不存在这里 —— 那是 skill_mastery (session 级聚合)
        --   - category 由 LLM 推断（可为空）；前端可分组显示
        CREATE TABLE IF NOT EXISTS user_skills (
            skill_id     TEXT PRIMARY KEY,
            name         TEXT NOT NULL,
            category     TEXT NOT NULL DEFAULT '',
            description  TEXT NOT NULL DEFAULT '',
            created_at   TEXT NOT NULL,
            updated_at   TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_user_skills_category ON user_skills (category);

        -- ════════════════════════════════════════════════════════════════
        -- v6 (2026-05) #3 vibelearning 统一 session 事件流
        -- ════════════════════════════════════════════════════════════════
        -- 一条事件 = 学习/训练过程中的一次显著动作。前端 VibeHistory 面板按
        -- (session_id, ts) 升序拉出，渲染成统一 timeline。
        --   kind: 事件类型枚举（字符串，便于演进）
        --     学习侧：plan_generated / unit_started / unit_taught / unit_advanced / agent_reset
        --     训练侧：training_started / training_attempt / training_pack_generated
        --     交互侧：chat_message / followup_asked
        --   payload_json: 该事件的 JSON 数据（自由格式，按 kind 解释）
        --   unit_index: 若关联到某学习单元，记录索引；否则 NULL
        --   ref_id: 关联其他表的外键（如 attempt_id / turn_id / entry_id），便于反查
        -- 表设计为 append-only，不更新不删除（除整 session 清除时 CASCADE）。
        CREATE TABLE IF NOT EXISTS vibe_session_events (
            event_id     INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id   TEXT NOT NULL,
            ts           TEXT NOT NULL,
            kind         TEXT NOT NULL,
            unit_index   INTEGER,
            ref_id       TEXT NOT NULL DEFAULT '',
            payload_json TEXT NOT NULL DEFAULT '{}',
            FOREIGN KEY (session_id) REFERENCES doc_sessions(session_id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_vibe_events_session ON vibe_session_events (session_id, ts);
        CREATE INDEX IF NOT EXISTS idx_vibe_events_kind ON vibe_session_events (session_id, kind);

        -- ════════════════════════════════════════════════════════════════
        -- v6 (2026-05) #3+ 学习流笔记（与课堂笔记彻底分开）
        -- ════════════════════════════════════════════════════════════════
        -- 历史：agent_advance next 之前会把 unit explanation 通过 merge_note_by_page
        -- 合并写入 dr_save_note(session, page=0)，导致：
        --   1) 和用户手写的「课堂笔记」共用同一行，互相覆盖
        --   2) 重新生成路线图 → 新 explanation 覆盖旧锚点页 → 看似丢失
        -- 现在：学习流单元讲解 append-only 写入这张表。课堂笔记仍走 doc_page_notes 不动。
        --
        --   archive_id: 该条笔记归属的「学习流轮次」。每次自动归档时把归档前的笔记打个标记。
        --               当前 active 学习流写入时 archive_id = 空串。
        CREATE TABLE IF NOT EXISTS agent_stream_notes (
            note_id      INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id   TEXT NOT NULL,
            archive_id   TEXT NOT NULL DEFAULT '',
            unit_index   INTEGER NOT NULL,
            anchor_page  INTEGER NOT NULL DEFAULT 0,
            unit_title   TEXT NOT NULL DEFAULT '',
            content      TEXT NOT NULL,
            created_at   TEXT NOT NULL,
            FOREIGN KEY (session_id) REFERENCES doc_sessions(session_id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_stream_notes_session
            ON agent_stream_notes (session_id, archive_id, unit_index);
        CREATE INDEX IF NOT EXISTS idx_stream_notes_created
            ON agent_stream_notes (session_id, created_at);",
    )?;

    let config_path = app_dir.join("llm_models.json");
    let uploads_dir = app_dir.join("uploads");
    let prefs_path = app_dir.join("app_prefs.json");
    std::fs::create_dir_all(&uploads_dir).ok();
    log::info!("Database initialized at {:?}", db_path);
    log::info!("模型配置文件路径: {:?}", config_path);
    log::info!("上传文件目录: {:?}", uploads_dir);
    app_handle.manage(AppState {
        db: Arc::new(Mutex::new(conn)),
        config_path,
        uploads_dir,
        prefs_path,
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

/// 获取单页内容。
///
/// 当 `(session_id, page_index)` 在 `doc_pages` 表中没有对应行时（典型场景：
/// EPUB/MOBI/AZW3 等流式电子书走 startup migration 补建的「空 session」，
/// 没有任何 page row），返回一个 page_index 占位、内容为空的 page，而不是
/// `Err("页面不存在: Query returned no rows")`。
///
/// 这样上层 `doc_reader_get_page` / `doc_reader_generate_note` 在 EPUB 场景
/// 下不会向前端抛错，而是返回空 page，前端 NoteTab 可继续展示并用前端传入
/// 的 `pageContent`（来自 foliate `relocate.range`）作为 AI 生成依据。
///
/// 真正的 SQL 错误（数据库损坏、表结构异常等）仍然 propagate 为 Err。
pub fn dr_get_page(conn: &Connection, session_id: &str, page_index: usize) -> Result<Value, String> {
    let mut stmt = conn
        .prepare(
            "SELECT page_index, content, word_count FROM doc_pages
             WHERE session_id = ?1 AND page_index = ?2",
        )
        .map_err(|e| format!("查询页面失败: {e}"))?;
    let row_result = stmt.query_row(params![session_id, page_index as i64], |r| {
        Ok(json!({
            "page_index": r.get::<_, i64>(0)?,
            "content": r.get::<_, String>(1)?,
            "word_count": r.get::<_, i64>(2)?,
        }))
    });
    match row_result {
        Ok(v) => Ok(v),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(json!({
            "page_index": page_index as i64,
            "content": "",
            "word_count": 0,
        })),
        Err(e) => Err(format!("查询页面失败: {e}")),
    }
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
    teacher: &str,
) -> Result<(), String> {
    let now = chrono::Local::now().to_rfc3339();
    conn.execute(
        "INSERT INTO notebooks (notebook_id, name, description, color, teacher, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
        params![notebook_id, name, description, color, teacher, now],
    )
    .map_err(|e| format!("创建笔记本失败: {e}"))?;
    Ok(())
}

/// 获取所有笔记本列表
pub fn nb_list(conn: &Connection) -> Result<Vec<Value>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT n.notebook_id, n.name, n.description, n.color, n.teacher, n.created_at, n.updated_at,
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
                "teacher": r.get::<_, String>(4)?,
                "created_at": r.get::<_, String>(5)?,
                "updated_at": r.get::<_, String>(6)?,
                "entry_count": r.get::<_, i64>(7)?,
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
            "SELECT notebook_id, name, description, color, teacher, created_at, updated_at
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
                "teacher": r.get::<_, String>(4)?,
                "created_at": r.get::<_, String>(5)?,
                "updated_at": r.get::<_, String>(6)?,
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
    teacher: &str,
) -> Result<(), String> {
    let now = chrono::Local::now().to_rfc3339();
    conn.execute(
        "UPDATE notebooks SET name = ?2, description = ?3, color = ?4, teacher = ?5, updated_at = ?6
         WHERE notebook_id = ?1",
        params![notebook_id, name, description, color, teacher, now],
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

/// Notebook 条目的结构化锚点信息（用于翻页联动、父子关系、嵌入式聊天）
#[derive(Clone, Default)]
pub struct NbAnchor {
    pub source_session_id: String,
    pub source_page_start: Option<i64>,
    pub source_page_end: Option<i64>,
    pub source_page_indexes: String, // JSON array 形如 "[0,3,7]"
    pub source_kind: String,         // single_page / page_range / text_select / explain / chat_append / ppt_import / annotation / manual
    pub parent_entry_id: String,
    pub section_role: String,        // root_note / deep_explain / chat_append
    pub chat_history_json: String,
}

const NB_ENTRY_COLUMNS: &str = "entry_id, notebook_id, title, content, entry_type, source_info, sort_order, created_at, updated_at, \
    COALESCE(source_session_id, '') as source_session_id, \
    source_page_start, source_page_end, \
    COALESCE(source_page_indexes, '') as source_page_indexes, \
    COALESCE(source_kind, '') as source_kind, \
    COALESCE(parent_entry_id, '') as parent_entry_id, \
    COALESCE(section_role, 'root_note') as section_role, \
    COALESCE(chat_history_json, '') as chat_history_json, \
    COALESCE(zone_id, '') as zone_id, \
    COALESCE(zone_order, 0) as zone_order, \
    COALESCE(entry_order, 0) as entry_order, \
    COALESCE(learning_role, '') as learning_role, \
    COALESCE(difficulty, 0) as difficulty, \
    COALESCE(meta_json, '') as meta_json";

fn row_to_entry(r: &rusqlite::Row) -> rusqlite::Result<Value> {
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
        "source_session_id": r.get::<_, String>(9)?,
        "source_page_start": r.get::<_, Option<i64>>(10)?,
        "source_page_end": r.get::<_, Option<i64>>(11)?,
        "source_page_indexes": r.get::<_, String>(12)?,
        "source_kind": r.get::<_, String>(13)?,
        "parent_entry_id": r.get::<_, String>(14)?,
        "section_role": r.get::<_, String>(15)?,
        "chat_history_json": r.get::<_, String>(16)?,
        "zone_id": r.get::<_, String>(17)?,
        "zone_order": r.get::<_, i64>(18)?,
        "entry_order": r.get::<_, i64>(19)?,
        "learning_role": r.get::<_, String>(20)?,
        "difficulty": r.get::<_, i64>(21)?,
        "meta_json": r.get::<_, String>(22)?,
    }))
}

/// 获取笔记本所有条目
pub fn nb_list_entries(conn: &Connection, notebook_id: &str) -> Result<Vec<Value>, String> {
    let sql = format!(
        "SELECT {} FROM notebook_entries WHERE notebook_id = ?1 ORDER BY sort_order",
        NB_ENTRY_COLUMNS
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| format!("查询笔记条目失败: {e}"))?;
    let rows = stmt
        .query_map(params![notebook_id], row_to_entry)
        .map_err(|e| format!("遍历笔记条目失败: {e}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("收集笔记条目失败: {e}"))
}

/// 获取单个笔记条目
pub fn nb_get_entry(conn: &Connection, entry_id: &str) -> Result<Value, String> {
    let sql = format!(
        "SELECT {} FROM notebook_entries WHERE entry_id = ?1",
        NB_ENTRY_COLUMNS
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| format!("查询笔记条目失败: {e}"))?;
    let row = stmt
        .query_row(params![entry_id], row_to_entry)
        .map_err(|e| format!("笔记条目不存在: {e}"))?;
    Ok(row)
}

/// 带锚点地添加 Notebook 条目（追加在末尾），返回生成的 sort_order
pub fn nb_add_entry_anchored(
    conn: &Connection,
    entry_id: &str,
    notebook_id: &str,
    title: &str,
    content: &str,
    entry_type: &str,
    source_info: &str,
    anchor: &NbAnchor,
) -> Result<i64, String> {
    let now = chrono::Local::now().to_rfc3339();
    let max_order: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(sort_order), -1) FROM notebook_entries WHERE notebook_id = ?1",
            params![notebook_id],
            |r| r.get(0),
        )
        .unwrap_or(-1);
    let sort_order = max_order + 1;
    conn.execute(
        "INSERT INTO notebook_entries (
            entry_id, notebook_id, title, content, entry_type, source_info, sort_order,
            created_at, updated_at,
            source_session_id, source_page_start, source_page_end, source_page_indexes,
            source_kind, parent_entry_id, section_role, chat_history_json
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
        params![
            entry_id, notebook_id, title, content, entry_type, source_info, sort_order, now,
            anchor.source_session_id,
            anchor.source_page_start,
            anchor.source_page_end,
            anchor.source_page_indexes,
            anchor.source_kind,
            anchor.parent_entry_id,
            anchor.section_role,
            anchor.chat_history_json,
        ],
    )
    .map_err(|e| format!("添加笔记条目失败: {e}"))?;
    conn.execute(
        "UPDATE notebooks SET updated_at = ?2 WHERE notebook_id = ?1",
        params![notebook_id, now],
    )
    .ok();
    Ok(sort_order)
}

/// 更新条目的嵌入式聊天历史 JSON
pub fn nb_update_chat_history(conn: &Connection, entry_id: &str, history_json: &str) -> Result<(), String> {
    let now = chrono::Local::now().to_rfc3339();
    conn.execute(
        "UPDATE notebook_entries SET chat_history_json = ?2, updated_at = ?3 WHERE entry_id = ?1",
        params![entry_id, history_json, now],
    )
    .map_err(|e| format!("更新聊天历史失败: {e}"))?;
    Ok(())
}

/// 只更新 entry 的 title（不动 content），用于"一键排版"中重命名 bad title
pub fn nb_update_entry_title(conn: &Connection, entry_id: &str, title: &str) -> Result<(), String> {
    let now = chrono::Local::now().to_rfc3339();
    conn.execute(
        "UPDATE notebook_entries SET title = ?2, updated_at = ?3 WHERE entry_id = ?1",
        params![entry_id, title, now],
    )
    .map_err(|e| format!("更新条目标题失败: {e}"))?;
    Ok(())
}

/// 批量更新 sort_order（用于一键排版重排顺序）。pairs: (entry_id, new_sort_order)
pub fn nb_update_sort_orders(conn: &Connection, pairs: &[(String, i64)]) -> Result<(), String> {
    conn.execute_batch("BEGIN").ok();
    for (eid, order) in pairs {
        if let Err(e) = conn.execute(
            "UPDATE notebook_entries SET sort_order = ?2 WHERE entry_id = ?1",
            params![eid, order],
        ) {
            conn.execute_batch("ROLLBACK").ok();
            return Err(format!("更新排序失败: {e}"));
        }
    }
    conn.execute_batch("COMMIT").ok();
    Ok(())
}

/// 查找某笔记本下、锚定到指定 session + page_index 的条目列表（按 sort_order 升序）
pub fn nb_entries_for_page(
    conn: &Connection,
    notebook_id: &str,
    session_id: &str,
    page_index: i64,
) -> Result<Vec<Value>, String> {
    let sql = format!(
        "SELECT {} FROM notebook_entries
         WHERE notebook_id = ?1
           AND source_session_id = ?2
           AND (
             (source_page_start IS NOT NULL AND source_page_start <= ?3 AND
              (source_page_end IS NULL OR source_page_end >= ?3))
             OR source_page_indexes LIKE ?4
           )
         ORDER BY sort_order",
        NB_ENTRY_COLUMNS
    );
    // LIKE 匹配 JSON 数组中的 page_index（兼容简单的 "[0,3,7]" 形式）
    let like_pat = format!("%[{}%", page_index);
    let mut stmt = conn.prepare(&sql).map_err(|e| format!("查询锚点条目失败: {e}"))?;
    let rows = stmt
        .query_map(params![notebook_id, session_id, page_index, like_pat], row_to_entry)
        .map_err(|e| format!("遍历锚点条目失败: {e}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("收集锚点条目失败: {e}"))
}

// ══════════════════════════════════════════════════════════════════════════════
// Learning Outline (notebook_outlines + entry meta)
// ══════════════════════════════════════════════════════════════════════════════

/// 每条 entry 的 LLM 抽取元信息（第一步产物）
#[derive(Clone, Default, Debug)]
pub struct NbEntryLearningMeta {
    pub meta_json: String,       // 完整 JSON：{ summary, keypoints[], topics[], prerequisites_hint[], role_hint, difficulty }
    pub learning_role: String,   // foundation / mechanism / comparison / misconception / application / example / recap
    pub difficulty: i64,         // 1..5
}

/// 批量更新 entry 的学习元信息（第一步）
pub fn nb_update_entry_meta(
    conn: &Connection,
    entry_id: &str,
    meta: &NbEntryLearningMeta,
) -> Result<(), String> {
    let now = chrono::Local::now().to_rfc3339();
    conn.execute(
        "UPDATE notebook_entries
         SET meta_json = ?2, learning_role = ?3, difficulty = ?4, updated_at = ?5
         WHERE entry_id = ?1",
        params![entry_id, meta.meta_json, meta.learning_role, meta.difficulty, now],
    )
    .map_err(|e| format!("更新 entry 元信息失败: {e}"))?;
    Ok(())
}

/// 批量更新 entry 的 zone 归属和学习顺序（第二步产物）
/// pairs: (entry_id, zone_id, zone_order, entry_order)
pub fn nb_update_entry_zones(
    conn: &Connection,
    pairs: &[(String, String, i64, i64)],
) -> Result<(), String> {
    conn.execute_batch("BEGIN").ok();
    let now = chrono::Local::now().to_rfc3339();
    for (eid, zid, zorder, eorder) in pairs {
        if let Err(e) = conn.execute(
            "UPDATE notebook_entries
             SET zone_id = ?2, zone_order = ?3, entry_order = ?4, sort_order = ?4, updated_at = ?5
             WHERE entry_id = ?1",
            params![eid, zid, zorder, eorder, now],
        ) {
            conn.execute_batch("ROLLBACK").ok();
            return Err(format!("更新 zone 归属失败: {e}"));
        }
    }
    conn.execute_batch("COMMIT").ok();
    Ok(())
}

/// 保存/覆盖笔记本学习大纲 JSON
pub fn nb_outline_upsert(
    conn: &Connection,
    notebook_id: &str,
    outline_json: &str,
    version: i64,
) -> Result<(), String> {
    let now = chrono::Local::now().to_rfc3339();
    conn.execute(
        "INSERT INTO notebook_outlines (notebook_id, outline_json, version, updated_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(notebook_id) DO UPDATE SET
            outline_json = excluded.outline_json,
            version = excluded.version,
            updated_at = excluded.updated_at",
        params![notebook_id, outline_json, version, now],
    )
    .map_err(|e| format!("保存学习大纲失败: {e}"))?;
    Ok(())
}

/// 读取笔记本学习大纲；不存在时返回 None
pub fn nb_outline_get(conn: &Connection, notebook_id: &str) -> Result<Option<Value>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT outline_json, version, updated_at
             FROM notebook_outlines WHERE notebook_id = ?1",
        )
        .map_err(|e| format!("查询学习大纲失败: {e}"))?;
    let result = stmt.query_row(params![notebook_id], |r| {
        let oj: String = r.get(0)?;
        let ver: i64 = r.get(1)?;
        let ua: String = r.get(2)?;
        Ok((oj, ver, ua))
    });
    match result {
        Ok((oj, ver, ua)) => {
            let parsed: Value = serde_json::from_str(&oj).unwrap_or(Value::Null);
            Ok(Some(json!({
                "outline": parsed,
                "version": ver,
                "updated_at": ua,
            })))
        }
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(format!("查询学习大纲失败: {e}")),
    }
}

/// 删除笔记本学习大纲（供"重建"时清空旧版本）
pub fn nb_outline_delete(conn: &Connection, notebook_id: &str) -> Result<(), String> {
    conn.execute(
        "DELETE FROM notebook_outlines WHERE notebook_id = ?1",
        params![notebook_id],
    )
    .map_err(|e| format!("删除学习大纲失败: {e}"))?;
    Ok(())
}

// ══════════════════════════════════════════════════════════════════════════════
// RAG 知识库 CRUD
// ══════════════════════════════════════════════════════════════════════════════
//
// embedding 在表里以 BLOB 存储 = 小端 f32 序列：
//   [chunk0_dim0, chunk0_dim1, ...]  共 dim * 4 字节
// 选 BLOB 而不是 JSON 数组：
//   * 解析快 100×（直接 cast 内存）
//   * 磁盘体积小 4×（f32 = 4 bytes vs JSON "0.0123456789" ≈ 12 bytes）
//   * SQLite BLOB 没有大小限制
// 选小端是因为 x86/ARM 当代主流 CPU 全是小端，Tauri 桌面/Android 都通吃；
// 真碰到大端机器再做转换层（极小概率）。

/// f32 向量 → 小端字节流（用于写库）
pub fn rag_vec_to_bytes(v: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(v.len() * 4);
    for &x in v {
        out.extend_from_slice(&x.to_le_bytes());
    }
    out
}

/// 小端字节流 → f32 向量（用于读库）。长度非 4 的倍数视为损坏，返回空 vec。
pub fn rag_bytes_to_vec(b: &[u8]) -> Vec<f32> {
    if b.len() % 4 != 0 {
        return Vec::new();
    }
    let n = b.len() / 4;
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        let off = i * 4;
        let mut buf = [0u8; 4];
        buf.copy_from_slice(&b[off..off + 4]);
        out.push(f32::from_le_bytes(buf));
    }
    out
}

/// 写入/更新单本书的 RAG 索引元信息。status 取值：
///   'pending'    占位（已知道要建索引但还没开始）
///   'building'   正在 embed
///   'ready'      索引完成可用
///   'failed'     失败（查 error 字段）
pub fn rag_upsert_meta(
    conn: &Connection,
    session_id: &str,
    status: &str,
    chunk_count: usize,
    model: &str,
    dim: usize,
    error: &str,
) -> Result<(), String> {
    let now = chrono::Local::now().to_rfc3339();
    conn.execute(
        "INSERT INTO rag_meta (session_id, status, chunk_count, model, dim, error, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(session_id) DO UPDATE SET
            status = excluded.status,
            chunk_count = excluded.chunk_count,
            model = excluded.model,
            dim = excluded.dim,
            error = excluded.error,
            updated_at = excluded.updated_at",
        params![session_id, status, chunk_count as i64, model, dim as i64, error, now],
    )
    .map_err(|e| format!("写入 rag_meta 失败: {e}"))?;
    Ok(())
}

/// 读取单本书的 RAG 索引状态；不存在返回 None。
pub fn rag_get_meta(conn: &Connection, session_id: &str) -> Result<Option<Value>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT session_id, status, chunk_count, model, dim, error, updated_at
             FROM rag_meta WHERE session_id = ?1",
        )
        .map_err(|e| format!("查询 rag_meta 失败: {e}"))?;
    let r = stmt.query_row(params![session_id], |r| {
        Ok(json!({
            "session_id": r.get::<_, String>(0)?,
            "status": r.get::<_, String>(1)?,
            "chunk_count": r.get::<_, i64>(2)?,
            "model": r.get::<_, String>(3)?,
            "dim": r.get::<_, i64>(4)?,
            "error": r.get::<_, String>(5)?,
            "updated_at": r.get::<_, String>(6)?,
        }))
    });
    match r {
        Ok(v) => Ok(Some(v)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(format!("查询 rag_meta 失败: {e}")),
    }
}

/// 清空某本书的 RAG 索引（chunks + meta），通常用于重新索引。
pub fn rag_clear_session(conn: &Connection, session_id: &str) -> Result<(), String> {
    conn.execute(
        "DELETE FROM rag_chunks WHERE session_id = ?1",
        params![session_id],
    )
    .map_err(|e| format!("清空 rag_chunks 失败: {e}"))?;
    conn.execute(
        "DELETE FROM rag_meta WHERE session_id = ?1",
        params![session_id],
    )
    .map_err(|e| format!("清空 rag_meta 失败: {e}"))?;
    Ok(())
}

/// 单条 chunk 的写入参数。
pub struct RagChunkInsert<'a> {
    pub chunk_id: &'a str,
    pub session_id: &'a str,
    pub chunk_index: i64,
    pub page_start: i64,
    pub page_end: i64,
    pub text: &'a str,
    pub token_count: i64,
    pub embedding: &'a [f32],
    pub model: &'a str,
}

/// 批量插入 chunks（内部用单一事务）。调用方应已 lock 住 conn。
pub fn rag_insert_chunks(conn: &Connection, items: &[RagChunkInsert<'_>]) -> Result<(), String> {
    let now = chrono::Local::now().to_rfc3339();
    let mut stmt = conn
        .prepare(
            "INSERT OR REPLACE INTO rag_chunks
             (chunk_id, session_id, chunk_index, page_start, page_end, text, token_count, embedding, model, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        )
        .map_err(|e| format!("准备 rag_chunks 插入失败: {e}"))?;
    for it in items {
        let blob = rag_vec_to_bytes(it.embedding);
        stmt.execute(params![
            it.chunk_id,
            it.session_id,
            it.chunk_index,
            it.page_start,
            it.page_end,
            it.text,
            it.token_count,
            blob,
            it.model,
            now,
        ])
        .map_err(|e| format!("插入 rag_chunks 失败: {e}"))?;
    }
    Ok(())
}

/// 单条 chunk 在内存中的形态（含解码后向量），供 retriever 使用。
#[derive(Clone)]
pub struct RagChunkRow {
    pub chunk_id: String,
    pub session_id: String,
    pub chunk_index: i64,
    pub page_start: i64,
    pub page_end: i64,
    pub text: String,
    pub embedding: Vec<f32>,
}

/// 加载某 session 的全部 chunks（含向量）。供向量检索使用。
/// 几千行级别全量读完全可承受；若以后要扩到全图书馆全文检索，可以转批读 + 流式打分。
pub fn rag_load_chunks(conn: &Connection, session_id: &str) -> Result<Vec<RagChunkRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT chunk_id, session_id, chunk_index, page_start, page_end, text, embedding
             FROM rag_chunks WHERE session_id = ?1
             ORDER BY chunk_index",
        )
        .map_err(|e| format!("查询 rag_chunks 失败: {e}"))?;
    let rows = stmt
        .query_map(params![session_id], |r| {
            let blob: Vec<u8> = r.get(6)?;
            Ok(RagChunkRow {
                chunk_id: r.get(0)?,
                session_id: r.get(1)?,
                chunk_index: r.get(2)?,
                page_start: r.get(3)?,
                page_end: r.get(4)?,
                text: r.get(5)?,
                embedding: rag_bytes_to_vec(&blob),
            })
        })
        .map_err(|e| format!("遍历 rag_chunks 失败: {e}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("收集 rag_chunks 失败: {e}"))
}

// ══════════════════════════════════════════════════════════════════════════════
// Knowledge Points: 基于 RAG chunks 的语义边界自动切分
// ══════════════════════════════════════════════════════════════════════════════

/// 知识点写入参数。
pub struct KpInsert<'a> {
    pub kp_id: &'a str,
    pub session_id: &'a str,
    pub kp_index: i64,
    pub title: &'a str,
    pub summary: &'a str,
    pub page_start: i64,
    pub page_end: i64,
    pub chunk_ids_json: &'a str,
    pub char_count: i64,
}

/// 知识点查询行。
#[derive(Clone, serde::Serialize)]
pub struct KpRow {
    pub kp_id: String,
    pub session_id: String,
    pub kp_index: i64,
    pub title: String,
    pub summary: String,
    pub page_start: i64,
    pub page_end: i64,
    /// JSON 数组字符串（chunk_id 升序）。前端解析后可回查 chunks。
    pub chunk_ids: String,
    pub char_count: i64,
    pub status: String,
    pub notebook_entry_id: String,
    pub updated_at: String,
}

/// 清空某 session 的全部知识点（重新检测前调用）。
pub fn kp_clear_session(conn: &Connection, session_id: &str) -> Result<(), String> {
    conn.execute(
        "DELETE FROM doc_knowledge_points WHERE session_id = ?1",
        params![session_id],
    )
    .map_err(|e| format!("清空 doc_knowledge_points 失败: {e}"))?;
    Ok(())
}

/// 批量插入知识点。调用方应已 lock 住 conn。
pub fn kp_insert_batch(conn: &Connection, items: &[KpInsert<'_>]) -> Result<(), String> {
    let now = chrono::Local::now().to_rfc3339();
    let mut stmt = conn
        .prepare(
            "INSERT OR REPLACE INTO doc_knowledge_points
             (kp_id, session_id, kp_index, title, summary,
              page_start, page_end, chunk_ids, char_count,
              status, notebook_entry_id, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'detected', '', ?10, ?10)",
        )
        .map_err(|e| format!("准备 doc_knowledge_points 插入失败: {e}"))?;
    for it in items {
        stmt.execute(params![
            it.kp_id,
            it.session_id,
            it.kp_index,
            it.title,
            it.summary,
            it.page_start,
            it.page_end,
            it.chunk_ids_json,
            it.char_count,
            now,
        ])
        .map_err(|e| format!("插入 doc_knowledge_points 失败: {e}"))?;
    }
    Ok(())
}

/// 列出某 session 的所有知识点（按 kp_index 升序）。
pub fn kp_list(conn: &Connection, session_id: &str) -> Result<Vec<KpRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT kp_id, session_id, kp_index, title, summary,
                    page_start, page_end, chunk_ids, char_count,
                    status, notebook_entry_id, updated_at
             FROM doc_knowledge_points
             WHERE session_id = ?1
             ORDER BY kp_index",
        )
        .map_err(|e| format!("查询 doc_knowledge_points 失败: {e}"))?;
    let rows = stmt
        .query_map(params![session_id], |r| {
            Ok(KpRow {
                kp_id: r.get(0)?,
                session_id: r.get(1)?,
                kp_index: r.get(2)?,
                title: r.get(3)?,
                summary: r.get(4)?,
                page_start: r.get(5)?,
                page_end: r.get(6)?,
                chunk_ids: r.get(7)?,
                char_count: r.get(8)?,
                status: r.get(9)?,
                notebook_entry_id: r.get(10)?,
                updated_at: r.get(11)?,
            })
        })
        .map_err(|e| format!("遍历 doc_knowledge_points 失败: {e}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("收集 doc_knowledge_points 失败: {e}"))
}

/// 取一个知识点（含 chunk_ids JSON）。
pub fn kp_get(conn: &Connection, kp_id: &str) -> Result<KpRow, String> {
    conn.query_row(
        "SELECT kp_id, session_id, kp_index, title, summary,
                page_start, page_end, chunk_ids, char_count,
                status, notebook_entry_id, updated_at
         FROM doc_knowledge_points WHERE kp_id = ?1",
        params![kp_id],
        |r| {
            Ok(KpRow {
                kp_id: r.get(0)?,
                session_id: r.get(1)?,
                kp_index: r.get(2)?,
                title: r.get(3)?,
                summary: r.get(4)?,
                page_start: r.get(5)?,
                page_end: r.get(6)?,
                chunk_ids: r.get(7)?,
                char_count: r.get(8)?,
                status: r.get(9)?,
                notebook_entry_id: r.get(10)?,
                updated_at: r.get(11)?,
            })
        },
    )
    .map_err(|e| format!("查询知识点 {kp_id} 失败: {e}"))
}

/// 更新知识点标题/摘要（LLM 生成 title 之后回填）。
pub fn kp_update_title(
    conn: &Connection,
    kp_id: &str,
    title: &str,
    summary: &str,
) -> Result<(), String> {
    let now = chrono::Local::now().to_rfc3339();
    conn.execute(
        "UPDATE doc_knowledge_points
         SET title = ?1, summary = ?2, status = CASE WHEN status = 'detected' THEN 'titled' ELSE status END,
             updated_at = ?3
         WHERE kp_id = ?4",
        params![title, summary, now, kp_id],
    )
    .map_err(|e| format!("更新知识点标题失败: {e}"))?;
    Ok(())
}

/// 标记知识点已生成笔记（回填 notebook_entry_id + status='note_generated'）。
pub fn kp_mark_note_generated(
    conn: &Connection,
    kp_id: &str,
    entry_id: &str,
) -> Result<(), String> {
    let now = chrono::Local::now().to_rfc3339();
    conn.execute(
        "UPDATE doc_knowledge_points
         SET notebook_entry_id = ?1, status = 'note_generated', updated_at = ?2
         WHERE kp_id = ?3",
        params![entry_id, now, kp_id],
    )
    .map_err(|e| format!("回填知识点 notebook_entry_id 失败: {e}"))?;
    Ok(())
}

/// 加载某知识点对应的全部 chunks 文本（按 chunk_index 升序）。
/// 用于：① 拼源文本喂 generate_auto_section；② UI 预览原文。
pub fn kp_load_chunk_texts(
    conn: &Connection,
    session_id: &str,
    chunk_indexes: &[i64],
) -> Result<Vec<(i64, i64, i64, String)>, String> {
    if chunk_indexes.is_empty() {
        return Ok(Vec::new());
    }
    // SQLite 不支持数组绑定，用 IN (?,?,?...) 拼参数
    let placeholders = std::iter::repeat("?").take(chunk_indexes.len()).collect::<Vec<_>>().join(",");
    let sql = format!(
        "SELECT chunk_index, page_start, page_end, text FROM rag_chunks
         WHERE session_id = ?1 AND chunk_index IN ({})
         ORDER BY chunk_index",
        placeholders
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| format!("准备查询 chunks 文本失败: {e}"))?;
    // 拼 params：先 session_id，再各 chunk_index
    let mut params_vec: Vec<rusqlite::types::Value> =
        vec![rusqlite::types::Value::Text(session_id.to_string())];
    for &ci in chunk_indexes {
        params_vec.push(rusqlite::types::Value::Integer(ci));
    }
    let rows = stmt
        .query_map(rusqlite::params_from_iter(params_vec.iter()), |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, String>(3)?,
            ))
        })
        .map_err(|e| format!("遍历 chunks 文本失败: {e}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("收集 chunks 文本失败: {e}"))
}

// ══════════════════════════════════════════════════════════════════════════════
// Agent CRUD（DESIGN.md §13）
// ══════════════════════════════════════════════════════════════════════════════
//
// 调用契约：
//   - 所有写操作要么更新 updated_at（记录中断恢复点），要么插入时同时写
//     created_at = updated_at = now。
//   - phase 取值：idle / planning / teaching / probing / grading / reviewing / done。
//   - status 在 page_states 上：pending / teaching / probing / grading / done。
//   - 不在 helper 里做业务校验（比如 phase 转换合法性）；由 commands 层负责。

/// 取出某 session 的整体 Agent 状态（路线图 + 所有单元状态）。
/// 路线图未生成时返回 `{plan: null, unit_states: []}`。
///
/// `plan.current_page` 字段在 v2 后语义即 `current_unit_index`（保留字段名兼容旧 schema）。
pub fn agent_get_state(conn: &Connection, session_id: &str) -> Result<Value, String> {
    let plan: Option<Value> = {
        let mut stmt = conn
            .prepare(
                "SELECT outline_json, page_total, current_page, current_phase, created_at, updated_at
                 FROM agent_plans WHERE session_id = ?1",
            )
            .map_err(|e| format!("查询 agent_plan 失败: {e}"))?;
        stmt.query_row(params![session_id], |r| {
            let outline_str: String = r.get(0)?;
            let outline: Value = serde_json::from_str(&outline_str)
                .unwrap_or(Value::Null);
            Ok(json!({
                "outline": outline,
                "page_total": r.get::<_, i64>(1)?,
                "current_unit": r.get::<_, i64>(2)?,
                "current_phase": r.get::<_, String>(3)?,
                "created_at": r.get::<_, String>(4)?,
                "updated_at": r.get::<_, String>(5)?,
            }))
        })
        .ok()
    };

    let mut stmt = conn
        .prepare(
            "SELECT unit_index, teach_pack_json, answers_json, status, retries, updated_at, partial_explanation
             FROM agent_unit_states WHERE session_id = ?1 ORDER BY unit_index ASC",
        )
        .map_err(|e| format!("查询 agent_unit_states 失败: {e}"))?;
    let rows = stmt
        .query_map(params![session_id], |r| {
            let teach_str: String = r.get(1)?;
            let answers_str: String = r.get(2)?;
            let teach_pack: Value = if teach_str.is_empty() {
                Value::Null
            } else {
                serde_json::from_str(&teach_str).unwrap_or(Value::Null)
            };
            let answers: Value = if answers_str.is_empty() {
                Value::Array(Vec::new())
            } else {
                serde_json::from_str(&answers_str).unwrap_or(Value::Array(Vec::new()))
            };
            let partial: String = r.get::<_, String>(6).unwrap_or_default();
            Ok(json!({
                "unit_index": r.get::<_, i64>(0)?,
                "teach_pack": teach_pack,
                "answers": answers,
                "status": r.get::<_, String>(3)?,
                "retries": r.get::<_, i64>(4)?,
                "updated_at": r.get::<_, String>(5)?,
                "partial_explanation": partial,
            }))
        })
        .map_err(|e| format!("遍历 agent_unit_states 失败: {e}"))?;
    let unit_states: Vec<Value> = rows
        .filter_map(|r| r.ok())
        .collect();

    Ok(json!({
        "plan": plan.unwrap_or(Value::Null),
        "unit_states": unit_states,
    }))
}

/// 保存或覆盖路线图（典型时机：用户首次进入 / 点"重新生成路线图"）。
/// current_page / current_phase 重置为 0 / 'idle'，等待用户开始。
pub fn agent_save_plan(
    conn: &Connection,
    session_id: &str,
    outline_json: &str,
    page_total: usize,
) -> Result<(), String> {
    let now = chrono::Local::now().to_rfc3339();
    conn.execute(
        "INSERT INTO agent_plans
            (session_id, outline_json, page_total, current_page, current_phase, created_at, updated_at)
         VALUES (?1, ?2, ?3, 0, 'idle', ?4, ?4)
         ON CONFLICT(session_id) DO UPDATE SET
            outline_json = excluded.outline_json,
            page_total   = excluded.page_total,
            current_page = 0,
            current_phase = 'idle',
            updated_at   = excluded.updated_at",
        params![session_id, outline_json, page_total as i64, now],
    )
    .map_err(|e| format!("保存路线图失败: {e}"))?;
    Ok(())
}

/// 推进 Agent 整体阶段（current_unit / current_phase）。
/// phase 由 caller 决定，不做合法性校验。
/// 注：底层列名仍是 `current_page`（兼容旧 schema），语义为 unit_index。
pub fn agent_set_phase(
    conn: &Connection,
    session_id: &str,
    current_unit: usize,
    current_phase: &str,
) -> Result<(), String> {
    let now = chrono::Local::now().to_rfc3339();
    conn.execute(
        "UPDATE agent_plans SET current_page = ?2, current_phase = ?3, updated_at = ?4
         WHERE session_id = ?1",
        params![session_id, current_unit as i64, current_phase, now],
    )
    .map_err(|e| format!("更新 agent 阶段失败: {e}"))?;
    Ok(())
}

/// 写入或覆盖某单元的"教学包"（讲解 + 题目 + 标准答案 + 评分点）。
/// 状态推到 'probing'（有题目时）或 'reviewing'（无题目时由调用方再调 set_phase）。
pub fn agent_save_teach_pack(
    conn: &Connection,
    session_id: &str,
    unit_index: usize,
    teach_pack_json: &str,
) -> Result<(), String> {
    let now = chrono::Local::now().to_rfc3339();
    conn.execute(
        "INSERT INTO agent_unit_states
            (session_id, unit_index, teach_pack_json, answers_json, status, retries, updated_at)
         VALUES (?1, ?2, ?3, '', 'probing', 0, ?4)
         ON CONFLICT(session_id, unit_index) DO UPDATE SET
            teach_pack_json = excluded.teach_pack_json,
            answers_json   = '',
            status         = 'probing',
            retries        = agent_unit_states.retries + 1,
            updated_at     = excluded.updated_at",
        params![session_id, unit_index as i64, teach_pack_json, now],
    )
    .map_err(|e| format!("保存教学包失败: {e}"))?;
    Ok(())
}

/// 写入用户答题与判分结果（answers_json 是已 grade 后的完整数组）。
/// 同时把单元状态推到 'done'（已完成本单元学习循环）。
pub fn agent_save_answers(
    conn: &Connection,
    session_id: &str,
    unit_index: usize,
    answers_json: &str,
) -> Result<(), String> {
    let now = chrono::Local::now().to_rfc3339();
    conn.execute(
        "UPDATE agent_unit_states
         SET answers_json = ?3, status = 'done', updated_at = ?4
         WHERE session_id = ?1 AND unit_index = ?2",
        params![session_id, unit_index as i64, answers_json, now],
    )
    .map_err(|e| format!("保存答题结果失败: {e}"))?;
    Ok(())
}

/// 单元无题目时：直接标记完成（用于 needs_quiz=false 的单元）。
pub fn agent_mark_unit_done(
    conn: &Connection,
    session_id: &str,
    unit_index: usize,
) -> Result<(), String> {
    let now = chrono::Local::now().to_rfc3339();
    conn.execute(
        "INSERT INTO agent_unit_states
            (session_id, unit_index, teach_pack_json, answers_json, status, retries, updated_at)
         VALUES (?1, ?2, '', '[]', 'done', 0, ?3)
         ON CONFLICT(session_id, unit_index) DO UPDATE SET
            status = 'done',
            updated_at = excluded.updated_at",
        params![session_id, unit_index as i64, now],
    )
    .map_err(|e| format!("标记单元完成失败: {e}"))?;
    Ok(())
}

/// 取单元教学包（含 questions / 标准答案）。判分时使用。
pub fn agent_get_teach_pack(
    conn: &Connection,
    session_id: &str,
    unit_index: usize,
) -> Result<Option<Value>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT teach_pack_json FROM agent_unit_states
             WHERE session_id = ?1 AND unit_index = ?2",
        )
        .map_err(|e| format!("查询教学包失败: {e}"))?;
    let row: Option<String> = stmt
        .query_row(params![session_id, unit_index as i64], |r| r.get(0))
        .ok();
    match row {
        None => Ok(None),
        Some(s) if s.is_empty() => Ok(None),
        Some(s) => {
            let v: Value = serde_json::from_str(&s)
                .map_err(|e| format!("教学包 JSON 解析失败: {e}"))?;
            Ok(Some(v))
        }
    }
}

// ════════════════════════════════════════════════════════════════════════════
// v10 (2026-05) 学习流断点续传：partial_explanation 持久化
// ════════════════════════════════════════════════════════════════════════════
//
// 设计：流式过程中后台 task 每攒到 ≥ 200 chars 或每过 1s 写一次本列。
//   - 流自然 done 时 caller 调 agent_clear_partial_explanation 清空（避免误判中断）
//   - 流意外失败 / app 进程退出时该列保留最后一次写入；重启后前端可见 "已部分生成"
//   - resume 时把这列内容作为 assistant turn 注入 LLM 输入，模型从断点续写

/// 写入或更新某单元的部分流式 markdown（INSERT ... ON CONFLICT 幂等）。
/// 与 agent_save_teach_pack 共用同一行；当 teach_pack 为空、partial 非空时表示
/// "讲解尚未完成、有断点可续"。
pub fn agent_save_partial_explanation(
    conn: &Connection,
    session_id: &str,
    unit_index: usize,
    partial: &str,
) -> Result<(), String> {
    let now = chrono::Local::now().to_rfc3339();
    conn.execute(
        "INSERT INTO agent_unit_states
            (session_id, unit_index, teach_pack_json, answers_json, status, retries, updated_at, partial_explanation)
         VALUES (?1, ?2, '', '', 'teaching', 0, ?3, ?4)
         ON CONFLICT(session_id, unit_index) DO UPDATE SET
            partial_explanation = excluded.partial_explanation,
            updated_at          = excluded.updated_at",
        params![session_id, unit_index as i64, now, partial],
    )
    .map_err(|e| format!("保存 partial_explanation 失败: {e}"))?;
    Ok(())
}

/// 清空某单元的 partial_explanation。流自然 done 时由 caller 调用，避免遗留误判。
pub fn agent_clear_partial_explanation(
    conn: &Connection,
    session_id: &str,
    unit_index: usize,
) -> Result<(), String> {
    conn.execute(
        "UPDATE agent_unit_states SET partial_explanation = ''
         WHERE session_id = ?1 AND unit_index = ?2",
        params![session_id, unit_index as i64],
    )
    .map_err(|e| format!("清空 partial_explanation 失败: {e}"))?;
    Ok(())
}

/// 读取某单元的 partial_explanation。空字符串视为"无断点"。
pub fn agent_get_partial_explanation(
    conn: &Connection,
    session_id: &str,
    unit_index: usize,
) -> Result<String, String> {
    let mut stmt = conn
        .prepare(
            "SELECT partial_explanation FROM agent_unit_states
             WHERE session_id = ?1 AND unit_index = ?2",
        )
        .map_err(|e| format!("查询 partial_explanation 失败: {e}"))?;
    let row: Option<String> = stmt
        .query_row(params![session_id, unit_index as i64], |r| r.get(0))
        .ok();
    Ok(row.unwrap_or_default())
}

// ──────────────────────────────────────────────────────────────────────────
// v4 (2026-05) 学习 ↔ 笔记深度绑定
//
// 每个 doc_session 对应一个学习笔记本（deterministic id `study-nb-{session_id}`）；
// 每个 unit 对应一个 entry（deterministic id `study-unit-{session_id}-{unit_index}`），
// source_kind = 'agent_unit'。这样可以双向同步且无需新表。
// ──────────────────────────────────────────────────────────────────────────

/// 学习笔记本 ID 的 deterministic 命名。同一 session 多次调用得到同 ID。
pub fn study_notebook_id(session_id: &str) -> String {
    format!("study-nb-{}", session_id)
}

/// 学习单元 entry ID 的 deterministic 命名。
pub fn study_unit_entry_id(session_id: &str, unit_index: usize) -> String {
    format!("study-unit-{}-{}", session_id, unit_index)
}

/// 按需建学习笔记本。若已存在则只刷 name（doc_title 可能变化）。
/// 返回 notebook_id。
pub fn agent_ensure_study_notebook(
    conn: &Connection,
    session_id: &str,
    doc_title: &str,
) -> Result<String, String> {
    let notebook_id = study_notebook_id(session_id);
    let name = if doc_title.trim().is_empty() {
        "学习笔记".to_string()
    } else {
        format!("《{}》学习笔记", doc_title.trim())
    };
    // 探测是否存在
    let existed: bool = conn
        .query_row(
            "SELECT 1 FROM notebooks WHERE notebook_id = ?1",
            params![notebook_id],
            |_| Ok(true),
        )
        .unwrap_or(false);
    let now = chrono::Local::now().to_rfc3339();
    if existed {
        // 仅按需刷新名字（不动 description / color / teacher）
        conn.execute(
            "UPDATE notebooks SET name = ?2, updated_at = ?3 WHERE notebook_id = ?1",
            params![notebook_id, name, now],
        )
        .map_err(|e| format!("刷新学习笔记本失败: {e}"))?;
    } else {
        conn.execute(
            "INSERT INTO notebooks (notebook_id, name, description, color, teacher, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, '', ?5, ?5)",
            params![
                notebook_id,
                name,
                "由学习流自动维护：每个单元的讲解会同步到一个 entry，编辑会双向同步回讲解。",
                "#3B82F6",
                now,
            ],
        )
        .map_err(|e| format!("创建学习笔记本失败: {e}"))?;
    }
    Ok(notebook_id)
}

/// 按需建/更新学习单元 entry。同 (session_id, unit_index) 对应同一 entry。
/// 1) 若 entry 不存在 → INSERT（source_kind='agent_unit'）
/// 2) 若已存在 → UPDATE content + title
/// 3) 回写 agent_unit_states.notebook_entry_id（幂等）
///
/// 返回 entry_id。
pub fn agent_upsert_unit_entry(
    conn: &Connection,
    session_id: &str,
    unit_index: usize,
    doc_title: &str,
    unit_title: &str,
    content: &str,
    page_start: Option<i64>,
    page_end: Option<i64>,
    page_indexes_json: &str,
) -> Result<String, String> {
    let notebook_id = agent_ensure_study_notebook(conn, session_id, doc_title)?;
    let entry_id = study_unit_entry_id(session_id, unit_index);
    let title = if unit_title.trim().is_empty() {
        format!("单元 {}", unit_index + 1)
    } else {
        unit_title.trim().to_string()
    };
    let now = chrono::Local::now().to_rfc3339();

    let existed: bool = conn
        .query_row(
            "SELECT 1 FROM notebook_entries WHERE entry_id = ?1",
            params![entry_id],
            |_| Ok(true),
        )
        .unwrap_or(false);

    if existed {
        conn.execute(
            "UPDATE notebook_entries
             SET title = ?2, content = ?3, updated_at = ?4
             WHERE entry_id = ?1",
            params![entry_id, title, content, now],
        )
        .map_err(|e| format!("更新学习单元 entry 失败: {e}"))?;
    } else {
        // 末尾追加 sort_order
        let max_order: i64 = conn
            .query_row(
                "SELECT COALESCE(MAX(sort_order), -1) FROM notebook_entries WHERE notebook_id = ?1",
                params![notebook_id],
                |r| r.get(0),
            )
            .unwrap_or(-1);
        let sort_order = max_order + 1;
        conn.execute(
            "INSERT INTO notebook_entries (
                entry_id, notebook_id, title, content, entry_type, source_info, sort_order,
                created_at, updated_at,
                source_session_id, source_page_start, source_page_end, source_page_indexes,
                source_kind, parent_entry_id, section_role, chat_history_json
             ) VALUES (?1, ?2, ?3, ?4, 'markdown', '', ?5, ?6, ?6, ?7, ?8, ?9, ?10, 'agent_unit', '', 'root_note', '')",
            params![
                entry_id,
                notebook_id,
                title,
                content,
                sort_order,
                now,
                session_id,
                page_start,
                page_end,
                page_indexes_json,
            ],
        )
        .map_err(|e| format!("创建学习单元 entry 失败: {e}"))?;
    }

    // 刷新笔记本 updated_at
    conn.execute(
        "UPDATE notebooks SET updated_at = ?2 WHERE notebook_id = ?1",
        params![notebook_id, now],
    )
    .ok();

    // 回写 agent_unit_states.notebook_entry_id（幂等）
    conn.execute(
        "UPDATE agent_unit_states
         SET notebook_entry_id = ?3
         WHERE session_id = ?1 AND unit_index = ?2",
        params![session_id, unit_index as i64, entry_id],
    )
    .ok();

    Ok(entry_id)
}

/// 查 (session_id, unit_index) 绑定的 notebook_entry_id（按需 fallback 到 deterministic id）。
/// 注意：返回值不保证 entry 真实存在，调用方需自行校验。
pub fn agent_get_unit_entry_id(
    conn: &Connection,
    session_id: &str,
    unit_index: usize,
) -> Result<Option<String>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT notebook_entry_id FROM agent_unit_states
             WHERE session_id = ?1 AND unit_index = ?2",
        )
        .map_err(|e| format!("查询单元 entry 绑定失败: {e}"))?;
    let row: Option<String> = stmt
        .query_row(params![session_id, unit_index as i64], |r| r.get(0))
        .ok();
    match row {
        Some(s) if !s.is_empty() => Ok(Some(s)),
        _ => Ok(None),
    }
}

/// 反查 entry 是否是某学习单元的绑定 entry，若是则返回 (session_id, unit_index)。
/// 用于 nb_update_entry 等编辑命令：当 entry 被改时，同步回写 teach_pack.explanation。
///
/// 判定优先级：
/// 1) entry source_kind = 'agent_unit'
/// 2) 解析 deterministic id `study-unit-{session_id}-{unit_index}`
///
/// 若 entry 不存在或不是单元 entry 返回 None。
pub fn nb_find_unit_binding(
    conn: &Connection,
    entry_id: &str,
) -> Result<Option<(String, usize)>, String> {
    let row: Option<(String, String)> = conn
        .query_row(
            "SELECT COALESCE(source_kind, ''), COALESCE(source_session_id, '')
             FROM notebook_entries WHERE entry_id = ?1",
            params![entry_id],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
        )
        .ok();
    let Some((source_kind, session_id)) = row else {
        return Ok(None);
    };
    if source_kind != "agent_unit" {
        return Ok(None);
    }
    // 解析 deterministic id 拿 unit_index：`study-unit-{session_id}-{unit_index}`
    let prefix = format!("study-unit-{}-", session_id);
    let Some(suffix) = entry_id.strip_prefix(&prefix) else {
        return Ok(None);
    };
    let unit_index: usize = suffix.parse().map_err(|_| {
        format!("entry_id 后缀不是合法 unit_index: {}", entry_id)
    })?;
    Ok(Some((session_id, unit_index)))
}

/// 写回 teach_pack.explanation。用于反向同步：用户编辑 unit-bound entry 时
/// 把新的 markdown 内容同步到 teach_pack.explanation，保持双向一致。
///
/// 若该 unit 尚无 teach_pack（不可能发生于编辑场景，但兜底处理），返回 Ok（noop）。
pub fn agent_save_explanation(
    conn: &Connection,
    session_id: &str,
    unit_index: usize,
    new_explanation: &str,
) -> Result<(), String> {
    let cur_json: Option<String> = conn
        .query_row(
            "SELECT teach_pack_json FROM agent_unit_states
             WHERE session_id = ?1 AND unit_index = ?2",
            params![session_id, unit_index as i64],
            |r| r.get(0),
        )
        .ok();
    let Some(cur_json) = cur_json else {
        return Ok(()); // unit 还没有 teach_pack，不操作
    };
    let mut pack: Value = if cur_json.trim().is_empty() {
        json!({})
    } else {
        serde_json::from_str(&cur_json).unwrap_or_else(|_| json!({}))
    };
    if !pack.is_object() {
        pack = json!({});
    }
    pack["explanation"] = Value::String(new_explanation.to_string());
    let new_json = serde_json::to_string(&pack)
        .map_err(|e| format!("teach_pack 序列化失败: {e}"))?;
    let now = chrono::Local::now().to_rfc3339();
    conn.execute(
        "UPDATE agent_unit_states
         SET teach_pack_json = ?3, updated_at = ?4
         WHERE session_id = ?1 AND unit_index = ?2",
        params![session_id, unit_index as i64, new_json, now],
    )
    .map_err(|e| format!("回写 teach_pack.explanation 失败: {e}"))?;
    Ok(())
}

/// 重置 Agent：清空路线图 + 全部单元状态。
/// session 仍保留，doc_pages / doc_page_notes 不动（笔记是用户产物）。
pub fn agent_reset(conn: &Connection, session_id: &str) -> Result<(), String> {
    conn.execute(
        "DELETE FROM agent_plans WHERE session_id = ?1",
        params![session_id],
    )
    .map_err(|e| format!("清空路线图失败: {e}"))?;
    conn.execute(
        "DELETE FROM agent_unit_states WHERE session_id = ?1",
        params![session_id],
    )
    .map_err(|e| format!("清空单元状态失败: {e}"))?;
    Ok(())
}

// ════════════════════════════════════════════════════════════════════════════
// 学习流档案（archive）：保留学习历史，"重新生成"前可归档当前进度
// ════════════════════════════════════════════════════════════════════════════

/// 把当前 session 的 active 学习流（plan + 全部 unit_states）打包为一个档案。
///
/// 使用场景：用户点"重新生成路线图"前，先调用此函数把当前进度存档；
/// 之后即使 active 区被清空（agent_reset），用户也能从档案列表里恢复。
///
/// `name`: 用户给档案的名字（前端 wizard 自动填或用户输入）。
/// `flow_config_json`: 该流的 wizard 配置（难度/范围/目标 JSON 字符串），可空。
/// `clarify_qa_json`: wizard 问答原文 JSON，可空。
///
/// 返回新建档案的 archive_id。当前 active 区**没有 plan** 时返回错误（不归档空数据）。
pub fn agent_archive_save(
    conn: &Connection,
    session_id: &str,
    name: &str,
    flow_config_json: &str,
    clarify_qa_json: &str,
) -> Result<String, String> {
    // 拉取 active 数据
    let state = agent_get_state(conn, session_id)?;
    let plan = state.get("plan").cloned().unwrap_or(Value::Null);
    if plan.is_null() {
        return Err("当前没有可归档的学习流（尚未生成路线图）".to_string());
    }
    let unit_states = state.get("unit_states").cloned().unwrap_or(json!([]));
    let snapshot = json!({
        "plan": plan,
        "unit_states": unit_states,
    });
    let snapshot_json =
        serde_json::to_string(&snapshot).map_err(|e| format!("序列化快照失败: {e}"))?;

    let archive_id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Local::now().to_rfc3339();
    let final_name = if name.trim().is_empty() {
        format!("学习档案 {}", chrono::Local::now().format("%m-%d %H:%M"))
    } else {
        name.to_string()
    };

    // v7 (2026-05) "同一学习流只保留一份档案"约束：
    //   每个 session 在 agent_flow_archives 中只允许有一份记录。
    //   写入新档案前，把该 session 历史所有档案及其挂载的 stream_notes 全清空。
    //   这与之前"只滚动 auto-archive"的策略不同 —— 用户主动 archive_save 也会
    //   覆盖之前的所有档案，避免无限堆积。
    purge_all_archives_for_session(conn, session_id);

    conn.execute(
        "INSERT INTO agent_flow_archives
            (archive_id, session_id, name, snapshot_json, flow_config_json, clarify_qa_json, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            archive_id,
            session_id,
            final_name,
            snapshot_json,
            flow_config_json,
            clarify_qa_json,
            now
        ],
    )
    .map_err(|e| format!("写入档案失败: {e}"))?;

    Ok(archive_id)
}

/// 清理某 session 的所有归档（含手动+自动）以及它们挂载的 stream_notes。
/// 用于 "同一 session 只保留一份档案" 约束 — 写入新档案前调用。
/// 失败仅 warn，不抛错。
fn purge_all_archives_for_session(conn: &Connection, session_id: &str) {
    // 先收集所有 archive_id，再分别清理（避免外键级联依赖）
    let ids: Vec<String> = match conn.prepare(
        "SELECT archive_id FROM agent_flow_archives WHERE session_id = ?1",
    ) {
        Ok(mut stmt) => stmt
            .query_map(params![session_id], |r| r.get::<_, String>(0))
            .ok()
            .map(|rows| rows.filter_map(|r| r.ok()).collect())
            .unwrap_or_default(),
        Err(e) => {
            log::warn!("[purge_archives] 查询失败: {e}");
            return;
        }
    };
    for old_id in &ids {
        if let Err(e) = conn.execute(
            "DELETE FROM agent_stream_notes WHERE archive_id = ?1",
            params![old_id],
        ) {
            log::warn!("[purge_archives] 清理 stream_notes 失败 {old_id}: {e}");
        }
        if let Err(e) = conn.execute(
            "DELETE FROM agent_flow_archives WHERE archive_id = ?1",
            params![old_id],
        ) {
            log::warn!("[purge_archives] 删除档案失败 {old_id}: {e}");
        }
    }
    if !ids.is_empty() {
        log::info!(
            "[purge_archives] {session_id} 清理了 {} 份历史档案（同一学习流只保留一份）",
            ids.len()
        );
    }
}

/// v6 (2026-05) #3+ 自动归档：在"破坏性操作"（agent_reset / plan_generate force=true）之前
/// 静默保存一份学习流档案。和 `agent_archive_save` 的差异：
///   - 当前没有 plan 时**返回 None 而不是错误**（首次生成不需要归档）
///   - 自动起名为 "自动归档 — MM-DD HH:MM"，并把触发原因写到 flow_config_json
///   - 任何失败仅 log::warn，不向上抛错（自动归档失败不能阻断用户操作）
///
/// 返回新建档案的 archive_id（None 表示无 plan 跳过 / 失败）。
pub fn agent_auto_archive_if_active(
    conn: &Connection,
    session_id: &str,
    reason: &str,
) -> Option<String> {
    // 先确认有 plan，避免给空 plan 调用 agent_archive_save 拿 Err
    let state = match agent_get_state(conn, session_id) {
        Ok(s) => s,
        Err(e) => {
            log::warn!("[auto_archive] 取 agent_state 失败({session_id}): {e}");
            return None;
        }
    };
    if state.get("plan").map(|v| v.is_null()).unwrap_or(true) {
        return None;
    }

    // v7 (2026-05) "同一 session 只保留一份档案" 由 agent_archive_save 内部统一清理，
    // 这里不再重复 collect_auto_archive_ids 逻辑。

    let name = format!(
        "自动归档 — {}",
        chrono::Local::now().format("%m-%d %H:%M:%S")
    );
    let flow_config = json!({ "auto": true, "reason": reason }).to_string();
    match agent_archive_save(conn, session_id, &name, &flow_config, "") {
        Ok(archive_id) => {
            // 同步把当前 active 学习流笔记打上归档标签，
            // 这样档案复习时能拉出对应轮次的 unit explanations。
            let tagged = agent_stream_notes_tag_archive(conn, session_id, &archive_id)
                .unwrap_or_else(|e| {
                    log::warn!("[auto_archive] tag stream_notes 失败: {e}");
                    0
                });
            log::info!(
                "[auto_archive] {session_id} → {archive_id} (reason: {reason}, tagged {tagged} notes)"
            );
            Some(archive_id)
        }
        Err(e) => {
            log::warn!("[auto_archive] {session_id} 失败({reason}): {e}");
            None
        }
    }
}

/// 收集该 session 所有"自动归档"的 archive_id（flow_config_json 含 `"auto":true`）。
/// 用 LIKE 模糊匹配，避免 JSON 解析开销 —— flow_config 写入是固定格式所以稳定。
///
/// v7 (2026-05) 注：现在 agent_archive_save 内统一调 purge_all_archives_for_session
/// 清理所有档案，本函数已无调用方，保留以备将来"只清自动归档"语义复用。
#[allow(dead_code)]
fn collect_auto_archive_ids(
    conn: &Connection,
    session_id: &str,
) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT archive_id FROM agent_flow_archives
             WHERE session_id = ?1
               AND flow_config_json LIKE '%\"auto\":true%'",
        )
        .map_err(|e| format!("准备 auto-archive 查询失败: {e}"))?;
    let rows = stmt
        .query_map(params![session_id], |r| r.get::<_, String>(0))
        .map_err(|e| format!("查询 auto-archive 失败: {e}"))?;
    let mut out = Vec::new();
    for r in rows {
        if let Ok(s) = r {
            out.push(s);
        }
    }
    Ok(out)
}

/// 列出某 session 的所有档案（按创建时间倒序）。
/// 返回数组，每项含元信息（不含 snapshot 大字段，节省 IPC 体积）。
pub fn agent_archive_list(conn: &Connection, session_id: &str) -> Result<Value, String> {
    let mut stmt = conn
        .prepare(
            "SELECT archive_id, name, flow_config_json, clarify_qa_json, created_at,
                    -- 顺手解析快照里的元信息：unit 数量、当前 unit、phase
                    snapshot_json
             FROM agent_flow_archives
             WHERE session_id = ?1
             ORDER BY created_at DESC",
        )
        .map_err(|e| format!("查询档案列表失败: {e}"))?;
    let rows = stmt
        .query_map(params![session_id], |r| {
            let snapshot: String = r.get(5)?;
            // 提取摘要信息（safe parse，失败就给 0）
            let (unit_total, current_unit, current_phase) =
                if let Ok(v) = serde_json::from_str::<Value>(&snapshot) {
                    let total = v
                        .get("plan")
                        .and_then(|p| p.get("outline"))
                        .and_then(|o| o.get("units"))
                        .and_then(|u| u.as_array())
                        .map(|a| a.len() as i64)
                        .unwrap_or(0);
                    let cur = v
                        .get("plan")
                        .and_then(|p| p.get("current_unit"))
                        .and_then(|x| x.as_i64())
                        .unwrap_or(0);
                    let ph = v
                        .get("plan")
                        .and_then(|p| p.get("current_phase"))
                        .and_then(|x| x.as_str())
                        .unwrap_or("idle")
                        .to_string();
                    (total, cur, ph)
                } else {
                    (0_i64, 0_i64, "idle".to_string())
                };

            let flow_cfg_str: String = r.get(2)?;
            let flow_config: Value =
                serde_json::from_str(&flow_cfg_str).unwrap_or(Value::Null);

            Ok(json!({
                "archive_id": r.get::<_, String>(0)?,
                "name": r.get::<_, String>(1)?,
                "flow_config": flow_config,
                "clarify_qa_json": r.get::<_, String>(3)?,
                "created_at": r.get::<_, String>(4)?,
                "unit_total": unit_total,
                "current_unit": current_unit,
                "current_phase": current_phase,
            }))
        })
        .map_err(|e| format!("遍历档案失败: {e}"))?;
    let list: Vec<Value> = rows.filter_map(|r| r.ok()).collect();
    Ok(Value::Array(list))
}

/// 把指定档案的快照恢复到 active 区。
///
/// **重要**：调用方应该在恢复前自己决定是否先把当前 active 状态再 archive 一次
/// （避免覆盖丢失）。本函数只负责"覆盖式恢复"。
pub fn agent_archive_restore(conn: &Connection, archive_id: &str) -> Result<(), String> {
    // 1) 拉档案数据
    let (session_id, snapshot_json) = {
        let mut stmt = conn
            .prepare(
                "SELECT session_id, snapshot_json FROM agent_flow_archives
                 WHERE archive_id = ?1",
            )
            .map_err(|e| format!("查档案失败: {e}"))?;
        stmt.query_row(params![archive_id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })
        .map_err(|e| format!("档案不存在: {e}"))?
    };

    let snapshot: Value =
        serde_json::from_str(&snapshot_json).map_err(|e| format!("解析档案失败: {e}"))?;
    let plan = snapshot.get("plan").cloned().unwrap_or(Value::Null);
    let unit_states = snapshot
        .get("unit_states")
        .and_then(|x| x.as_array())
        .cloned()
        .unwrap_or_default();
    if plan.is_null() {
        return Err("档案数据损坏：plan 为空".to_string());
    }

    // 2) 清空 active
    agent_reset(conn, &session_id)?;

    // 3) 写回 plan
    let outline_json =
        serde_json::to_string(plan.get("outline").unwrap_or(&Value::Null))
            .map_err(|e| format!("序列化 outline 失败: {e}"))?;
    let page_total = plan.get("page_total").and_then(|x| x.as_i64()).unwrap_or(0) as usize;
    let current_unit = plan
        .get("current_unit")
        .and_then(|x| x.as_i64())
        .unwrap_or(0) as usize;
    let current_phase = plan
        .get("current_phase")
        .and_then(|x| x.as_str())
        .unwrap_or("idle");
    agent_save_plan(conn, &session_id, &outline_json, page_total)?;
    agent_set_phase(conn, &session_id, current_unit, current_phase)?;

    // 4) 写回 unit_states（教学包 + 答题）
    for us in unit_states.iter() {
        let unit_index = us
            .get("unit_index")
            .and_then(|x| x.as_i64())
            .unwrap_or(-1);
        if unit_index < 0 {
            continue;
        }
        let teach_pack = us.get("teach_pack").cloned().unwrap_or(Value::Null);
        let answers = us
            .get("answers")
            .and_then(|x| x.as_array())
            .cloned()
            .unwrap_or_default();
        let status = us
            .get("status")
            .and_then(|x| x.as_str())
            .unwrap_or("pending")
            .to_string();

        if !teach_pack.is_null() {
            let tp_json = serde_json::to_string(&teach_pack)
                .map_err(|e| format!("序列化教学包失败: {e}"))?;
            agent_save_teach_pack(conn, &session_id, unit_index as usize, &tp_json)?;
        }

        if !answers.is_empty() {
            let ans_json = serde_json::to_string(&Value::Array(answers))
                .map_err(|e| format!("序列化答案失败: {e}"))?;
            agent_save_answers(conn, &session_id, unit_index as usize, &ans_json)?;
        }

        // 修正 status（agent_save_answers 默认推到 done；teach_pack 单独保存推到 probing）
        let now = chrono::Local::now().to_rfc3339();
        conn.execute(
            "UPDATE agent_unit_states SET status = ?3, updated_at = ?4
             WHERE session_id = ?1 AND unit_index = ?2",
            params![session_id, unit_index, status, now],
        )
        .map_err(|e| format!("修正状态失败: {e}"))?;
    }

    // 5) v6 #3++ 修复（用户反馈："回档学习流功能失效"）：
    //    把档案的 stream_notes 复制为 active 状态（archive_id='')，让讲解流笔记跟随恢复。
    //    - 先清空 active 区残留（reset 前的 auto_archive 应已 tag 走，这里兜底防止数据漂移）
    //    - 用 INSERT INTO ... SELECT 复制，note_id 由 AUTOINCREMENT 重新生成，避免 PK 冲突
    conn.execute(
        "DELETE FROM agent_stream_notes WHERE session_id = ?1 AND archive_id = ''",
        params![session_id],
    )
    .map_err(|e| format!("清空 active stream_notes 失败: {e}"))?;
    conn.execute(
        "INSERT INTO agent_stream_notes
            (session_id, archive_id, unit_index, anchor_page, unit_title, content, created_at)
         SELECT session_id, '', unit_index, anchor_page, unit_title, content, created_at
         FROM agent_stream_notes
         WHERE session_id = ?1 AND archive_id = ?2",
        params![session_id, archive_id],
    )
    .map_err(|e| format!("复制档案 stream_notes 失败: {e}"))?;

    Ok(())
}

/// 删除某档案。
pub fn agent_archive_delete(conn: &Connection, archive_id: &str) -> Result<(), String> {
    conn.execute(
        "DELETE FROM agent_flow_archives WHERE archive_id = ?1",
        params![archive_id],
    )
    .map_err(|e| format!("删除档案失败: {e}"))?;
    Ok(())
}

/// 重命名档案。
pub fn agent_archive_rename(
    conn: &Connection,
    archive_id: &str,
    new_name: &str,
) -> Result<(), String> {
    conn.execute(
        "UPDATE agent_flow_archives SET name = ?2 WHERE archive_id = ?1",
        params![archive_id, new_name],
    )
    .map_err(|e| format!("重命名档案失败: {e}"))?;
    Ok(())
}

// ══════════════════════════════════════════════════════════════════════════════
// 训练模块 CRUD
// ══════════════════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════════════════
// v5 (2026-05) B2: training_unit_packs —— 单元 pre-generated 训练题集
// ════════════════════════════════════════════════════════════════════════════

/// 写入或覆盖某单元的训练题集。
pub fn tup_save(
    conn: &Connection,
    session_id: &str,
    unit_index: usize,
    pack_json: &str,
) -> Result<(), String> {
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO training_unit_packs (session_id, unit_index, pack_json, generated_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(session_id, unit_index) DO UPDATE SET
            pack_json = excluded.pack_json,
            generated_at = excluded.generated_at",
        params![session_id, unit_index as i64, pack_json, now],
    )
    .map_err(|e| format!("保存单元训练包失败: {e}"))?;
    Ok(())
}

/// 取某单元的训练题集（解析后的 JSON）。不存在返回 `Ok(None)`。
pub fn tup_get(
    conn: &Connection,
    session_id: &str,
    unit_index: usize,
) -> Result<Option<Value>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT pack_json, generated_at FROM training_unit_packs
             WHERE session_id = ?1 AND unit_index = ?2",
        )
        .map_err(|e| format!("准备 SQL 失败: {e}"))?;
    let row_res = stmt.query_row(params![session_id, unit_index as i64], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
    });
    let (pack_json, generated_at) = match row_res {
        Ok(t) => t,
        Err(rusqlite::Error::QueryReturnedNoRows) => return Ok(None),
        Err(e) => return Err(format!("查询单元训练包失败: {e}")),
    };
    let pack: Value = serde_json::from_str(&pack_json).unwrap_or(Value::Null);
    Ok(Some(json!({
        "session_id": session_id,
        "unit_index": unit_index,
        "pack": pack,
        "generated_at": generated_at,
    })))
}

/// 列出某 session 已生成的所有单元训练包索引（用于前端 UI 标记 ready 状态）。
/// 返回简短摘要，不带完整 pack_json。
pub fn tup_list_session(
    conn: &Connection,
    session_id: &str,
) -> Result<Vec<Value>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT unit_index, generated_at,
                    json_array_length(json_extract(pack_json, '$.questions')) AS qcount
             FROM training_unit_packs
             WHERE session_id = ?1
             ORDER BY unit_index ASC",
        )
        .map_err(|e| format!("准备 SQL 失败: {e}"))?;
    let rows = stmt
        .query_map(params![session_id], |r| {
            Ok(json!({
                "unit_index": r.get::<_, i64>(0)?,
                "generated_at": r.get::<_, String>(1)?,
                "question_count": r.get::<_, Option<i64>>(2)?.unwrap_or(0),
            }))
        })
        .map_err(|e| format!("查询训练包索引失败: {e}"))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| format!("行解析失败: {e}"))?);
    }
    Ok(out)
}

/// 删除某单元的训练包（用户重置学习时调用）。
pub fn tup_delete(
    conn: &Connection,
    session_id: &str,
    unit_index: Option<usize>,
) -> Result<(), String> {
    if let Some(idx) = unit_index {
        conn.execute(
            "DELETE FROM training_unit_packs WHERE session_id = ?1 AND unit_index = ?2",
            params![session_id, idx as i64],
        )
        .map_err(|e| format!("删除单元训练包失败: {e}"))?;
    } else {
        conn.execute(
            "DELETE FROM training_unit_packs WHERE session_id = ?1",
            params![session_id],
        )
        .map_err(|e| format!("批量删除单元训练包失败: {e}"))?;
    }
    Ok(())
}

/// 插入一条答题记录。
#[allow(clippy::too_many_arguments)]
pub fn training_save_attempt(
    conn: &Connection,
    attempt_id: &str,
    session_id: &str,
    unit_index: Option<i64>,
    question_id: &str,
    question_json: &str,
    user_answer: &str,
    code_run_json: Option<&str>,
    grade_json: &str,
    skills_json: &str,
    score: i64,
    is_correct: bool,
) -> Result<(), String> {
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO training_attempts (
            attempt_id, session_id, unit_index, question_id, question_json,
            user_answer, code_run_json, grade_json, skills_json, score, is_correct, created_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        params![
            attempt_id, session_id, unit_index, question_id, question_json,
            user_answer, code_run_json, grade_json, skills_json,
            score, if is_correct { 1 } else { 0 }, now,
        ],
    )
    .map_err(|e| format!("保存训练记录失败: {e}"))?;
    Ok(())
}

/// 取最近 N 条答题记录（按时间倒序）。
pub fn training_list_attempts(
    conn: &Connection,
    session_id: &str,
    limit: i64,
) -> Result<Vec<Value>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT attempt_id, unit_index, question_id, question_json, user_answer,
                    code_run_json, grade_json, skills_json, score, is_correct, created_at
             FROM training_attempts
             WHERE session_id = ?1
             ORDER BY created_at DESC
             LIMIT ?2",
        )
        .map_err(|e| format!("准备 SQL 失败: {e}"))?;
    let rows = stmt
        .query_map(params![session_id, limit], |row| {
            let q_json: String = row.get(3)?;
            let g_json: String = row.get(6)?;
            let s_json: String = row.get(7)?;
            let cr_json: Option<String> = row.get(5)?;
            Ok(json!({
                "attempt_id": row.get::<_, String>(0)?,
                "unit_index": row.get::<_, Option<i64>>(1)?,
                "question_id": row.get::<_, String>(2)?,
                "question": serde_json::from_str::<Value>(&q_json).unwrap_or(Value::Null),
                "user_answer": row.get::<_, String>(4)?,
                "code_run": cr_json.and_then(|s| serde_json::from_str::<Value>(&s).ok()),
                "grade": serde_json::from_str::<Value>(&g_json).unwrap_or(Value::Null),
                "skills": serde_json::from_str::<Value>(&s_json).unwrap_or(json!([])),
                "score": row.get::<_, i64>(8)?,
                "is_correct": row.get::<_, i64>(9)? != 0,
                "created_at": row.get::<_, String>(10)?,
            }))
        })
        .map_err(|e| format!("查询训练记录失败: {e}"))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| format!("行解析失败: {e}"))?);
    }
    Ok(out)
}

/// 增量更新某 (session, skill) 的掌握度。
/// `delta_mastery`：本次的增减量（答对 +0.05；答错 -0.02）；做 clamp 到 [0,1]。
/// 同时累加 practice_count；is_correct=true 时累加 correct_count。
pub fn skill_mastery_bump(
    conn: &Connection,
    session_id: &str,
    skill_id: &str,
    delta_mastery: f64,
    is_correct: bool,
) -> Result<(), String> {
    let now = chrono::Utc::now().to_rfc3339();
    // UPSERT 写法：先尝试 update；行数为 0 则 insert
    let updated = conn
        .execute(
            "UPDATE skill_mastery
             SET mastery = MIN(1.0, MAX(0.0, mastery + ?3)),
                 practice_count = practice_count + 1,
                 correct_count = correct_count + ?4,
                 last_practiced_at = ?5
             WHERE session_id = ?1 AND skill_id = ?2",
            params![
                session_id, skill_id, delta_mastery,
                if is_correct { 1 } else { 0 }, now,
            ],
        )
        .map_err(|e| format!("UPDATE skill_mastery 失败: {e}"))?;
    if updated == 0 {
        let initial = (delta_mastery.max(0.0)).min(1.0);
        conn.execute(
            "INSERT INTO skill_mastery (
                session_id, skill_id, mastery, practice_count, correct_count, last_practiced_at
             ) VALUES (?1, ?2, ?3, 1, ?4, ?5)",
            params![
                session_id, skill_id, initial,
                if is_correct { 1 } else { 0 }, now,
            ],
        )
        .map_err(|e| format!("INSERT skill_mastery 失败: {e}"))?;
    }
    Ok(())
}

/// 取一个会话的全部技能进度（用 skill_id → row 的形式返回）。
pub fn skill_mastery_list(
    conn: &Connection,
    session_id: &str,
) -> Result<Vec<Value>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT skill_id, mastery, practice_count, correct_count, last_practiced_at
             FROM skill_mastery
             WHERE session_id = ?1",
        )
        .map_err(|e| format!("准备 SQL 失败: {e}"))?;
    let rows = stmt
        .query_map(params![session_id], |row| {
            Ok(json!({
                "skill_id": row.get::<_, String>(0)?,
                "mastery": row.get::<_, f64>(1)?,
                "practice_count": row.get::<_, i64>(2)?,
                "correct_count": row.get::<_, i64>(3)?,
                "last_practiced_at": row.get::<_, Option<String>>(4)?,
            }))
        })
        .map_err(|e| format!("查询技能掌握度失败: {e}"))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| format!("行解析失败: {e}"))?);
    }
    Ok(out)
}

// ── v4 (2026-05) user_skills 全局技能字典 ───────────────────────────────────

/// upsert 一行 user_skills。如果已存在，仅在 name/category/description 任一项为空时补全
/// （不会用空值覆盖用户编辑过的内容）；created_at 不变，updated_at 刷新。
///
/// LLM 评分时调用：保证每个出现在 attempt.skills 里的 skill_id 都能在 SkillsPage 上看见。
pub fn user_skill_ensure(
    conn: &Connection,
    skill_id: &str,
    name: &str,
    category: &str,
    description: &str,
) -> Result<(), String> {
    if skill_id.trim().is_empty() {
        return Ok(());
    }
    let now = chrono::Local::now().to_rfc3339();
    // 已存在 → 只补空字段；不存在 → 全字段插入
    let existing: Option<(String, String, String)> = conn
        .query_row(
            "SELECT name, category, description FROM user_skills WHERE skill_id = ?1",
            params![skill_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .ok();
    match existing {
        Some((cur_name, cur_cat, cur_desc)) => {
            let new_name = if cur_name.trim().is_empty() { name } else { &cur_name };
            let new_cat = if cur_cat.trim().is_empty() { category } else { &cur_cat };
            let new_desc = if cur_desc.trim().is_empty() {
                description
            } else {
                &cur_desc
            };
            conn.execute(
                "UPDATE user_skills SET name = ?2, category = ?3, description = ?4, updated_at = ?5
                 WHERE skill_id = ?1",
                params![skill_id, new_name, new_cat, new_desc, now],
            )
            .map_err(|e| format!("UPDATE user_skills 失败: {e}"))?;
        }
        None => {
            let final_name = if name.trim().is_empty() { skill_id } else { name };
            conn.execute(
                "INSERT INTO user_skills (skill_id, name, category, description, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
                params![skill_id, final_name, category, description, now],
            )
            .map_err(|e| format!("INSERT user_skills 失败: {e}"))?;
        }
    }
    Ok(())
}

/// 列出所有 user_skills（叠加跨会话 mastery 聚合，方便前端一次显示）。
/// 返回 `[{skill_id, name, category, description, avg_mastery, sessions_count, total_attempts}]`。
pub fn user_skills_list(conn: &Connection) -> Result<Vec<Value>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT us.skill_id, us.name, us.category, us.description,
                    COALESCE(AVG(sm.mastery), 0) AS avg_mastery,
                    COUNT(DISTINCT sm.session_id) AS sessions_count,
                    COALESCE(SUM(sm.practice_count), 0) AS total_attempts
             FROM user_skills us
             LEFT JOIN skill_mastery sm ON sm.skill_id = us.skill_id
             GROUP BY us.skill_id
             ORDER BY us.category ASC, us.name ASC",
        )
        .map_err(|e| format!("准备 user_skills_list SQL 失败: {e}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok(json!({
                "skill_id": row.get::<_, String>(0)?,
                "name": row.get::<_, String>(1)?,
                "category": row.get::<_, String>(2)?,
                "description": row.get::<_, String>(3)?,
                "avg_mastery": row.get::<_, f64>(4)?,
                "sessions_count": row.get::<_, i64>(5)?,
                "total_attempts": row.get::<_, i64>(6)?,
            }))
        })
        .map_err(|e| format!("查询 user_skills 失败: {e}"))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| format!("行解析失败: {e}"))?);
    }
    Ok(out)
}

/// 重命名 / 编辑 user_skill（name / category / description）。skill_id 不可改。
pub fn user_skill_update(
    conn: &Connection,
    skill_id: &str,
    name: Option<&str>,
    category: Option<&str>,
    description: Option<&str>,
) -> Result<(), String> {
    let now = chrono::Local::now().to_rfc3339();
    // 用 COALESCE 半套：参数为 None 时保持原值
    conn.execute(
        "UPDATE user_skills SET
           name        = COALESCE(?2, name),
           category    = COALESCE(?3, category),
           description = COALESCE(?4, description),
           updated_at  = ?5
         WHERE skill_id = ?1",
        params![skill_id, name, category, description, now],
    )
    .map_err(|e| format!("UPDATE user_skills 失败: {e}"))?;
    Ok(())
}

/// 合并两个 skill：把 from_id 的 skill_mastery 行聚合到 to_id，然后删除 from_id 的所有数据。
///
/// 合并规则（per session）：
///   - mastery：取较大值（保留更高熟练度，不让用户合并后"降级"）
///   - practice_count / correct_count：累加
///   - last_practiced_at：取较晚（max）
///
/// 注意：training_attempts.skills_json 不动 —— 历史记录保持原 skill_id 引用（前端展示时按需 fallback）。
pub fn user_skill_merge(
    conn: &Connection,
    from_id: &str,
    to_id: &str,
) -> Result<(), String> {
    if from_id == to_id {
        return Ok(());
    }
    // 把 from 的每个 session 行合并进 to
    let mut stmt = conn
        .prepare(
            "SELECT session_id, mastery, practice_count, correct_count, last_practiced_at
             FROM skill_mastery WHERE skill_id = ?1",
        )
        .map_err(|e| format!("准备 SELECT skill_mastery 失败: {e}"))?;
    let rows: Vec<(String, f64, i64, i64, Option<String>)> = stmt
        .query_map(params![from_id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
        })
        .map_err(|e| format!("查询 skill_mastery 失败: {e}"))?
        .filter_map(|r| r.ok())
        .collect();
    drop(stmt);
    for (sid, f_mastery, f_prac, f_corr, f_last) in rows {
        let existing: Option<(f64, i64, i64, Option<String>)> = conn
            .query_row(
                "SELECT mastery, practice_count, correct_count, last_practiced_at
                 FROM skill_mastery WHERE session_id = ?1 AND skill_id = ?2",
                params![sid, to_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .ok();
        match existing {
            Some((t_m, t_p, t_c, t_last)) => {
                // 合并到 to
                let merged_mastery = if f_mastery > t_m { f_mastery } else { t_m };
                let merged_prac = t_p + f_prac;
                let merged_corr = t_c + f_corr;
                let merged_last = match (f_last.as_deref(), t_last.as_deref()) {
                    (Some(a), Some(b)) => Some(if a > b { a.to_string() } else { b.to_string() }),
                    (Some(a), None) => Some(a.to_string()),
                    (None, Some(b)) => Some(b.to_string()),
                    (None, None) => None,
                };
                conn.execute(
                    "UPDATE skill_mastery SET mastery = ?3, practice_count = ?4,
                       correct_count = ?5, last_practiced_at = ?6
                     WHERE session_id = ?1 AND skill_id = ?2",
                    params![sid, to_id, merged_mastery, merged_prac, merged_corr, merged_last],
                )
                .map_err(|e| format!("UPDATE merged skill_mastery 失败: {e}"))?;
            }
            None => {
                // 直接 INSERT 一份新 (sid, to_id)
                conn.execute(
                    "INSERT INTO skill_mastery
                       (session_id, skill_id, mastery, practice_count, correct_count, last_practiced_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![sid, to_id, f_mastery, f_prac, f_corr, f_last],
                )
                .map_err(|e| format!("INSERT merged skill_mastery 失败: {e}"))?;
            }
        }
    }
    // 删 from 的 skill_mastery
    conn.execute(
        "DELETE FROM skill_mastery WHERE skill_id = ?1",
        params![from_id],
    )
    .map_err(|e| format!("DELETE skill_mastery (from) 失败: {e}"))?;
    // 删 from 的 user_skills
    conn.execute(
        "DELETE FROM user_skills WHERE skill_id = ?1",
        params![from_id],
    )
    .map_err(|e| format!("DELETE user_skills (from) 失败: {e}"))?;
    // 保证 to 存在 user_skills（如果 from 是新建但 to 不存在则补一行）
    // 这里假定调用方已确保 to_id 存在 user_skills 表
    Ok(())
}

/// 删除一个 skill：删 user_skills + 级联删 skill_mastery；training_attempts 历史保留。
pub fn user_skill_delete(conn: &Connection, skill_id: &str) -> Result<(), String> {
    conn.execute(
        "DELETE FROM skill_mastery WHERE skill_id = ?1",
        params![skill_id],
    )
    .map_err(|e| format!("DELETE skill_mastery 失败: {e}"))?;
    conn.execute(
        "DELETE FROM user_skills WHERE skill_id = ?1",
        params![skill_id],
    )
    .map_err(|e| format!("DELETE user_skills 失败: {e}"))?;
    Ok(())
}

/// 训练统计（总题数 / 总分 / 准确率）。
pub fn training_stats(conn: &Connection, session_id: &str) -> Result<Value, String> {
    let mut stmt = conn
        .prepare(
            "SELECT
                COUNT(*) AS total,
                COALESCE(SUM(score), 0) AS sum_score,
                COALESCE(SUM(is_correct), 0) AS sum_correct
             FROM training_attempts WHERE session_id = ?1",
        )
        .map_err(|e| format!("准备 SQL 失败: {e}"))?;
    let row = stmt
        .query_row(params![session_id], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, i64>(2)?,
            ))
        })
        .map_err(|e| format!("查询训练统计失败: {e}"))?;
    let (total, sum_score, sum_correct) = row;
    let accuracy = if total > 0 {
        sum_correct as f64 / total as f64
    } else {
        0.0
    };
    let avg_score = if total > 0 {
        sum_score as f64 / total as f64
    } else {
        0.0
    };
    Ok(json!({
        "total_attempts": total,
        "total_correct": sum_correct,
        "avg_score": avg_score,
        "accuracy": accuracy,
    }))
}

/// === Migration: 修复 teach_pack.extra_questions 中重复的 qE id ============
///
/// 历史 bug：早期 prompt 让 LLM 每次"再来 N 道"都从 `qE1` 开始编号，多次点击
/// 后 DB 里同一个 k_idx 下会出现重复 id（k0qE1 出现 3 次等）。前端按 id 去重
/// 后只能恢复 3 道，超出的丢失。
///
/// 这里在启动时扫描所有 agent_unit_states，对每个 unit 的 extra_questions[k_idx]：
///   - 检查是否有重复 id；没有就跳过（**幂等**）
///   - 有重复就按出现顺序重新分配 `k{k_idx}qE{1..N}`，写回 DB
///
/// 安全性：answers_json 里只引用核心题（teach_pack.questions）的 id，不引用
/// extras 的 id，所以重编号 extras 不会断引用。
/// 加题数量上限（每个知识点）。超出从最旧开始丢。
/// 早期 prompt bug 导致历史数据可能堆积 9+ 道；上限是产品决策。
pub const MAX_EXTRAS_PER_KIDX: usize = 5;

pub fn migrate_dedupe_extra_quiz_ids(conn: &Connection) -> Result<(), Box<dyn std::error::Error>> {
    use std::collections::HashSet;

    let rows: Vec<(String, i64, String)> = {
        let mut stmt = conn.prepare(
            "SELECT session_id, unit_index, teach_pack_json FROM agent_unit_states",
        )?;
        let it = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?;
        it.filter_map(|r| r.ok()).collect()
    };

    let mut fixed_units = 0_usize;
    let mut renumbered_total = 0_usize;
    let mut trimmed_total = 0_usize;
    for (session_id, unit_index, teach_pack_json) in rows {
        if teach_pack_json.is_empty() {
            continue;
        }
        let mut tp: Value = match serde_json::from_str(&teach_pack_json) {
            Ok(v) => v,
            Err(_) => continue,
        };

        let extras_obj = match tp
            .get_mut("extra_questions")
            .and_then(|x| x.as_object_mut())
        {
            Some(m) => m,
            None => continue,
        };

        let mut unit_changed = false;
        for (k_idx_str, qs) in extras_obj.iter_mut() {
            let arr = match qs.as_array_mut() {
                Some(a) => a,
                None => continue,
            };

            // ── Step 1: 按 MAX_EXTRAS_PER_KIDX 裁断（保留最新的，即末尾 N 道）
            //   早期堆积的脏数据从这里收口。array 头部 = 最早生成。
            if arr.len() > MAX_EXTRAS_PER_KIDX {
                let drop_n = arr.len() - MAX_EXTRAS_PER_KIDX;
                arr.drain(0..drop_n);
                trimmed_total += drop_n;
                unit_changed = true;
            }

            // ── Step 2: 检查重复 id 或缺失 id，重新分配
            let mut seen: HashSet<String> = HashSet::new();
            let mut has_issue = false;
            for q in arr.iter() {
                match q.get("id").and_then(|x| x.as_str()) {
                    Some(id) => {
                        if !seen.insert(id.to_string()) {
                            has_issue = true;
                            break;
                        }
                    }
                    None => {
                        has_issue = true;
                        break;
                    }
                }
            }
            if !has_issue {
                continue;
            }

            // 按出现顺序重新分配 id：k{k_idx}qE{1..N}
            for (i, q) in arr.iter_mut().enumerate() {
                let new_id = format!("k{}qE{}", k_idx_str, i + 1);
                if let Some(obj) = q.as_object_mut() {
                    obj.insert("id".to_string(), Value::String(new_id));
                }
            }
            renumbered_total += arr.len();
            unit_changed = true;
        }

        if unit_changed {
            let new_json = serde_json::to_string(&tp)?;
            conn.execute(
                "UPDATE agent_unit_states SET teach_pack_json = ?1
                 WHERE session_id = ?2 AND unit_index = ?3",
                params![new_json, session_id, unit_index],
            )?;
            fixed_units += 1;
        }
    }

    if fixed_units > 0 {
        log::info!(
            "migrate_dedupe_extra_quiz_ids: 修复 {} 个 unit（重编号 {} 题，截断 {} 道超量加题）",
            fixed_units,
            renumbered_total,
            trimmed_total
        );
    }
    Ok(())
}

// ══════════════════════════════════════════════════════════════════════════════
// v6 (2026-05) #3 vibelearning 统一 session 事件流
// ══════════════════════════════════════════════════════════════════════════════
//
// 设计：
//   - 任何"显著"的学习 / 训练 / 交互动作都在执行成功后追加一条事件
//   - 写入失败不应影响业务（用 `let _ =` 容忍，仅 warn 一行）
//   - 读取按 (session_id, ts) 升序，前端按时序渲染 timeline

/// 追加一条 vibe 事件。失败时 `log::warn` 但不中断业务流。
/// `unit_index` 用 None 表示"非单元上下文"；`ref_id` 可空。
pub fn vibe_event_append(
    conn: &Connection,
    session_id: &str,
    kind: &str,
    unit_index: Option<i64>,
    ref_id: &str,
    payload: &Value,
) {
    if session_id.is_empty() {
        return;
    }
    let payload_str = payload.to_string();
    let now = chrono::Local::now().to_rfc3339();
    if let Err(e) = conn.execute(
        "INSERT INTO vibe_session_events (session_id, ts, kind, unit_index, ref_id, payload_json)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![session_id, now, kind, unit_index, ref_id, payload_str],
    ) {
        log::warn!("vibe_event_append({}, {}) 失败: {}", session_id, kind, e);
    }
}

/// 拉取一个 session 的事件 timeline（按 ts 升序）。
/// `limit = 0` 表示不限制（最多硬上限 5000，防止 DoS）。
pub fn vibe_events_list(
    conn: &Connection,
    session_id: &str,
    limit: i64,
) -> Result<Vec<Value>, String> {
    let cap = if limit <= 0 { 5000 } else { limit.min(5000) };
    let mut stmt = conn
        .prepare(
            "SELECT event_id, ts, kind, unit_index, ref_id, payload_json
             FROM vibe_session_events
             WHERE session_id = ?1
             ORDER BY ts ASC, event_id ASC
             LIMIT ?2",
        )
        .map_err(|e| format!("准备 vibe_events SQL 失败: {e}"))?;
    let rows = stmt
        .query_map(params![session_id, cap], |row| {
            let payload_str: String = row.get(5)?;
            let payload: Value = serde_json::from_str(&payload_str).unwrap_or(json!({}));
            Ok(json!({
                "event_id": row.get::<_, i64>(0)?,
                "ts": row.get::<_, String>(1)?,
                "kind": row.get::<_, String>(2)?,
                "unit_index": row.get::<_, Option<i64>>(3)?,
                "ref_id": row.get::<_, String>(4)?,
                "payload": payload,
            }))
        })
        .map_err(|e| format!("查询 vibe_events 失败: {e}"))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| format!("行解析失败: {e}"))?);
    }
    Ok(out)
}

/// 清除一个 session 的所有 vibe 事件（agent_reset 时调用）
pub fn vibe_events_clear(conn: &Connection, session_id: &str) -> Result<(), String> {
    conn.execute(
        "DELETE FROM vibe_session_events WHERE session_id = ?1",
        params![session_id],
    )
    .map_err(|e| format!("清空 vibe_events 失败: {e}"))?;
    Ok(())
}

// ══════════════════════════════════════════════════════════════════════════════
// v6 (2026-05) #3+ 学习流笔记（与课堂笔记隔离）
// ══════════════════════════════════════════════════════════════════════════════
//
// 与 dr_save_note(page=0) 的区别：
//   - 这张表是 append-only，按 unit 维度切片
//   - 课堂笔记仍由用户独占（doc_page_notes 表）
//   - 重新生成路线图 / 重置 Agent 不会覆盖这里
// 失败仅 warn —— 与 vibe_event_append 同款"软依赖"策略。

/// 追加一条学习流笔记。
pub fn agent_stream_note_append(
    conn: &Connection,
    session_id: &str,
    archive_id: &str,
    unit_index: i64,
    anchor_page: i64,
    unit_title: &str,
    content: &str,
) {
    if session_id.is_empty() || content.trim().is_empty() {
        return;
    }
    let now = chrono::Local::now().to_rfc3339();
    if let Err(e) = conn.execute(
        "INSERT INTO agent_stream_notes
            (session_id, archive_id, unit_index, anchor_page, unit_title, content, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            session_id,
            archive_id,
            unit_index,
            anchor_page,
            unit_title,
            content,
            now,
        ],
    ) {
        log::warn!(
            "agent_stream_note_append({}, unit={}) 失败: {}",
            session_id,
            unit_index,
            e
        );
    }
}

/// 列出某 session 的学习流笔记。
///   archive_id_filter:
///     - None  : 当前 active 笔记（archive_id = ''）
///     - Some(id) : 只返回指定档案的笔记
///     - Some("") : 同 None
/// 排序：created_at 升序（学习时间线）。
pub fn agent_stream_notes_list(
    conn: &Connection,
    session_id: &str,
    archive_id_filter: Option<&str>,
) -> Result<Vec<Value>, String> {
    let aid = archive_id_filter.unwrap_or("");
    let mut stmt = conn
        .prepare(
            "SELECT note_id, archive_id, unit_index, anchor_page, unit_title, content, created_at
             FROM agent_stream_notes
             WHERE session_id = ?1 AND archive_id = ?2
             ORDER BY created_at ASC, note_id ASC",
        )
        .map_err(|e| format!("准备 stream_notes SQL 失败: {e}"))?;
    let rows = stmt
        .query_map(params![session_id, aid], |row| {
            Ok(json!({
                "note_id": row.get::<_, i64>(0)?,
                "archive_id": row.get::<_, String>(1)?,
                "unit_index": row.get::<_, i64>(2)?,
                "anchor_page": row.get::<_, i64>(3)?,
                "unit_title": row.get::<_, String>(4)?,
                "content": row.get::<_, String>(5)?,
                "created_at": row.get::<_, String>(6)?,
            }))
        })
        .map_err(|e| format!("查询 stream_notes 失败: {e}"))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| format!("行解析失败: {e}"))?);
    }
    Ok(out)
}

/// 把当前 active 学习流的笔记打个 archive_id 标签（在 auto_archive 时调用，
/// 让"档案模式"能拉出对应轮次的笔记）。
pub fn agent_stream_notes_tag_archive(
    conn: &Connection,
    session_id: &str,
    archive_id: &str,
) -> Result<usize, String> {
    if archive_id.is_empty() {
        return Ok(0);
    }
    let n = conn
        .execute(
            "UPDATE agent_stream_notes SET archive_id = ?1
             WHERE session_id = ?2 AND archive_id = ''",
            params![archive_id, session_id],
        )
        .map_err(|e| format!("标记 stream_notes archive 失败: {e}"))?;
    Ok(n)
}
