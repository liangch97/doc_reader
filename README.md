# Doc Reader

> 带 AI 学习助手的课程资料阅读 / 笔记 / 学习路径平台。
> 把 PDF / DOCX / PPTX / EPUB / MOBI 课件和 LLM 教练放进同一个 app，让"读"和"学"在同一个流程里闭环。

[![Windows / macOS / Android](https://img.shields.io/badge/platforms-Windows%20%7C%20macOS%20%7C%20Android-7C5CFC)](#)
[![Tauri 2](https://img.shields.io/badge/Tauri-2.10-FFC131?logo=tauri&logoColor=white)](https://tauri.app)
[![React 18](https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=white)](https://react.dev)
[![Rust](https://img.shields.io/badge/Rust-1.77+-CE412B?logo=rust&logoColor=white)](https://www.rust-lang.org)

---

## 功能一览

### 阅读
- **统一渲染引擎**：vendored 的 [foliate-js](https://github.com/johnfactotum/foliate-js)（MIT，来自 readest 项目）原生支持 EPUB / MOBI / AZW3 / CBZ
- **PDF / DOCX / PPTX**：Rust 端用 `pdf-extract` + `lopdf` + `zip` + `scraper` 抽文本；前端按页 card 渲染
- **批注系统**：高亮 / 划线 / 行内笔记 / 书签，cfi 与 page_index 双轴定位
- **阅读进度**：CFI 或页号 + 累计阅读时长，自动持久化到 SQLite

### 学习（v2 Auto-Pilot）
- **整本路线图**：LLM 抽样章节 → 自动跳过版权 / 目录 / 索引 / 课程介绍 → 把剩余内容拆成 3-12 个学习单元
- **流式讲解**：每个单元一次 LLM 调用，真正的 token 流（不是打字机假象）；Markdown 渲染含 KaTeX / 代码高亮 / ASCII 转 SVG
- **追问 / 加题**：每个知识点屏可"+ 再来 N 道"按需扩展练习
- **流档案**：每次重新生成路线图前可归档当前进度，随时恢复

### 训练
- **题集池**：每个学习单元同步生成训练题集（选择 / 简答 / 代码题）
- **代码题运行**：内置 [Piston](https://github.com/engineer-man/piston) 一键 Docker 部署，离线跑用户提交的代码
- **技能掌握度**：答题驱动 `skill_mastery` 累积，可视化技能树

### 课程 / 笔记本
- **课程**：必读 / 参考 / 扩展三档资料分组，进度环聚合到课程级
- **笔记本**：完整 Milkdown 编辑器，支持 zone 分区 + learning_role 标注的"学习大纲"
- **RAG**：单本资料一键索引到向量库，跨资料 chat
- **AI 笔记**：LLM 直接产出页内笔记，可应用到原文 / 笔记本

---

## 快速开始

### 环境要求

| 依赖 | 版本 |
|---|---|
| [Node.js](https://nodejs.org) | 18+ |
| [Rust](https://www.rust-lang.org/tools/install) | 1.77+ |
| [Tauri 2 系统依赖](https://tauri.app/start/prerequisites/) | 按平台配置 |
| Docker（可选） | 仅训练模块的代码运行用 |

### 1. clone + 安装

```bash
git clone https://github.com/liangch97/doc_reader.git
cd doc_reader
npm install        # postinstall 会自动从 pdfjs-dist 复制 worker / cmaps / 字体到 public/pdfjs
```

### 2. 配置 LLM

```bash
cp src-tauri/.env.example src-tauri/.env
# 编辑 src-tauri/.env，填入你的 API key
```

支持以下 provider：
- `LLM_PROVIDER=openai` —— OpenAI 官方
- `LLM_PROVIDER=anthropic` —— Anthropic Claude
- `LLM_PROVIDER=custom` —— **任意 OpenAI 兼容端点**（火山方舟 / DeepSeek / 智谱 / Moonshot / SiliconFlow / Ollama 等）

启动 app 后也可以在 SettingsPage 用图形化界面配置**多模型池**（轮询负载均衡），优先级高于 `.env`。

### 3. 启动开发模式

```bash
npm run tauri dev
```

首次启动会编译 Rust 后端（~ 3 分钟）。窗口出来后可以直接拖入 PDF / EPUB 试用。

### 4. 打包

```bash
npm run tauri build
```

产物在 `src-tauri/target/release/bundle/`：

| 平台 | 产物 |
|---|---|
| Windows | `*.msi` / `*.exe`（NSIS） |
| macOS | `*.dmg` / `*.app` |
| Android | 见 [Tauri Android 文档](https://tauri.app/develop/sidecar/#android) |

---

## 技术栈

```
┌────────────────────────────────────────────────────────────┐
│ React 18 + Vite 8 + TypeScript 5 + Tailwind 3              │
│ Zustand · React Router 6 · Radix UI · @dnd-kit             │
│ Milkdown · marked + KaTeX + highlight.js                   │
│ foliate-js（vendored）· pdfjs-dist                          │
└────────────────────────────────────────────────────────────┘
                       ↕ Tauri IPC
┌────────────────────────────────────────────────────────────┐
│ Tauri 2.10 + Rust 1.77+                                    │
│ rusqlite · reqwest · pdf-extract / lopdf · zip · scraper   │
│ tokio · serde · regex · futures                            │
└────────────────────────────────────────────────────────────┘
```

后端模块划分：

| 文件 | 职责 |
|---|---|
| `agent.rs` | 学习 Agent 协议层（路线图 / 单元教学 / 判分 / 围栏抽取） |
| `llm.rs` | LLM 客户端（多 provider / 池化轮询 / 流式 / Embedding） |
| `parser.rs` | PDF / DOCX / PPTX / HTML 文本提取（含 panic guard） |
| `db.rs` | SQLite 初始化 + 全部表 schema |
| `commands.rs` | Tauri command 入口（60+ 命令） |
| `library_db.rs` / `library_cmd.rs` | 课程 / 资料 / 进度 / 批注 / 书签 |
| `rag.rs` | RAG 知识库 + chat_stream |
| `knowledge_points.rs` | 语义边界 + TOC 切分 |
| `training.rs` | 训练题集 / 答题 / 技能掌握度 |
| `runtime.rs` | Piston 代码运行时（Docker 一键部署） |
| `epub_cover.rs` | EPUB 封面提取 |

---

## 项目结构

```
doc-reader/
├── src/                         # 前端 React 源码
│   ├── pages/                   # 路由页面（HomePage / LibraryPage / ReaderPage / ...）
│   ├── features/                # 业务模块（reader / library / courses / training）
│   ├── components/              # 通用组件（含 Milkdown 编辑器）
│   ├── shell/                   # 全局壳（TitleBar / Sidebar）
│   ├── lib/                     # Tauri 调用 / 平台检测 / 主题
│   └── styles/                  # Tailwind + 设计 Token
├── src-tauri/                   # Rust 后端
│   ├── src/                     # 见上"后端模块划分"
│   └── capabilities/            # Tauri 权限配置
├── public/
│   ├── vendor/foliate-js/       # vendored 阅读引擎
│   └── static/vendor/           # 离线运行时（KaTeX / marked / highlight.js / pdf.js）
├── scripts/
│   └── copy-pdfjs-assets.mjs    # 从 pdfjs-dist 拷 worker / cmaps（postinstall）
└── DESIGN.md                    # 设计文档（约 2400 行，单一真相来源）
```

---

## 设计文档

完整的产品定位、数据模型、UI 设计 Token、迁移路线图、状态矩阵、禁止行为清单等都在 [DESIGN.md](./DESIGN.md)。

任何代码改动开始前请先读 DESIGN.md。

---

## 致谢

- [foliate-js](https://github.com/johnfactotum/foliate-js) by John Factotum（MIT）—— 阅读引擎
- [readest](https://github.com/readest/readest)（AGPL 3.0）—— 设计灵感来源
- [Tauri](https://tauri.app)、[React](https://react.dev)、[Milkdown](https://milkdown.dev) 及其它众多开源项目

---

## License

本项目暂未指定 license，请联系作者讨论使用。
