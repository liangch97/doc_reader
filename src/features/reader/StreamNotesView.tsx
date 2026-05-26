/**
 * StreamNotesView —— 学习流笔记可编辑视图（v6 #3++ 重构）
 *
 * 数据源统一（用户诉求：「二者共用一份文档」）：
 *   - 读：从 `agent_get_state` 的 `unit_states[i].teach_pack.explanation` 拉实时内容
 *   - 写：调 `notebooksApi.updateEntry`（后端会同步回写 teach_pack.explanation
 *           并 emit `agent-unit-explanation-updated` 事件）
 *   - 讲解区（AgentTab）同一数据源，事件触发 refresh 后跨区同步
 *
 * 不再读 `agent_stream_notes` 表（该表仅用于档案快照、复习场景）。
 *
 * 特性：
 *   - 每个单元一张卡片、一个 MarkdownEditor、800ms 防抖保存
 *   - 「导出到课堂笔记」按钮：把全部单元 explanation 拼成 markdown 追加到
 *     dr_save_note(page=0)。这个动作不会领取 stream_notes 表数据，与讲解区一致。
 *
 * UX：
 *   - 空态：提示「还没有单元讲解，先去『学习』 tab 学一个单元」
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AlertCircle,
  BookOpen,
  Check,
  Download,
  Loader2,
  RefreshCw,
  Sparkles,
} from 'lucide-react'
import { invoke } from '@/lib/tauri'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { cn } from '@/lib/cn'
import { MarkdownEditor } from '@/components/markdown/MarkdownEditor'
import { notebooksApi } from '@/lib/api'

interface UnitOutline {
  title?: string
  pages?: number[]
}
interface UnitState {
  unit_index: number
  teach_pack: { explanation?: string } | null
  status: string
}
interface AgentState {
  plan: { outline?: { units?: UnitOutline[] } | null } | null
  unit_states: UnitState[]
}

interface StreamNote {
  unit_index: number
  anchor_page: number
  unit_title: string
  content: string
}

interface Props {
  sessionId: string
}

/**
 * 把 stream notes 数组拼成 markdown 字符串。
 * 格式：
 *   ## 第 P 页 — 单元 N: TITLE
 *
 *   (content)
 *
 * 与课堂笔记 dr_save_note 使用的 `## 第 N 页` 锚点风格对齐。
 */
function streamNotesToMarkdown(notes: StreamNote[]): string {
  const sorted = [...notes].sort((a, b) => a.unit_index - b.unit_index)
  return sorted
    .map((n) => {
      const title = n.unit_title.trim() || `单元 ${n.unit_index + 1}`
      const header = `## 第 ${n.anchor_page} 页 — U${n.unit_index + 1}: ${title}`
      return `${header}\n\n${n.content.trim()}`
    })
    .join('\n\n---\n\n')
}

/** 从 agent_get_state 拼出可编辑的单元笔记列表（只要 explanation 非空就收）。 */
function stateToNotes(state: AgentState | null): StreamNote[] {
  if (!state?.plan) return []
  const units = state.plan.outline?.units ?? []
  const map = new Map<number, UnitState>()
  for (const us of state.unit_states ?? []) map.set(us.unit_index, us)
  const out: StreamNote[] = []
  for (let i = 0; i < units.length; i++) {
    const us = map.get(i)
    const expl = us?.teach_pack?.explanation?.trim() ?? ''
    if (!expl) continue
    const u = units[i] ?? {}
    const pages = Array.isArray(u.pages) ? u.pages.filter((n) => Number.isFinite(n)) : []
    const anchor = pages.length > 0 ? pages[Math.floor(pages.length / 2)] : 1
    out.push({
      unit_index: i,
      anchor_page: anchor,
      unit_title: u.title ?? `单元 ${i + 1}`,
      content: expl,
    })
  }
  return out
}

export function StreamNotesView({ sessionId }: Props) {
  const [notes, setNotes] = useState<StreamNote[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [exportStatus, setExportStatus] = useState<'idle' | 'exporting' | 'done'>('idle')

  const refresh = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const state = await invoke<AgentState>('agent_get_state', { sessionId })
      setNotes(stateToNotes(state))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [sessionId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // 订阅讲解区 / 后端任意处回写 explanation 的事件，自动 refresh
  useEffect(() => {
    let unlistenExpl: UnlistenFn | undefined
    let unlistenArchive: UnlistenFn | undefined
    let cancelled = false
    void (async () => {
      const u = await listen<{ session_id: string }>('agent-unit-explanation-updated', (ev) => {
        if (ev.payload?.session_id !== sessionId) return
        // 本面板刚提交的编辑 1.5s 内也会发事件，本地 lastSelfEditAt 抵消即可
        const now = Date.now()
        for (const u of Object.keys(lastSelfEditAtRef.current)) {
          if (now - lastSelfEditAtRef.current[+u] < 1500) return
        }
        void refresh()
      })
      // v7 (2026-05) 档案管理鲁棒性：恢复后单元 explanation 全部更新，需要 refresh
      const a = await listen<{
        session_id: string
        reason: 'saved' | 'restored' | 'deleted' | 'renamed'
      }>('agent-archive-changed', (ev) => {
        if (ev.payload?.session_id !== sessionId) return
        if (ev.payload.reason === 'restored' || ev.payload.reason === 'saved') {
          // 清掉自身防回声 timestamp（恢复后所有 unit 都视为外部更新）
          lastSelfEditAtRef.current = {}
          void refresh()
        }
      })
      if (cancelled) {
        u(); a()
      } else {
        unlistenExpl = u
        unlistenArchive = a
      }
    })()
    return () => {
      cancelled = true
      unlistenExpl?.()
      unlistenArchive?.()
    }
  }, [sessionId, refresh])

  // 「在笔记中编辑」：AgentTab 底部 / 其它入口快捷跳转过来，跳到指定单元
  // 本组件仅负责滚动，不动 sub-tab（上层 LearningHistoryPanel / NoteTab 已控制）
  useEffect(() => {
    const handler = (ev: Event) => {
      const idx = (ev as CustomEvent<{ unitIndex?: number }>).detail?.unitIndex
      if (typeof idx !== 'number') return
      const el = unitRefs.current[idx]
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
    window.addEventListener('stream-notes-scroll-to-unit', handler)
    return () => window.removeEventListener('stream-notes-scroll-to-unit', handler)
  }, [])

  // 保存调度：按 unit 防抖 800ms 写入
  const saveTimersRef = useRef<Record<number, ReturnType<typeof setTimeout>>>({})
  const lastSelfEditAtRef = useRef<Record<number, number>>({})
  const unitRefs = useRef<Record<number, HTMLElement | null>>({})
  const [savingUnits, setSavingUnits] = useState<Record<number, 'saving' | 'saved' | undefined>>({})

  const saveUnit = useCallback(
    (unitIdx: number, content: string, title: string) => {
      const existing = saveTimersRef.current[unitIdx]
      if (existing) clearTimeout(existing)
      saveTimersRef.current[unitIdx] = setTimeout(async () => {
        delete saveTimersRef.current[unitIdx]
        setSavingUnits((m) => ({ ...m, [unitIdx]: 'saving' }))
        try {
          // 拿 entry_id，调 update 后端会同步回写 teach_pack.explanation 并 emit 事件
          const r = await invoke<{ entry_id: string; exists: boolean }>(
            'agent_get_unit_entry_id',
            { sessionId, unitIndex: unitIdx },
          )
          if (!r.exists || !r.entry_id) {
            // 该单元 entry 还未生成（流式未完成） —— 跳过，避免误置管
            setSavingUnits((m) => ({ ...m, [unitIdx]: undefined }))
            return
          }
          lastSelfEditAtRef.current[unitIdx] = Date.now()
          await notebooksApi.updateEntry({ entryId: r.entry_id, title, content })
          setSavingUnits((m) => ({ ...m, [unitIdx]: 'saved' }))
          setTimeout(() => {
            setSavingUnits((m) => ({ ...m, [unitIdx]: undefined }))
          }, 1200)
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e))
          setSavingUnits((m) => ({ ...m, [unitIdx]: undefined }))
        }
      }, 800)
    },
    [sessionId],
  )

  // 卸载时清理 timer、防止 unmount 后调 setState
  useEffect(
    () => () => {
      for (const t of Object.values(saveTimersRef.current)) clearTimeout(t)
      saveTimersRef.current = {}
    },
    [],
  )

  const handleExport = useCallback(async () => {
    if (notes.length === 0) return
    if (
      !window.confirm(
        `把 ${notes.length} 条学习流笔记追加到课堂笔记（页 0）末尾？\n\n学习流笔记本身不会被删除。`,
      )
    ) {
      return
    }
    setExportStatus('exporting')
    try {
      // 1) 拿当前课堂笔记
      const cur = await invoke<{ note?: { content?: string } | null }>('doc_reader_get_page', {
        sessionId,
        pageIndex: 0,
      })
      const existing = cur?.note?.content ?? ''
      // 2) 拼接学习流 markdown 到末尾，加分隔条
      const streamMd = streamNotesToMarkdown(notes)
      const merged = existing.trim()
        ? `${existing.trim()}\n\n---\n\n<!-- 学习流导出 ${new Date().toLocaleString()} -->\n\n${streamMd}`
        : streamMd
      // 3) 写回
      await invoke('doc_reader_save_note', {
        sessionId,
        pageIndex: 0,
        content: merged,
      })
      setExportStatus('done')
      setTimeout(() => setExportStatus('idle'), 2000)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setExportStatus('idle')
    }
  }, [notes, sessionId])

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* 顶部工具条 */}
      <div className="flex shrink-0 items-center gap-1.5 border-b border-border-1 bg-surface-1 px-2 py-1.5 text-[11px]">
        <Sparkles className="size-3.5 text-indigo-500" />
        <span className="text-text-2">学习流笔记</span>
        <span className="text-text-3">
          · 与讲解区共用 · {notes.length} 条 · 可编辑
        </span>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={loading}
            title="刷新"
            className="rounded p-1 text-text-3 hover:bg-surface-2 hover:text-text-1 disabled:opacity-50"
          >
            {loading ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
          </button>
          {notes.length > 0 && (
            <button
              type="button"
              onClick={() => void handleExport()}
              disabled={exportStatus === 'exporting'}
              className={cn(
                'inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium transition',
                exportStatus === 'done'
                  ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                  : 'border-border-1 bg-surface-1 text-text-1 hover:bg-surface-2',
              )}
              title="把全部学习流笔记追加到课堂笔记"
            >
              {exportStatus === 'exporting' ? (
                <Loader2 className="size-3 animate-spin" />
              ) : exportStatus === 'done' ? (
                <Check className="size-3 text-emerald-500" />
              ) : (
                <Download className="size-3" />
              )}
              {exportStatus === 'done' ? '已导出' : '导出到课堂'}
            </button>
          )}
        </div>
      </div>

      {/* 内容 */}
      <div className="min-h-0 flex-1 overflow-auto">
        {error && (
          <div className="mx-3 mt-3 flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/8 px-3 py-2 text-[11.5px] text-red-600 dark:text-red-400">
            <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}
        {!loading && notes.length === 0 && !error && (
          <div className="flex h-full items-center justify-center p-8 text-center">
            <div className="space-y-2">
              <BookOpen className="mx-auto size-8 text-text-3/40" />
              <div className="text-[12.5px] font-medium text-text-2">还没有单元讲解</div>
              <div className="text-[10.5px] text-text-3">
                在「学习」tab 完成至少一个单元后，
                <br />
                在这里可编辑该单元的讲解内容。
              </div>
            </div>
          </div>
        )}
        {loading && notes.length === 0 && (
          <div className="flex h-32 items-center justify-center text-[11.5px] text-text-3">
            <Loader2 className="mr-2 size-4 animate-spin" />
            加载学习流笔记…
          </div>
        )}
        <div className="space-y-3 p-3">
          {notes.map((n) => {
            const saving = savingUnits[n.unit_index]
            const editorKey = `u${n.unit_index}`
            return (
              <article
                key={editorKey}
                ref={(el) => {
                  unitRefs.current[n.unit_index] = el
                }}
                className="md-knowledge-card overflow-hidden rounded-2xl border border-indigo-500/15 bg-bg-1 shadow-[0_1px_2px_rgba(0,0,0,0.03)]"
              >
                <header className="flex items-center gap-2 border-b border-indigo-500/10 bg-indigo-500/5 px-4 py-2">
                  <span className="font-mono text-[11px] font-bold text-indigo-600 dark:text-indigo-400">
                    U{n.unit_index + 1}
                  </span>
                  <span className="truncate text-[13px] font-semibold text-text-1">
                    {n.unit_title || `单元 ${n.unit_index + 1}`}
                  </span>
                  <span className="ml-auto flex items-center gap-2">
                    {saving === 'saving' && (
                      <span className="inline-flex items-center gap-1 text-[10px] text-text-3">
                        <Loader2 className="size-3 animate-spin" />
                        保存中
                      </span>
                    )}
                    {saving === 'saved' && (
                      <span className="inline-flex items-center gap-1 text-[10px] text-emerald-600 dark:text-emerald-400">
                        <Check className="size-3" />
                        已保存
                      </span>
                    )}
                    <span className="font-mono text-[10px] text-text-3">P.{n.anchor_page}</span>
                  </span>
                </header>
                <div className="px-5 py-4">
                  <MarkdownEditor
                    key={editorKey}
                    defaultValue={n.content}
                    onChange={(md) =>
                      saveUnit(n.unit_index, md, n.unit_title || `单元 ${n.unit_index + 1}`)
                    }
                  />
                </div>
              </article>
            )
          })}
        </div>
      </div>
    </div>
  )
}
