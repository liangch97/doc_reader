/**
 * TrainingPage — 训练顶层入口（v4 2026-05 P5.1）
 *
 * 用户决策：训练板块"A 双入口" — 顶层 /training + 阅读器右栏 TrainingTab 都保留。
 *
 * 本页面作用：
 *   - 列出所有已有 doc_session（即可基于其讲解命题）的资料
 *   - 点击某资料 → 跳到 reader/<id>?pane=training 直接打开右栏训练 tab
 *   - 同时显示底部"管理技能字典"链接 → /skills
 *
 * 实际答题界面继续走右栏 TrainingTab（共用 sessionId 上下文，避免双实现分裂）。
 */
import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ArrowRight, BarChart3, Dumbbell, Library, Loader2, Sparkles, Target } from 'lucide-react'
import { resourcesApi } from '@/lib/api'
import { invoke } from '@/lib/tauri'
import type { Resource } from '@/types/resource'
import { cn } from '@/lib/cn'
import { computeUserTier, masteryPct } from '@/features/training/theme'
import { StatCard } from '@/features/training/StatCard'

interface UserSkill {
  skill_id: string
  name: string
  category: string
  description: string
  avg_mastery: number
  sessions_count: number
  total_attempts: number
}

export default function TrainingPage() {
  const navigate = useNavigate()
  const [resources, setResources] = useState<Resource[]>([])
  const [skills, setSkills] = useState<UserSkill[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    void (async () => {
      setLoading(true)
      try {
        const [list, sk] = await Promise.all([
          resourcesApi.list(),
          invoke<UserSkill[]>('skills_list').catch(() => []),
        ])
        if (cancelled) return
        // 仅保留有 doc_session 的（其它资源无法命题）
        setResources((list ?? []).filter((r) => !!r.doc_session_id))
        setSkills(sk ?? [])
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const totalAttempts = skills.reduce((s, x) => s + x.total_attempts, 0)
  const avgMastery =
    skills.length > 0 ? skills.reduce((s, x) => s + x.avg_mastery, 0) / skills.length : 0
  const tier = computeUserTier(avgMastery)
  const unlockedCount = skills.filter((s) => s.total_attempts > 0).length

  return (
    <div className="flex h-full flex-col overflow-y-auto bg-bg">
      {/* ╔═══ 顶部 hero ═══╗ */}
      <header className="relative shrink-0 border-b border-border-1 bg-bg-1 px-6 pt-5 pb-4">
        <div className="pointer-events-none absolute inset-x-0 top-0 h-32 bg-[radial-gradient(ellipse_at_top_left,rgba(16,185,129,0.10),transparent_60%)]" />
        <div className="relative flex items-start justify-between gap-4">
          <div className="flex items-center gap-2">
            <div className={cn('flex size-9 items-center justify-center rounded-xl ring-1', tier.bgClass, tier.ringClass)}>
              <Dumbbell className={cn('size-4', tier.iconClass)} />
            </div>
            <div>
              <h1 className="text-[17px] font-bold leading-tight text-text-1">训练中心</h1>
              <p className="mt-0.5 text-[11.5px] text-text-3">
                选份资料开始训练 · 题目自动基于单元讲解生成
              </p>
            </div>
          </div>
          <Link
            to="/skills"
            className="inline-flex items-center gap-1 rounded-md border border-border-1 bg-bg-1 px-2.5 py-1.5 text-[12px] text-text-2 hover:bg-bg-2/60"
          >
            <Sparkles className="size-3 text-blue-500" />
            技能树管理
            <ArrowRight className="size-3" />
          </Link>
        </div>

        {/* 统一 StatCard（与 HomePage / TrainingHome 一致） */}
        {skills.length > 0 && (
          <div className="relative mt-3 grid grid-cols-3 gap-2">
            <StatCard
              icon={<Target className="size-3.5" />}
              label="平均掌握度"
              value={`${masteryPct(avgMastery)}%`}
              sub={tier.label}
              tone="blue"
              compact
            />
            <StatCard
              icon={<Sparkles className="size-3.5" />}
              label="已解锁技能"
              value={`${unlockedCount}`}
              sub={`/ ${skills.length}`}
              tone="emerald"
              compact
            />
            <StatCard
              icon={<BarChart3 className="size-3.5" />}
              label="累计答题"
              value={`${totalAttempts}`}
              tone="purple"
              compact
            />
          </div>
        )}
      </header>

      {error && (
        <div className="shrink-0 border-b border-border-1 bg-rose-500/10 px-6 py-2 text-[12px] text-rose-600 dark:text-rose-400">
          {error}
        </div>
      )}

      {/* ╔═══ 主体：资料列表（点击 → 进右栏训练） ═══╗ */}
      <section className="space-y-3 px-6 py-4">
        <h2 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-text-3">
          <Library className="size-3" />
          选择资料开始训练
        </h2>

        {loading ? (
          <div className="flex items-center gap-2 px-3 py-6 text-[12px] text-text-3">
            <Loader2 className="size-3 animate-spin" /> 加载中…
          </div>
        ) : resources.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border-2 bg-bg-2/30 px-4 py-8 text-center text-[12px] text-text-3">
            还没有可训练的资料。先到「
            <Link to="/library" className="text-accent hover:underline">
              图书馆
            </Link>
            」导入一份 PDF / DOCX，让学习 Agent 生成讲解后即可来训练。
          </div>
        ) : (
          <div
            className="grid gap-3"
            style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}
          >
            {resources.map((r) => (
              <button
                key={r.resource_id}
                type="button"
                onClick={() => navigate(`/reader/${r.resource_id}?pane=training`)}
                className={cn(
                  'group flex flex-col items-start gap-1 rounded-lg border border-border-1 bg-bg-1 px-3 py-2.5 text-left transition',
                  'hover:border-emerald-500/40 hover:bg-emerald-500/[0.04] hover:shadow-sm',
                )}
              >
                <div className="flex w-full items-center gap-2">
                  <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
                    <Dumbbell className="size-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium text-text-1">{r.title}</div>
                    <div className="text-[10.5px] text-text-3">
                      {r.kind?.toUpperCase()} · {r.page_count} 页
                    </div>
                  </div>
                  <ArrowRight className="size-3 text-text-3 transition group-hover:translate-x-0.5 group-hover:text-emerald-500" />
                </div>
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
