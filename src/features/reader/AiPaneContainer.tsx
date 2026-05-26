import { useCallback, useEffect, useRef, useState } from 'react'
import { Sparkles, Send, Loader2, RefreshCw, BookmarkPlus, Check, Plus, Pencil, Trash2, ChevronDown, Copy, Database, AlertCircle, Layers } from 'lucide-react'
import { invoke } from '@/lib/tauri'
import type { RagSource, RagIndexStatus, RagBuildProgressEvent, RagBuildDoneEvent } from '@/lib/tauri'
import type { Resource } from '@/types/resource'
import type { FoliateTocItem } from '@/lib/foliate'
import { cn } from '@/lib/cn'
import { MarkdownView, loadMdTheme, saveMdTheme, type MdTheme } from '@/components/markdown/MarkdownView'
import { MarkdownEditor } from '@/components/markdown/MarkdownEditor'
import { MdThemePicker } from '@/components/markdown/MdThemePicker'
import { notebooksApi } from '@/lib/api'
import type { Notebook } from '@/types/notebook'
import { onAiExplain } from './readerAiBus'
import { AgentTab } from './AgentTab'
import { TrainingTab } from '@/features/training/TrainingTab'
import { LearningHistoryPanel } from './LearningHistoryPanel'
import { StreamNotesView } from './StreamNotesView'
import { setKeyboardOwner } from './keyboardFocus'

type Tab = 'note' | 'chat' | 'agent' | 'training' | 'vibe'

interface Props {
  resource: Resource
  /** 保留参数以兼容调用方；大纲已迁移到左栏 TocPanel，这里不再使用。 */
  toc?: FoliateTocItem[]
  /** 当前页索引（仅 doc_session 场景有意义） */
  currentPageIndex?: number
  /**
   * 当前可见页面的原始文本（从 Foliate / PdfPptxAdapter 透传）。
   * 优先于 `doc_reader_get_page(pageIndex)` 查出的 DB 内容作为 AI 的 prompt。
   */
  currentPageContent?: string
  /**
   * 受控显示模式 ('note' | 'chat')。由 RightPane 的顶层 4-tab 决定，
   * 不再在面板内部再开一层「笔记 / 聊天」tab。不传则默认 'note'。
   */
  mode?: Tab
  /** RAG 来源跳转回调（ReaderShell 提供） */
  onJumpPage?: (pageIndex: number) => void
}

interface ChatMsg {
  role: 'user' | 'assistant'
  content: string
  /** RAG 检索来源（仅 assistant 消息有,且仅在走 RAG 时非空) */
  sources?: RagSource[]
  /** 是否走了 fallback(无索引时退回单页 chat) */
  fallback?: 'no_index'
  /** 该轮 turn_id(用于流式时按 id 匹配增量) */
  turn_id?: string
  /** 助手的"下一步追问"建议(流结束后异步推送) */
  followups?: string[]
  /** 流式状态:streaming 中渲染光标,done 后取消 */
  streaming?: boolean
  /** 是否处于"思考中"阶段(模型在 <think> 块内,UI 应显示"思考中…"而不是空白光标) */
  reasoning?: boolean
}

/**
 * AI 面板：复用旧版 Rust 命令
 * - tab 仅保留「笔记」/「聊天」两项（大纲与左栏 TocPanel 重复，已下线）
 * - 笔记 tab 在 doc_session 不存在时仍允许手写（仅禁用 AI 生成）；
 *   doc_session_id 仅决定是否能调 LLM。
 */
export function AiPaneContainer({
  resource,
  toc: _toc,
  currentPageIndex,
  currentPageContent,
  mode = 'note',
  onJumpPage,
}: Props) {
  void _toc
  const sessionId = resource.doc_session_id || null
  const aiAvailable = !!sessionId

  // mode 切换时同步键盘默认所有权：切到 agent tab → 默认翻学习屏；
  // 切到其他 tab → 默认翻 PDF。鼠标 hover 会进一步覆盖。
  useEffect(() => {
    setKeyboardOwner(mode === 'agent' ? 'agent' : 'pdf')
  }, [mode])

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-hidden">
        {/*
          不再用条件卸载：用 hidden 切换可见性，让联聪插件、在途中的 fetch promise、
          已输入的草稿都随着会话一起保留。为修复「切换窗口 / 页面 chat 丢掉结果」。
          NoteTab 反正轻量：ChatTab 当无 doc_session 时不渲染。
        */}
        <div className={cn('h-full', mode !== 'note' && 'hidden')}>
          <NoteTab
            sessionId={sessionId}
            visibleContent={currentPageContent}
            currentDisplayPageIndex={currentPageIndex}
            resourceId={resource.resource_id}
            resourceTitle={resource.title}
          />
        </div>
        {aiAvailable && (
          <div className={cn('h-full', mode !== 'chat' && 'hidden')}>
            <ChatTab
              sessionId={sessionId!}
              pageIndex={currentPageIndex ?? 0}
              pageContent={currentPageContent}
              onJumpPage={onJumpPage}
            />
          </div>
        )}
        {mode === 'chat' && !aiAvailable && (
          <div className="flex h-full items-center justify-center p-6 text-center text-xs text-text-3">
            AI 聊天需要资料已抽取文本（PDF / DOCX / PPTX / HTML）。
          </div>
        )}
        {aiAvailable && (
          <div
            className={cn('h-full', mode !== 'agent' && 'hidden')}
            // 鼠标进入 Agent 区 → 键盘所有权切到 'agent'，方向键翻学习屏
            onMouseEnter={() => setKeyboardOwner('agent')}
          >
            {/* isActive 让 AgentTab 仅在自己被显示时才抢占键盘方向键，
                避免：① 切到 chat / note tab 时后台 Agent 屏仍偷偷翻；
                      ② Agent 屏和 PDF 同时翻（之前两个 window listener 各自处理键盘）。
                AgentTab 内部还会再读 keyboardOwner —— 鼠标移到 PDF 区时即使 isActive=true
                也不抢键盘。*/}
            <AgentTab
              sessionId={sessionId!}
              currentDisplayPageIndex={currentPageIndex}
              visibleContent={currentPageContent}
              onJumpPage={onJumpPage}
              isActive={mode === 'agent'}
            />
          </div>
        )}
        {mode === 'agent' && !aiAvailable && (
          <div className="flex h-full items-center justify-center p-6 text-center text-xs text-text-3">
            学习 Agent 需要资料已抽取文本（PDF / DOCX / PPTX / HTML）。
          </div>
        )}
        {/* 训练模块：与 agent tab 同样依赖 doc_session（要从单元 explanation 出发命题） */}
        {aiAvailable && (
          <div className={cn('h-full', mode !== 'training' && 'hidden')}>
            <TrainingTab sessionId={sessionId!} isActive={mode === 'training'} />
          </div>
        )}
        {mode === 'training' && !aiAvailable && (
          <div className="flex h-full items-center justify-center p-6 text-center text-xs text-text-3">
            训练模块需要资料已抽取文本（PDF / DOCX / PPTX / HTML），并完成至少一个学习单元。
          </div>
        )}
        {/* v6 (2026-05) #3+ 修订：以**档案管理**为主的学习历史面板。
            内部含「档案管理」(默认) / 「时间线」两个子 tab —— 用户可在档案视角和事件视角之间切换。 */}
        {aiAvailable && (
          <div className={cn('h-full', mode !== 'vibe' && 'hidden')}>
            <LearningHistoryPanel sessionId={sessionId!} isActive={mode === 'vibe'} />
          </div>
        )}
        {mode === 'vibe' && !aiAvailable && (
          <div className="flex h-full items-center justify-center p-6 text-center text-xs text-text-3">
            学习历史需要资料已抽取文本，并至少进行过一次学习或训练。
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Note Tab ───────────────────────────────────────────────────────────

interface PageData {
  page: { content: string; word_count: number }
  note: { content: string; source: string } | null
}

/**
 * 阅读器右栏「全书笔记」。
 *
 * **整本书单一笔记**（用户决策）：
 *  - 不再随翻页刷新内容；翻页只更新 `visibleContent`（作为下次 AI 生成的"看到的文本"）
 *  - 所有 AI 生成都以 **追加** 形式合并到这一份笔记末尾（后端 `doc_reader_generate_note`
 *    在占锁期间已实现"读出已有 + append AI + 写回"的原子合并）
 *  - 前端契约：固定使用 `page_index = 0` 作为本资料的"全书笔记"主键。
 *    后端 `(session_id, page_index)` 复合主键不变；这只是前端选了一个稳定哨兵值。
 *  - 历史已生成的 per-page 笔记不会自动合并（用户既然要"整本一个"就不该再看到旧的散页）。
 *
 * 设计要点：
 * 1. 内容区始终呈现 MarkdownEditor，可直接手写；输入防抖 600ms 自动保存到
 *    `doc_reader_save_note(session, 0, content)`。
 * 2. 点击「AI 生成 / AI 补充」：把"当前可见页文本 + 已有笔记内容"一起喂给后端，
 *    后端原子追加并触发 `doc-note-generated` 事件回到前端。
 * 3. 无 doc_session 资料（EPUB 等）走 localStorage fallback，全书共享单 key。
 */
/** 全书笔记在 (session, page_index) 主键中使用的固定哨兵 page_index */
const WHOLE_BOOK_PAGE_INDEX = 0

function NoteTab({
  sessionId,
  visibleContent,
  currentDisplayPageIndex,
  resourceId,
  resourceTitle,
}: {
  sessionId: string | null
  /** 优先作为 AI 生成依据的当前可见文本（来自上层 currentPageContent）。 */
  visibleContent?: string
  /** 真实当前阅读页（0-based）。用于 AI prompt 的页码 + `## 第 N 页` 锚点排序。 */
  currentDisplayPageIndex?: number
  resourceId: string
  /** 用于"保存到笔记本"时构造默认标题。 */
  resourceTitle?: string
}) {
  // 整本书一个笔记 —— 永远存到 (session, 0)
  const pageIndex = WHOLE_BOOK_PAGE_INDEX
  const aiAvailable = !!sessionId
  // v6 (2026-05) #3+ D5: 子 tab 切换
  //   - 'classroom' : 用户手写的课堂笔记（沿用原有 dr_save_note 流程）
  //   - 'stream'    : 学习 Agent 自动产出的学习流笔记（只读 + 可导出）
  // 仅 aiAvailable 时显示子 tab；EPUB 等无 doc_session 资料隐藏（只有课堂笔记）
  const [noteSubTab, setNoteSubTab] = useState<'classroom' | 'stream'>('classroom')
  const [data, setData] = useState<PageData | null>(null)
  // v5 (2026-05) B5: 移除 'generating' 态 —— 笔记 AI 生成入口在 v4 已下线，
  // 这里只保留纯加载/错误两态。学习区 Agent 通过 entry 双向同步生成笔记内容。
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('loading')
  const [error, setError] = useState('')
  const [mdTheme, setMdTheme] = useState<MdTheme>(() => loadMdTheme('notes'))
  const [savePickerOpen, setSavePickerOpen] = useState(false)
  const [notebooks, setNotebooks] = useState<Notebook[]>([])
  const [savedNbId, setSavedNbId] = useState<string | null>(null)
  const [savingTo, setSavingTo] = useState<string | null>(null)
  const pickerRef = useRef<HTMLDivElement | null>(null)
  // Inline editing state
  const [editContent, setEditContent] = useState('')
  const [editorEpoch, setEditorEpoch] = useState(0)
  const [autosave, setAutosave] = useState<'idle' | 'saving' | 'saved'>('idle')
  const saveTimerRef = useRef<number | null>(null)

  useEffect(() => {
    if (!savePickerOpen) return
    notebooksApi.list().then(setNotebooks).catch(() => {})
    const close = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setSavePickerOpen(false)
      }
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [savePickerOpen])

  /**
   * 本地 fallback 存储键：用于没有 doc_session 的资料（纯 EPUB 等）。
   * 整本书一个笔记 → 不再带 pageIndex 后缀；旧 per-page 的散页留在 localStorage
   * 不会被自动合并（与后端的策略一致）。
   */
  const fallbackKey = `doc-reader.note-fallback.${resourceId}`

  const saveToNotebook = async (nb: Notebook) => {
    const content = editContent || data?.note?.content || ''
    if (!content.trim()) return
    try {
      setSavingTo(nb.notebook_id)
      await notebooksApi.addEntry({
        notebookId: nb.notebook_id,
        title: resourceTitle ? `${resourceTitle} · 阅读笔记` : '阅读笔记',
        content,
        entryType: 'ai',
        sourceInfo: '阅读器全书笔记 · 手写 / AI 生成',
      })
      setSavedNbId(nb.notebook_id)
      setSavePickerOpen(false)
      setTimeout(() => setSavedNbId(null), 2000)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSavingTo(null)
    }
  }

  const setTheme = (t: MdTheme) => {
    setMdTheme(t)
    saveMdTheme(t, 'notes')
  }

  const reload = useCallback(async () => {
    if (!aiAvailable) {
      // 无 doc_session 场景：走 localStorage fallback
      try {
        const cached = localStorage.getItem(fallbackKey) || ''
        setData({
          page: { content: '', word_count: 0 },
          note: cached ? { content: cached, source: 'manual' } : null,
        })
        setEditContent(cached)
        setEditorEpoch((n) => n + 1)
        setStatus('idle')
      } catch {
        setStatus('idle')
      }
      return
    }
    try {
      setStatus('loading')
      const d = await invoke<PageData>('doc_reader_get_page', {
        sessionId,
        pageIndex,
      })
      setData(d)
      setEditContent(d.note?.content || '')
      setEditorEpoch((n) => n + 1)
      setStatus('idle')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setStatus('error')
    }
  }, [sessionId, pageIndex, aiAvailable, fallbackKey])

  // 切页时若仍有挂起的保存，先冲掉
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        window.clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
      }
    }
  }, [])

  const scheduleAutosave = useCallback(
    (md: string) => {
      setEditContent(md)
      setAutosave('saving')
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current)
      saveTimerRef.current = window.setTimeout(async () => {
        try {
          if (aiAvailable) {
            await invoke('doc_reader_save_note', {
              sessionId,
              pageIndex,
              content: md,
            })
          } else {
            // EPUB 等无 doc_session 资料：手写内容走 localStorage
            try {
              localStorage.setItem(fallbackKey, md)
            } catch {
              /* quota / privacy mode — 忽略 */
            }
          }
          setAutosave('saved')
          window.setTimeout(() => setAutosave('idle'), 1500)
        } catch (e) {
          setAutosave('idle')
          setError(e instanceof Error ? e.message : String(e))
        }
      }, 600)
    },
    [sessionId, pageIndex, aiAvailable, fallbackKey]
  )

  useEffect(() => {
    reload()
  }, [reload])

  // v5 (2026-05) B5: 移除 doc-note-generated / doc-note-error 监听器与 generate() 函数。
  // 笔记 AI 生成入口已下线（v4 起），后端 doc_reader_generate_note 命令仍保留（兼容外部调用），
  // 但前端不再触发也不再消费对应事件。学习区 Agent 通过 entry 双向同步覆盖笔记内容。

  const hasContent = !!editContent.trim()

  // 学习流子 tab：只在 doc_session 可用时提供（EPUB 等没有 agent_stream_notes）
  if (aiAvailable && noteSubTab === 'stream') {
    return (
      <div className="relative flex h-full flex-col">
        <NoteSubTabBar value={noteSubTab} onChange={setNoteSubTab} />
        <div className="min-h-0 flex-1">
          <StreamNotesView sessionId={sessionId!} />
        </div>
      </div>
    )
  }

  return (
    <div className="relative flex h-full flex-col">
      {aiAvailable && <NoteSubTabBar value={noteSubTab} onChange={setNoteSubTab} />}
      {/* 工具栏：贴顶不占额外边距，与内容之间只靠 border-b 分隔 */}
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border-1 bg-surface-1 px-2 py-1.5 text-[11px]">
        <span className="truncate text-text-3">
          全书笔记
          {autosave !== 'idle' && (
            <span className="ml-1 text-text-3">
              · {autosave === 'saving' ? '保存中…' : '已保存'}
            </span>
          )}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <MdThemePicker value={mdTheme} onChange={setTheme} />
          {aiAvailable && (
            <button
              type="button"
              onClick={reload}
              className="rounded p-1 text-text-3 hover:bg-surface-2 hover:text-text-1"
              title="刷新"
            >
              <RefreshCw className="h-3 w-3" />
            </button>
          )}
          {/* v4 (2026-05): 「知识点 → 剪贴板」按钮已移除 —— AI 生成笔记入口下线，
              讲解笔记由学习 Agent 通过 entry 双向同步生成。 */}
          {hasContent && (
            <div ref={pickerRef} className="relative">
              <button
                type="button"
                onClick={() => setSavePickerOpen((v) => !v)}
                className="flex items-center gap-1 rounded-md border border-border-1 bg-surface-1 px-2 py-1 text-[11px] text-text-1 hover:bg-surface-2"
                title="保存到笔记本"
              >
                {savedNbId ? <Check className="h-3 w-3 text-success" /> : <BookmarkPlus className="h-3 w-3" />}
                {savedNbId ? '已保存' : '保存到'}
              </button>
              {savePickerOpen && (
                <div className="absolute right-0 top-full z-50 mt-1 max-h-72 w-56 overflow-y-auto rounded-md border border-popover-border bg-popover shadow-2xl">
                  {notebooks.length === 0 && (
                    <div className="p-3 text-[11px] text-text-3">暂无笔记本，请先创建</div>
                  )}
                  {notebooks.map((nb) => (
                    <button
                      key={nb.notebook_id}
                      type="button"
                      disabled={savingTo === nb.notebook_id}
                      onClick={() => saveToNotebook(nb)}
                      className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-text-1 hover:bg-surface-2 disabled:opacity-50"
                    >
                      <span
                        className="h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{ background: nb.color || '#7C5CFC' }}
                      />
                      <span className="min-w-0 flex-1 truncate">{nb.name}</span>
                      <span className="text-[10px] text-text-3">{nb.entry_count ?? 0}</span>
                      {savingTo === nb.notebook_id && <Loader2 className="h-3 w-3 animate-spin" />}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {/* v4 (2026-05): 「AI 生成 / AI 补充」按钮已移除 —— 笔记由学习 Agent 通过 entry 双向同步生成。 */}
        </div>
      </div>

      {/* 内容区：始终渲染编辑器。空页也可直接手写。 */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {status === 'loading' && (
          <div className="px-2 py-2 text-xs text-text-3">加载中…</div>
        )}
        {status === 'error' && (
          <div className="px-2 py-2 text-xs text-error">{error}</div>
        )}
        {status === 'idle' && (
          <div className={`md-root md-compact md-theme-${mdTheme} px-2 py-2`}>
            <MarkdownEditor
              key={`${sessionId ?? 'no-session'}:${pageIndex}:${editorEpoch}`}
              defaultValue={editContent || data?.note?.content || ''}
              onChange={scheduleAutosave}
            />
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * NoteTab 顶部子 tab 切换条（v6 #3+ D5）。
 * 视觉风格：薄 border-b + 小号文本，与现有 NoteTab 工具栏一致。
 * 「学习流」选中时整个 NoteTab 切换到 <StreamNotesView />。
 */
function NoteSubTabBar({
  value,
  onChange,
}: {
  value: 'classroom' | 'stream'
  onChange: (v: 'classroom' | 'stream') => void
}) {
  return (
    <div className="flex shrink-0 items-center gap-0 border-b border-border-1 bg-bg-2/30 px-2 text-[11px]">
      <SubTabBtn active={value === 'classroom'} onClick={() => onChange('classroom')}>
        📝 课堂笔记
      </SubTabBtn>
      <SubTabBtn active={value === 'stream'} onClick={() => onChange('stream')}>
        ✨ 学习流
      </SubTabBtn>
    </div>
  )
}

function SubTabBtn({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'border-b-2 px-2.5 py-1.5 transition',
        active
          ? 'border-indigo-500 text-text-1'
          : 'border-transparent text-text-3 hover:text-text-2',
      )}
    >
      {children}
    </button>
  )
}

// ─── Chat Tab ───────────────────────────────────────────────────────────

/**
 * 单个会话的数据形态。多会话存在同一份资料下，按 sessionId 分组。
 */
interface Conversation {
  id: string
  title: string
  msgs: ChatMsg[]
  draft: string
  createdAt: number
  updatedAt: number
}

interface ChatState {
  conversations: Conversation[]
  activeId: string
}

function makeNewConv(title = '新对话'): Conversation {
  const now = Date.now()
  return {
    id: `c_${now.toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    title,
    msgs: [],
    draft: '',
    createdAt: now,
    updatedAt: now,
  }
}

/**
 * 从 localStorage 读取多会话状态。
 * 兼容旧格式：早期版本只有 `doc-reader:chat:msgs:${sessionId}` 单一会话，迁移成一条会话。
 */
function loadChatState(sessionId: string): ChatState {
  const stateKey = `doc-reader:chat:state:${sessionId}`
  try {
    const raw = localStorage.getItem(stateKey)
    if (raw) {
      const parsed = JSON.parse(raw) as ChatState
      if (parsed && Array.isArray(parsed.conversations) && parsed.conversations.length > 0) {
        const activeId = parsed.conversations.some((c) => c.id === parsed.activeId)
          ? parsed.activeId
          : parsed.conversations[0].id
        return { conversations: parsed.conversations, activeId }
      }
    }
    // 迁移旧单会话格式
    const oldMsgsKey = `doc-reader:chat:msgs:${sessionId}`
    const oldDraftKey = `doc-reader:chat:draft:${sessionId}`
    const oldMsgsRaw = localStorage.getItem(oldMsgsKey)
    const oldDraft = localStorage.getItem(oldDraftKey) ?? ''
    if (oldMsgsRaw || oldDraft) {
      const oldMsgs = oldMsgsRaw ? (JSON.parse(oldMsgsRaw) as ChatMsg[]) : []
      const conv = makeNewConv('历史对话')
      conv.msgs = Array.isArray(oldMsgs) ? oldMsgs : []
      conv.draft = oldDraft
      try {
        localStorage.removeItem(oldMsgsKey)
        localStorage.removeItem(oldDraftKey)
      } catch {
        /* ignore */
      }
      return { conversations: [conv], activeId: conv.id }
    }
  } catch {
    /* fall through */
  }
  const first = makeNewConv()
  return { conversations: [first], activeId: first.id }
}

function ChatTab({
  sessionId,
  pageIndex,
  pageContent,
  onJumpPage,
}: {
  sessionId: string
  pageIndex: number
  /** 当前页可见文本：优先于后端 DB 查 page_index → 绕过 PDF parser 历史错位 */
  pageContent?: string
  /** 来源跳转（来自 ReaderShell） */
  onJumpPage?: (pageIndex: number) => void
}) {
  // 多会话状态持久化到 localStorage（按 sessionId 隔离）。
  // 修复用户反馈："聊天记录无法保存，并且聊天框一切内容就会消失"
  // 进阶："新建/切换/重命名/删除"多个会话
  const stateKey = `doc-reader:chat:state:${sessionId}`
  const [state, setState] = useState<ChatState>(() => loadChatState(sessionId))
  const [busy, setBusy] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [mdTheme] = useState<MdTheme>(() => loadMdTheme())
  const scrollRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const lastSeqRef = useRef(0)

  // ─── RAG 状态 ─────────────────────────────────────────────────────────
  // useRag = true 时，send() 调 'rag_chat_stream'(流式 + RAG)；
  // false 时调老的 'doc_reader_chat'（一次性、不走 RAG）。
  // 默认开启；若用户没配 embedding 模型，第一次 send 会拿到 fallback='no_index'，
  // 提示用户去设置页配置。开关被持久化到 localStorage（按 sessionId 隔离）。
  const ragToggleKey = `doc-reader:chat:rag-on:${sessionId}`
  const [useRag, setUseRagState] = useState<boolean>(() => {
    try {
      const v = localStorage.getItem(ragToggleKey)
      return v === null ? true : v === '1'
    } catch {
      return true
    }
  })
  const setUseRag = (v: boolean) => {
    setUseRagState(v)
    try {
      localStorage.setItem(ragToggleKey, v ? '1' : '0')
    } catch {
      /* ignore */
    }
  }

  // 索引状态：none / pending / building / ready / failed
  const [ragStatus, setRagStatus] = useState<RagIndexStatus | null>(null)
  const [ragProgress, setRagProgress] = useState<{ completed: number; total: number } | null>(null)
  const [ragBuilding, setRagBuilding] = useState(false)

  const refreshRagStatus = useCallback(async () => {
    try {
      const s = await invoke<RagIndexStatus>('rag_index_status', { sessionId })
      setRagStatus(s)
      // 若后端依然 building 但前端没接到 progress（页面刷新场景），保持 ragBuilding
      if (s.status === 'building') setRagBuilding(true)
      else setRagBuilding(false)
    } catch (e) {
      console.warn('[rag] index_status failed', e)
    }
  }, [sessionId])

  useEffect(() => {
    refreshRagStatus()
  }, [refreshRagStatus])

  // 监听后台索引事件
  useEffect(() => {
    let unlisten1: (() => void) | undefined
    let unlisten2: (() => void) | undefined
    ;(async () => {
      const { listen } = await import('@tauri-apps/api/event')
      unlisten1 = await listen<RagBuildProgressEvent>('rag-build-progress', (ev) => {
        if (ev.payload.session_id !== sessionId) return
        setRagProgress({ completed: ev.payload.completed, total: ev.payload.total })
        setRagBuilding(true)
      })
      unlisten2 = await listen<RagBuildDoneEvent>('rag-build-done', (ev) => {
        if (ev.payload.session_id !== sessionId) return
        setRagBuilding(false)
        setRagProgress(null)
        refreshRagStatus()
      })
    })()
    return () => {
      unlisten1?.()
      unlisten2?.()
    }
  }, [sessionId, refreshRagStatus])

  const buildOrRebuildIndex = async (rebuild: boolean) => {
    try {
      setRagBuilding(true)
      setRagProgress(null)
      await invoke('rag_index_session', { sessionId, rebuild })
      // 立即刷新一下状态（后端会发 rag-build-progress / rag-build-done）
      refreshRagStatus()
    } catch (e) {
      setRagBuilding(false)
      console.error('[rag] index_session failed', e)
      // 在面板底部显示 toast：直接 push 一条 assistant 错误消息
      const msg = e instanceof Error ? e.message : String(e)
      setState((s) => ({
        ...s,
        conversations: s.conversations.map((c) =>
          c.id === s.activeId
            ? {
                ...c,
                msgs: [
                  ...c.msgs,
                  { role: 'assistant', content: `❌ 构建知识库失败：${msg}` },
                ],
                updatedAt: Date.now(),
              }
            : c
        ),
      }))
    }
  }

  const active = state.conversations.find((c) => c.id === state.activeId) ?? state.conversations[0]
  const msgs = active?.msgs ?? []
  const input = active?.draft ?? ''

  // 当 active 不存在时（异常态）兜底创建一条
  useEffect(() => {
    if (!active) {
      const c = makeNewConv()
      setState({ conversations: [c], activeId: c.id })
    }
  }, [active])

  // 持久化整个状态：消息长度上限 200 条/会话；会话数量上限 50（超出删最旧）
  useEffect(() => {
    try {
      const cleaned: ChatState = {
        activeId: state.activeId,
        conversations: state.conversations
          .slice(-50)
          .map((c) => ({ ...c, msgs: c.msgs.length > 200 ? c.msgs.slice(-200) : c.msgs })),
      }
      localStorage.setItem(stateKey, JSON.stringify(cleaned))
    } catch {
      /* quota / private mode */
    }
  }, [state, stateKey])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [msgs])

  // 点外部关菜单
  useEffect(() => {
    if (!menuOpen) return
    const onDoc = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [menuOpen])

  /** 修改当前活动会话的字段 */
  const patchActive = useCallback((patch: Partial<Conversation>) => {
    setState((s) => ({
      ...s,
      conversations: s.conversations.map((c) =>
        c.id === s.activeId ? { ...c, ...patch, updatedAt: Date.now() } : c
      ),
    }))
  }, [])

  const setInput = useCallback(
    (v: string) => patchActive({ draft: v }),
    [patchActive]
  )

  // 选区 AI 解释 prefill
  useEffect(() => {
    const off = onAiExplain(
      (p) => {
        if (p.seq <= lastSeqRef.current) return
        lastSeqRef.current = p.seq
        if (!p.text) return // 顶部"AI 生成笔记"按钮发空文本，仅用于唤起右栏
        const prefilled = `请解释下面这段文本：\n\n"""\n${p.text}\n"""`
        setInput(prefilled)
        queueMicrotask(() => {
          const ta = textareaRef.current
          if (!ta) return
          ta.focus()
          const len = ta.value.length
          try {
            ta.setSelectionRange(len, len)
          } catch {
            /* ignore */
          }
        })
      },
      { consumePending: true, lastSeenSeq: lastSeqRef.current }
    )
    return off
  }, [setInput])

  const newConversation = () => {
    const c = makeNewConv()
    setState((s) => ({ conversations: [...s.conversations, c], activeId: c.id }))
    setMenuOpen(false)
    queueMicrotask(() => textareaRef.current?.focus())
  }
  const switchTo = (id: string) => {
    setState((s) => ({ ...s, activeId: id }))
    setMenuOpen(false)
  }
  const renameActive = () => {
    if (!active) return
    const next = window.prompt('重命名对话', active.title)
    if (next && next.trim()) patchActive({ title: next.trim().slice(0, 60) })
    setMenuOpen(false)
  }
  const deleteActive = () => {
    if (!active) return
    if (!window.confirm(`确定删除对话「${active.title}」？此操作不可恢复。`)) return
    setState((s) => {
      const rest = s.conversations.filter((c) => c.id !== s.activeId)
      if (rest.length === 0) {
        const c = makeNewConv()
        return { conversations: [c], activeId: c.id }
      }
      return { conversations: rest, activeId: rest[rest.length - 1].id }
    })
    setMenuOpen(false)
  }

  // ─── 流式响应:把 in-flight turn 用 ref 缓存,事件回来时按 turn_id 找消息 ──
  // 不放在 state 里,因为事件触发频率高(每 token 一次),用 ref 直接 setState 单条 msg
  // 比每次都 mapping 整个 conversations 数组要轻
  const activeTurnRef = useRef<string | null>(null)
  const turnAccumRef = useRef<string>('')

  const send = async () => {
    if (!active) return
    const q = input.trim()
    if (!q || busy) return
    // 追加 user 消息；同时如果是首条用户消息，自动用前 20 字命名
    const isFirst = msgs.length === 0
    const newMsgs: ChatMsg[] = [...msgs, { role: 'user', content: q }]
    patchActive({
      msgs: newMsgs,
      draft: '',
      title: isFirst ? q.replace(/\s+/g, ' ').slice(0, 30) : active.title,
    })
    setBusy(true)
    try {
      const history: Array<[string, string]> = msgs.map((m) => [m.role, m.content])

      if (!useRag) {
        // 关闭 RAG → 走原来的非流式单页 chat（保留作为降级 / 调试用）
        const res = await invoke<{ answer: string }>('doc_reader_chat', {
          sessionId,
          question: q,
          pageIndex,
          pageContent: pageContent && pageContent.trim() ? pageContent : undefined,
          history,
        })
        setState((s) => ({
          ...s,
          conversations: s.conversations.map((c) =>
            c.id === active.id
              ? { ...c, msgs: [...newMsgs, { role: 'assistant', content: res.answer }], updatedAt: Date.now() }
              : c
          ),
        }))
        setBusy(false)
        return
      }

      // 走流式 RAG。命令立即返回 turn_id;真正内容靠 chat-stream-* 事件
      const startResp = await invoke<{
        turn_id: string
        sources: RagSource[]
        retrieved_count: number
        fallback?: 'no_index'
      }>('rag_chat_stream', {
        sessionId,
        question: q,
        pageIndex,
        pageContent: pageContent && pageContent.trim() ? pageContent : undefined,
        history,
        topK: 5,
        withFollowups: true,
      })

      activeTurnRef.current = startResp.turn_id
      turnAccumRef.current = ''

      // 占位的 assistant 消息(streaming=true 让 UI 显示光标)
      const placeholder: ChatMsg = {
        role: 'assistant',
        content: '',
        turn_id: startResp.turn_id,
        sources: startResp.sources,
        fallback: startResp.fallback,
        streaming: true,
      }
      setState((s) => ({
        ...s,
        conversations: s.conversations.map((c) =>
          c.id === active.id
            ? { ...c, msgs: [...newMsgs, placeholder], updatedAt: Date.now() }
            : c
        ),
      }))
      // setBusy 在 chat-stream-done / chat-stream-error 后再 false
      // 索引 fallback 触发刷新(前端能更新状态条)
      if (startResp.fallback === 'no_index') {
        refreshRagStatus()
      }
    } catch (e) {
      setState((s) => ({
        ...s,
        conversations: s.conversations.map((c) =>
          c.id === active.id
            ? {
                ...c,
                msgs: [
                  ...newMsgs,
                  { role: 'assistant', content: `❌ ${e instanceof Error ? e.message : String(e)}` },
                ],
                updatedAt: Date.now(),
              }
            : c
        ),
      }))
      setBusy(false)
    }
  }

  // 监听 chat-stream-* 事件并按 turn_id 匹配并更新对应 assistant 消息
  useEffect(() => {
    let unlistenToken: (() => void) | undefined
    let unlistenDone: (() => void) | undefined
    let unlistenError: (() => void) | undefined
    let unlistenFollowups: (() => void) | undefined
    let unlistenReasoning: (() => void) | undefined

    const updateMsgByTurn = (turnId: string, patch: Partial<ChatMsg>) => {
      setState((s) => ({
        ...s,
        conversations: s.conversations.map((c) => ({
          ...c,
          msgs: c.msgs.map((m) =>
            m.turn_id === turnId ? { ...m, ...patch } : m
          ),
        })),
      }))
    }

    ;(async () => {
      const { listen } = await import('@tauri-apps/api/event')
      unlistenToken = await listen<{ turn_id: string; delta: string }>(
        'chat-stream-token',
        (ev) => {
          const tid = ev.payload.turn_id
          // 仅响应当前活动的 turn(避免历史 turn 残留事件污染)
          if (tid !== activeTurnRef.current) return
          turnAccumRef.current += ev.payload.delta
          updateMsgByTurn(tid, { content: turnAccumRef.current })
        }
      )
      unlistenDone = await listen<{ turn_id: string; full_answer: string }>(
        'chat-stream-done',
        (ev) => {
          const tid = ev.payload.turn_id
          if (tid !== activeTurnRef.current) return
          updateMsgByTurn(tid, {
            content: ev.payload.full_answer,
            streaming: false,
          })
          activeTurnRef.current = null
          turnAccumRef.current = ''
          setBusy(false)
        }
      )
      unlistenError = await listen<{ turn_id: string; error: string }>(
        'chat-stream-error',
        (ev) => {
          const tid = ev.payload.turn_id
          if (tid !== activeTurnRef.current) return
          updateMsgByTurn(tid, {
            content: `❌ ${ev.payload.error}`,
            streaming: false,
          })
          activeTurnRef.current = null
          turnAccumRef.current = ''
          setBusy(false)
        }
      )
      unlistenFollowups = await listen<{ turn_id: string; followups: string[] }>(
        'chat-stream-followups',
        (ev) => {
          // 追问可能晚于 done 到,所以不限制 activeTurnRef 比较;直接按 turn_id 匹配
          updateMsgByTurn(ev.payload.turn_id, { followups: ev.payload.followups })
        }
      )
      unlistenReasoning = await listen<{ turn_id: string; phase: 'start' | 'end' }>(
        'chat-stream-reasoning',
        (ev) => {
          const tid = ev.payload.turn_id
          if (tid !== activeTurnRef.current) return
          updateMsgByTurn(tid, { reasoning: ev.payload.phase === 'start' })
        }
      )
    })()
    return () => {
      unlistenToken?.()
      unlistenDone?.()
      unlistenError?.()
      unlistenFollowups?.()
      unlistenReasoning?.()
    }
  }, [])

  if (!active) return null

  return (
    <div className="flex h-full flex-col">
      {/* 会话栏：标题下拉 + 新建 + 重命名 + 删除 */}
      <div className="relative flex shrink-0 items-center gap-1 border-b border-border-1 px-2 py-1.5 text-xs">
        <div ref={menuRef} className="relative min-w-0 flex-1">
          <button
            type="button"
            className="flex w-full items-center gap-1 rounded px-2 py-1 text-left hover:bg-surface-2"
            onClick={() => setMenuOpen((v) => !v)}
            title="切换会话"
          >
            <span className="min-w-0 flex-1 truncate font-medium text-text-1">{active.title}</span>
            <span className="shrink-0 text-[10px] text-text-3">{active.msgs.length} 条</span>
            <ChevronDown className="h-3 w-3 shrink-0 text-text-3" />
          </button>
          {menuOpen && (
            <div className="absolute left-0 right-0 top-full z-20 mt-1 max-h-72 overflow-y-auto rounded-md border border-border-1 bg-popover py-1 shadow-lg">
              {[...state.conversations]
                .sort((a, b) => b.updatedAt - a.updatedAt)
                .map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    className={cn(
                      'flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-surface-2',
                      c.id === state.activeId && 'bg-surface-2'
                    )}
                    onClick={() => switchTo(c.id)}
                  >
                    {c.id === state.activeId && <Check className="h-3 w-3 shrink-0 text-accent" />}
                    <span className="min-w-0 flex-1 truncate">{c.title}</span>
                    <span className="shrink-0 text-[10px] text-text-3">{c.msgs.length}</span>
                  </button>
                ))}
              <div className="my-1 border-t border-border-1" />
              <button
                type="button"
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-surface-2"
                onClick={newConversation}
              >
                <Plus className="h-3 w-3 text-accent" />
                <span>新建对话</span>
              </button>
            </div>
          )}
        </div>
        <button
          type="button"
          className="rounded p-1.5 text-text-2 hover:bg-surface-2 hover:text-text-1"
          onClick={newConversation}
          title="新建对话"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          className="rounded p-1.5 text-text-2 hover:bg-surface-2 hover:text-text-1"
          onClick={renameActive}
          title="重命名"
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          className="rounded p-1.5 text-text-2 hover:bg-surface-2 hover:text-error"
          onClick={deleteActive}
          title="删除当前对话"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3 text-xs">
        {/* RAG 状态条：始终顶部，根据状态切样式 */}
        <RagStatusBar
          status={ragStatus}
          building={ragBuilding}
          progress={ragProgress}
          useRag={useRag}
          onToggleUseRag={setUseRag}
          onBuild={() => buildOrRebuildIndex(false)}
          onRebuild={() => buildOrRebuildIndex(true)}
        />
        {msgs.length === 0 && (
          <div className="rounded-md border border-dashed border-border-1 p-4 text-center text-text-3">
            基于当前文档提问，AI 会结合内容回答。
          </div>
        )}
        {msgs.map((m, i) => (
          <div
            key={i}
            className={cn(
              'group relative rounded-md p-2.5',
              m.role === 'user' ? 'bg-accent/10 text-text-1' : 'bg-surface-1 text-text-2'
            )}
          >
            <div className="mb-1 flex items-center justify-between gap-2 text-[10px] uppercase tracking-wide text-text-3">
              <div className="flex items-center gap-1.5">
                <span>{m.role === 'user' ? '你' : 'AI'}</span>
                {m.role === 'assistant' && m.streaming && (
                  <Loader2 className="h-2.5 w-2.5 animate-spin text-accent" />
                )}
              </div>
              <CopyButton text={m.content} />
            </div>
            {m.role === 'user' ? (
              <div className="whitespace-pre-wrap leading-6">{m.content}</div>
            ) : (
              <>
                <MarkdownView content={m.content} theme={mdTheme} />
                {m.streaming && m.content.length === 0 && (
                  <div className="mt-1 flex items-center gap-1.5 text-[10px] text-text-3">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    {m.reasoning
                      ? '模型正在思考…(已过滤推理内容)'
                      : m.fallback === 'no_index'
                      ? '基于当前页生成中…'
                      : '检索中…'}
                  </div>
                )}
                {m.sources && m.sources.length > 0 && (
                  <SourceList sources={m.sources} onJumpPage={onJumpPage} />
                )}
                {m.followups && m.followups.length > 0 && !m.streaming && (
                  <FollowupChips
                    followups={m.followups}
                    onPick={(q) => {
                      // 把追问填进 input,光标到末尾;让用户能改一下再发
                      patchActive({ draft: q })
                      queueMicrotask(() => textareaRef.current?.focus())
                    }}
                  />
                )}
                {m.fallback === 'no_index' && !m.streaming && (
                  <div className="mt-2 flex items-start gap-1.5 rounded border border-warning/30 bg-warning/10 p-2 text-[10px] text-warning">
                    <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
                    <span>本回答未走 RAG（知识库未构建或为空）。点击上方「构建知识库」可启用全书检索。</span>
                  </div>
                )}
              </>
            )}
          </div>
        ))}
        {busy && (
          <div className="flex items-center gap-2 rounded-md bg-surface-1 p-2.5 text-text-3">
            <Loader2 className="h-3 w-3 animate-spin" /> 思考中…
          </div>
        )}
      </div>
      <div className="shrink-0 border-t border-border-1 p-2">
        <div className="flex gap-1">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                send()
              }
            }}
            placeholder="提问（Enter 发送，Shift+Enter 换行）…"
            rows={2}
            className="flex-1 resize-none rounded-md border border-border-1 bg-bg p-2 text-xs text-text-1 outline-none focus:border-accent"
          />
          <button
            type="button"
            disabled={busy || !input.trim()}
            onClick={send}
            className="flex shrink-0 items-center justify-center rounded-md bg-accent px-3 text-white disabled:opacity-50"
          >
            <Send className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * 一键复制消息内容到剪贴板。已复制状态显示 2 秒打勾。
 * Tauri / 浏览器都走 navigator.clipboard.writeText（Android WebView 也支持）。
 */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      // 兜底：execCommand
      try {
        const ta = document.createElement('textarea')
        ta.value = text
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        document.body.removeChild(ta)
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1500)
      } catch {
        /* ignore */
      }
    }
  }
  return (
    <button
      type="button"
      onClick={onCopy}
      title={copied ? '已复制' : '复制'}
      className="flex h-5 items-center gap-1 rounded px-1.5 text-[10px] text-text-3 transition-opacity hover:bg-surface-2 hover:text-text-1"
    >
      {copied ? (
        <>
          <Check className="h-3 w-3" />
          <span>已复制</span>
        </>
      ) : (
        <>
          <Copy className="h-3 w-3" />
          <span>复制</span>
        </>
      )}
    </button>
  )
}

// Outline Tab 已删除：大纲与左栏 TocPanel 重复，统一在左栏渲染.

// ─── RAG 知识库状态条 + 来源标记 ─────────────────────────────────────────

/**
 * 顶置在 ChatTab 消息列表第一行，根据 RAG 索引状态变样式：
 *   - 'none'                未构建 → 灰底，主按钮"构建知识库"
 *   - 'building'             构建中 → 进度条 + "X / Y"
 *   - 'ready'                就绪 → 紫底 + 切换"使用 RAG / 仅当前页"toggle + 「重建」
 *   - 'failed'               失败 → 红底 + 错误信息 + 「重试」
 *
 * 数据来源：父 ChatTab 维护，事件 'rag-build-progress' / 'rag-build-done' 实时更新。
 */
function RagStatusBar({
  status,
  building,
  progress,
  useRag,
  onToggleUseRag,
  onBuild,
  onRebuild,
}: {
  status: RagIndexStatus | null
  building: boolean
  progress: { completed: number; total: number } | null
  useRag: boolean
  onToggleUseRag: (v: boolean) => void
  onBuild: () => void
  onRebuild: () => void
}) {
  const s = status?.status ?? 'none'
  // building 状态优先：避免后端 status 还没刷新但 progress 已经在飞
  const effective = building ? 'building' : s

  if (effective === 'building') {
    const pct = progress && progress.total > 0
      ? Math.round((progress.completed / progress.total) * 100)
      : 0
    return (
      <div className="rounded-md border border-accent/30 bg-accent/10 p-2 text-[11px]">
        <div className="flex items-center gap-1.5 text-text-1">
          <Loader2 className="h-3 w-3 shrink-0 animate-spin text-accent" />
          <span className="font-medium">正在构建知识库…</span>
          {progress && (
            <span className="ml-auto tabular-nums text-text-3">
              {progress.completed} / {progress.total}
            </span>
          )}
        </div>
        <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-surface-3">
          <div
            className="h-full rounded-full bg-accent transition-[width] duration-200"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
    )
  }

  if (effective === 'ready') {
    return (
      <div className="flex items-center gap-2 rounded-md border border-border-1 bg-surface-1 p-2 text-[11px]">
        <Database className="h-3 w-3 shrink-0 text-accent" />
        <span className="text-text-2">
          知识库就绪{' '}
          <span className="text-text-3">· {status?.chunk_count ?? 0} 段</span>
        </span>
        <label className="ml-auto flex shrink-0 cursor-pointer items-center gap-1 text-text-3 hover:text-text-1">
          <input
            type="checkbox"
            checked={useRag}
            onChange={(e) => onToggleUseRag(e.target.checked)}
            className="h-3 w-3 cursor-pointer accent-accent"
          />
          <span>RAG</span>
        </label>
        <button
          type="button"
          onClick={onRebuild}
          title="重新切块 + 嵌入。原索引会先被清空。"
          className="rounded p-1 text-text-3 hover:bg-surface-2 hover:text-text-1"
        >
          <RefreshCw className="h-3 w-3" />
        </button>
      </div>
    )
  }

  if (effective === 'failed') {
    return (
      <div className="rounded-md border border-error/30 bg-error/10 p-2 text-[11px]">
        <div className="flex items-center gap-1.5 text-error">
          <AlertCircle className="h-3 w-3 shrink-0" />
          <span className="font-medium">知识库构建失败</span>
          <button
            type="button"
            onClick={onBuild}
            className="ml-auto rounded bg-error/20 px-2 py-0.5 text-error hover:bg-error/30"
          >
            重试
          </button>
        </div>
        {status?.error && (
          <div className="mt-1 break-all text-text-3" title={status.error}>
            {status.error.slice(0, 200)}
          </div>
        )}
      </div>
    )
  }

  // 'none' / 'pending'：未构建
  return (
    <div className="flex items-center gap-2 rounded-md border border-dashed border-border-1 bg-surface-1 p-2 text-[11px]">
      <Database className="h-3 w-3 shrink-0 text-text-3" />
      <span className="text-text-3">
        知识库未构建。构建后，AI 可以跨页检索整本书来回答。
      </span>
      <button
        type="button"
        onClick={onBuild}
        className="ml-auto shrink-0 rounded-md bg-accent px-2 py-0.5 font-medium text-white hover:bg-accent-2"
      >
        构建知识库
      </button>
    </div>
  )
}

/**
 * RAG 来源列表:在 assistant 消息底部展示检索到的 chunk。
 * 点击单条来源会调 onJumpPage(page_start) 跳到该页(仅 PDF/DOCX/PPTX 生效)。
 *
 * 设计精简版:只渲染可点击的页码标签 + 原文片段一行截断;不要 hover 卡片、
 * 不要相似度数字 — 这些是过度设计,实际使用时分散注意力。
 */
function SourceList({
  sources,
  onJumpPage,
}: {
  sources: RagSource[]
  onJumpPage?: (pageIndex: number) => void
}) {
  return (
    <details className="mt-2 rounded border border-border-1 bg-surface-1 text-[10px]">
      <summary className="cursor-pointer select-none list-none px-2 py-1.5 text-text-3 hover:bg-surface-2">
        <span className="inline-flex items-center gap-1">
          <Database className="h-3 w-3" />
          来源 · {sources.length} 段
        </span>
      </summary>
      <ul className="border-t border-border-1">
        {sources.map((src, i) => {
          const label =
            src.page_start === src.page_end
              ? `P${src.page_start + 1}`
              : `P${src.page_start + 1}-${src.page_end + 1}`
          const canJump = !!onJumpPage && src.page_start >= 0
          return (
            <li
              key={src.chunk_id || i}
              className="flex gap-1.5 border-b border-border-1 px-2 py-1.5 last:border-b-0"
            >
              <button
                type="button"
                disabled={!canJump}
                onClick={() => canJump && onJumpPage!(src.page_start)}
                title={canJump ? '点击跳到该页' : 'EPUB / 流式资料无法精确跳页'}
                className={cn(
                  'shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px]',
                  canJump
                    ? 'bg-accent/10 text-accent hover:bg-accent/20'
                    : 'bg-surface-2 text-text-3'
                )}
              >
                {label}
              </button>
              <span className="min-w-0 flex-1 truncate text-text-2" title={src.snippet}>
                {src.snippet}
              </span>
            </li>
          )
        })}
      </ul>
    </details>
  )
}

/** Follow-up 追问按钮组 — 流结束后由后端异步推送 followups */
function FollowupChips({
  followups,
  onPick,
}: {
  followups: string[]
  onPick: (q: string) => void
}) {
  return (
    <div className="mt-2.5 space-y-1">
      <div className="text-[9px] uppercase tracking-wide text-text-3">下一步可问</div>
      {followups.map((q, i) => (
        <button
          key={i}
          type="button"
          onClick={() => onPick(q)}
          className="flex w-full items-start gap-1.5 rounded border border-border-1 bg-surface-1 px-2 py-1.5 text-left text-[11px] text-text-2 transition-colors hover:border-accent/50 hover:bg-accent/5 hover:text-text-1"
        >
          <span className="mt-0.5 shrink-0 text-text-3">›</span>
          <span className="flex-1 leading-5">{q}</span>
        </button>
      ))}
    </div>
  )
}
