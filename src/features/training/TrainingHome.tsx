/**
 * 训练首页：展示当前进度概览 + 启动训练 + 跳转到子页面。
 *
 * 三个卡片：
 *   1. 总览卡：技能解锁数 / 平均掌握度 / 累计答题数 / 准确率
 *   2. 启动训练卡：选单元 + 题型 + 难度 + 数量 → 调 generate_pack 进 session
 *   3. 入口卡：技能树 / 历史 / 学习单元跳转
 */
import { useEffect, useRef, useState, useCallback } from 'react'
import { ArrowRight, BarChart3, BookOpen, Check, Code2, Dumbbell, GraduationCap, History, Loader2, Shuffle, Sparkles, Star, Target, Trees, Zap } from 'lucide-react'
import { invoke } from '@/lib/tauri'
import { cn } from '@/lib/cn'
import {
  SUPPORTED_LANGUAGES,
  TYPE_LABELS,
  type SkillOverview,
  type SupportedLanguage,
  type TrainingQuestion,
  type TrainingStats,
  type TrainingType,
} from './types'
import { TYPE_COLORS, TYPE_ICONS, computeUserTier, masteryPct } from './theme'
import { StatCard } from './StatCard'

/** 难度 1-5 → 档位描述 */
const DIFFICULTY_LABELS = ['', '极简', '入门', '中等', '进阶', '挑战']
const DIFFICULTY_DESC = ['', '概念识别', '基本应用', '综合理解', '深度推理', '迁移创新']

interface Props {
  sessionId: string
  overview: SkillOverview | null
  stats: TrainingStats | null
  historyCount: number
  onStartSession: (payload: {
    questions: TrainingQuestion[]
    unitIndex: number | null
    language: string
    difficulty: number
  }) => void
  onOpenSkillTree: () => void
  onOpenHistory: () => void
  onRefresh: () => void
}

interface UnitOption {
  index: number
  title: string
  hasTeachPack: boolean
  /** v6 (2026-05) #3++ 该单元是否已有预生成的训练 pack（可一键直达） */
  packReady: boolean
  /** 该 pack 的题数（仅 packReady=true 时有意义） */
  packSize: number
}

const ALL_TYPES: TrainingType[] = ['choice', 'short', 'code', 'debug', 'fill', 'sequence']

export function TrainingHome({
  sessionId,
  overview,
  stats,
  historyCount,
  onStartSession,
  onOpenSkillTree,
  onOpenHistory,
  onRefresh,
}: Props) {
  // ── 训练参数 state ──────────────────────────────────────────────
  const [units, setUnits] = useState<UnitOption[]>([])
  const [unitIndex, setUnitIndex] = useState<number | null>(null) // null = 整体（基于 outline 概要）
  // v4 (2026-05) P3.3 多源命题
  // mixUnits: 主选 unitIndex 之外的额外单元（多选）— 非空时改用 unit_indexes 传给后端
  const [mixUnits, setMixUnits] = useState<Set<number>>(() => new Set())
  // entryId: 基于笔记本条目命题（高优先级）— 非空时覆盖 unit 选择
  const [entryId, setEntryId] = useState<string>('')
  const [types, setTypes] = useState<TrainingType[]>(['choice', 'short', 'code'])
  const [count, setCount] = useState(6)
  const [difficulty, setDifficulty] = useState(3)
  const [language, setLanguage] = useState<SupportedLanguage>('python')
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState('')

  // ── 拉取学习单元列表（让用户选 "基于哪个单元命题"） + 训练 pack 就绪状态 ─
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [state, packs] = await Promise.all([
          invoke<{ plan: any; unit_states: any[] }>('agent_get_state', { sessionId }),
          invoke<Array<{ unit_index: number; question_count: number }>>(
            'training_list_unit_packs',
            { sessionId },
          ).catch(() => []),
        ])
        if (cancelled) return
        const outlineUnits: any[] = state?.plan?.outline?.units ?? []
        // 把 unit_states 转成 map 看哪些有 teach_pack
        const teachPackMap = new Map<number, boolean>()
        for (const us of state?.unit_states ?? []) {
          teachPackMap.set(us.unit_index, !!us.teach_pack)
        }
        // 训练 pack 已就绪的 (unit_index → 题数)
        const packMap = new Map<number, number>()
        for (const p of packs ?? []) packMap.set(p.unit_index, p.question_count)
        const opts: UnitOption[] = outlineUnits.map((u, i) => ({
          index: i,
          title: u?.title ?? `单元 ${i + 1}`,
          hasTeachPack: teachPackMap.get(i) ?? false,
          packReady: packMap.has(i) && (packMap.get(i) ?? 0) > 0,
          packSize: packMap.get(i) ?? 0,
        }))
        setUnits(opts)
        // 默认选第一个有 teach_pack 的单元；都没有则保持 null（走整体命题）
        const firstReady = opts.find((u) => u.hasTeachPack)
        if (firstReady) setUnitIndex(firstReady.index)
      } catch (e) {
        console.error('[TrainingHome] 拉单元失败', e)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [sessionId])

  // v6 (2026-05) #3++ 「直达单元训练」：从 ready 单元直接拉 pack 进 session，跳过 3 步表单
  const jumpToUnitPack = useCallback(
    async (unitIdx: number) => {
      try {
        const resp = await invoke<{
          unit_index: number
          pack: { questions: TrainingQuestion[] } | null
        } | null>('training_get_unit_pack', { sessionId, unitIndex: unitIdx })
        const qs = resp?.pack?.questions
        if (Array.isArray(qs) && qs.length > 0) {
          onStartSession({
            questions: qs,
            unitIndex: unitIdx,
            language: 'python',
            difficulty: 3,
          })
        } else {
          setError(`单元 ${unitIdx + 1} 的训练题尚未生成完毕，请稍候`)
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      }
    },
    [sessionId, onStartSession],
  )

  // ── v5 (2026-05) B2: 学习↔训练联动 —— URL ?unit=N 自动加载预生成 pack ───
  // 当用户从学习区点「练习本单元 →」按钮跳转过来时，URL 会带 ?unit=N。
  // 我们检测后调 training_get_unit_pack 拿已 ready 的题集，命中则**直接进 session**
  // 跳过启动表单。命中失败（pack 还没生成）→ 回退到原启动表单 + 提示生成中。
  const autoStartConsumedRef = useRef(false)
  useEffect(() => {
    if (autoStartConsumedRef.current) return
    let cancelled = false
    const url = new URL(window.location.href)
    const unitParam = url.searchParams.get('unit')
    if (!unitParam) return
    const ui = Number(unitParam)
    if (!Number.isFinite(ui) || ui < 0) return
    autoStartConsumedRef.current = true
    // 立即清掉 URL 参数避免刷新时重复触发
    url.searchParams.delete('unit')
    window.history.replaceState({}, '', url.toString())

    void (async () => {
      try {
        const resp = await invoke<{
          unit_index: number
          pack: { questions: TrainingQuestion[]; skill_meta?: Record<string, unknown> } | null
          generated_at?: string
        } | null>('training_get_unit_pack', { sessionId, unitIndex: ui })
        if (cancelled) return
        const qs = resp?.pack?.questions
        if (Array.isArray(qs) && qs.length > 0) {
          // 直接进 session（无需 LLM）
          onStartSession({
            questions: qs,
            unitIndex: ui,
            language: 'python',
            difficulty: 3,
          })
        } else {
          // 还没 ready → 仅在表单里预选这个 unit
          setUnitIndex(ui)
          setError('该单元的训练题还在生成中，请稍候或手动启动')
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e))
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [sessionId, onStartSession])

  const toggleType = useCallback((t: TrainingType) => {
    setTypes((cur) => {
      if (cur.includes(t)) {
        // 至少保留 1 个
        if (cur.length === 1) return cur
        return cur.filter((x) => x !== t)
      }
      return [...cur, t]
    })
  }, [])

  // ── 启动训练：调 LLM 生成题集 → 进 session 视图 ─────────────────
  const startTraining = useCallback(async () => {
    if (generating) return
    setGenerating(true)
    setError('')
    try {
      // v4 (2026-05) P3.3 命题源优先级：entryId > 多单元 > 单单元
      const callArgs: Record<string, unknown> = {
        sessionId,
        types,
        count,
        difficulty,
        language,
      }
      if (entryId.trim()) {
        callArgs.entryId = entryId.trim()
      } else if (mixUnits.size > 0) {
        // 主选 unit + 额外混合单元一起去重
        const set = new Set<number>(mixUnits)
        if (unitIndex !== null) set.add(unitIndex)
        callArgs.unitIndexes = Array.from(set).sort((a, b) => a - b)
      } else {
        callArgs.unitIndex = unitIndex
      }
      const resp = await invoke<{
        questions: TrainingQuestion[]
        count: number
        unit_index: number | null
        language: string
        difficulty: number
      }>('training_generate_pack', callArgs)
      if (!Array.isArray(resp.questions) || resp.questions.length === 0) {
        throw new Error('LLM 未生成有效题集')
      }
      onStartSession({
        questions: resp.questions,
        unitIndex: unitIndex,
        language,
        difficulty,
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setGenerating(false)
    }
  }, [
    generating,
    sessionId,
    unitIndex,
    mixUnits,
    entryId,
    types,
    count,
    difficulty,
    language,
    onStartSession,
  ])

  const toggleMixUnit = useCallback(
    (idx: number) => {
      setMixUnits((cur) => {
        const next = new Set(cur)
        if (next.has(idx)) next.delete(idx)
        else next.add(idx)
        return next
      })
    },
    [],
  )

  const includesCode = types.includes('code') || types.includes('debug')

  // v5 (2026-05) B1：段位计算统一到 theme.ts::computeUserTier（与 HomePage 共用一套阈值）
  const tier = computeUserTier(overview?.summary.avg_mastery ?? 0)

  return (
    <div className="flex h-full flex-col overflow-y-auto bg-bg">
      {/* ╔═══ 顶部 hero：大标题 + 段位徽章 ═══╗ */}
      <header className="relative border-b border-border-1 bg-bg-1 px-5 pt-5 pb-4">
        {/* 装饰背景：左上角一点颜色渐变点缀，不抢眼 */}
        <div className="pointer-events-none absolute inset-x-0 top-0 h-32 bg-[radial-gradient(ellipse_at_top_left,rgba(59,130,246,0.10),transparent_60%)]" />
        <div className="relative">
          <div className="mb-1 flex items-center gap-2">
            <div className="flex size-9 items-center justify-center rounded-xl bg-blue-500/12 ring-1 ring-blue-500/20">
              <Dumbbell className="size-5 text-blue-500" />
            </div>
            <div className="flex-1">
              <h1 className="flex items-center gap-2 text-[18px] font-bold leading-tight text-text-1">
                训练中心
                <span className="rounded-md bg-blue-500/12 px-1.5 py-0.5 text-[10px] font-medium text-blue-600 dark:text-blue-300">
                  SE 定制
                </span>
              </h1>
              <p className="text-[11.5px] text-text-3">创造属于你的学习路径 · 技能逐步点亮</p>
            </div>
            <button
              type="button"
              onClick={onRefresh}
              title="刷新数据"
              className="rounded-md p-1.5 text-text-3 transition hover:bg-bg-2/80 hover:text-text-1"
            >
              <Sparkles className="size-3.5" />
            </button>
          </div>

          {/* 段位卡：当前段位 + 进度条 —— 能看到“还需多少掌握度升下一级” */}
          {overview && (
            <div className="mt-3 flex items-center gap-3 rounded-lg border border-border-2 bg-bg-1 px-3 py-2.5">
              <div className={cn('flex size-9 items-center justify-center rounded-lg ring-1', tier.bgClass, tier.ringClass)}>
                <GraduationCap className={cn('size-4', tier.iconClass)} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-1.5">
                  <span className={cn('text-[13px] font-bold', tier.iconClass)}>{tier.label}</span>
                  <span className="text-[10px] text-text-3">Lv.{tier.level} · 平均掌握 {masteryPct(overview.summary.avg_mastery)}%</span>
                </div>
                <div className="mt-1 h-1 overflow-hidden rounded-full bg-bg-2/60">
                  <div
                    className={cn('h-full transition-all duration-700', tier.barClass)}
                    style={{ width: `${Math.min(100, overview.summary.avg_mastery * 100)}%` }}
                  />
                </div>
              </div>
              <span className="text-[10px] text-text-3">{tier.nextHint}</span>
            </div>
          )}
        </div>

        {/* 总览四宫格：重设计为左图标 + 右块数字 */}
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <StatCard
            label="技能解锁"
            value={overview ? `${overview.summary.unlocked_skills}` : '-'}
            sub={overview ? `共 ${overview.summary.total_skills}` : undefined}
            tone="emerald"
            icon={<Trees className="size-4" />}
          />
          <StatCard
            label="掌握度"
            value={overview ? `${masteryPct(overview.summary.avg_mastery)}%` : '-'}
            tone="blue"
            icon={<Target className="size-4" />}
          />
          <StatCard
            label="累计答题"
            value={stats ? `${stats.total_attempts}` : '-'}
            tone="purple"
            icon={<BarChart3 className="size-4" />}
          />
          <StatCard
            label="准确率"
            value={stats && stats.total_attempts > 0 ? `${Math.round(stats.accuracy * 100)}%` : '-'}
            sub={stats && stats.total_attempts > 0 ? `${stats.total_correct}/${stats.total_attempts}` : undefined}
            tone="amber"
            icon={<Zap className="size-4" />}
          />
        </div>
      </header>

      {/* ╔═══ 主体：启动训练【分 3 步骤】 + 入口卡 ═══╗ */}
      <div className="space-y-4 px-5 py-4">
        {/* v6 (2026-05) #3++ 「已生成训练直达」—— 用户从学习区跳过来后无需再走 3 步表单 */}
        {units.some((u) => u.packReady) && (
          <section className="overflow-hidden rounded-xl border border-emerald-500/30 bg-gradient-to-br from-emerald-500/[0.06] to-transparent">
            <div className="flex items-center gap-2 border-b border-emerald-500/20 bg-emerald-500/[0.04] px-4 py-2.5">
              <Zap className="size-3.5 text-emerald-500" />
              <h2 className="text-[13px] font-bold text-text-1">已生成单元训练 · 直达</h2>
              <span className="ml-auto text-[10.5px] text-text-3">
                共 {units.filter((u) => u.packReady).length} 个单元 · 点击立即开始
              </span>
            </div>
            <div className="grid grid-cols-1 gap-1.5 p-3 sm:grid-cols-2">
              {units
                .filter((u) => u.packReady)
                .map((u) => (
                  <button
                    key={u.index}
                    type="button"
                    onClick={() => void jumpToUnitPack(u.index)}
                    className="group flex items-center gap-2.5 rounded-lg border border-border-1 bg-bg-1 px-3 py-2 text-left transition hover:border-emerald-500/40 hover:bg-emerald-500/[0.04]"
                  >
                    <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-emerald-500/12 font-mono text-[11.5px] font-bold text-emerald-600 dark:text-emerald-400">
                      U{u.index + 1}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12px] font-medium text-text-1">{u.title}</span>
                      <span className="block text-[10.5px] text-text-3">{u.packSize} 道题 · 已就绪</span>
                    </span>
                    <ArrowRight className="size-3.5 shrink-0 text-emerald-500/60 transition group-hover:translate-x-0.5 group-hover:text-emerald-500" />
                  </button>
                ))}
            </div>
          </section>
        )}

        {/* 启动训练总卡 */}
        <section className="overflow-hidden rounded-xl border border-border-1 bg-bg-1">
          <div className="border-b border-border-1 bg-bg-2/40 px-4 py-2.5">
            <h2 className="flex items-center gap-2 text-[13px] font-bold text-text-1">
              <Sparkles className="size-3.5 text-blue-500" />
              定制一组训练
              <span className="ml-auto text-[10.5px] font-normal text-text-3">3 步完成</span>
            </h2>
          </div>

          <div className="divide-y divide-border-1">
            {/* ╈╈╈ ① 命题素材 ╈╈╈ */}
            <Step number="1" title="命题素材" hint="选择题目从哪里生成">
              {units.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border-2 bg-bg-2/30 px-3 py-3 text-center text-[11.5px] text-text-3">
                  还没有学习路线图。可选“基于全文”先试试，或去「学习」面板生成路线。
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-1.5">
                  <UnitOptionRow
                    selected={unitIndex === null}
                    onClick={() => setUnitIndex(null)}
                    title="📚 基于全文（路线图概要）"
                    desc="从整本书的 thesis + 单元概要出题，覆盖广度大"
                    ready
                  />
                  {units.map((u) => (
                    <UnitOptionRow
                      key={u.index}
                      selected={unitIndex === u.index}
                      onClick={() => setUnitIndex(u.index)}
                      title={`单元 ${u.index + 1} · ${u.title}`}
                      desc={u.hasTeachPack ? '已学过，可基于讲解精准出题' : '未学过；建议先去学习面板完成讲解'}
                      ready={u.hasTeachPack}
                    />
                  ))}
                </div>
              )}

              {/* v4 (2026-05) P3.3 多单元混合：可选额外几个单元一起命题 */}
              {units.filter((u) => u.hasTeachPack).length >= 2 && (
                <div className="mt-3 rounded-lg border border-dashed border-border-2 bg-bg-2/20 px-3 py-2">
                  <div className="mb-1.5 flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-text-3">
                    <Shuffle className="size-3" />
                    可选：混入其他单元一起命题
                    {mixUnits.size > 0 && (
                      <span className="ml-auto rounded bg-purple-500/15 px-1.5 py-0.5 font-mono text-[10px] text-purple-600 dark:text-purple-400">
                        已选 {mixUnits.size}
                      </span>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {units
                      .filter((u) => u.hasTeachPack && u.index !== unitIndex)
                      .map((u) => {
                        const on = mixUnits.has(u.index)
                        return (
                          <button
                            key={u.index}
                            type="button"
                            onClick={() => toggleMixUnit(u.index)}
                            className={cn(
                              'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] transition',
                              on
                                ? 'border-purple-500/50 bg-purple-500/12 text-purple-600 dark:text-purple-400'
                                : 'border-border-2 bg-bg-2/40 text-text-3 hover:border-border-1 hover:text-text-2',
                            )}
                          >
                            {on && <Check className="size-2.5" strokeWidth={3} />}
                            单元 {u.index + 1}
                          </button>
                        )
                      })}
                  </div>
                </div>
              )}

              {/* v4 (2026-05) P3.3 笔记本条目命题入口（高优先级覆盖 unit 选择）*/}
              <div className="mt-2 rounded-lg border border-dashed border-border-2 bg-bg-2/20 px-3 py-2">
                <label className="mb-1 flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-text-3">
                  <BookOpen className="size-3" />
                  或：基于笔记本条目命题（选填 entry_id）
                </label>
                <input
                  type="text"
                  value={entryId}
                  onChange={(e) => setEntryId(e.target.value)}
                  placeholder="entry_xxxxxxxx（在笔记本中复制 ID）"
                  className="w-full rounded-md border border-border-2 bg-bg-2/40 px-2 py-1 font-mono text-[11px] text-text-1 placeholder:text-text-3 focus:border-blue-500/50 focus:outline-none"
                />
                {entryId.trim() && (
                  <div className="mt-1 text-[10.5px] text-amber-600 dark:text-amber-400">
                    将基于该笔记本条目命题（忽略上方单元选择）
                  </div>
                )}
              </div>
            </Step>

            {/* ╈╈╈ ② 题型组合 ╈╈╈ */}
            <Step
              number="2"
              title="题型组合"
              hint={`已选 ${types.length} 个题型·点击切换`}
            >
              <div className="grid grid-cols-3 gap-2">
                {ALL_TYPES.map((t) => {
                  const Icon = TYPE_ICONS[t]
                  const c = TYPE_COLORS[t]
                  const active = types.includes(t)
                  return (
                    <button
                      key={t}
                      type="button"
                      onClick={() => toggleType(t)}
                      className={cn(
                        'group relative flex flex-col items-center gap-1 rounded-lg border px-2 py-2.5 transition',
                        active
                          ? cn(c.border, c.bg, 'shadow-sm')
                          : 'border-border-2 bg-bg-2/20 hover:border-border-1 hover:bg-bg-2/40',
                      )}
                    >
                      <div
                        className={cn(
                          'flex size-7 items-center justify-center rounded-md transition',
                          active
                            ? cn(c.iconBg, c.iconText)
                            : 'bg-bg-2/60 text-text-3 group-hover:text-text-2',
                        )}
                      >
                        <Icon className="size-3.5" />
                      </div>
                      <span
                        className={cn(
                          'text-[11px] font-medium transition',
                          active ? 'text-text-1' : 'text-text-3 group-hover:text-text-2',
                        )}
                      >
                        {TYPE_LABELS[t]}
                      </span>
                      {active && (
                        <span className={cn('absolute right-1 top-1 size-1.5 rounded-full', c.dot)} />
                      )}
                    </button>
                  )
                })}
              </div>
            </Step>

            {/* ╈╈╈ ③ 训练参数 ╈╈╈ */}
            <Step number="3" title="训练参数" hint="调整题数·难度·语言">
              <div className="space-y-3">
                {/* 题数 slider */}
                <div>
                  <div className="mb-1.5 flex items-center justify-between text-[11px]">
                    <span className="font-medium text-text-2">题数</span>
                    <span className="font-mono text-[12.5px] font-bold text-text-1 tabular-nums">{count} 道</span>
                  </div>
                  <div className="relative">
                    <input
                      type="range"
                      min={1}
                      max={12}
                      value={count}
                      onChange={(e) => setCount(Number(e.target.value))}
                      className="w-full accent-blue-500"
                    />
                    <div className="mt-0.5 flex justify-between text-[9px] text-text-3">
                      <span>1</span><span>3</span><span>6</span><span>9</span><span>12</span>
                    </div>
                  </div>
                </div>

                {/* 难度 —— 五颗星 */}
                <div>
                  <div className="mb-1.5 flex items-center justify-between text-[11px]">
                    <span className="font-medium text-text-2">难度</span>
                    <span className="text-[10.5px] text-text-3">
                      <span className="font-mono font-bold text-text-1">{DIFFICULTY_LABELS[difficulty]}</span>
                      <span className="ml-1.5">{DIFFICULTY_DESC[difficulty]}</span>
                    </span>
                  </div>
                  <div className="flex gap-1">
                    {[1, 2, 3, 4, 5].map((d) => (
                      <button
                        key={d}
                        type="button"
                        onClick={() => setDifficulty(d)}
                        className={cn(
                          'flex-1 rounded-md border py-1.5 transition',
                          d <= difficulty
                            ? 'border-amber-500/40 bg-amber-500/12'
                            : 'border-border-2 bg-bg-2/20 hover:border-border-1',
                        )}
                        title={`难度 ${d} · ${DIFFICULTY_LABELS[d]}`}
                      >
                        <Star
                          className={cn(
                            'mx-auto size-3.5',
                            d <= difficulty
                              ? 'fill-amber-500 text-amber-500'
                              : 'text-text-3',
                          )}
                        />
                      </button>
                    ))}
                  </div>
                </div>

                {/* 代码题语言 */}
                <div>
                  <div className="mb-1.5 flex items-center justify-between text-[11px]">
                    <span className="font-medium text-text-2">代码题语言</span>
                    {!includesCode && <span className="text-[10px] text-text-3">未选代码题 · 此选项隐藏作用</span>}
                  </div>
                  <select
                    value={language}
                    onChange={(e) => setLanguage(e.target.value as SupportedLanguage)}
                    disabled={!includesCode}
                    className={cn(
                      'w-full rounded-md border bg-bg-2/30 px-2.5 py-1.5 text-[12.5px] focus:outline-none',
                      includesCode
                        ? 'border-border-2 text-text-1 focus:border-blue-500'
                        : 'cursor-not-allowed border-border-2/50 text-text-3',
                    )}
                  >
                    {SUPPORTED_LANGUAGES.map((l) => (
                      <option key={l.value} value={l.value}>
                        {l.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </Step>
          </div>

          {/* 错误提示 + 主 CTA */}
          <div className="border-t border-border-1 bg-bg-2/20 p-3">
            {error && (
              <div className="mb-2 flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/8 px-3 py-2 text-[11.5px] text-red-600 dark:text-red-400">
                <span className="mt-0.5 inline-block size-1.5 shrink-0 rounded-full bg-red-500" />
                <span>{error}</span>
              </div>
            )}
            <button
              type="button"
              onClick={startTraining}
              disabled={generating || types.length === 0}
              className={cn(
                'group inline-flex w-full items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-[13px] font-semibold transition',
                generating || types.length === 0
                  ? 'cursor-not-allowed bg-bg-2/60 text-text-3'
                  : 'bg-blue-500 text-white shadow-sm shadow-blue-500/25 hover:bg-blue-600 hover:shadow-md hover:shadow-blue-500/30 active:scale-[0.99]',
              )}
            >
              {generating ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  LLM 生成 {count} 道 {DIFFICULTY_LABELS[difficulty]} 题中…
                </>
              ) : (
                <>
                  <Sparkles className="size-4" />
                  开始训练
                  <span className="text-[11.5px] font-normal opacity-90">{count} 道 · {DIFFICULTY_LABELS[difficulty]}</span>
                  <ArrowRight className="size-4 transition group-hover:translate-x-0.5" />
                </>
              )}
            </button>
          </div>
        </section>

        {/* ╔══ 入口卡：技能树 / 历史 ══╗ */}
        <section className="grid grid-cols-2 gap-3">
          <EntryCard
            icon={<Trees className="size-5" />}
            title="技能树"
            tone="emerald"
            desc={
              overview
                ? `${overview.summary.unlocked_skills}/${overview.summary.total_skills} 已解锁`
                : '加载中…'
            }
            sub={overview ? `平均 ${masteryPct(overview.summary.avg_mastery)}%` : ''}
            onClick={onOpenSkillTree}
          />
          <EntryCard
            icon={<History className="size-5" />}
            title="训练历史"
            tone="purple"
            desc={historyCount > 0 ? `${historyCount} 条记录` : '还没有训练记录'}
            sub={stats && stats.total_attempts > 0 ? `准确率 ${Math.round(stats.accuracy * 100)}%` : ''}
            onClick={onOpenHistory}
          />
        </section>

        {/* 底部提示 */}
        <div className="flex items-start gap-2 rounded-lg border border-border-2 bg-bg-2/30 px-3 py-2.5">
          <Code2 className="mt-0.5 size-3.5 shrink-0 text-blue-500/70" />
          <div className="text-[11px] leading-relaxed text-text-3">
            训练板块独立运作 —— 不会影响「学习」面板进度。代码题使用
            <span className="mx-1 rounded bg-bg px-1 py-0.5 font-mono text-[10px] text-text-2">Piston / emkc.org</span>
            公共节点真实运行，支持 60+ 语言。
          </div>
        </div>
      </div>
    </div>
  )
}

// 步骤包装器：左侧编号 + 右侧内容
function Step({
  number,
  title,
  hint,
  children,
}: {
  number: string
  title: string
  hint: string
  children: React.ReactNode
}) {
  return (
    <div className="px-4 py-3">
      <div className="mb-2.5 flex items-center gap-2">
        <span className="flex size-5 items-center justify-center rounded-full bg-blue-500/12 text-[10px] font-bold text-blue-600 dark:text-blue-300">
          {number}
        </span>
        <h3 className="text-[12.5px] font-bold text-text-1">{title}</h3>
        <span className="ml-auto text-[10px] text-text-3">{hint}</span>
      </div>
      {children}
    </div>
  )
}

/** 单元选项行：抽屉抽屉隐接，选中时左侧藍色点亮调 */
function UnitOptionRow({
  selected,
  onClick,
  title,
  desc,
  ready,
}: {
  selected: boolean
  onClick: () => void
  title: string
  desc: string
  ready: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'group flex items-center gap-2.5 rounded-lg border px-3 py-2 text-left transition',
        selected
          ? 'border-blue-500/50 bg-blue-500/[0.06] shadow-sm shadow-blue-500/10'
          : 'border-border-2 bg-bg-1 hover:border-border-1 hover:bg-bg-2/40',
      )}
    >
      <div
        className={cn(
          'flex size-4 shrink-0 items-center justify-center rounded-full border-2 transition',
          selected
            ? 'border-blue-500 bg-blue-500'
            : 'border-border-1 bg-bg-1 group-hover:border-text-3',
        )}
      >
        {selected && <Check className="size-2.5 text-white" strokeWidth={3} />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className={cn('truncate text-[12px] font-medium', selected ? 'text-text-1' : 'text-text-2')}>
            {title}
          </span>
          {ready && (
            <span className="shrink-0 rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-emerald-600 dark:text-emerald-400">
              ready
            </span>
          )}
        </div>
        <div className="mt-0.5 truncate text-[10.5px] text-text-3">{desc}</div>
      </div>
    </button>
  )
}

/** 入口卡：大图标色块 + 主标题 + 辅助信息；hover 后出现颜色边框 */
function EntryCard({
  icon,
  title,
  desc,
  sub,
  tone,
  onClick,
}: {
  icon: React.ReactNode
  title: string
  desc: string
  sub?: string
  tone: 'emerald' | 'purple'
  onClick: () => void
}) {
  const colors = {
    emerald: {
      bg: 'bg-emerald-500/10',
      text: 'text-emerald-600 dark:text-emerald-400',
      hover: 'hover:border-emerald-500/40 hover:bg-emerald-500/[0.04]',
    },
    purple: {
      bg: 'bg-purple-500/10',
      text: 'text-purple-600 dark:text-purple-400',
      hover: 'hover:border-purple-500/40 hover:bg-purple-500/[0.04]',
    },
  }[tone]
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'group flex flex-col gap-2 rounded-xl border border-border-1 bg-bg-1 p-3 text-left transition',
        colors.hover,
      )}
    >
      <div className="flex items-center gap-2">
        <div className={cn('flex size-9 items-center justify-center rounded-lg transition', colors.bg, colors.text)}>
          {icon}
        </div>
        <div className="flex-1">
          <div className="text-[13px] font-bold text-text-1">{title}</div>
          <div className="text-[10.5px] text-text-3">{desc}</div>
        </div>
        <ArrowRight className={cn('size-3.5 text-text-3 transition group-hover:translate-x-0.5', colors.text.replace('text-', 'group-hover:text-'))} />
      </div>
      {sub && (
        <div className="flex items-center gap-1.5 border-t border-border-1/50 pt-2 text-[10px] text-text-3">
          <span className={cn('size-1 rounded-full', colors.bg)} />
          {sub}
        </div>
      )}
    </button>
  )
}
