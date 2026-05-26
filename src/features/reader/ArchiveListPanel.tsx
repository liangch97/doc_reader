/**
 * ArchiveListPanel —— 学习流档案列表 + 复习 / 恢复 / 重命名 / 删除 + 复习模式（v6 #3+ C）
 *
 * 数据模型（来自后端 agent_archive_list）：
 *   archive_id / name / flow_config / clarify_qa_json / created_at /
 *   unit_total / current_unit / current_phase
 *
 * v7 (2026-05) 健壮性约束：「每个学习流只保留一份档案」
 *   - 后端 agent_archive_save 写入新档案前会清空该 session 所有历史档案
 *   - 这意味着「恢复前自动备份」逻辑不能再用（会清掉要恢复的档案）
 *   - UI 必须明确告诉用户「恢复后当前进度无法找回」
 *   - 跨面板的归档操作通过监听 `agent-archive-changed` 事件做 refresh
 *
 * 行为：
 *   - 默认显示档案列表（按创建时间倒序）
 *   - 复习：调 agent_stream_notes_list(archive_id) 拉那次学习的 unit explanations，
 *           只读卡片式渲染（不影响 active 学习流）
 *   - 恢复：弹窗强提示后直接调 agent_archive_restore（不再做"恢复前备份"）
 *   - 重命名：inline 编辑
 *   - 删除：二次确认
 *
 * 关闭面板时回调 onClose()。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArchiveRestore,
  Book,
  BookOpen,
  ChevronLeft,
  Edit3,
  Eye,
  History,
  Loader2,
  RefreshCw,
  Trash2,
  X,
} from 'lucide-react'
import { invoke } from '@/lib/tauri'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { cn } from '@/lib/cn'
import { MarkdownView } from '@/components/markdown/MarkdownView'

interface ArchiveMeta {
  archive_id: string
  name: string
  flow_config: { auto?: boolean; reason?: string } | null
  clarify_qa_json: string
  created_at: string
  unit_total: number
  current_unit: number
  current_phase: string
}

interface StreamNote {
  note_id: number
  archive_id: string
  unit_index: number
  anchor_page: number
  unit_title: string
  content: string
  created_at: string
}

interface StreamNotesResp {
  notes: StreamNote[]
  count: number
  archive_id: string
}

interface Props {
  sessionId: string
  /**
   * 关闭面板回调。
   * - AgentTab 覆盖弹出模式：必传，点 X 回到学习
   * - 右栏 tab 常驻模式（v6 #3+ "学习历史" tab）：不传，省略关闭按钮
   */
  onClose?: () => void
  /** 恢复成功后回调，让 AgentTab refresh 状态 */
  onRestored?: () => void | Promise<void>
  /**
   * 进入面板时直接打开指定 archive 的复习视图（v6 #3+ C4）。
   * 来源：VibeHistoryPanel 的 plan_generated 卡片「查看这次学习」链接。
   * 命中规则：在列表里找到该 archive_id 后自动进 ArchiveReviewView；
   *           列表未拉取到时静默忽略（用户仍看到列表）。
   */
  initialArchiveId?: string
}

function formatTime(ts: string): string {
  try {
    const d = new Date(ts)
    if (Number.isNaN(d.getTime())) return ts
    const mo = String(d.getMonth() + 1).padStart(2, '0')
    const dd = String(d.getDate()).padStart(2, '0')
    const hh = String(d.getHours()).padStart(2, '0')
    const mm = String(d.getMinutes()).padStart(2, '0')
    return `${d.getFullYear()}-${mo}-${dd} ${hh}:${mm}`
  } catch {
    return ts
  }
}

export function ArchiveListPanel({ sessionId, onClose, onRestored, initialArchiveId }: Props) {
  const [archives, setArchives] = useState<ArchiveMeta[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  // 当前进入复习模式的 archive；null = 列表模式
  const [reviewingArchive, setReviewingArchive] = useState<ArchiveMeta | null>(null)
  // initialArchiveId 命中后只执行一次自动进入复习
  const initialAppliedRef = useRef(false)

  // inline 重命名 state
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')

  const refresh = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const list = await invoke<ArchiveMeta[]>('agent_archive_list', { sessionId })
      setArchives(Array.isArray(list) ? list : [])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [sessionId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // v7 (2026-05) 档案管理鲁棒性：监听 agent-archive-changed 自动 refresh 列表，
  // 这样从 AgentTab / 其他面板触发的归档操作也能即时反映到列表。
  useEffect(() => {
    let unlisten: UnlistenFn | undefined
    let cancelled = false
    void (async () => {
      const u = await listen<{
        session_id: string
        reason: 'saved' | 'restored' | 'deleted' | 'renamed'
      }>('agent-archive-changed', (ev) => {
        if (ev.payload?.session_id !== sessionId) return
        void refresh()
      })
      if (cancelled) u()
      else unlisten = u
    })()
    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [sessionId, refresh])

  // 列表拉到后，如果调用方传了 initialArchiveId，命中即自动进复习视图
  useEffect(() => {
    if (initialAppliedRef.current) return
    if (!initialArchiveId) return
    if (archives.length === 0) return
    const hit = archives.find((a) => a.archive_id === initialArchiveId)
    if (hit) {
      initialAppliedRef.current = true
      setReviewingArchive(hit)
    }
  }, [archives, initialArchiveId])

  const handleRestore = useCallback(
    async (a: ArchiveMeta) => {
      // v7 (2026-05) 健壮性：每个 session 只保留一份档案，所以"恢复前自动备份"
      // 反而会把要恢复的档案误删（archive_save 内部会清空所有历史档案）。
      // 因此恢复 = 当前进度直接被覆盖；用户必须明确同意。
      if (
        !window.confirm(
          `恢复档案「${a.name}」会覆盖当前学习流。\n\n当前进度将被替换为档案内容，且**无法恢复**（每个学习流只保留一份档案）。\n\n确定继续？`,
        )
      ) {
        return
      }
      setLoading(true)
      setError('')
      try {
        await invoke('agent_archive_restore', { archiveId: a.archive_id })
        await refresh()
        await onRestored?.()
        onClose?.()
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setLoading(false)
      }
    },
    [refresh, onRestored, onClose],
  )

  const handleDelete = useCallback(
    async (a: ArchiveMeta) => {
      if (!window.confirm(`确定删除档案「${a.name}」？此操作不可撤销。`)) return
      setLoading(true)
      setError('')
      try {
        await invoke('agent_archive_delete', { archiveId: a.archive_id })
        await refresh()
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setLoading(false)
      }
    },
    [refresh],
  )

  const handleRenameStart = useCallback((a: ArchiveMeta) => {
    setRenamingId(a.archive_id)
    setRenameDraft(a.name)
  }, [])

  const handleRenameSubmit = useCallback(async () => {
    if (!renamingId) return
    const name = renameDraft.trim()
    if (!name) {
      setRenamingId(null)
      return
    }
    try {
      await invoke('agent_archive_rename', { archiveId: renamingId, newName: name })
      setRenamingId(null)
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [renamingId, renameDraft, refresh])

  // ─── 复习模式 ─────────────────────────────────────────────────────
  if (reviewingArchive) {
    return (
      <ArchiveReviewView
        sessionId={sessionId}
        archive={reviewingArchive}
        onBack={() => setReviewingArchive(null)}
        onRestore={() => void handleRestore(reviewingArchive)}
        onClose={onClose}
      />
    )
  }

  // ─── 列表模式 ─────────────────────────────────────────────────────
  return (
    <div className="flex h-full flex-col overflow-hidden bg-bg">
      {/* 顶栏 */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border-1 bg-surface-1/60 px-3.5 py-2">
        <History className="size-4 text-indigo-500" />
        <div className="flex flex-col leading-tight">
          <div className="text-[12.5px] font-semibold text-text-1">学习档案</div>
          <div className="text-[10px] text-text-3">
            历次学习流的完整快照 · 可复习 / 恢复 / 重命名 / 删除
          </div>
        </div>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={loading}
            title="刷新"
            className={cn(
              'inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[10.5px] transition',
              loading
                ? 'cursor-wait border-border-2 text-text-3'
                : 'border-border-2 text-text-2 hover:border-border-1 hover:text-text-1',
            )}
          >
            {loading ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
            刷新
          </button>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              title="关闭"
              className="inline-flex items-center rounded-md border border-border-2 px-2 py-1 text-text-2 transition hover:border-border-1 hover:text-text-1"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* 错误 */}
      {error && (
        <div className="mx-3 mt-3 rounded-md border border-red-500/30 bg-red-500/8 px-3 py-2 text-[11.5px] text-red-600 dark:text-red-400">
          {error}
        </div>
      )}

      {/* 空态 */}
      {!loading && archives.length === 0 && !error && (
        <div className="flex h-full items-center justify-center p-8 text-center">
          <div className="space-y-2">
            <Book className="mx-auto size-8 text-text-3/40" />
            <div className="text-[12.5px] font-medium text-text-2">还没有档案</div>
            <div className="text-[10.5px] text-text-3">
              当你重新生成路线图或重置学习流时，
              <br />
              当前进度会自动归档到这里，方便回看。
            </div>
          </div>
        </div>
      )}

      {/* 列表 */}
      <div className="min-h-0 flex-1 overflow-auto px-3 py-3">
        <ul className="space-y-2">
          {archives.map((a) => {
            const auto = a.flow_config?.auto === true
            const reason = a.flow_config?.reason
            const isRenaming = renamingId === a.archive_id
            const progressPct =
              a.unit_total > 0 ? Math.min(100, Math.round((a.current_unit / a.unit_total) * 100)) : 0
            return (
              <li
                key={a.archive_id}
                className="rounded-xl border border-border-1/70 bg-bg-1 px-3.5 py-3 transition hover:border-border-1"
              >
                <div className="mb-1.5 flex items-start gap-2">
                  {/* name */}
                  <div className="min-w-0 flex-1">
                    {isRenaming ? (
                      <input
                        autoFocus
                        value={renameDraft}
                        onChange={(e) => setRenameDraft(e.target.value)}
                        onBlur={() => void handleRenameSubmit()}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void handleRenameSubmit()
                          else if (e.key === 'Escape') setRenamingId(null)
                        }}
                        className="w-full rounded border border-indigo-500/50 bg-bg px-2 py-1 text-[13px] font-medium text-text-1 focus:outline-none focus:ring-1 focus:ring-indigo-500/30"
                      />
                    ) : (
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-[13px] font-semibold text-text-1">
                          {a.name}
                        </span>
                        {auto && (
                          <span
                            className="rounded bg-amber-500/12 px-1.5 py-0.5 text-[9px] font-medium text-amber-600 dark:text-amber-400"
                            title={`触发原因：${reason ?? 'auto'}`}
                          >
                            自动
                          </span>
                        )}
                      </div>
                    )}
                    <div className="mt-0.5 flex items-center gap-2 text-[10.5px] text-text-3">
                      <span className="font-mono">{formatTime(a.created_at)}</span>
                      <span>·</span>
                      <span>
                        {a.unit_total} 单元 / 已学到 U{a.current_unit + 1}（{a.current_phase}）
                      </span>
                    </div>
                  </div>
                </div>

                {/* progress */}
                <div className="mb-2 h-1 overflow-hidden rounded-full bg-bg-2/60">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-purple-500"
                    style={{ width: `${progressPct}%` }}
                  />
                </div>

                {/* actions */}
                <div className="flex items-center gap-1">
                  <ActionBtn icon={Eye} label="复习" onClick={() => setReviewingArchive(a)} />
                  <ActionBtn
                    icon={ArchiveRestore}
                    label="恢复"
                    onClick={() => void handleRestore(a)}
                    accent="emerald"
                  />
                  <ActionBtn icon={Edit3} label="重命名" onClick={() => handleRenameStart(a)} />
                  <div className="ml-auto" />
                  <ActionBtn
                    icon={Trash2}
                    label="删除"
                    onClick={() => void handleDelete(a)}
                    accent="red"
                  />
                </div>
              </li>
            )
          })}
        </ul>
      </div>
    </div>
  )
}

function ActionBtn({
  icon: Icon,
  label,
  onClick,
  accent,
}: {
  icon: typeof Eye
  label: string
  onClick: () => void
  accent?: 'emerald' | 'red'
}) {
  const palette =
    accent === 'emerald'
      ? 'text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/8'
      : accent === 'red'
        ? 'text-red-600 dark:text-red-400 hover:bg-red-500/8'
        : 'text-text-2 hover:bg-bg-2/60 hover:text-text-1'
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] transition',
        palette,
      )}
    >
      <Icon className="size-3.5" />
      {label}
    </button>
  )
}

// ══════════════════════════════════════════════════════════════════════════════
// 复习模式视图（v6 #3+ C3）
// ══════════════════════════════════════════════════════════════════════════════
//
// 数据：调 agent_stream_notes_list(archive_id) 拿那次学习的 unit explanations。
//   - 列表式渲染（按 unit_index 排序，与原学习顺序一致）
//   - 顶栏显示档案名 + 「返回列表」/ 「恢复到 active」/ 「关闭」
//   - 只读 MarkdownView，禁用任何编辑入口

function ArchiveReviewView({
  sessionId,
  archive,
  onBack,
  onRestore,
  onClose,
}: {
  sessionId: string
  archive: ArchiveMeta
  onBack: () => void
  onRestore: () => void
  /** 可选关闭：tab 常驻模式不传 → 不渲染右上角 X */
  onClose?: () => void
}) {
  const [notes, setNotes] = useState<StreamNote[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      setLoading(true)
      setError('')
      try {
        const r = await invoke<StreamNotesResp>('agent_stream_notes_list', {
          sessionId,
          archiveId: archive.archive_id,
        })
        if (!cancelled) setNotes(r.notes ?? [])
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [sessionId, archive.archive_id])

  const sortedNotes = useMemo(() => {
    return [...notes].sort((a, b) => a.unit_index - b.unit_index)
  }, [notes])

  return (
    <div className="flex h-full flex-col overflow-hidden bg-bg">
      {/* 顶栏 */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border-1 bg-surface-1/60 px-3.5 py-2">
        <button
          type="button"
          onClick={onBack}
          title="返回档案列表"
          className="inline-flex items-center gap-1 rounded-md border border-border-2 px-2 py-1 text-[10.5px] text-text-2 transition hover:border-border-1 hover:text-text-1"
        >
          <ChevronLeft className="size-3.5" />
          列表
        </button>
        <BookOpen className="size-4 text-emerald-500" />
        <div className="min-w-0 flex flex-col leading-tight">
          <div className="truncate text-[12.5px] font-semibold text-text-1">
            复习：{archive.name}
          </div>
          <div className="text-[10px] text-text-3">
            {formatTime(archive.created_at)} · {archive.unit_total} 单元 · {sortedNotes.length} 条笔记
          </div>
        </div>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={onRestore}
            className="inline-flex items-center gap-1 rounded-md border border-emerald-500/40 bg-emerald-500/8 px-2.5 py-1 text-[11px] font-medium text-emerald-600 transition hover:bg-emerald-500/15 dark:text-emerald-400"
          >
            <ArchiveRestore className="size-3.5" />
            恢复到当前
          </button>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              title="关闭"
              className="inline-flex items-center rounded-md border border-border-2 px-2 py-1 text-text-2 transition hover:border-border-1 hover:text-text-1"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* 内容 */}
      <div className="min-h-0 flex-1 overflow-auto">
        {loading && (
          <div className="flex h-32 items-center justify-center text-[11.5px] text-text-3">
            <Loader2 className="mr-2 size-4 animate-spin" />
            加载档案笔记…
          </div>
        )}
        {error && (
          <div className="m-3 rounded-md border border-red-500/30 bg-red-500/8 px-3 py-2 text-[11.5px] text-red-600 dark:text-red-400">
            {error}
          </div>
        )}
        {!loading && !error && sortedNotes.length === 0 && (
          <div className="flex h-full items-center justify-center p-8 text-center text-[11.5px] text-text-3">
            <div>
              <Book className="mx-auto mb-2 size-6 text-text-3/40" />
              <div>这次学习没有产出 unit 笔记。</div>
              <div className="mt-1 text-[10px]">
                可能用户没点过「下一单元」，或这是 v6 之前的旧档案。
              </div>
            </div>
          </div>
        )}
        <div className="space-y-3 p-4">
          {sortedNotes.map((n) => (
            <article
              key={n.note_id}
              className="md-knowledge-card overflow-hidden rounded-2xl border border-emerald-500/15 bg-bg-1 shadow-[0_1px_2px_rgba(0,0,0,0.03)]"
            >
              <header className="flex items-center gap-2 border-b border-emerald-500/10 bg-emerald-500/5 px-4 py-2">
                <span className="font-mono text-[11px] font-bold text-emerald-600 dark:text-emerald-400">
                  U{n.unit_index + 1}
                </span>
                <span className="truncate text-[13px] font-semibold text-text-1">
                  {n.unit_title || `单元 ${n.unit_index + 1}`}
                </span>
                <span className="ml-auto font-mono text-[10px] text-text-3">
                  P.{n.anchor_page}
                </span>
              </header>
              <div className="px-5 py-4">
                <MarkdownView content={n.content} theme="vibe" />
              </div>
            </article>
          ))}
        </div>
      </div>
    </div>
  )
}
