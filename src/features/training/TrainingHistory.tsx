/**
 * 训练历史页：列出最近 50 条答题记录 + 总体统计。
 *
 * 每条记录展示：
 *   - 题型 / 难度 badge + 提交时间（相对）
 *   - 题面（截断）+ 用户答案（折叠）
 *   - 评分：score / is_correct + feedback
 *   - 关联的 skills（彩色标签）
 *
 * 顶部卡片：累计题数 / 准确率 / 平均分 / 累计技能影响
 */
import { useMemo, useState } from 'react'
import { ArrowLeft, Award, BarChart3, CheckCircle2, ChevronDown, ChevronUp, History as HistoryIcon, Target, XCircle } from 'lucide-react'
import { cn } from '@/lib/cn'
import { TYPE_LABELS, type TrainingAttempt, type TrainingStats, type TrainingType } from './types'
import { TYPE_COLORS } from './theme'
import { StatCard } from './StatCard'

interface Props {
  attempts: TrainingAttempt[]
  stats: TrainingStats | null
  onBack: () => void
}

export function TrainingHistory({ attempts, stats, onBack }: Props) {
  // 按时间分组：今天 / 昨天 / 本周 / 更早 —— 临场取出以便列表上加“时间轴”隔位
  const grouped = useMemo(() => groupByDate(attempts), [attempts])
  return (
    <div className="flex h-full flex-col overflow-hidden bg-bg">
      <header className="flex shrink-0 items-center gap-2 border-b border-border-1 bg-surface-1 px-4 py-2">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1 rounded px-2 py-1 text-[11.5px] text-text-2 hover:bg-bg-2/60 hover:text-text-1"
        >
          <ArrowLeft className="size-3.5" />
          返回训练首页
        </button>
        <div className="ml-auto flex items-center gap-1 text-[11px] text-text-3">
          <HistoryIcon className="size-3.5" />
          <span>最近 {attempts.length} 条记录</span>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto">
        {/* ╔══ 顶部 hero 统计卡 ══╗ */}
        <section className="relative border-b border-border-1 bg-bg-1 px-5 py-4">
          <div className="pointer-events-none absolute inset-x-0 top-0 h-24 bg-[radial-gradient(ellipse_at_top,rgba(168,85,247,0.08),transparent_60%)]" />
          <div className="relative">
            <div className="mb-3 flex items-center gap-2">
              <div className="flex size-8 items-center justify-center rounded-lg bg-purple-500/12 ring-1 ring-purple-500/20">
                <HistoryIcon className="size-4 text-purple-500" />
              </div>
              <div>
                <h1 className="text-[15px] font-bold leading-tight text-text-1">训练历史</h1>
                <p className="text-[10.5px] text-text-3">最近 50 条 · 点开查看评分详情</p>
              </div>
            </div>
            {stats && (
              <div className="grid grid-cols-3 gap-2">
                <StatCard
                  icon={<BarChart3 className="size-4" />}
                  label="累计答题"
                  value={`${stats.total_attempts}`}
                  tone="blue"
                />
                <StatCard
                  icon={<Target className="size-4" />}
                  label="准确率"
                  value={
                    stats.total_attempts > 0
                      ? `${Math.round(stats.accuracy * 100)}%`
                      : '-'
                  }
                  sub={stats.total_attempts > 0 ? `${stats.total_correct}/${stats.total_attempts}` : undefined}
                  tone="emerald"
                />
                <StatCard
                  icon={<Award className="size-4" />}
                  label="平均分"
                  value={stats.total_attempts > 0 ? `${Math.round(stats.avg_score)}` : '-'}
                  tone="amber"
                />
              </div>
            )}
          </div>
        </section>

        {/* ╔══ 历史列表（按时间分组） ══╗ */}
        <div className="px-4 py-3">
          {attempts.length === 0 ? (
            <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border-2 bg-bg-1 px-4 py-12 text-center">
              <div className="mb-2 flex size-10 items-center justify-center rounded-full bg-bg-2/60">
                <HistoryIcon className="size-5 text-text-3" />
              </div>
              <p className="text-[12.5px] font-medium text-text-2">还没有任何训练记录</p>
              <p className="mt-0.5 text-[10.5px] text-text-3">返回首页，开始你的第一组训练</p>
            </div>
          ) : (
            <div className="space-y-4">
              {grouped.map((g) => (
                <div key={g.label}>
                  {/* 时间分组 header */}
                  <div className="mb-2 flex items-center gap-2">
                    <div className="h-px flex-1 bg-border-1/60" />
                    <span className="shrink-0 rounded-full bg-bg-2/60 px-2 py-0.5 text-[10px] font-medium text-text-3">
                      {g.label} · {g.items.length} 道
                    </span>
                    <div className="h-px flex-1 bg-border-1/60" />
                  </div>
                  <div className="space-y-2">
                    {g.items.map((a) => (
                      <AttemptRow key={a.attempt_id} attempt={a} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// 按日期分组：今天 / 昨天 / 本周 / 更早
function groupByDate(attempts: TrainingAttempt[]): { label: string; items: TrainingAttempt[] }[] {
  const today: TrainingAttempt[] = []
  const yesterday: TrainingAttempt[] = []
  const thisWeek: TrainingAttempt[] = []
  const earlier: TrainingAttempt[] = []
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const startOfYesterday = startOfToday - 24 * 60 * 60 * 1000
  const startOfWeek = startOfToday - 7 * 24 * 60 * 60 * 1000
  for (const a of attempts) {
    const t = new Date(a.created_at).getTime()
    if (Number.isNaN(t)) {
      earlier.push(a)
      continue
    }
    if (t >= startOfToday) today.push(a)
    else if (t >= startOfYesterday) yesterday.push(a)
    else if (t >= startOfWeek) thisWeek.push(a)
    else earlier.push(a)
  }
  const out: { label: string; items: TrainingAttempt[] }[] = []
  if (today.length) out.push({ label: '今天', items: today })
  if (yesterday.length) out.push({ label: '昨天', items: yesterday })
  if (thisWeek.length) out.push({ label: '本周内', items: thisWeek })
  if (earlier.length) out.push({ label: '更早', items: earlier })
  return out
}

function AttemptRow({ attempt }: { attempt: TrainingAttempt }) {
  const [expanded, setExpanded] = useState(false)
  const q = attempt.question
  const grade = attempt.grade
  const typeLabel = q?.type ? TYPE_LABELS[q.type as TrainingType] : '未知'
  const typeBadge = q?.type
    ? { bg: TYPE_COLORS[q.type as TrainingType].iconBg, text: TYPE_COLORS[q.type as TrainingType].iconText }
    : { bg: 'bg-bg-2/60', text: 'text-text-3' }
  return (
    <article
      className={cn(
        'group flex items-stretch gap-3 rounded-lg border bg-bg-1 transition hover:shadow-sm',
        attempt.is_correct
          ? 'border-emerald-500/25 hover:border-emerald-500/40'
          : 'border-amber-500/25 hover:border-amber-500/40',
      )}
    >
      {/* 左侧分数大圈圈：一眼看到对错 + 分数 */}
      <div
        className={cn(
          'flex w-14 shrink-0 flex-col items-center justify-center gap-0.5 rounded-l-lg border-r',
          attempt.is_correct
            ? 'border-emerald-500/20 bg-emerald-500/[0.04]'
            : 'border-amber-500/20 bg-amber-500/[0.04]',
        )}
      >
        {attempt.is_correct ? (
          <CheckCircle2 className="size-3.5 text-emerald-500" />
        ) : (
          <XCircle className="size-3.5 text-amber-500" />
        )}
        <span
          className={cn(
            'text-[15px] font-bold leading-none tabular-nums',
            attempt.is_correct ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400',
          )}
        >
          {attempt.score}
        </span>
        <span className="text-[8px] font-medium uppercase tracking-wider text-text-3">/100</span>
      </div>

      {/* 主体 */}
      <div className="flex min-w-0 flex-1 flex-col py-2 pr-3">
      <header className="mb-1 flex items-center gap-1.5 text-[10.5px]">
        <span className={cn('rounded-md px-1.5 py-0.5 font-bold', typeBadge.bg, typeBadge.text)}>
          {typeLabel}
        </span>
        {q && (
          <span className="flex items-center gap-0.5 rounded bg-bg-2/60 px-1.5 py-0.5 text-text-2">
            <span className="font-mono">Lv.{q.difficulty}</span>
          </span>
        )}
        <span className="ml-auto font-mono text-text-3">{formatTime(attempt.created_at)}</span>
      </header>

      <div className="text-[12px] leading-snug text-text-1 line-clamp-2">{q?.prompt ?? '(题面缺失)'}</div>

      {/* skills 标签 + 展开按钮同行 */}
      <div className="mt-1.5 flex items-center gap-1.5">
        {attempt.skills && attempt.skills.length > 0 && (
          <div className="flex flex-wrap items-center gap-1">
            {attempt.skills.slice(0, 3).map((s) => (
              <span
                key={s}
                className="rounded bg-purple-500/10 px-1.5 py-0.5 font-mono text-[9px] text-purple-600 dark:text-purple-400"
              >
                {s}
              </span>
            ))}
            {attempt.skills.length > 3 && (
              <span className="text-[9px] text-text-3">+{attempt.skills.length - 3}</span>
            )}
          </div>
        )}
        <button
          type="button"
          onClick={() => setExpanded((x) => !x)}
          className="ml-auto inline-flex items-center gap-0.5 rounded text-[10.5px] text-text-3 hover:text-text-1"
        >
          {expanded ? '收起' : '展开详情'}
          {expanded ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
        </button>
      </div>

      {expanded && (
        <div className="mt-2 space-y-2 rounded-md bg-bg-1 px-2.5 py-2 text-[11px]">
          {/* 用户答案 */}
          <div>
            <div className="text-[9.5px] font-bold uppercase tracking-wider text-text-3">你的答案</div>
            <pre className="mt-0.5 max-h-32 overflow-auto whitespace-pre-wrap rounded bg-bg-2/40 px-2 py-1 font-mono text-[10.5px] text-text-2">
              {attempt.user_answer || '(空)'}
            </pre>
          </div>
          {/* 评分 feedback */}
          {grade && (
            <>
              <div>
                <div className="text-[9.5px] font-bold uppercase tracking-wider text-text-3">AI 反馈</div>
                <div className="mt-0.5 text-text-1">{grade.feedback}</div>
              </div>
              {grade.missed_points && grade.missed_points.length > 0 && (
                <div>
                  <div className="text-[9.5px] font-bold uppercase tracking-wider text-text-3">遗漏要点</div>
                  <ul className="mt-0.5 space-y-0.5 text-text-2">
                    {grade.missed_points.map((m, i) => (
                      <li key={i} className="flex items-start gap-1">
                        <span className="mt-1 size-1 shrink-0 rounded-full bg-amber-500" />
                        <span>{m}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
          {/* 参考答案 */}
          {q?.answer && (
            <div>
              <div className="text-[9.5px] font-bold uppercase tracking-wider text-text-3">参考答案</div>
              <pre className="mt-0.5 max-h-32 overflow-auto whitespace-pre-wrap rounded bg-bg-2/40 px-2 py-1 font-mono text-[10.5px] text-text-1">
                {q.answer}
              </pre>
            </div>
          )}
          {/* 代码运行结果（若存在） */}
          {attempt.code_run && (
            <div>
              <div className="text-[9.5px] font-bold uppercase tracking-wider text-text-3">
                代码运行（{attempt.code_run.success ? '成功' : '失败'} · {attempt.code_run.time_ms}ms）
              </div>
              {attempt.code_run.stdout && (
                <pre className="mt-0.5 max-h-24 overflow-auto whitespace-pre-wrap rounded bg-[#0d1117] px-2 py-1 font-mono text-[10px] text-emerald-300">
                  {attempt.code_run.stdout}
                </pre>
              )}
              {attempt.code_run.stderr && (
                <pre className="mt-0.5 max-h-24 overflow-auto whitespace-pre-wrap rounded bg-[#0d1117] px-2 py-1 font-mono text-[10px] text-red-300">
                  {attempt.code_run.stderr}
                </pre>
              )}
            </div>
          )}
        </div>
      )}
      </div>
    </article>
  )
}

function formatTime(iso: string): string {
  try {
    const t = new Date(iso).getTime()
    if (Number.isNaN(t)) return iso
    const diff = Date.now() - t
    const sec = Math.floor(diff / 1000)
    if (sec < 60) return `${sec} 秒前`
    const min = Math.floor(sec / 60)
    if (min < 60) return `${min} 分钟前`
    const hr = Math.floor(min / 60)
    if (hr < 24) return `${hr} 小时前`
    const day = Math.floor(hr / 24)
    if (day < 30) return `${day} 天前`
    return new Date(iso).toLocaleDateString()
  } catch {
    return iso
  }
}
