/**
 * VibeHistoryPanel —— vibelearning 统一会话历史面板（v6 2026-05 #3）
 *
 * 设计：
 *   - 学习（AgentTab）和训练（TrainingTab）UI 仍然分开，但都把"发生过的事"
 *     通过后端 vibe_event_append 写入 vibe_session_events 表。
 *   - 本面板作为第 7 个右栏 tab "历史"，读 vibe_get_timeline 命令把事件按
 *     时序渲染成 timeline 视图。
 *   - 仅 doc_session 已就绪时可用。
 *
 * 事件 kind 约定（与后端 commands.rs 中 vibe_event_append 调用点对齐）：
 *   - plan_generated     : 路线图生成
 *   - unit_advanced      : 单元推进（next）
 *   - unit_paused        : 学习暂停
 *   - unit_retried       : 单元重新生成
 *   - agent_reset        : 整 Agent 重置
 *   - training_attempt   : 训练答题（score / is_correct / skills）
 *
 * 后续随业务扩展，前端只需在 KIND_META 加配置即可显示新事件。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertCircle,
  ArrowRight,
  BookOpen,
  CheckCircle2,
  ClipboardList,
  Dumbbell,
  History,
  Loader2,
  Map as MapIcon,
  Pause,
  RefreshCw,
  RotateCcw,
  Sparkles,
  XCircle,
} from 'lucide-react'
import { invoke } from '@/lib/tauri'
import { cn } from '@/lib/cn'

interface Props {
  sessionId: string
  /** 当前 tab 是否处于激活态（用于跳过非激活时的轮询/拉取） */
  isActive?: boolean
}

interface VibeEvent {
  event_id: number
  ts: string
  kind: string
  unit_index: number | null
  ref_id: string
  payload: Record<string, unknown>
}

interface TimelineResp {
  events: VibeEvent[]
  count: number
}

/** 每种事件的展示元数据：图标 / 颜色 token / 标题前缀生成 */
interface KindMeta {
  Icon: typeof Sparkles
  label: string
  /** 圆点 / 边色 token（tailwind 类） */
  dot: string
  /** 用 payload 生成右侧详情段（短句，可包含数字 / 标签） */
  detail: (e: VibeEvent) => React.ReactNode
}

/**
 * 派发"跳转到学习档案复习"：
 *   1) 通知 RightPane 切到 'vibe' tab（学习档案）
 *   2) 通知 LearningHistoryPanel 切到「档案管理」子 tab + ArchiveListPanel
 *      直接打开该 archive 的复习视图
 *
 * 注：本面板自身就在 'vibe' tab 的「时间线」子 tab 内，但发 reader-pane-change
 *     仍然安全（同 tab 时是 no-op），保持调用链一致。
 */
function jumpToArchive(archiveId: string) {
  if (!archiveId) return
  window.dispatchEvent(
    new CustomEvent('reader-pane-change', { detail: { pane: 'vibe' } }),
  )
  // microtask 排队，确保 LearningHistoryPanel 切到 archives 子 tab 时
  // 再让它把 initialArchiveId 透传给 ArchiveListPanel
  Promise.resolve().then(() => {
    window.dispatchEvent(
      new CustomEvent('agent-open-archive', { detail: { archiveId } }),
    )
  })
}

/**
 * 「查看上一次学习」按钮：仅在 ref_id 非空时渲染，
 * 点击 → 切到学习 tab + 自动进入对应 archive 的复习视图。
 */
function ArchiveJumpLink({ archiveId }: { archiveId: string }) {
  if (!archiveId) return null
  return (
    <button
      type="button"
      onClick={() => jumpToArchive(archiveId)}
      className="mt-1 inline-flex items-center gap-1 rounded-md border border-emerald-500/30 bg-emerald-500/6 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600 transition hover:bg-emerald-500/12 dark:text-emerald-400"
    >
      <BookOpen className="size-3" />
      查看上一次学习
    </button>
  )
}

const KIND_META: Record<string, KindMeta> = {
  plan_generated: {
    Icon: MapIcon,
    label: '生成学习路线',
    dot: 'bg-indigo-500',
    detail: (e) => {
      const units = (e.payload.unit_count as number | undefined) ?? 0
      const pages = (e.payload.page_total as number | undefined) ?? 0
      const force = e.payload.force === true
      const thesis = (e.payload.thesis as string | undefined) ?? ''
      const prevArchiveId = (e.payload.previous_archive_id as string | undefined) ?? ''
      return (
        <div className="space-y-1">
          <div className="text-[12px] text-text-2">
            共 <span className="font-mono font-semibold text-text-1">{units}</span> 单元 ·{' '}
            <span className="font-mono text-text-2">{pages}</span> 页
            {force && (
              <span className="ml-1.5 rounded bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-medium text-amber-600 dark:text-amber-400">
                重新生成
              </span>
            )}
          </div>
          {thesis && (
            <div className="line-clamp-2 text-[11px] italic text-text-3">"{thesis}"</div>
          )}
          {/* C4：force=true 时 ref_id/previous_archive_id 指向上一份学习流的归档 */}
          {prevArchiveId && <ArchiveJumpLink archiveId={prevArchiveId} />}
        </div>
      )
    },
  },
  unit_advanced: {
    Icon: ArrowRight,
    label: '推进到下一单元',
    dot: 'bg-emerald-500',
    detail: (e) => {
      const from = (e.payload.from_unit as number | undefined) ?? 0
      const to = (e.payload.to_unit as number | undefined) ?? 0
      const title = (e.payload.from_unit_title as string | undefined) ?? ''
      const prefetched = e.payload.prefetched === true
      return (
        <div className="space-y-0.5">
          <div className="flex items-center gap-1.5 text-[12px] text-text-2">
            <span className="font-mono">U{from + 1}</span>
            <ArrowRight className="size-3 text-text-3" />
            <span className="font-mono font-semibold text-text-1">U{to + 1}</span>
            {prefetched && (
              <span className="rounded bg-emerald-500/12 px-1.5 py-0.5 text-[9px] text-emerald-600 dark:text-emerald-400">
                已预生成
              </span>
            )}
          </div>
          {title && <div className="truncate text-[11px] text-text-3">完成：{title}</div>}
        </div>
      )
    },
  },
  unit_paused: {
    Icon: Pause,
    label: '暂停学习',
    dot: 'bg-amber-500',
    detail: (e) => {
      const u = e.unit_index ?? 0
      return <div className="text-[11.5px] text-text-3">停在 U{u + 1}</div>
    },
  },
  unit_retried: {
    Icon: RotateCcw,
    label: '重新生成单元',
    dot: 'bg-orange-500',
    detail: (e) => {
      const u = e.unit_index ?? 0
      return <div className="text-[11.5px] text-text-3">U{u + 1} 清空重学</div>
    },
  },
  agent_reset: {
    Icon: AlertCircle,
    label: '重置学习流',
    dot: 'bg-red-500',
    detail: (e) => {
      const archivedTo = (e.payload.archived_to as string | undefined) ?? ''
      return (
        <div className="space-y-1">
          <div className="text-[11.5px] text-text-3">
            {archivedTo
              ? '当前进度已自动归档到「档案」面板，可随时回看。'
              : '清空了所有单元状态（当时没有可归档内容）。'}
          </div>
          {archivedTo && <ArchiveJumpLink archiveId={archivedTo} />}
        </div>
      )
    },
  },
  training_attempt: {
    Icon: Dumbbell,
    label: '训练答题',
    dot: 'bg-purple-500',
    detail: (e) => {
      const score = (e.payload.score as number | undefined) ?? 0
      const isCorrect = e.payload.is_correct === true
      const qType = (e.payload.type as string | undefined) ?? ''
      const preview = (e.payload.prompt_preview as string | undefined) ?? ''
      return (
        <div className="space-y-0.5">
          <div className="flex items-center gap-1.5 text-[12px]">
            {isCorrect ? (
              <CheckCircle2 className="size-3.5 text-emerald-500" />
            ) : (
              <XCircle className="size-3.5 text-amber-500" />
            )}
            <span
              className={cn(
                'font-mono font-bold tabular-nums',
                isCorrect ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400',
              )}
            >
              {score}
            </span>
            <span className="text-[10px] text-text-3">/ 100</span>
            {qType && (
              <span className="rounded bg-bg-2/60 px-1.5 py-0.5 text-[9px] uppercase text-text-3">
                {qType}
              </span>
            )}
          </div>
          {preview && (
            <div className="line-clamp-2 text-[11px] text-text-3">{preview}</div>
          )}
        </div>
      )
    },
  },
}

const FALLBACK_META: KindMeta = {
  Icon: ClipboardList,
  label: '未知事件',
  dot: 'bg-text-3/60',
  detail: (e) => (
    <div className="font-mono text-[10.5px] text-text-3">{e.kind}</div>
  ),
}

function formatTime(ts: string): string {
  try {
    const d = new Date(ts)
    if (Number.isNaN(d.getTime())) return ts
    // 显示 HH:MM:SS，旁边显示日期短格式 MM-DD
    const hh = String(d.getHours()).padStart(2, '0')
    const mm = String(d.getMinutes()).padStart(2, '0')
    const ss = String(d.getSeconds()).padStart(2, '0')
    const mo = String(d.getMonth() + 1).padStart(2, '0')
    const dd = String(d.getDate()).padStart(2, '0')
    return `${mo}-${dd} ${hh}:${mm}:${ss}`
  } catch {
    return ts
  }
}

/** 按日期分组的 timeline 单元 */
interface DayGroup {
  dayLabel: string
  events: VibeEvent[]
}

function groupByDay(events: VibeEvent[]): DayGroup[] {
  const groups = new Map<string, VibeEvent[]>()
  for (const e of events) {
    const d = new Date(e.ts)
    const key = Number.isNaN(d.getTime())
      ? e.ts.slice(0, 10)
      : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(e)
  }
  return Array.from(groups.entries()).map(([dayLabel, evts]) => ({
    dayLabel,
    events: evts,
  }))
}

export function VibeHistoryPanel({ sessionId, isActive = true }: Props) {
  const [events, setEvents] = useState<VibeEvent[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [lastFetchTs, setLastFetchTs] = useState<number>(0)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const r = await invoke<TimelineResp>('vibe_get_timeline', {
        sessionId,
        limit: 1000,
      })
      setEvents(r.events ?? [])
      setLastFetchTs(Date.now())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [sessionId])

  // 首次激活 + 切回该 tab 时拉取；6 秒以内的重复进入跳过避免抖动。
  useEffect(() => {
    if (!isActive) return
    if (Date.now() - lastFetchTs < 6_000 && events.length > 0) return
    void refresh()
  }, [isActive, refresh, lastFetchTs, events.length])

  const groups = useMemo(() => groupByDay(events), [events])
  const totals = useMemo(() => {
    const counter: Record<string, number> = {}
    for (const e of events) counter[e.kind] = (counter[e.kind] ?? 0) + 1
    return counter
  }, [events])

  return (
    <div className="flex h-full flex-col overflow-hidden bg-bg">
      {/* 顶部条 */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border-1 bg-surface-1/60 px-3.5 py-2">
        <History className="size-4 text-indigo-500" />
        <div className="flex flex-col leading-tight">
          <div className="text-[12.5px] font-semibold text-text-1">学习历史</div>
          <div className="text-[10px] text-text-3">vibelearning · 同一资料的学习 + 训练时间线</div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {/* 简短统计胶囊 */}
          <div className="flex items-center gap-1 text-[10.5px]">
            <Stat label="路线" value={totals.plan_generated ?? 0} color="indigo" />
            <Stat label="推进" value={totals.unit_advanced ?? 0} color="emerald" />
            <Stat label="答题" value={totals.training_attempt ?? 0} color="purple" />
          </div>
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
            {loading ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <RefreshCw className="size-3" />
            )}
            刷新
          </button>
        </div>
      </div>

      {/* 内容 */}
      <div className="min-h-0 flex-1 overflow-auto">
        {error && (
          <div className="m-3 flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/8 px-3 py-2 text-[11.5px] text-red-600 dark:text-red-400">
            <AlertCircle className="mt-0.5 size-3.5" />
            <span>{error}</span>
          </div>
        )}
        {!error && events.length === 0 && !loading && (
          <div className="flex h-full items-center justify-center p-8 text-center">
            <div className="space-y-2">
              <ClipboardList className="mx-auto size-8 text-text-3/40" />
              <div className="text-[12.5px] font-medium text-text-2">还没有学习事件</div>
              <div className="text-[10.5px] text-text-3">
                在「学习」或「训练」面板开始后，
                <br />
                这里会按时间线汇总你的所有动作。
              </div>
            </div>
          </div>
        )}
        {groups.map((g) => (
          <section key={g.dayLabel} className="px-3.5 py-3">
            <header className="mb-2 flex items-center gap-2">
              <span className="font-mono text-[11px] font-medium text-text-2">{g.dayLabel}</span>
              <div className="h-px flex-1 bg-border-1" />
              <span className="rounded-full bg-bg-2/60 px-1.5 py-0.5 text-[9.5px] font-medium text-text-3">
                {g.events.length} 条
              </span>
            </header>
            <ol className="relative space-y-2.5 border-l border-border-1/70 pl-4">
              {g.events.map((e) => {
                const meta = KIND_META[e.kind] ?? FALLBACK_META
                const Icon = meta.Icon
                return (
                  <li key={e.event_id} className="relative">
                    {/* timeline dot */}
                    <span
                      className={cn(
                        'absolute -left-[21px] top-1.5 flex size-3 items-center justify-center rounded-full ring-2 ring-bg',
                        meta.dot,
                      )}
                    />
                    <div className="rounded-lg border border-border-1/60 bg-bg-1 px-3 py-2 shadow-[0_1px_0_rgba(0,0,0,0.02)]">
                      <div className="mb-0.5 flex items-center gap-1.5">
                        <Icon className="size-3.5 text-text-2" />
                        <span className="text-[12px] font-semibold text-text-1">{meta.label}</span>
                        {typeof e.unit_index === 'number' && (
                          <span className="rounded bg-bg-2/60 px-1.5 py-0.5 font-mono text-[9.5px] text-text-3">
                            U{e.unit_index + 1}
                          </span>
                        )}
                        <span className="ml-auto font-mono text-[10px] text-text-3">
                          {formatTime(e.ts)}
                        </span>
                      </div>
                      <div className="pl-5">{meta.detail(e)}</div>
                    </div>
                  </li>
                )
              })}
            </ol>
          </section>
        ))}
      </div>
    </div>
  )
}

function Stat({
  label,
  value,
  color,
}: {
  label: string
  value: number
  color: 'indigo' | 'emerald' | 'purple'
}) {
  const palette = {
    indigo: 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-400',
    emerald: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
    purple: 'bg-purple-500/10 text-purple-600 dark:text-purple-400',
  }[color]
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-md px-1.5 py-0.5', palette)}>
      <span className="text-[9.5px] uppercase tracking-wider opacity-80">{label}</span>
      <span className="font-mono font-bold tabular-nums">{value}</span>
    </span>
  )
}
