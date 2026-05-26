import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Plus, ArrowRight, Hand, Dumbbell, Sparkles, Trophy } from 'lucide-react'
import { resourcesApi, progressApi, coursesApi } from '@/lib/api'
import { invoke } from '@/lib/tauri'
import type { Resource } from '@/types/resource'
import type { Course } from '@/types/course'
import { ResourceCard } from '@/features/library/ResourceCard'
import { CourseCard } from '@/features/courses/CourseCard'
import { ImportDialog } from '@/features/library/ImportDialog'
import { cn } from '@/lib/cn'
import { computeUserTier, masteryBarClass, masteryPct } from '@/features/training/theme'
import { StatCard } from '@/features/training/StatCard'

// v4 (2026-05) P4.2 训练进度卡：从全局 user_skills 聚合
interface UserSkill {
  skill_id: string
  name: string
  category: string
  description: string
  avg_mastery: number
  sessions_count: number
  total_attempts: number
}

export default function HomePage() {
  const [recent, setRecent] = useState<Resource[]>([])
  const [progressMap, setProgressMap] = useState<Record<string, number>>({})
  const [lastReadMap, setLastReadMap] = useState<Record<string, string>>({})
  const [courses, setCourses] = useState<Course[]>([])
  const [importOpen, setImportOpen] = useState(false)
  // v4 (2026-05) P4.2
  const [skills, setSkills] = useState<UserSkill[]>([])

  const reload = async () => {
    try {
      const [list, cs] = await Promise.all([
        resourcesApi.list({ limit: 50 }),
        coursesApi.list(false),
      ])
      const entries = await Promise.all(
        list.map(async (r) => {
          try {
            const p = await progressApi.get(r.resource_id)
            return [r.resource_id, p] as const
          } catch {
            return [r.resource_id, null] as const
          }
        })
      )
      const pm: Record<string, number> = {}
      const lm: Record<string, string> = {}
      for (const [id, p] of entries) {
        pm[id] = p?.percent ?? 0
        if (p?.last_read_at) lm[id] = p.last_read_at
      }
      setProgressMap(pm)
      setLastReadMap(lm)
      // 按 last_read_at 降序；无进度的资料排到最后
      const sorted = [...list].sort((a, b) => {
        const la = lm[a.resource_id]
        const lb = lm[b.resource_id]
        if (la && lb) return lb.localeCompare(la)
        if (la) return -1
        if (lb) return 1
        return b.created_at.localeCompare(a.created_at)
      })
      setRecent(sorted.slice(0, 8))
      setCourses(cs.slice(0, 4))
      // v4 (2026-05) P4.2 拉 user_skills（全局，session 无关）
      try {
        const sk = await invoke<UserSkill[]>('skills_list')
        setSkills(sk ?? [])
      } catch (e) {
        console.warn('[HomePage] skills_list 失败', e)
      }
    } catch (e) {
      console.error(e)
    }
  }

  useEffect(() => {
    reload()
    // 全局拖拽导入后会派发此事件，让首页"最近阅读"区自动刷新
    const onChanged = () => reload()
    window.addEventListener('doc-reader:resources-changed', onChanged)
    return () => window.removeEventListener('doc-reader:resources-changed', onChanged)
  }, [])

  const today = new Date().toISOString().slice(0, 10)
  const totalReadCount = Object.keys(lastReadMap).length

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <header className="flex items-end justify-between px-4 py-5 sm:px-8 sm:py-6">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold text-text-1">
            你好 <Hand className="h-6 w-6 text-accent" strokeWidth={1.6} />
          </h1>
          <p className="mt-1 text-xs text-text-3">
            {today} · 已开始阅读 {totalReadCount} 份资料
          </p>
        </div>
        <button
          type="button"
          onClick={() => setImportOpen(true)}
          className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-2"
        >
          <Plus className="h-3.5 w-3.5" /> 导入资料
        </button>
      </header>

      <Section
        title="继续阅读"
        empty={recent.length === 0 ? '导入资料后会在这里显示' : undefined}
        more={
          recent.length > 0 ? (
            <Link to="/library" className="flex items-center gap-1 text-xs text-text-3 hover:text-accent">
              全部 <ArrowRight className="h-3 w-3" />
            </Link>
          ) : null
        }
      >
        <div className="flex gap-4 overflow-x-auto pb-2">
          {recent.map((r) => (
            <ResourceCard key={r.resource_id} resource={r} progress={progressMap[r.resource_id]} />
          ))}
        </div>
      </Section>

      <Section
        title="我的课程"
        empty={courses.length === 0 ? '在「课程」页创建第一门课' : undefined}
        more={
          <Link to="/courses" className="flex items-center gap-1 text-xs text-text-3 hover:text-accent">
            全部 <ArrowRight className="h-3 w-3" />
          </Link>
        }
      >
        <div className="grid gap-5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}>
          {courses.map((c) => (
            <CourseCard key={c.course_id} course={c} />
          ))}
        </div>
      </Section>

      <TrainingSection skills={skills} />

      <ImportDialog open={importOpen} onClose={() => setImportOpen(false)} onImported={reload} />
    </div>
  )
}

// ─── v5 (2026-05) B4: 训练区合并为单一 Section ────────────────────────────
// 之前 HomePage 有两段独立 Section（训练进度 + 技能树速览），各占一行 4 宫格 + 双列网格，
// 信息密度过高。本次合并为单一 Section：左侧 4 个紧凑统计卡 + 段位条；
// 右侧 top 4 技能进度条。
//
// 用户路径：HomePage → /training（训练首页）/ /skills（技能管理）/ 各资料的右栏训练 tab。

function TrainingSection({ skills }: { skills: UserSkill[] }) {
  const totalSkills = skills.length
  const unlockedSkills = skills.filter((s) => s.total_attempts > 0).length
  const totalAttempts = skills.reduce((sum, s) => sum + s.total_attempts, 0)
  const avgMastery =
    skills.length > 0 ? skills.reduce((sum, s) => sum + s.avg_mastery, 0) / skills.length : 0
  const tier = computeUserTier(avgMastery)
  const top = skills
    .filter((s) => s.total_attempts > 0)
    .sort((a, b) => b.avg_mastery - a.avg_mastery)
    .slice(0, 4)

  return (
    <Section
      title="训练 & 技能"
      empty={totalSkills === 0 ? '完成第一组训练后，进度与技能树会显示在这里。' : undefined}
      more={
        <div className="flex items-center gap-3 text-xs">
          <Link to="/training" className="flex items-center gap-1 text-text-3 hover:text-accent">
            训练 <ArrowRight className="h-3 w-3" />
          </Link>
          <Link to="/skills" className="flex items-center gap-1 text-text-3 hover:text-accent">
            技能管理 <ArrowRight className="h-3 w-3" />
          </Link>
        </div>
      }
    >
      {/* 段位条：单行紧凑显示 */}
      <div className={cn('mb-3 flex items-center gap-3 rounded-lg border border-border-2 bg-bg-1 px-3 py-2.5')}>
        <div className={cn('flex size-9 items-center justify-center rounded-lg ring-1', tier.bgClass, tier.ringClass)}>
          <Trophy className={cn('size-4', tier.iconClass)} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className={cn('text-[14px] font-bold', tier.iconClass)}>{tier.label}</span>
            <span className="text-[11px] text-text-3">Lv.{tier.level} · 平均掌握 {masteryPct(avgMastery)}%</span>
            <span className="ml-auto text-[10px] text-text-3">{tier.nextHint}</span>
          </div>
          <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-bg-2/60">
            <div
              className={cn('h-full transition-all duration-700', tier.barClass)}
              style={{ width: `${Math.min(100, avgMastery * 100)}%` }}
            />
          </div>
        </div>
      </div>

      {/* 主体：3 个紧凑卡（不再单独平均掌握度，已在段位条里） + top 4 技能 */}
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <div className="grid grid-cols-3 gap-2">
          <StatCard
            icon={<Dumbbell className="size-3.5" />}
            label="解锁技能"
            value={`${unlockedSkills}`}
            sub={`/ ${totalSkills}`}
            tone="emerald"
            compact
          />
          <StatCard
            icon={<Sparkles className="size-3.5" />}
            label="累计答题"
            value={`${totalAttempts}`}
            tone="purple"
            compact
          />
          <StatCard
            icon={<ArrowRight className="size-3.5" />}
            label="技能树"
            value={`${totalSkills}`}
            sub="项"
            tone="blue"
            compact
          />
        </div>
        {top.length > 0 && (
          <div className="grid gap-1.5 sm:grid-cols-2">
            {top.map((s) => {
              const pct = masteryPct(s.avg_mastery)
              const barColor = masteryBarClass(s.avg_mastery)
              return (
                <div
                  key={s.skill_id}
                  className="rounded-lg border border-border-1 bg-bg-1 px-2.5 py-1.5"
                >
                  <div className="flex items-center justify-between gap-2 text-[11.5px]">
                    <span className="min-w-0 flex-1 truncate font-medium text-text-1">{s.name}</span>
                    <span className="font-mono text-[10.5px] tabular-nums text-text-3">{pct}%</span>
                  </div>
                  <div className="mt-1 h-1 overflow-hidden rounded-full bg-bg-2/60">
                    <div
                      className={cn('h-full transition-all duration-500', barColor)}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </Section>
  )
}

function Section({
  title,
  children,
  more,
  empty,
}: {
  title: string
  children: React.ReactNode
  more?: React.ReactNode
  empty?: string
}) {
  return (
    <section className="flex flex-col gap-3 px-4 py-4 sm:px-8">
      <header className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-text-2">{title}</h2>
        {more}
      </header>
      {empty ? (
        <div className="rounded-md border border-dashed border-border-1 p-6 text-center text-xs text-text-3">
          {empty}
        </div>
      ) : (
        children
      )}
    </section>
  )
}
