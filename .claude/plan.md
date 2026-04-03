# 增强型笔记侧栏系统 — 实现计划

## 总体架构

右侧侧栏改为双Tab模式：
- **Tab1「AI 笔记」**: 保留现有的页面级 AI 笔记功能（不变）
- **Tab2「笔记本」**: 新增笔记本管理系统

笔记本与文档会话松耦合：每个文档会话自动关联一个默认笔记本，用户也可创建额外笔记本。

---

## 分阶段实施

### 阶段一：笔记本管理 + 选择 + 预览（本次实现）

#### 1. 数据库扩展 (db.rs)

新增 2 张表：

```sql
-- 笔记本
CREATE TABLE IF NOT EXISTS notebooks (
    notebook_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    session_id TEXT,                    -- 关联的文档会话（可为 NULL = 独立笔记本）
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES doc_sessions(session_id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_notebooks_session ON notebooks (session_id);

-- 笔记本条目（无限延伸）
CREATE TABLE IF NOT EXISTS notebook_entries (
    entry_id TEXT PRIMARY KEY,
    notebook_id TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    entry_type TEXT NOT NULL DEFAULT 'note',  -- note / imported / ppt_note / annotation
    source_info TEXT DEFAULT '',               -- 来源信息（如 "第3页AI笔记" 或 "slide_5.pptx"）
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (notebook_id) REFERENCES notebooks(notebook_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_entries_notebook ON notebook_entries (notebook_id, sort_order);
```

新增 CRUD 函数：
- `nb_create_notebook(conn, notebook_id, name, description, session_id)`
- `nb_list_notebooks(conn)` → 所有笔记本列表
- `nb_list_notebooks_by_session(conn, session_id)` → 某会话关联的笔记本
- `nb_get_notebook(conn, notebook_id)` → 单个笔记本详情
- `nb_update_notebook(conn, notebook_id, name, description)`
- `nb_delete_notebook(conn, notebook_id)`
- `nb_add_entry(conn, entry_id, notebook_id, title, content, entry_type, source_info, sort_order)`
- `nb_list_entries(conn, notebook_id)` → 笔记本所有条目
- `nb_get_entry(conn, entry_id)` → 单条目详情
- `nb_update_entry(conn, entry_id, title, content)`
- `nb_delete_entry(conn, entry_id)`
- `nb_import_page_note(conn, notebook_id, session_id, page_index)` → 从页面笔记导入

#### 2. Tauri 命令 (commands.rs)

新增命令：
- `notebook_create(name, description, session_id?)` → 创建笔记本
- `notebook_list(session_id?)` → 列出笔记本（可按会话过滤）
- `notebook_get(notebook_id)` → 获取笔记本详情+条目列表
- `notebook_update(notebook_id, name, description)` → 更新笔记本信息
- `notebook_delete(notebook_id)` → 删除笔记本
- `notebook_add_entry(notebook_id, title, content, entry_type, source_info)` → 添加条目
- `notebook_update_entry(entry_id, title, content)` → 更新条目
- `notebook_delete_entry(entry_id)` → 删除条目
- `notebook_import_notes(notebook_id, session_id)` → 从当前文档会话批量导入AI笔记

#### 3. 前端 UI (doc_reader.html + doc_reader.js)

**HTML 改动**：
- 右侧 `notes-sidebar` 顶部增加 Tab 切换栏：`[AI 笔记 | 笔记本]`
- Tab2 内容区：
  - 笔记本选择器（下拉框 + 新建按钮）
  - 笔记本条目列表（可滚动）
  - 条目卡片：标题 + 内容摘要 + 操作按钮
  - 底部：添加条目按钮

**JS 改动**：
- 新增 `notebookState` 对象管理笔记本状态
- Tab 切换逻辑
- 笔记本 CRUD 操作函数
- 条目列表渲染
- 悬停/点击预览面板（在条目卡片下方展开 inline 预览）
- 文档打开时自动创建/关联默认笔记本
- 「导入到笔记本」按钮（在 AI 笔记 Tab 的每个笔记卡片上）

#### 4. 笔记预览系统

- 条目卡片默认显示标题 + 前2行摘要
- 点击条目卡片展开完整内容（inline 展开，支持 Markdown 渲染）
- 支持编辑模式切换（点击编辑按钮进入 contentEditable）

---

### 阶段二：PPT 长笔记生成（后续）
### 阶段三：智能文本标注与解释（后续）

---

## 文件改动清单

| 文件 | 改动类型 | 说明 |
|------|---------|------|
| `src-tauri/src/db.rs` | 修改 | 新增 notebooks + notebook_entries 表和 CRUD |
| `src-tauri/src/commands.rs` | 修改 | 新增 notebook_* 系列命令 |
| `src-tauri/src/lib.rs` | 修改 | 注册新命令到 invoke_handler |
| `public/doc_reader.html` | 修改 | 右侧侧栏改为双Tab + 笔记本UI |
| `public/static/doc_reader.js` | 修改 | 新增笔记本管理前端逻辑 |
| `public/static/doc_reader_theme.css` | 修改 | 新增 Tab 和笔记本相关样式变量 |
