/**
 * 技能树可视化页：展示软件工程预设技能树 × 学生当前掌握度。
 *
 * 视觉设计：
 *   - 顶部 hero：总体进度（解锁数 / 平均掌握度）+ 进度条
 *   - 主体：按 category 分组（10 大类），每类一个 section
 *   - 每个 skill 节点：圆形徽章（颜色按掌握度变化）+ 名称 + 进度条
 *
 * 颜色映射（掌握度 0-1）：
 *   - 0%      : 灰色（未解锁）
 *   - 1-30%   : 红色（初识）
 *   - 30-60%  : 橙色（熟悉）
 *   - 60-85%  : 蓝色（掌握）
 *   - 85-100% : 翡翠（精通）
 */
import { ArrowLeft, Lock, RefreshCw, Sparkles, Trees, TrendingUp } from 'lucide-react'
import { cn } from '@/lib/cn'
import type { SkillNodeWithProgress, SkillOverview } from './types'
import { computeSkillTier, masteryPct } from './theme'

interface Props {
  overview: SkillOverview | null
  onBack: () => void
  onRefresh: () => void
}

const CATEGORY_ICONS: Record<string, string> = {
  编程基础: '🔤',
  数据结构: '📊',
  算法: '🧮',
  面向对象: '🧱',
  设计模式: '🎨',
  数据库: '🗄️',
  计算机网络: '🌐',
  操作系统: '⚙️',
  软件工程: '🛠️',
  架构: '🏛️',
}

export function SkillTreeView({ overview, onBack, onRefresh }: Props) {
  if (!overview) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-text-3">
        加载中…
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* 顶部 nav */}
      <header className="flex shrink-0 items-center gap-2 border-b border-border-1 bg-surface-1 px-4 py-2">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1 rounded px-2 py-1 text-[11.5px] text-text-2 hover:bg-bg-2/60 hover:text-text-1"
        >
          <ArrowLeft className="size-3.5" />
          返回训练首页
        </button>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={onRefresh}
            className="inline-flex items-center gap-1 rounded px-2 py-1 text-[10.5px] text-text-3 hover:bg-bg-2/60 hover:text-text-1"
          >
            <RefreshCw className="size-3" />
            刷新
          </button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto bg-bg">
        {/* ╔══ hero —— 错错有动进度环 + 两条细进度条 ══╗ */}
        <section className="relative border-b border-border-1 bg-bg-1 px-5 py-5">
          {/* 装饰背景 */}
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,rgba(16,185,129,0.08),transparent_50%)]" />
          <div className="relative flex items-start gap-4">
            {/* 左侧进度环：最重要的“总掌握度”一眼就能看到 */}
            <ProgressRing percent={Math.round(overview.summary.avg_mastery * 100)} />

            {/* 右侧信息 */}
            <div className="min-w-0 flex-1">
              <div className="mb-1 flex items-center gap-2">
                <div className="flex size-7 items-center justify-center rounded-lg bg-emerald-500/12 ring-1 ring-emerald-500/20">
                  <Trees className="size-4 text-emerald-500" />
                </div>
                <h1 className="text-[16px] font-bold leading-tight text-text-1">SE 技能树</h1>
              </div>
              <p className="mb-2.5 text-[11px] text-text-3">
                {overview.summary.total_skills} 个技能 · {overview.groups.length} 大类 · 覆盖软件工程本科主线
              </p>

              {/* 解锁 + 掌握两条细进度条 */}
              <div className="space-y-2">
                <ProgressBar
                  label="技能解锁"
                  current={overview.summary.unlocked_skills}
                  total={overview.summary.total_skills}
                  barClass="bg-gradient-to-r from-emerald-500 to-cyan-500"
                />
                <ProgressBar
                  label="平均掌握度"
                  current={Math.round(overview.summary.avg_mastery * 100)}
                  total={100}
                  unit="%"
                  barClass="bg-gradient-to-r from-amber-500 via-blue-500 to-emerald-500"
                />
              </div>
            </div>
          </div>

          <div className="relative mt-3 flex items-center gap-1.5 rounded-md border border-border-2 bg-bg-2/30 px-2.5 py-1.5 text-[10.5px] text-text-3">
            <TrendingUp className="size-3 shrink-0 text-blue-500/80" />
            <span>答对关联题 <b className="text-emerald-500">+5%</b>，答错 <b className="text-amber-500">-2%</b>。坚持训练，从 <b>I</b> 初识逐步点亮到 <b>IV</b> 精通。</span>
          </div>
        </section>

        {/* ╔══ 各大类技能 ══╗ */}
        <div className="space-y-3 px-4 py-4">
          {overview.groups.map((group) => {
            const unlocked = group.skills.filter((s) => s.practice_count > 0).length
            const avgMastery = group.skills.reduce((s, n) => s + n.mastery, 0) / Math.max(1, group.skills.length)
            const totalPractice = group.skills.reduce((s, n) => s + n.practice_count, 0)
            return (
              <section
                key={group.category}
                className="overflow-hidden rounded-xl border border-border-1 bg-bg-1"
              >
                {/* 大类 header：左 emoji 图标块 + 中间标题 + 右进度环 */}
                <header className="flex items-center gap-3 border-b border-border-1 bg-bg-2/30 px-4 py-2.5">
                  <div className="flex size-9 items-center justify-center rounded-lg bg-bg-1 text-[18px] ring-1 ring-border-2">
                    {CATEGORY_ICONS[group.category] ?? '📚'}
                  </div>
                  <div className="min-w-0 flex-1">
                    <h2 className="text-[13.5px] font-bold text-text-1">{group.category}</h2>
                    <div className="mt-0.5 flex items-center gap-2 text-[10px] text-text-3">
                      <span>{unlocked}/{group.skills.length} 解锁</span>
                      {totalPractice > 0 && (
                        <>
                          <span>·</span>
                          <span>累计 {totalPractice} 道</span>
                        </>
                      )}
                    </div>
                  </div>
                  {/* 进度环 + 百分数 */}
                  <div className="flex items-center gap-2">
                    <div className="h-1.5 w-24 overflow-hidden rounded-full bg-bg-2/60">
                      <div
                        className={cn(
                          'h-full transition-all duration-700',
                          avgMastery >= 0.6
                            ? 'bg-gradient-to-r from-emerald-500 to-cyan-500'
                            : avgMastery >= 0.3
                              ? 'bg-blue-500'
                              : avgMastery > 0
                                ? 'bg-amber-500'
                                : 'bg-text-3/40',
                        )}
                        style={{ width: `${Math.min(100, avgMastery * 100)}%` }}
                      />
                    </div>
                    <span className="font-mono text-[11px] font-bold text-text-1 tabular-nums">{Math.round(avgMastery * 100)}%</span>
                  </div>
                </header>
                <div className="grid grid-cols-1 gap-2 p-3 sm:grid-cols-2">
                  {group.skills.map((sk) => (
                    <SkillBadge key={sk.id} skill={sk} />
                  ))}
                </div>
              </section>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// SVG 进度环：作为 hero 主视觉焦点
function ProgressRing({ percent }: { percent: number }) {
  const size = 76
  const stroke = 6
  const radius = (size - stroke) / 2
  const circumference = 2 * Math.PI * radius
  const offset = circumference * (1 - Math.min(1, Math.max(0, percent / 100)))
  // 根据掌握度选颜色
  const colorStop =
    percent >= 85 ? '#10b981' /* emerald */
    : percent >= 60 ? '#3b82f6' /* blue */
    : percent >= 30 ? '#a855f7' /* purple */
    : percent > 0 ? '#f59e0b' /* amber */
    : 'currentColor'
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90 text-bg-2/60">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={colorStop}
          strokeWidth={stroke}
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          className="transition-all duration-700"
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-[18px] font-bold leading-none text-text-1 tabular-nums">{percent}</span>
        <span className="text-[9px] text-text-3">掌握度%</span>
      </div>
    </div>
  )
}

// 细进度条
function ProgressBar({
  label,
  current,
  total,
  unit = '',
  barClass,
}: {
  label: string
  current: number
  total: number
  unit?: string
  barClass: string
}) {
  const pct = total > 0 ? (current / total) * 100 : 0
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-[10.5px]">
        <span className="font-medium text-text-2">{label}</span>
        <span className="font-mono tabular-nums text-text-1">
          {current}{unit ? unit : `/${total}`}
        </span>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-bg-2/60">
        <div className={cn('h-full transition-all duration-700', barClass)} style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
    </div>
  )
}

function SkillBadge({ skill }: { skill: SkillNodeWithProgress }) {
  const pct = masteryPct(skill.mastery)
  const tier = computeSkillTier(skill.mastery, skill.practice_count)
  const locked = skill.practice_count === 0
  return (
    <div
      className={cn(
        'group relative flex items-start gap-2.5 rounded-lg border px-2.5 py-2 transition',
        tier.borderClass,
        tier.bgClass,
        !locked && 'hover:shadow-sm',
      )}
      title={skill.description}
    >
      {/* 左侧徽章：不在圈圈里，而是一个有边框圈的 chip，更精美 */}
      <div
        className={cn(
          'flex size-10 shrink-0 items-center justify-center rounded-lg ring-1 transition',
          tier.badgeClass,
          tier.badgeRing,
        )}
      >
        {locked ? <Lock className="size-3.5" /> : <span className="text-[11px] font-black">{tier.label}</span>}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span
            className={cn(
              'truncate text-[12px] font-semibold transition',
              locked ? 'text-text-3' : 'text-text-1',
            )}
          >
            {skill.name}
          </span>
          {skill.practice_count > 0 && (
            <span className="shrink-0 rounded-full bg-bg-2/60 px-1.5 py-0.5 font-mono text-[9px] text-text-3">
              ×{skill.practice_count}
            </span>
          )}
        </div>
        <div className="mt-1">
          <div className="h-1 overflow-hidden rounded-full bg-bg-2/60">
            <div
              className={cn('h-full transition-all duration-500', tier.barClass)}
              style={{ width: `${Math.min(100, pct)}%` }}
            />
          </div>
        </div>
        <div className="mt-0.5 flex items-center justify-between text-[9.5px]">
          <span className={cn('font-medium', locked ? 'text-text-3' : tier.tierTextClass)}>
            {tier.tierLabel}
          </span>
          <span className="font-mono tabular-nums text-text-3">{pct}%</span>
        </div>
      </div>
      {/* 精通级在右上角加一个 Sparkles 徽标 */}
      {tier.label === 'IV' && (
        <Sparkles className="absolute right-1.5 top-1.5 size-3 text-emerald-500" />
      )}
    </div>
  )
}

