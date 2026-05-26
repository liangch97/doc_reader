# Doc Reader v2 — 设计文档

> **版本**: 0.2.0-design
> **状态**: Draft（待 review）
> **创建**: 2026-05-09
> **作者**: Cascade + 用户协作起草
> **范围**: 整体产品设计、技术架构、数据模型、UI 设计 Token、迁移路线图

本文件是 **唯一真相来源**。任何代码改动开始前必须先读本文件。

---

## 目录

1. [产品定位与愿景](#1-产品定位与愿景)
2. [关键决策](#2-关键决策已确认)
3. [技术架构](#3-技术架构)
4. [设计 Token 系统](#4-设计-token-系统)
5. [信息架构与路由](#5-信息架构与路由)
6. [数据模型](#6-数据模型)
7. [前端目录结构](#7-前端目录结构)
8. [核心页面布局规范](#8-核心页面布局规范)
9. [状态矩阵（10 状态全覆盖）](#9-状态矩阵10-状态全覆盖)
10. [迁移路线图](#10-迁移路线图)
11. [风险与缓解](#11-风险与缓解)
12. [禁止行为清单](#12-禁止行为清单)

---

## 1. 产品定位与愿景

### 1.1 一句话定位

**带 AI 的课程资料阅读 + 笔记 + 学习路径平台** — 把当前的「AI 课件笔记助手」升级为吸收 readest 专业阅读体验的统一学习工作台，让"读"和"学"在同一个 app 里闭环。

### 1.2 三条产品主线

| 主线 | 描述 |
|---|---|
| **读得专业** | 引入 [foliate-js](https://github.com/johnfactotum/foliate-js)（来自 readest 项目）作为渲染引擎，原生支持 EPUB/MOBI/PDF/AZW3/CBZ；保留 Rust 端 PDF/DOCX/PPTX 文本抽取喂 AI |
| **学得结构化** | 引入「**课程**」实体作为资料分组与进度容器：每门课程聚合多份资料 + 一个课程笔记本 + 学习大纲（zone/learning_role）+ 进度统计 |
| **AI 是助手不是主角** | AI 笔记 / 聊天 / 学习大纲全部下沉为右侧 AI 面板，不打扰主阅读流；选中文本即可触发 AI 解释/翻译/笔记 |

### 1.3 与原版对比

| 维度 | doc-reader v1（现状） | doc-reader v2（目标） |
|---|---|---|
| 前端栈 | 原生 HTML + Vite，单页 150K 大文件 | Vite + React 18 + TypeScript + Tailwind |
| 渲染引擎 | 自研：Rust 抽文本 → 前端渲染 Markdown | foliate-js 主线 + 旧 Rust 文本抽取作为 AI 通道 |
| 阅读格式 | PDF/DOCX/PPTX/HTML | + EPUB/MOBI/AZW3/CBZ |
| 资料组织 | 扁平的 `doc_sessions` | 课程（多对多）+ 资料 + 必读/参考/扩展三档 |
| 批注 | 仅 AI 页面笔记 | + 高亮 / 划线 / 行内笔记 / 书签（cfi 定位） |
| 进度 | 无 | 阅读进度 + 总阅读时长 + 课程进度环 |
| 主体形态 | 桌面 + Android | **Windows 优先 + Android 跟随** |

---

## 2. 关键决策（已确认）

| # | 决策点 | 选定方案 |
|---|---|---|
| 1 | 整合深度 | **B**：重构前端为 Vite + React + TypeScript，复用 foliate-js；保留 Tauri Rust 后端 + 全部 AI 功能 |
| 2 | 课程模型 | **资料分组 + 进度**：课程是一组资料 + 课程级笔记本 + 进度，资料可重复挂入多个课程 |
| 3 | 功能保留 | **全部保留** + 新增：AI 页面笔记 / Notebook / 学习大纲 / PDF·DOCX·PPTX 解析 + EPUB·MOBI·AZW3 阅读 + readest 风格批注 |
| 4 | 平台优先级 | **Windows 桌面优先**，Android 跟随；设计基线为大屏鼠标键盘 + 双栏布局 |

---

## 3. 技术架构

### 3.1 技术栈

| 层 | 技术 | 版本/说明 |
|---|---|---|
| 渲染引擎 | **foliate-js**（vendored） | 从 readest 的 `packages/foliate-js` 拷贝至 `public/vendor/foliate-js/`；通过 `<foliate-view>` web component 接入 |
| 前端框架 | **React 18 + Vite 8 + TypeScript 5** | Vite 已在用；不上 Next.js，避免 SSR 双链路复杂度 |
| 状态管理 | **Zustand 4** | 轻量、与 readest 一致 |
| 路由 | **React Router 6** | SPA 路由，5 个主路由 |
| UI 基础 | **Radix UI primitives + Tailwind CSS 3 + class-variance-authority** | 与 readest 风格对齐；按需引入 |
| 图标 | **lucide-react**（已在 deps） | 替换现有 `lucide` umd 用法 |
| Markdown | **marked + KaTeX + highlight.js** | 已在 deps，沿用 |
| 拖拽 | **@dnd-kit/core + @dnd-kit/sortable** | 课程排序、资料归类 |
| 后端 | **Tauri 2.10 + Rust 1.77+** | 沿用，扩展 `commands.rs` / `db.rs` |
| 数据库 | **SQLite via rusqlite**（保留 + 扩表） | 新增 5 张表，旧表零改动 |
| 解析 | 保留 `pdf-extract` / `lopdf` / `zip` / `scraper` | EPUB 解析交给前端 foliate-js |
| LLM | 保留 `reqwest` + 现有 `llm.rs` | 沿用 |

### 3.2 高层架构图

```
┌────────────────────────────────────────────────────────────────┐
│                  React SPA (Vite + TypeScript)                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Shell  │  Pages  │  Features (library/courses/reader/   │   │
│  │  TitleBar          annotation/ai-pane/notebook/settings) │   │
│  └──────────────────────────────────────────────────────────┘   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Stores (Zustand)  │  lib/tauri.ts (invoke wrapper)       │   │
│  └──────────────────────────────────────────────────────────┘   │
│             ↓ Tauri IPC (invoke)                                │
└─────────────┼──────────────────────────────────────────────────┘
              ↓
┌─────────────────────────────────────────────────────────────────┐
│                 Tauri Rust Backend (保留)                        │
│  ┌────────┐  ┌────────┐  ┌────────┐  ┌────────┐  ┌──────────┐  │
│  │commands│  │   db   │  │ parser │  │  llm   │  │doc_reader│  │
│  └────────┘  └────────┘  └────────┘  └────────┘  └──────────┘  │
│       ↓                                                          │
│  ┌────────────────────────────────────────────────────────┐    │
│  │   SQLite  (旧表保留 + 5 张新表)                          │    │
│  └────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
```

### 3.3 保留 vs 淘汰

**保留**（零改动或仅扩展）：

- `src-tauri/src/commands.rs`（114K，60+ 命令）
- `src-tauri/src/parser.rs`（PDF/DOCX/PPTX 解析）
- `src-tauri/src/llm.rs` + `doc_reader.rs`
- 现有 SQLite 全部表

**淘汰**（拆解为 React 组件）：

- `index.html`（919 行）
- `src/pages/doc_reader.html`（150K 大文件）
- `src/pages/settings.html`（22K）
- `_backup_before_layout_redesign/` 旧版备份

---

## 4. 设计 Token 系统

> 沿用现有深色玻璃风格（紫色主调 `#7C5CFC`），沉淀为 Token，禁止硬编码 hex。

### 4.1 颜色 Token

```css
:root {
  /* === 品牌 === */
  --accent:        #7C5CFC;   /* 主紫 */
  --accent-2:      #A78BFA;   /* 浅紫（hover） */
  --accent-3:      #6366F1;   /* 蓝紫（次要操作） */
  --accent-glow:   rgba(124, 92, 252, 0.3);

  /* === 表面 === */
  --bg:            #08080D;   /* 应用背景 */
  --surface-1:     rgba(255, 255, 255, 0.03); /* 卡片 */
  --surface-2:     rgba(255, 255, 255, 0.06); /* hover */
  --surface-3:     rgba(255, 255, 255, 0.09); /* active */
  --card-glass:    rgba(14, 14, 22, 0.6);     /* 玻璃卡片 */

  /* === 边框 === */
  --border-1:      rgba(255, 255, 255, 0.06);
  --border-2:      rgba(124, 92, 252, 0.3);   /* hover/focus */

  /* === 文字 === */
  --text-1:        #F0F0F5;   /* 主文本 */
  --text-2:        #A0A0B8;   /* 次要文本 */
  --text-3:        #6B6B80;   /* 辅助文本 */
  --text-4:        #3A3A4A;   /* 占位 */

  /* === 语义色 === */
  --success:       #22C55E;
  --warning:       #F59E0B;
  --error:         #EF4444;
  --info:          #3B82F6;

  /* === 高亮色（批注） === */
  --hl-yellow:     rgba(250, 204, 21, 0.35);
  --hl-green:      rgba(34, 197, 94, 0.35);
  --hl-blue:       rgba(59, 130, 246, 0.35);
  --hl-pink:       rgba(244, 114, 182, 0.35);
  --hl-purple:     rgba(168, 85, 247, 0.35);
}
```

### 4.2 字号 Token

| Token | 值 | 用途 |
|---|---|---|
| `--text-xs` | 11px / 16px | 角标、标签 |
| `--text-sm` | 13px / 18px | 次要说明、按钮 |
| `--text-base` | 14px / 20px | 正文、卡片 |
| `--text-md` | 15px / 22px | 列表项 |
| `--text-lg` | 17px / 24px | 卡片标题 |
| `--text-xl` | 20px / 28px | 页面副标题 |
| `--text-2xl` | 24px / 32px | 页面标题 |
| `--text-3xl` | 32px / 40px | 主页 Hero |

字体族：`'Inter', -apple-system, BlinkMacSystemFont, sans-serif`

### 4.3 间距 Token

```
--space-0:   0
--space-1:   4px      微小间隙（icon 与文字）
--space-2:   8px      紧凑间距
--space-3:   12px     标准内间距
--space-4:   16px     卡片内间距
--space-5:   20px     卡片间间距
--space-6:   24px     段落间距
--space-8:   32px     大区块分隔
--space-10:  40px     页面级 padding
--space-16:  64px     主要分区
```

### 4.4 圆角 Token

```
--radius-sm:   6px      小按钮、tag
--radius-md:   10px     卡片、输入框
--radius-lg:   14px     大卡片、面板
--radius-xl:   20px     模态框
--radius-full: 9999px   圆形按钮、头像
```

### 4.5 动效 Token

```
--ease-out:     cubic-bezier(0.16, 1, 0.3, 1)        通用退场
--ease-in-out:  cubic-bezier(0.65, 0, 0.35, 1)       平滑过渡
--ease-spring:  cubic-bezier(0.34, 1.56, 0.64, 1)    弹性

--duration-fast:   150ms     hover、focus
--duration-base:   240ms     标准过渡
--duration-slow:   400ms     页面切换
--duration-page:   600ms     全屏转场
```

### 4.6 阴影 Token

```
--shadow-sm:  0 1px 2px rgba(0,0,0,0.2)
--shadow-md:  0 4px 12px rgba(0,0,0,0.3)
--shadow-lg:  0 12px 40px rgba(0,0,0,0.4)
--shadow-glow: 0 0 24px var(--accent-glow)    悬浮强调
```

---

## 5. 信息架构与路由

### 5.1 路由表

| 路径 | 页面 | 主体内容 | 入口来源 |
|---|---|---|---|
| `/` | HomePage | 最近阅读（横向）+ 课程概览（4 卡）+ 待续读建议 | 启动默认页 |
| `/library` | LibraryPage | 全部资料网格 + 筛选（格式 / 课程 / 已读未读） | 侧栏 |
| `/courses` | CoursesPage | 课程卡片墙 + 新建按钮 | 侧栏 |
| `/courses/:courseId` | CourseWorkspacePage | 课程头 + 资料三组 + 课程笔记本 + 学习大纲 | 课程墙点击 |
| `/reader/:resourceId` | ReaderPage | 三栏：TOC / 阅读视图 / AI 面板 | 资料卡片点击 |
| `/notebook/:notebookId` | NotebookPage | 笔记本编辑器（迁移现有完整功能） | 课程工作区 / 侧栏 |
| `/settings` | SettingsPage | LLM 模型 / 外观 / 数据导入导出 | 侧栏底部 |

### 5.2 全局导航

```
┌─────────────────────────────────────────────┐
│  TitleBar (32px) — 拖拽区 + 窗口控制         │
├──────┬──────────────────────────────────────┤
│      │                                      │
│ 侧栏 │           主内容区                    │
│      │                                      │
│ 64px │  根据路由切换不同 Page               │
│      │                                      │
│ ────│                                      │
│ 🏠  │                                      │
│ 📚  │                                      │
│ 🎓  │                                      │
│ 📓  │                                      │
│ ⚙️  │                                      │
└──────┴──────────────────────────────────────┘
```

侧栏图标（自上而下）：
- 🏠 主页（HomePage）
- 📚 图书馆（LibraryPage）
- 🎓 课程（CoursesPage）
- 📓 笔记本（NotebookPage 列表）
- ⚙️ 设置

---

## 6. 数据模型

### 6.1 兼容策略

> **核心原则**：旧表零改动，新表通过软关联挂接；迁移时把现有 `doc_sessions` 自动登记为 `resources`。

### 6.2 新增表

```sql
-- ════════════════════════════════════════════════════════════════
-- 课程表
-- ════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS courses (
  course_id     TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  cover_color   TEXT NOT NULL DEFAULT '#7C5CFC',
  cover_emoji   TEXT NOT NULL DEFAULT '📚',
  notebook_id   TEXT NOT NULL DEFAULT '',  -- 软关联 notebooks.notebook_id
  outline_id    TEXT NOT NULL DEFAULT '',  -- 软关联 notebook_outlines.notebook_id
  sort_order    INTEGER NOT NULL DEFAULT 0,
  archived      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_courses_updated ON courses (updated_at DESC);

-- ════════════════════════════════════════════════════════════════
-- 资料表（统一抽象：可以是旧 doc_session，也可以是 EPUB/MOBI 等）
-- ════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS resources (
  resource_id     TEXT PRIMARY KEY,
  kind            TEXT NOT NULL,  -- 'pdf' | 'docx' | 'pptx' | 'epub' | 'mobi' | 'azw3' | 'cbz' | 'txt' | 'html'
  title           TEXT NOT NULL,
  author          TEXT NOT NULL DEFAULT '',
  filename        TEXT NOT NULL,
  file_path       TEXT NOT NULL,
  file_size       INTEGER NOT NULL DEFAULT 0,
  cover_path      TEXT NOT NULL DEFAULT '',  -- 自动提取或手设
  page_count      INTEGER NOT NULL DEFAULT 0,
  has_text        INTEGER NOT NULL DEFAULT 0,  -- 是否已抽取文本到 doc_pages
  doc_session_id  TEXT NOT NULL DEFAULT '',  -- 软关联 doc_sessions（兼容）
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_resources_kind ON resources (kind);
CREATE INDEX IF NOT EXISTS idx_resources_updated ON resources (updated_at DESC);

-- ════════════════════════════════════════════════════════════════
-- 课程↔资料 多对多
-- ════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS course_resources (
  course_id    TEXT NOT NULL,
  resource_id  TEXT NOT NULL,
  category     TEXT NOT NULL DEFAULT 'main',  -- 'main' 必读 | 'ref' 参考 | 'extra' 扩展
  sort_order   INTEGER NOT NULL DEFAULT 0,
  added_at     TEXT NOT NULL,
  PRIMARY KEY (course_id, resource_id),
  FOREIGN KEY (course_id) REFERENCES courses(course_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_cr_course ON course_resources (course_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_cr_resource ON course_resources (resource_id);

-- ════════════════════════════════════════════════════════════════
-- 阅读进度
-- ════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS reading_progress (
  resource_id            TEXT PRIMARY KEY,
  cfi                    TEXT NOT NULL DEFAULT '',  -- foliate-js EPUB 定位
  page_index             INTEGER NOT NULL DEFAULT 0,  -- PDF/PPTX/DOCX 定位
  percent                REAL NOT NULL DEFAULT 0,
  total_reading_seconds  INTEGER NOT NULL DEFAULT 0,
  last_read_at           TEXT NOT NULL,
  FOREIGN KEY (resource_id) REFERENCES resources(resource_id) ON DELETE CASCADE
);

-- ════════════════════════════════════════════════════════════════
-- 批注（高亮 / 划线 / 行内笔记）
-- ════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS annotations (
  annotation_id      TEXT PRIMARY KEY,
  resource_id        TEXT NOT NULL,
  kind               TEXT NOT NULL,  -- 'highlight' | 'underline' | 'note' | 'strikethrough'
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

-- ════════════════════════════════════════════════════════════════
-- 书签
-- ════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS bookmarks (
  bookmark_id   TEXT PRIMARY KEY,
  resource_id   TEXT NOT NULL,
  cfi           TEXT NOT NULL DEFAULT '',
  page_index    INTEGER NOT NULL DEFAULT -1,
  label         TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL,
  FOREIGN KEY (resource_id) REFERENCES resources(resource_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_bookmarks_resource ON bookmarks (resource_id);
```

### 6.3 关系图

```
courses ──┬─< course_resources >─┬── resources ─┬─ doc_sessions (legacy)
          │                       │              │
          │                       │              ├─< reading_progress
          │                       │              │
          │                       │              ├─< annotations
          │                       │              │
          │                       │              └─< bookmarks
          │                       │
          ├──> notebook_id ──── notebooks ──< notebook_entries
          │
          └──> outline_id  ──── notebook_outlines
```

### 6.4 迁移脚本（伪代码）

```rust
// 在 init_db 末尾追加：
fn migrate_legacy_sessions_to_resources(conn: &Connection) -> Result<()> {
    let sessions = conn.prepare("SELECT session_id, filename, file_path, page_count FROM doc_sessions")?
        .query_map([], |row| { /* ... */ })?;

    for s in sessions {
        let resource_id = uuid_v4();
        let kind = guess_kind_from_filename(&s.filename); // pdf/docx/pptx
        conn.execute(
            "INSERT OR IGNORE INTO resources
             (resource_id, kind, title, filename, file_path, page_count, has_text, doc_session_id, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)",
            params![resource_id, kind, stem(&s.filename), s.filename, s.file_path,
                    s.page_count, s.session_id, now(), now()]
        )?;
    }
    Ok(())
}
```

---

## 7. 前端目录结构

```
src/
├── main.tsx                          # React + ReactDOM 入口
├── App.tsx                           # Router + Provider 装配
├── shell/                            # 顶层壳
│   ├── TitleBar.tsx                  # 拖拽栏 + 窗口控制
│   ├── AppSidebar.tsx                # 64px 侧栏
│   └── CommandPalette.tsx            # ⌘K 全局命令（v2.1+）
├── pages/                            # 路由级页面
│   ├── HomePage.tsx
│   ├── LibraryPage.tsx
│   ├── CoursesPage.tsx
│   ├── CourseWorkspacePage.tsx
│   ├── ReaderPage.tsx
│   ├── NotebookPage.tsx
│   └── SettingsPage.tsx
├── features/                         # 功能模块
│   ├── library/
│   │   ├── ResourceGrid.tsx
│   │   ├── ResourceCard.tsx
│   │   ├── ImportDialog.tsx
│   │   └── api.ts
│   ├── courses/
│   │   ├── CourseCard.tsx
│   │   ├── CourseHeader.tsx
│   │   ├── CourseResourceList.tsx
│   │   ├── CourseProgressPanel.tsx
│   │   └── store.ts
│   ├── reader/
│   │   ├── ReaderShell.tsx           # 三栏布局
│   │   ├── FoliateView.tsx           # foliate-js wrapper
│   │   ├── PdfPptxAdapter.tsx        # 旧文档文本视图
│   │   ├── ReaderToolbar.tsx
│   │   ├── TocPanel.tsx
│   │   ├── SearchPanel.tsx
│   │   └── settings/
│   ├── annotation/
│   │   ├── AnnotationLayer.tsx
│   │   ├── SelectionPopover.tsx
│   │   ├── AnnotationList.tsx
│   │   └── BookmarkList.tsx
│   ├── ai-pane/
│   │   ├── AiPaneContainer.tsx       # 三 tab 切换
│   │   ├── PageNoteTab.tsx
│   │   ├── ChatTab.tsx
│   │   └── OutlineTab.tsx
│   ├── notebook/
│   │   ├── NotebookEditor.tsx
│   │   ├── EntryCard.tsx
│   │   ├── ZoneNavigator.tsx
│   │   ├── LearningOutlineView.tsx
│   │   └── api.ts
│   └── settings/
│       ├── LlmModelsTab.tsx
│       ├── AppearanceTab.tsx
│       └── DataTab.tsx
├── lib/
│   ├── tauri.ts                      # invoke wrapper + 类型
│   ├── foliate.ts                    # foliate-js 加载器
│   └── markdown.ts                   # marked + katex + hljs
├── stores/
│   ├── courseStore.ts
│   ├── readerStore.ts
│   ├── annotationStore.ts
│   └── settingsStore.ts
├── styles/
│   ├── globals.css                   # tailwind base + token
│   └── tokens.css                    # 设计 Token CSS 变量
├── types/
│   ├── course.ts
│   ├── resource.ts
│   └── annotation.ts
└── components/                       # 通用 UI 原子
    ├── ui/                           # Radix 二次封装
    │   ├── Button.tsx
    │   ├── Dialog.tsx
    │   ├── Tabs.tsx
    │   ├── Tooltip.tsx
    │   └── DropdownMenu.tsx
    └── primitives/
        ├── Spinner.tsx
        ├── EmptyState.tsx
        ├── ErrorBoundary.tsx
        └── ProgressRing.tsx

public/
└── vendor/
    ├── foliate-js/                   # 从 readest vendor
    └── pdfjs/                        # foliate-js 依赖
```

---

## 8. 核心页面布局规范

### 8.1 阅读器三栏布局（核心页面）

```
┌─────────────────────────────────────────────────────────────────┐
│ TitleBar                                          ─ □ ×          │
├──────────┬──────────────────────────────────────────┬────────────┤
│          │  ReaderToolbar                            │ AI Pane   │
│ TOC 240px│  [< 前一页]  书名 — 第 12 页    [次页 >] │  280px    │
│          │                                           │ ┌───────┐ │
│ Chapter 1│  ┌──────────────────────────────────┐    │ │ 笔记  │ │
│ Chapter 2│  │                                  │    │ │ 聊天  │ │
│  ...     │  │  foliate-view / PDF / PPTX       │    │ │ 大纲  │ │
│          │  │  ── 主阅读区域 ──                │    │ └───────┘ │
│ ─────    │  │                                  │    │           │
│ 搜索     │  └──────────────────────────────────┘    │ 当前页    │
│ 书签     │                                           │ AI 笔记   │
│ 批注     │  AnnotationLayer（覆盖层）                │ + 生成    │
│          │  SelectionPopover（选中浮出）             │           │
└──────────┴──────────────────────────────────────────┴────────────┘
   折叠 →                                                ← 折叠
```

**布局规则**：
- 桌面默认：`左 240 + 主区域 + 右 280`
- 主区域宽度 `min(800px, 100% - 32px)`，居中显示
- 左/右栏均可折叠为 48px 图标条
- 移动端：左/右栏折叠为底部抽屉

**PPTX/DOCX 模式**：当资料是 PPT/DOCX 时，主区不走 foliate-js，渲染抽取文本（每页一个 card），AI 面板/批注/进度逻辑统一。

### 8.2 课程工作区布局

```
┌─────────────────────────────────────────────────────────────────┐
│ ← 返回    📚 计算机网络             ●●●●○○ 42%      [⚙ 设置]    │
│           13 份资料 · 38 条批注 · 24 条笔记 · 上次 2 小时前      │
├─────────────────────────────────────────────────────────────────┤
│ [必读 8] [参考 3] [扩展 2]              ＋ 添加资料              │
│                                                                  │
│  ┌────┐ ┌────┐ ┌────┐ ┌────┐                                   │
│  │ 📕 │ │ 📘 │ │ 📗 │ │ 📕 │   ← 资料卡片                       │
│  │TCP │ │HTTP│ │OS  │ │NW  │     封面 + 进度条 + 已批注数        │
│  └────┘ └────┘ └────┘ └────┘                                   │
│  ┌────┐ ┌────┐ ┌────┐                                           │
│  │ 📘 │ │ 📕 │ │ 📗 │                                           │
│  └────┘ └────┘ └────┘                                           │
├──────────────────────────────────┬───────────────────────────────┤
│ 课程笔记本                         │ 学习大纲                       │
│ - 第 1 章 物理层                   │  Zone 1: 基础概念 (✓✓✓)       │
│ - 第 2 章 数据链路层               │  Zone 2: 协议栈 (✓✓○ 进行中)  │
│ - ...                             │  Zone 3: 应用层 (○○○ 未开始)   │
└──────────────────────────────────┴───────────────────────────────┘
```

### 8.3 图书馆页布局

```
┌─────────────────────────────────────────────────────────────────┐
│ 图书馆          [全部 ▾] [PDF ▾] [已读 ▾]    🔍 搜索    ＋ 导入 │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌────┐ ┌────┐ ┌────┐ ┌────┐ ┌────┐ ┌────┐                     │
│  │ 📕 │ │ 📘 │ │ 📗 │ │ 📕 │ │ 📘 │ │ 📕 │                     │
│  │封面│ │封面│ │封面│ │封面│ │封面│ │封面│                     │
│  └────┘ └────┘ └────┘ └────┘ └────┘ └────┘                     │
│  TCP/IP  HTTP权威 操作系统 网络协议 算法导论 编译原理            │
│  42%     ●●○○    刚开始   未开始   100%      72%                │
│                                                                  │
│  ┌────┐ ┌────┐ ┌────┐ ...                                       │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

**卡片规格**：宽 160px × 高 240px（封面 160×220 + 标题 + 进度），网格 `gap: 24px`，自动列数。

### 8.4 主页布局

```
┌─────────────────────────────────────────────────────────────────┐
│ 你好 👋                                          2026-05-09       │
│                                                                  │
│ 继续阅读                                                          │
│ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐                    │
│ │📕 TCP  │ │📘 HTTP │ │📗 OS   │ │📕 编译 │   ← 横向滚动        │
│ │ 42%    │ │ 65%    │ │ 18%    │ │ 90%    │                    │
│ └────────┘ └────────┘ └────────┘ └────────┘                    │
│                                                                  │
│ 我的课程                                                          │
│ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐             │
│ │ 📚 网络  │ │ 🤖 ML    │ │ 💾 OS    │ │ 🔧 编译  │             │
│ │ 13 资料  │ │  9 资料  │ │  7 资料  │ │  5 资料  │             │
│ │ 42% ●●○ │ │ 18% ●○○ │ │  0% ○○○ │ │ 67% ●●○ │             │
│ └──────────┘ └──────────┘ └──────────┘ └──────────┘             │
│                                                                  │
│ 今日建议                                                          │
│ • 📕 TCP/IP 卷一 — 距上次阅读 3 天，建议续读 第 5 章             │
│ • 🎓 网络课程 — Zone 2「协议栈」还有 2 节未学                    │
└─────────────────────────────────────────────────────────────────┘
```

---

## 9. 状态矩阵（10 状态全覆盖）

> **全局规则**：每个页面都必须显式处理这 10 种状态。

| 状态 | 触发条件 | UI 表现 |
|---|---|---|
| **loading** | 数据请求中 | Skeleton 占位 + 顶部细进度条 |
| **empty** | 无数据 | 居中插画 + 主要 CTA（如「导入资料」） |
| **error** | 请求失败 | 错误图标 + 错误描述 + 重试按钮 |
| **success** | 数据加载完成 | 正常渲染 |
| **partial** | 部分数据可用 | 已有内容正常显示 + 顶部「部分加载失败」横幅 |
| **offline** | 网络离线（仅 LLM 调用） | LLM 入口禁用 + tooltip 解释 |
| **refreshing** | 后台刷新中 | 顶部细进度条 + 内容继续可交互 |
| **submitting** | 用户操作进行中 | 按钮 spinner + 禁用输入 |
| **permission** | 文件读取被拒等 | 引导对话框 + 重试 |
| **firstTime** | 首次进入 | 引导提示气泡或欢迎页 |

每个 Page 必须实现 `<StateGuard>` 组件包裹，根据 `query.status` 切换上述状态。

---

## 10. 迁移路线图

> **总工期**：约 12.5 个工作日。每阶段独立可交付，每阶段后 Windows + Android 都必须能跑。

### P0 — 基础设施搭建（1 天）

**目标**：搭好 React 框架，旧 HTML 仍可访问。

- [ ] 创建本 `DESIGN.md` 完成 ✅
- [ ] 升级 `package.json`：加入 React 18、TS 5、Tailwind 3、Zustand 4、React Router 6、@dnd-kit、Radix UI 子包、lucide-react
- [ ] `tsconfig.json` + `tailwind.config.ts` + 改造 `vite.config.ts` 为 SPA
- [ ] 创建 `src/main.tsx` + `App.tsx` 空骨架，TitleBar + 侧栏可用
- [ ] 旧 `index.html` / `doc_reader.html` / `settings.html` 移到 `_legacy/` 临时保留
- [ ] `.gitignore` 兜住 `*.bak` / `*.apk` / `*.idsig`

**验收**：能跑起一个空白 React + Tailwind 应用，标题栏/侧栏照旧。

### P1 — 数据模型扩展 + 兼容迁移（1 天）

**目标**：后端数据层 + Rust API 完备，前端可调。

- [ ] `src-tauri/src/db.rs` 追加 5 张新表（幂等 ALTER）
- [ ] 写迁移函数：`doc_sessions` → `resources` 自动登记
- [ ] `commands.rs` 新增命令：`course_*`、`resource_*`、`progress_*`、`annotation_*`、`bookmark_*`
- [ ] 前端 `lib/tauri.ts` 写好类型 wrapper

**验收**：通过 Rust 单元测试 / 前端能用 invoke 列出迁移后的 resources。

### P2 — foliate-js 接入 + 阅读器骨架（2 天）

**目标**：能打开 EPUB 翻页，能打开 PPTX 走文本视图。

- [ ] vendor `foliate-js` 到 `public/vendor/foliate-js/`（核实 license）
- [ ] vendor `pdfjs` worker / 字体到 `public/vendor/pdfjs/`
- [ ] 实装 `FoliateView.tsx`：加载 EPUB/PDF/MOBI；监听 `relocate` / `add-annotation`
- [ ] 实装 `ReaderShell.tsx` 三栏布局 + Toolbar + TocPanel
- [ ] 实装 `PdfPptxAdapter.tsx`：复用 `doc_reader_get_page` 渲染 card

**验收**：导入 EPUB 能翻页 + 目录导航；导入 PPTX 能逐张浏览。

### P3 — 图书馆 + 课程工作区（2 天）

**目标**：能创建课程、把资料归入课程、点击进入阅读。

- [ ] `LibraryPage` 资料网格（封面 + 进度 + 标签）
- [ ] `CoursesPage` 课程墙
- [ ] `CourseWorkspacePage` 课程头 + 资料三组 + 拖拽分类
- [ ] `ImportDialog`：选择文件 → Rust 解析 → 写入 `resources` + 可选挂课程

**验收**：完成「创建课程 → 导入 PDF → 拖到必读 → 点击进入阅读」全链路。

### P4 — 批注 / 高亮 / 书签 / 进度（2 天）

**目标**：完整的 readest 风格批注体验。

- [ ] `SelectionPopover`：选中触发颜色选择 + 加注
- [ ] `AnnotationLayer`：渲染 cfi / page_index 高亮
- [ ] 批注列表 + 书签列表（侧栏）
- [ ] 阅读进度自动写库（debounce 2s）

**验收**：高亮一段文字 → 关闭 → 重开 → 高亮还在；进度条正确反映位置。

### P5 — AI 面板重接入（1.5 天）

**目标**：所有 AI 功能在新 UI 中跑通，零功能丢失。

- [ ] `AiPaneContainer` 三 tab：当前页笔记 / 聊天 / 大纲
- [ ] 复用全部现有 Rust 命令（`doc_reader_generate_note` / `chat` / `notebook_*`）
- [ ] 选中文本浮动菜单加「AI 解释 / 翻译 / 生成笔记」入口

**验收**：旧版所有 LLM 功能在新 UI 中可用。

### P6 — 笔记本 + 学习大纲完整迁移（2 天）

**目标**：旧 `doc_reader.html` 可弃用。

- [ ] `NotebookPage` 完整迁移旧 Notebook UI 到 React
- [ ] `LearningOutlineView`：zone 导航 + entry_order 排序
- [ ] 课程级笔记本嵌入：`CourseWorkspacePage` 内嵌只读卡片化大纲

**验收**：用清单核对 23 个 notebook_* 命令对应 UI 全部可用。

### P7 — Android 适配 + 打包（1 天）

**目标**：Android APK 安装可用。

- [ ] 响应式断点：`md:` 768 / `lg:` 1024，移动端 TOC + AI 面板折为底抽屉
- [ ] 触屏手势：foliate-js 原生左/右滑翻页
- [ ] Android 文件选择 + 资料导入
- [ ] 使用已记录的 Android 打包绕过方案：`cargo build --target aarch64-linux-android` → 手动拷贝 `libapp_lib.so` → `gradlew assembleArm64Debug -x rustBuildArm64Debug`

**验收**：在 Android 设备上能完成「导入 → 阅读 → 批注 → 看 AI 笔记」全链路。

---

## 11. 风险与缓解

| 风险 | 等级 | 缓解策略 |
|---|---|---|
| **foliate-js license（GPL/AGPL）传染** | 🔴 高 | 在 P2 开始前核实其 LICENSE 文件；若是 GPL 则只能在源码层 vendor 并保持开源；若是 MIT 则无忧 |
| **foliate-js 在 Tauri WebView 上 PDF.js worker 路径问题** | 🔴 高 | 复用 readest 的 `setup-pdfjs` 脚本，把 worker / 字体拷到 `public/vendor/pdfjs`；用相对路径 |
| **PPTX 文本视图 + 批注模型如何统一** | 🟡 中 | 走 `page_index + text_offset_start/end` 双轴定位，批注表已设计冗余字段兼容 |
| **150K 行 `doc_reader.html` 迁移漏功能** | 🟡 中 | P6 阶段用「23 个 notebook 命令清单」逐项核对；保留 `_legacy/` 做对照 |
| **Android Tauri 链路复杂** | 🟡 中 | P7 优先验证；已有跑通经验（`libapp_lib.so` 符号链接绕过方案已记录） |
| **工程量爆炸 / 中途放弃** | 🔴 高 | 严格按 P0–P7 阶段交付，每阶段都可运行；P0 后任何时候停下，旧 HTML 仍可作为 fallback |
| **依赖膨胀** | 🟢 低 | Radix 按需引入子包；Tailwind 用 JIT；Vite 已是较优 bundler |

---

## 12. 禁止行为清单

> 这些是**红线**，违反需要在 PR 中明确说明并取得 review。

1. ❌ 不读 `DESIGN.md` 就开始写 UI 代码
2. ❌ 颜色使用硬编码 hex 值（必须用本文档定义的语义 Token）
3. ❌ 只实现 happy path（必须覆盖[第 9 节](#9-状态矩阵10-状态全覆盖)的 10 种状态）
4. ❌ 跳过审查直接交付（每阶段完成后必须自检对照清单）
5. ❌ 使用未在 DESIGN.md 中定义的字号 / 间距 / 圆角值
6. ❌ 自创动效参数（必须使用 `--ease-*` 和 `--duration-*` 标准值）
7. ❌ 修改旧 SQLite 表 schema（只允许新增表 + 软关联）
8. ❌ 删除现有 Rust 命令（只允许新增 / 重构内部实现）
9. ❌ 把 React 代码和旧 HTML 页面同时引入构建（只能二选一）
10. ❌ 在前端硬编码 LLM API Key（保留现有 `.env` + 后端读取的链路）

---

## 13. 学习 Agent 模式（v2 Auto-Pilot, 2026-05）

> 参考 vibe coding 平台（Cursor / Cascade / v0）的 **auto-pilot 模式**：进入即自动启动、Agent 自主拆分学习单元、流式讲解、按需出题、用户唯一介入点 = 答题。
>
> **v2 关键升级（vs 初版）**：
> - **学习单位 = 单元（unit）而非页**：Agent 在路线图阶段把整本书拆成 3-12 个学习单元，每个单元覆盖 1-N 页
> - **跳过无价值页**：版权、目录、致谢、索引、课程介绍由 Agent 在路线图阶段标 `skip_pages`，**不进入循环**
> - **按需出题**：每个单元有 `needs_quiz` 标记，过渡性内容直接讲完进入下一单元，不强制出题
> - **真流式讲解**：后端 `chat_stream` + `<<<QUESTIONS>>>` 分隔符协议；前端实时 markdown 渲染，无打字机假象
> - **零按钮 Auto-Pilot**：进入面板后无"生成本页讲解 / 下一页"按钮；用户唯一交互 = 答题 + 顶角"暂停 / 重置"

### 13.1 设计原则

1. **UI 粒度 ≠ LLM req 边界**：UI 走"流式讲解 / 答题 / 反馈 / 自动衔接"，但 **每个单元只发 1 个 LLM 调用**（讲解 + 题目合并），简答判分按需 1 req。
2. **按 request 计费友好**：整本书路线图仅 1 req；选择题前端判分 0 req；总成本 ≈ `1 + 1.2 × U` req（U = 单元数，通常 3-12）。
3. **Agent 自主裁剪**：路线图阶段决定"哪些页跳过 / 哪些页合成一个单元 / 哪个单元值不值得出题"——前端不做这些决策。
4. **复用而非重启**：不重启已废弃的 ` ```flashcards/qa ` 围栏（`progress.txt:38-42`），所有交互走**纯对话+流式**。
5. **状态可中断可恢复**：路线图、当前 unit phase、已答题、AI 反馈持久化到 SQLite，关闭后再打开继续。
6. **写笔记复用现有原子追加管道**：单元讲解仍走 `doc_reader_save_note` 的"持锁原子合并"，按 `## 第 N 页`（unit.pages 中位数）锚点对齐，**不再发明新存储**。

### 13.2 状态机

```
        (一次性 1 req)              (每单元循环：流式 1 req + 0~1 req 判分)         (终结)
   idle ──plan──▶ planning ──▶ idle ──teach_stream──▶ teaching ──stream done──▶
        ┌─ needs_quiz=false ─▶ reviewing ──auto next 800ms──▶ next unit (idle) ─┐
        └─ needs_quiz=true ──▶ probing ──submit──▶ grading ──▶ reviewing        │
                                                  ┌─ all correct ─▶ next 1500ms ┘
                                                  └─ wrong ─▶ wait user click "继续"

   达到最后单元 ──▶ done（错题集报告）
```

> 用户唯一显式操作：答题 + 暂停 + （答错后）"继续 / 重新讲解"。
> 所有"下一单元"过渡由前端 `useEffect` 在 `phase=idle` 时自动触发 `agent_teach_unit_stream`。

旧 v1 状态机（已废弃，仅供对照）：

```
        (一次性)              (每页循环)                          (终结)
[idle] ──▶ [planning] ──▶ [page:teaching] ──▶ [page:probing] ──▶ [page:grading] ──▶ [page:reviewing] ──▶ [done]
   │           │                │                  │                  │                   │
   │           ▼                ▼                  ▼                  ▼                   ▼
   └─[error]   └──user 审批      └─stream 完成       └─用户作答          └─0~1 req           └─用户点"下一页" or "再问/重讲/跳过"
                  路线图          自动进入 probing      自动进入 grading    判分完成进入 reviewing  写入笔记 → 回到 page:teaching
```

| Phase | UI 表现 | LLM req |
|---|---|---|
| `idle` | 空状态卡片 + "开始学习"按钮 | 0 |
| `planning` | 进度条 "正在生成路线图…" | 1 |
| `page:teaching` | 讲解流式打字 + 灰色"开始考察"按钮（流完才亮起） | **1**（教学包） |
| `page:probing` | 题目卡片（选择题 radio / 简答题 textarea）+ 提交按钮 | 0（题目已在缓存） |
| `page:grading` | "判分中…" loader | **0**（选择题）/ **1**（简答题，可批量） |
| `page:reviewing` | 反馈卡片 + 三按钮 [下一页 / 再问一题 / 重讲] | 0 |
| `done` | 学习报告（弱点 / 错题集快照） | 0 |

### 13.3 状态规格（10 状态全覆盖）

| 状态 | 表现 |
|---|---|
| **loading** | 路线图未拉取完成 → 全屏骨架屏 + 进度条 |
| **empty** | 资料无 `doc_session_id` 或页数=0 → "AI 学习需要可解析文本（PDF/DOCX/PPTX）" |
| **error** | 路线图 / 教学包 / 判分任意阶段失败 → 红框 + "重试" + 错误详情可展开 |
| **success** | `done`：显示学习报告 + 错题集 + "回到第一页重学"按钮 |
| **partial** | 路线图已生成但教学包失败 → 当前页错误，其他页保持已学进度 |
| **offline** | 检测到 `navigator.onLine === false` → 顶部黄色横条 "离线，AI 不可用" |
| **refreshing** | 用户点 "重讲这页" → 同 page:teaching loader，但旁注"正在重新生成讲解" |
| **submitting** | 用户提交答案后到判分前 → 提交按钮转 spinner，禁用重复提交 |
| **permission** | LLM 未配置（无 model）→ "请先在设置页配置 LLM 模型"  + 跳转按钮 |
| **firstTime** | 首次进入 Agent 模式 → 显示 onboarding 卡片，解释三段式批准流 |

### 13.4 数据模型

```sql
-- 路线图（每个 doc_session 一条）
CREATE TABLE IF NOT EXISTS agent_plans (
  session_id     TEXT PRIMARY KEY,
  outline_json   TEXT NOT NULL,   -- v2: {thesis, skip_pages[], skip_reason, units[{id,title,pages[],key_points[],needs_quiz,difficulty}]}
  page_total     INTEGER NOT NULL,
  current_page   INTEGER NOT NULL DEFAULT 0,
  current_phase  TEXT NOT NULL DEFAULT 'idle',  -- idle/teaching/probing/grading/reviewing/done
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

-- v2 注释：
-- agent_plans.outline_json 包含 {thesis, skip_pages[], skip_reason, units[]}
-- agent_plans.current_page 字段保留底层名，语义为 current_unit_index（不另建表）

-- 每单元学习状态（每 session × unit 一条）
CREATE TABLE IF NOT EXISTS agent_unit_states (
  session_id      TEXT NOT NULL,
  unit_index      INTEGER NOT NULL,
  teach_pack_json TEXT NOT NULL DEFAULT '',  -- {explanation, questions:[{id,type,prompt,choices?,answer,rubric}], unit_title}
  answers_json    TEXT NOT NULL DEFAULT '',  -- [{question_id, user_answer, is_correct, ai_feedback, score}]
  status          TEXT NOT NULL DEFAULT 'pending',  -- pending/teaching/probing/grading/done
  retries         INTEGER NOT NULL DEFAULT 0,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (session_id, unit_index)
);
```

### 13.5 后端命令契约（v2）

| Command | 入参 | 出参 / 事件 |
|---|---|---|
| `agent_plan_generate` | `session_id`, `force?` | 返回 `{plan: {outline: {thesis, skip_pages[], skip_reason, units[]}, page_total, current_unit, current_phase}}`；缓存命中直接返回，否则 1 req |
| `agent_get_state` | `session_id` | 返回 `{plan, unit_states[]}`；`plan.current_unit` 是 `unit_index` |
| `agent_teach_unit_stream` | `session_id`, `unit_index` | 立即返回 `{turn_id, unit_index, needs_quiz}`；事件流：<br/>• `agent-teach-start { turn_id, unit_index, needs_quiz, unit_title }`<br/>• `agent-teach-reasoning { turn_id, phase: 'start'\|'end' }`<br/>• `agent-teach-token { turn_id, delta }` 仅讲解段（`<<<QUESTIONS>>>` 分隔符之前）<br/>• `agent-teach-done { turn_id, unit_index, full_explanation, questions[], needs_quiz }`<br/>• `agent-teach-error { turn_id, error }` |
| `agent_submit_answers` | `session_id`, `unit_index`, `answers[]` | 选择题前端比对 0 req；简答题合并 1 req；返回 `{results: [{question_id, is_correct, ai_feedback, score, ...}]}`；持久化到 `agent_unit_states.answers_json`，phase → `reviewing` |
| `agent_advance` | `session_id`, `action` (`next` / `retry` / `pause`) | `next`：本单元 `explanation` 以 `### {unit_title}` 形式 append 到全书笔记（中位数页码作锚点），unit_index+=1，phase=idle（让前端自动触发下一单元）<br/>`retry`：清空当前单元教学包，phase=idle（前端自动重新触发流）<br/>`pause`：phase=idle 但不推进 |
| `agent_reset` | `session_id` | 清空 `agent_plans` + `agent_unit_states` |

#### 流式协议（教学单元）

后端 `chat_stream` 输出由 `<<<QUESTIONS>>>` 分隔符切两段：

```
（前段：markdown 讲解，前端实时渲染为 token）
<<<QUESTIONS>>>
（后段：JSON 数组，前端累积到流末整体解析）
```

`needs_quiz=false` 的单元 LLM 直接不输出分隔符，前端拿到 `agent-teach-done` 时 `questions=[]`，phase 自动推到 `reviewing` 再 800ms 后 `next`。

### 13.6 设计 Token 复用

- 主色 `--accent`（紫）：进度条 / 主按钮
- `--success` / `--error` / `--warning`：判分结果着色
- 状态条沿用 `RagStatusBar` 风格（圆角 `rounded-md` + `border-border-1` + 内边距 `p-2`）
- 不引入新颜色 / 字号 / 间距

### 13.7 禁止行为

1. ❌ 不要为 Agent 单独发明新的 LLM 配置/模型选择（沿用 `config::load_models`）
2. ❌ 不要把题目渲染为 ` ```flashcards / qa ` 围栏（已废弃）
3. ❌ 不要把 Agent 笔记写到 `notebook_entries`（不污染笔记本，仅 append 到本资料的全书笔记）
4. ❌ 不要在前端实现"按页死板讲解"——LLM 在路线图阶段自主拆分单元，前端不参与决策
5. ❌ 不要给用户加"生成本页讲解 / 下一页"按钮——v2 是 auto-pilot，状态衔接由 `useEffect` 自动驱动
6. ❌ 不要在 `streamingTurnId` 不为 null 时再次调用 `agent_teach_unit_stream`（防重复消耗 req；前端用 `teachStartedRef: Set<unitIndex>` 守卫）
7. ❌ 不要为流式讲解使用打字机模拟——必须用真 token 流（事件 `agent-teach-token`）

---

## 附录 A：命名约定

| 类型 | 约定 | 示例 |
|---|---|---|
| 组件文件 | PascalCase + `.tsx` | `CourseCard.tsx` |
| Hook 文件 | `use*.ts` | `useReader.ts` |
| Store 文件 | `*Store.ts` | `courseStore.ts` |
| 类型文件 | 全小写 + `.ts` | `course.ts` |
| Rust 命令 | snake_case | `course_create` / `resource_import` |
| 数据库列 | snake_case | `course_id` / `created_at` |
| CSS Token | kebab-case + `--` | `--accent` / `--space-4` |

## 附录 B：参考资料

- [readest 项目](https://github.com/readest/readest)（设计参考来源）
- [foliate-js](https://github.com/johnfactotum/foliate-js)（渲染引擎）
- [Tauri 2.x 文档](https://tauri.app/)
- [Radix UI](https://www.radix-ui.com/)
- 当前项目 Android 打包记录（见用户全局记忆）

---

**变更日志**：

| 版本 | 日期 | 说明 |
|---|---|---|
| 0.2.0-design | 2026-05-09 | 初稿：整合 readest 阅读机制 + 课程资料管理；选定 B 路线 |
