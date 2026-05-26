import { useEffect, useRef, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  Plus,
  NotebookPen,
  Trash2,
  ArrowLeft,
  Wand2,
  User,
  Menu,
} from 'lucide-react'
import { invoke } from '@/lib/tauri'
import { cn } from '@/lib/cn'
import { loadMdTheme, saveMdTheme, type MdTheme } from '@/components/markdown/MarkdownView'
import { MarkdownEditor } from '@/components/markdown/MarkdownEditor'
import { MdThemePicker } from '@/components/markdown/MdThemePicker'
import { NotesSettingsPopover } from '@/components/markdown/NotesSettingsPopover'
import {
  loadNotesPrefs,
  saveNotesPrefs,
  notesPrefsToStyle,
  type NotesPrefs,
} from '@/components/markdown/notesPrefs'
import { notebooksApi } from '@/lib/api'
import { useLayoutMode } from '@/lib/useLayoutMode'

interface Notebook {
  notebook_id: string
  name: string
  description: string
  color: string
  teacher: string
  created_at: string
  updated_at: string
  entry_count?: number
}

interface NotebookEntry {
  entry_id: string
  notebook_id: string
  title: string
  content: string
  entry_type: string
  source_info: string
  created_at: string
  updated_at: string
}

interface NotebookDetail {
  notebook: Notebook
  entries: NotebookEntry[]
}

export default function NotebookPage() {
  const { notebookId } = useParams()
  if (notebookId) return <NotebookDetailView notebookId={notebookId} />
  return <NotebookList />
}

function NotebookList() {
  const navigate = useNavigate()
  const [items, setItems] = useState<Notebook[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [teacher, setTeacher] = useState('')
  const [description, setDescription] = useState('')
  const [color, setColor] = useState('#7C5CFC')

  const reload = async () => {
    try {
      setLoading(true)
      setError('')
      const res = await invoke<{ notebooks: Notebook[] }>('notebook_list')
      setItems(res.notebooks ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    reload()
  }, [])

  const create = async () => {
    if (!name.trim()) return
    try {
      const res = await notebooksApi.create({
        name: name.trim(),
        description: description.trim(),
        color,
        teacher: teacher.trim(),
      })
      setName('')
      setTeacher('')
      setDescription('')
      setColor('#7C5CFC')
      setCreating(false)
      navigate(`/notebook/${res.notebook_id}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const remove = async (id: string, title: string) => {
    if (!confirm(`删除笔记本 “${title}”？`)) return
    try {
      await invoke('notebook_delete', { notebookId: id })
      await reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <header className="flex items-end justify-between px-4 py-5 sm:px-8 sm:py-6">
        <div>
          <h1 className="text-2xl font-semibold text-text-1">笔记本</h1>
          <p className="mt-1 text-xs text-text-3">汇总 AI 笔记 / 手动笔记 / 跨资料整理</p>
        </div>
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-2"
        >
          <Plus className="h-3.5 w-3.5" /> 新建
        </button>
      </header>

      <section className="px-4 pb-8 sm:px-8">
        {error && (
          <div className="mb-3 rounded-md border border-error/40 bg-error/10 px-3 py-2 text-xs text-error">
            {error}
          </div>
        )}
        {loading ? (
          <div className="rounded-md border border-border-1 p-6 text-center text-xs text-text-3">
            加载中…
          </div>
        ) : items.length === 0 ? (
          <div className="rounded-md border border-dashed border-border-1 p-8 text-center text-xs text-text-3">
            还没有笔记本，点击右上角「新建」创建第一本。
          </div>
        ) : (
          <ul
            className="grid gap-4"
            style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}
          >
            {items.map((nb) => (
              <li
                key={nb.notebook_id}
                className="group relative flex cursor-pointer flex-col gap-2 rounded-lg border border-border-1 bg-surface-1 p-4 transition-all hover:border-border-2 hover:bg-surface-2"
                onClick={() => navigate(`/notebook/${nb.notebook_id}`)}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-white" style={{ background: nb.color || '#7C5CFC' }}>
                    <NotebookPen className="h-4 w-4" />
                  </div>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      remove(nb.notebook_id, nb.name)
                    }}
                    className="invisible rounded p-1 text-text-3 hover:bg-error/10 hover:text-error group-hover:visible"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
                <div className="text-sm font-medium text-text-1">{nb.name}</div>
                {nb.teacher && (
                  <div className="flex items-center gap-1 text-[11px] text-text-2">
                    <User className="h-3 w-3" /> {nb.teacher}
                  </div>
                )}
                {nb.description && (
                  <div className="line-clamp-2 text-xs text-text-3">{nb.description}</div>
                )}
                <div className="mt-1 text-[11px] text-text-3">
                  {nb.entry_count ?? 0} 条 · {nb.updated_at?.slice(0, 10)}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {creating && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-sm rounded-lg border border-border-1 bg-popover p-4 shadow-xl">
            <h3 className="mb-3 text-sm font-semibold text-text-1">新建笔记本</h3>
            <div className="space-y-2">
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && create()}
                placeholder="名称（必填）"
                className="w-full rounded-md border border-border-1 bg-bg px-3 py-2 text-xs text-text-1 outline-none focus:border-accent"
              />
              <input
                value={teacher}
                onChange={(e) => setTeacher(e.target.value)}
                placeholder="老师名字（可选）"
                className="w-full rounded-md border border-border-1 bg-bg px-3 py-2 text-xs text-text-1 outline-none focus:border-accent"
              />
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="描述（可选）"
                rows={2}
                className="w-full resize-none rounded-md border border-border-1 bg-bg px-3 py-2 text-xs text-text-1 outline-none focus:border-accent"
              />
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-text-3">颜色</span>
                <div className="flex gap-1.5">
                  {['#7C5CFC', '#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#EC4899', '#6B7280'].map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setColor(c)}
                      className={cn(
                        'h-5 w-5 rounded-full border-2 transition-transform',
                        color === c ? 'border-text-1 scale-110' : 'border-transparent'
                      )}
                      style={{ background: c }}
                      aria-label={`颜色 ${c}`}
                    />
                  ))}
                </div>
              </div>
            </div>
            <div className="mt-3 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setCreating(false)}
                className="rounded-md border border-border-1 px-3 py-1.5 text-xs text-text-2 hover:bg-surface-2"
              >
                取消
              </button>
              <button
                type="button"
                onClick={create}
                disabled={!name.trim()}
                className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
              >
                创建
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function NotebookDetailView({ notebookId }: { notebookId: string }) {
  const navigate = useNavigate()
  const [data, setData] = useState<NotebookDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [activeId, setActiveId] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [draftTitle, setDraftTitle] = useState('')
  const [draftContent, setDraftContent] = useState('')
  const [mdTheme, setMdTheme] = useState<MdTheme>(() => loadMdTheme())
  const [editTitle, setEditTitle] = useState('')
  const [editContent, setEditContent] = useState('')
  const [saving, setSaving] = useState<'idle' | 'saving' | 'saved'>('idle')
  const layoutMode = useLayoutMode()
  // 平板 / phone：条目列表改抽屉式（设计文档 §6.3）。桌面保留分栏。
  const drawerMode = layoutMode !== 'desktop'
  const [drawerOpen, setDrawerOpen] = useState(false)
  // 选中条目后自动关闭抽屉（用户视角：选完看内容，不需要列表挡着）
  useEffect(() => {
    if (drawerMode && activeId) setDrawerOpen(false)
  }, [activeId, drawerMode])
  // Bumped to force-remount the uncontrolled MarkdownEditor (e.g., after auto-format)
  const [editorEpoch, setEditorEpoch] = useState(0)
  const saveTimerRef = useRef<number | null>(null)
  const setTheme = (t: MdTheme) => {
    setMdTheme(t)
    saveMdTheme(t)
  }
  // 笔记排版 prefs：字号 / 行距 / 字间距 / 字体族；通过 CSS 变量注入到 article 根，
  // markdown.css 里 .milkdown / .md-root 用 var(--notes-*) 消费。
  const [notesPrefs, setNotesPrefs] = useState<NotesPrefs>(() => loadNotesPrefs())
  const updateNotesPrefs = (patch: Partial<NotesPrefs>) => {
    setNotesPrefs((cur) => {
      const next = { ...cur, ...patch }
      saveNotesPrefs(next)
      return next
    })
  }
  const notesPrefsStyle = notesPrefsToStyle(notesPrefs)

  const reload = async () => {
    try {
      setLoading(true)
      setError('')
      const res = await invoke<NotebookDetail>('notebook_get', { notebookId })
      setData(res)
      if (!activeId && res.entries?.length) setActiveId(res.entries[0].entry_id)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notebookId])

  // Sync editor buffers whenever the active entry changes
  useEffect(() => {
    const a = data?.entries.find((e) => e.entry_id === activeId)
    if (!a) {
      setEditTitle('')
      setEditContent('')
      return
    }
    setEditTitle(a.title)
    setEditContent(a.content || '')
  }, [activeId, data])

  const addEntry = async () => {
    if (!draftTitle.trim()) return
    try {
      await invoke('notebook_add_entry', {
        notebookId,
        title: draftTitle.trim(),
        content: draftContent,
        entryType: 'note',
      })
      setDraftTitle('')
      setDraftContent('')
      setAdding(false)
      await reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const removeEntry = async (id: string) => {
    if (!confirm('删除该条目？')) return
    try {
      await invoke('notebook_delete_entry', { entryId: id })
      if (activeId === id) setActiveId(null)
      await reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const createBlankEntry = async () => {
    try {
      const res = await invoke<{ entry_id: string }>('notebook_add_entry', {
        notebookId,
        title: '未命名条目',
        content: '',
        entryType: 'note',
      })
      await reload()
      if (res?.entry_id) setActiveId(res.entry_id)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  // 排版任务的 entry_id 集合：覆盖整个笔记本任意条目的多任务并发；
  // 用于显示进度 + 防止用户重复触发同一条目。
  const [formattingIds, setFormattingIds] = useState<Set<string>>(new Set())
  const isFormatting = activeId ? formattingIds.has(activeId) : false

  // 启动排版（异步事件驱动）：立刻返回，进度/结果走 Tauri 事件。
  const autoFormatEntry = async () => {
    if (!activeId) return
    if (!editContent.trim()) {
      alert('当前条目内容为空，无法排版')
      return
    }
    if (formattingIds.has(activeId)) return
    if (!confirm('一键排版会让 AI 重新组织当前条目的内容（自动选择闪卡 / 问答 / 思维导图 / 概念图等渲染形式）。\n排版会在后台异步进行，期间你可以切换到其它条目继续编辑。'))
      return
    const targetId = activeId
    try {
      setFormattingIds((s) => {
        const next = new Set(s)
        next.add(targetId)
        return next
      })
      // 立即返回；真正完成由事件通知
      await notebooksApi.entryAutoFormat({ entryId: targetId })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setFormattingIds((s) => {
        const next = new Set(s)
        next.delete(targetId)
        return next
      })
    }
  }

  // 全局监听排版完成 / 失败事件（按 entry_id 过滤），跨条目并发安全
  useEffect(() => {
    let unlistenDone: (() => void) | undefined
    let unlistenErr: (() => void) | undefined
    ;(async () => {
      const { listen } = await import('@tauri-apps/api/event')
      unlistenDone = await listen<{ entry_id: string; content: string; char_count: number }>(
        'note-format-done',
        (ev) => {
          const eid = ev.payload.entry_id
          setFormattingIds((s) => {
            if (!s.has(eid)) return s
            const next = new Set(s)
            next.delete(eid)
            return next
          })
          setData((prev) =>
            prev
              ? {
                  ...prev,
                  entries: prev.entries.map((e) =>
                    e.entry_id === eid
                      ? { ...e, content: ev.payload.content, updated_at: new Date().toISOString() }
                      : e
                  ),
                }
              : prev
          )
          // 仅当用户当前正在编辑该条目时同步 editor 缓冲与重挂载
          setActiveId((curActive) => {
            if (curActive === eid) {
              setEditContent(ev.payload.content)
              setEditorEpoch((n) => n + 1)
            }
            return curActive
          })
        }
      )
      unlistenErr = await listen<{ entry_id: string; error: string }>(
        'note-format-error',
        (ev) => {
          const eid = ev.payload.entry_id
          setFormattingIds((s) => {
            if (!s.has(eid)) return s
            const next = new Set(s)
            next.delete(eid)
            return next
          })
          setError(`排版失败：${ev.payload.error}`)
        }
      )
    })()
    return () => {
      unlistenDone?.()
      unlistenErr?.()
    }
  }, [])

  if (loading) return <CenterText>加载中…</CenterText>
  if (error) return <CenterText variant="error">{error}</CenterText>
  if (!data) return <CenterText>笔记本不存在</CenterText>

  const active = data.entries.find((e) => e.entry_id === activeId)

  const saveEntry = async (silent = false) => {
    if (!active) return
    try {
      if (!silent) setSaving('saving')
      await notebooksApi.updateEntry({
        entryId: active.entry_id,
        title: editTitle,
        content: editContent,
      })
      // 乐观更新
      setData((prev) =>
        prev
          ? {
              ...prev,
              entries: prev.entries.map((e) =>
                e.entry_id === active.entry_id
                  ? { ...e, title: editTitle, content: editContent, updated_at: new Date().toISOString() }
                  : e
              ),
            }
          : prev
      )
      setSaving('saved')
      setTimeout(() => setSaving('idle'), 1500)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setSaving('idle')
    }
  }
  // 调度防抖保存
  const scheduleAutosave = () => {
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current)
    saveTimerRef.current = window.setTimeout(() => saveEntry(true), 1200)
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 单层 header：返回 · 笔记本名 · 条目标题 · 操作（主题/排版/新条目） */}
      <header className="flex shrink-0 items-center gap-2 border-b border-border-1 px-3 py-2 sm:px-4">
        <button
          type="button"
          onClick={() => navigate('/notebook')}
          className={cn(
            'shrink-0 rounded-md text-text-3 hover:bg-surface-2 hover:text-text-1',
            drawerMode ? 'flex h-11 w-11 items-center justify-center' : 'p-1'
          )}
          title="返回笔记本列表"
        >
          <ArrowLeft className={drawerMode ? 'h-5 w-5' : 'h-4 w-4'} />
        </button>
        {drawerMode && (
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-text-2 hover:bg-surface-2"
            aria-label="打开条目列表"
            title="条目列表"
          >
            <Menu className="h-5 w-5" />
          </button>
        )}
        <div
          className="flex min-w-0 shrink items-center gap-1.5"
          title={[data.notebook.name, data.notebook.teacher, data.notebook.description].filter(Boolean).join(' · ')}
        >
          <span className="truncate text-sm font-semibold text-text-1">{data.notebook.name}</span>
          {data.notebook.teacher && (
            <span className="hidden items-center gap-0.5 truncate text-[10px] text-text-3 md:inline-flex">
              <User className="h-2.5 w-2.5 shrink-0" />
              <span className="truncate">{data.notebook.teacher}</span>
            </span>
          )}
        </div>
        {active && <span className="h-5 w-px shrink-0 bg-border-1" />}
        {active && (
          <input
            value={editTitle}
            onChange={(e) => {
              setEditTitle(e.target.value)
              scheduleAutosave()
            }}
            onBlur={() => saveEntry(true)}
            placeholder="条目标题"
            className="min-w-0 flex-1 rounded-md border border-border-1 bg-bg px-2 py-1 text-sm text-text-1 outline-none focus:border-accent"
          />
        )}
        {active && saving !== 'idle' && (
          <span className="shrink-0 text-[10px] text-text-3">
            {saving === 'saving' ? '保存中' : '已保存'}
          </span>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <NotesSettingsPopover prefs={notesPrefs} onChange={updateNotesPrefs} />
          <MdThemePicker value={mdTheme} onChange={setTheme} />
          {active && (
            <button
              type="button"
              onClick={autoFormatEntry}
              disabled={isFormatting || !editContent.trim()}
              title={isFormatting ? 'AI 正在后台排版（可继续编辑其它条目）' : 'AI 排版当前条目'}
              className="flex items-center gap-1 rounded-md border border-border-1 bg-surface-1 px-2 py-1 text-xs text-text-1 hover:bg-surface-2 disabled:opacity-50"
            >
              <Wand2 className={cn('h-3 w-3', isFormatting && 'animate-pulse')} />
              {isFormatting ? '排版中…' : '排版'}
            </button>
          )}
          <button
            type="button"
            onClick={createBlankEntry}
            className="flex items-center gap-1 rounded-md bg-accent px-2 py-1 text-xs font-medium text-white hover:bg-accent-2"
            title="新建条目"
          >
            <Plus className="h-3 w-3" /> 新条目
          </button>
        </div>
      </header>
      <div className="relative flex min-h-0 flex-1">
        {/* drawerMode 下：遮罩层，点击关抽屉 */}
        {drawerMode && drawerOpen && (
          <div
            className="absolute inset-0 z-20 bg-black/40"
            onClick={() => setDrawerOpen(false)}
            aria-hidden
          />
        )}
        <aside
          className={cn(
            'flex shrink-0 flex-col border-r border-border-1 bg-surface-1',
            drawerMode
              ? cn(
                  'absolute inset-y-0 left-0 z-30 w-72 shadow-2xl transition-transform',
                  drawerOpen ? 'translate-x-0' : '-translate-x-full'
                )
              : 'w-60'
          )}
        >
          <ul className={cn('flex-1 overflow-y-auto p-2', drawerMode ? 'text-sm' : 'text-xs')}>
            {data.entries.length === 0 && (
              <li className="rounded-md border border-dashed border-border-1 p-4 text-center text-text-3">
                暂无条目
              </li>
            )}
            {data.entries.map((e) => (
              <li
                key={e.entry_id}
                className={cn(
                  'group flex cursor-pointer items-center gap-2 rounded-md transition-colors',
                  // 触控：行高 ≥ 44px
                  drawerMode ? 'min-h-[44px] p-3' : 'p-2',
                  activeId === e.entry_id ? 'bg-surface-3 text-text-1' : 'text-text-2 hover:bg-surface-2'
                )}
                onClick={() => setActiveId(e.entry_id)}
              >
                <span className="min-w-0 flex-1 truncate">{e.title || '(无标题)'}</span>
                {formattingIds.has(e.entry_id) && (
                  <Wand2
                    className="h-3 w-3 shrink-0 animate-pulse text-accent"
                    aria-label="排版中"
                  />
                )}
                <button
                  type="button"
                  onClick={(ev) => {
                    ev.stopPropagation()
                    removeEntry(e.entry_id)
                  }}
                  className={cn(
                    'rounded text-text-3 hover:bg-error/10 hover:text-error',
                    // 触控：删除按钮常驻 44×44；桌面保持 hover 显隐
                    drawerMode
                      ? 'flex h-11 w-11 items-center justify-center'
                      : 'invisible p-1 group-hover:visible'
                  )}
                >
                  <Trash2 className={drawerMode ? 'h-4 w-4' : 'h-3 w-3'} />
                </button>
              </li>
            ))}
          </ul>
        </aside>
        <section className="flex min-w-0 flex-1 flex-col overflow-hidden bg-surface-1">
          {active ? (
            <>
              {isFormatting && (
                <div className="flex shrink-0 items-center gap-2 border-b border-border-1 bg-accent/10 px-3 py-1.5 text-[11px] text-text-2">
                  <Wand2 className="h-3 w-3 animate-pulse text-accent" />
                  AI 正在后台排版当前条目，完成后会自动替换内容；期间你可以切换到其它条目继续编辑。
                </div>
              )}
              <div className="min-h-0 flex-1 overflow-y-auto bg-surface-1">
                <article
                  className={`mx-auto max-w-3xl py-6 md-root md-theme-${mdTheme}`}
                  style={notesPrefsStyle}
                >
                  <MarkdownEditor
                    key={`${active.entry_id}:${editorEpoch}`}
                    defaultValue={active.content || ''}
                    onChange={(md) => {
                      setEditContent(md)
                      scheduleAutosave()
                    }}
                  />
                </article>
              </div>
            </>
          ) : (
            <CenterText>选择左侧条目查看内容</CenterText>
          )}
        </section>
      </div>

      {adding && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="flex w-full max-w-lg flex-col gap-3 rounded-lg border border-border-1 bg-popover p-4 shadow-xl">
            <h3 className="text-sm font-semibold text-text-1">新建条目</h3>
            <input
              autoFocus
              value={draftTitle}
              onChange={(e) => setDraftTitle(e.target.value)}
              placeholder="标题"
              className="rounded-md border border-border-1 bg-bg px-3 py-2 text-xs text-text-1 outline-none focus:border-accent"
            />
            <textarea
              value={draftContent}
              onChange={(e) => setDraftContent(e.target.value)}
              rows={8}
              placeholder="内容（Markdown）"
              className="resize-none rounded-md border border-border-1 bg-bg px-3 py-2 text-xs text-text-1 outline-none focus:border-accent"
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setAdding(false)}
                className="rounded-md border border-border-1 px-3 py-1.5 text-xs text-text-2 hover:bg-surface-2"
              >
                取消
              </button>
              <button
                type="button"
                onClick={addEntry}
                disabled={!draftTitle.trim()}
                className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
              >
                添加
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function CenterText({
  children,
  variant,
}: {
  children: React.ReactNode
  variant?: 'error'
}) {
  return (
    <div
      className={cn(
        'flex h-full items-center justify-center p-6 text-center text-sm',
        variant === 'error' ? 'text-error' : 'text-text-3'
      )}
    >
      {children}
    </div>
  )
}
