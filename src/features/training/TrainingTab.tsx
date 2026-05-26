/**
 * 训练 Tab —— 训练板块入口（DESIGN.md §15）。
 *
 * 与"学习 Agent"对应，但定位完全不同：
 *   - 学习（agent）：被动跟着路线图走，讲解 → 小测 → 推进，强调**理解**
 *   - 训练（training）：主动选题型 + 难度 + 单元，刷题 → 评分 → 技能树成长，强调**熟练**
 *
 * 内部三页（用本地 state 切换，不走 react-router）：
 *   1. home：训练首页（开始训练 / 历史 / 技能树概览）
 *   2. session：训练会话（题目列表 + 答题 + 代码运行 + 提交评分）
 *   3. skill-tree：技能树独立大图（可视化 35 个技能 × 进度）
 *
 * 数据流：
 *   - 题目通过 `training_generate_pack` 一次性 LLM 生成（基于已学单元 explanation）
 *   - 代码题通过 `training_code_run` 调 Piston 公共节点真实运行
 *   - 提交后 `training_submit_attempt` LLM 评分 + 写训练记录 + 更新技能掌握度
 *   - 技能树进度通过 `training_skill_overview` 拉取
 */
import { useCallback, useEffect, useState } from 'react'
import { invoke } from '@/lib/tauri'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { TrainingHome } from './TrainingHome'
import { TrainingSession } from './TrainingSession'
import { SkillTreeView } from './SkillTreeView'
import { TrainingHistory } from './TrainingHistory'
import type {
  SkillOverview,
  TrainingAttempt,
  TrainingStats,
  TrainingView,
} from './types'

interface Props {
  sessionId: string
  isActive?: boolean
}

export function TrainingTab({ sessionId, isActive = true }: Props) {
  const [view, setView] = useState<TrainingView>({ kind: 'home' })
  const [overview, setOverview] = useState<SkillOverview | null>(null)
  const [history, setHistory] = useState<TrainingAttempt[]>([])
  const [stats, setStats] = useState<TrainingStats | null>(null)
  const [refreshTick, setRefreshTick] = useState(0)

  // 拉取技能树总览（home / skill-tree 都用）
  const fetchOverview = useCallback(async () => {
    try {
      const r = await invoke<SkillOverview>('training_skill_overview', { sessionId })
      setOverview(r)
    } catch (e) {
      console.error('[Training] skill_overview 失败', e)
    }
  }, [sessionId])

  // 拉取训练历史 + 统计
  const fetchHistory = useCallback(async () => {
    try {
      const r = await invoke<{ attempts: TrainingAttempt[]; stats: TrainingStats }>(
        'training_get_history',
        { sessionId, limit: 50 },
      )
      setHistory(r.attempts ?? [])
      setStats(r.stats ?? null)
    } catch (e) {
      console.error('[Training] get_history 失败', e)
    }
  }, [sessionId])

  // 首次进入 + 提交答题后刷新
  useEffect(() => {
    if (!isActive) return
    void fetchOverview()
    void fetchHistory()
  }, [isActive, fetchOverview, fetchHistory, refreshTick])

  // v7 (2026-05) 档案管理鲁棒性：监听 agent-archive-changed
  //   - reason="restored" : 学习单元内容全部变了，正在做的 session 题目已过期 →
  //                          强制回到 home 视图（避免用户继续答错位的题）
  //   - 其他 reason     : 只刷新统计/历史
  useEffect(() => {
    let unlisten: UnlistenFn | undefined
    let cancelled = false
    void (async () => {
      const u = await listen<{
        session_id: string
        reason: 'saved' | 'restored' | 'deleted' | 'renamed'
      }>('agent-archive-changed', (ev) => {
        if (ev.payload?.session_id !== sessionId) return
        if (ev.payload.reason === 'restored') {
          setView({ kind: 'home' })
        }
        // 触发 home 重新拉数据（unit 列表 + 训练 pack 状态 + 技能 + 历史）
        setRefreshTick((t) => t + 1)
      })
      if (cancelled) u()
      else unlisten = u
    })()
    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [sessionId])

  // 一次提交完成后调用：触发数据刷新
  const onAttemptSubmitted = useCallback(() => {
    setRefreshTick((t) => t + 1)
  }, [])

  return (
    <div className="flex h-full flex-col bg-bg overflow-hidden">
      {view.kind === 'home' && (
        <TrainingHome
          sessionId={sessionId}
          overview={overview}
          stats={stats}
          historyCount={history.length}
          onStartSession={(payload) => setView({ kind: 'session', ...payload })}
          onOpenSkillTree={() => setView({ kind: 'skill-tree' })}
          onOpenHistory={() => setView({ kind: 'history' })}
          onRefresh={() => {
            void fetchOverview()
            void fetchHistory()
          }}
        />
      )}
      {view.kind === 'session' && (
        <TrainingSession
          sessionId={sessionId}
          questions={view.questions}
          unitIndex={view.unitIndex}
          language={view.language}
          difficulty={view.difficulty}
          onExit={() => setView({ kind: 'home' })}
          onAttemptSubmitted={onAttemptSubmitted}
        />
      )}
      {view.kind === 'skill-tree' && (
        <SkillTreeView
          overview={overview}
          onBack={() => setView({ kind: 'home' })}
          onRefresh={() => void fetchOverview()}
        />
      )}
      {view.kind === 'history' && (
        <TrainingHistory
          attempts={history}
          stats={stats}
          onBack={() => setView({ kind: 'home' })}
        />
      )}
    </div>
  )
}
