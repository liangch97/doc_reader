/**
 * 训练会话页：题目列表 + 答题 UI + 代码运行 + 提交评分。
 *
 * 设计：左右分栏 —— 左侧题目导航（缩略 + 完成状态），右侧当前题答题区。
 * 6 种题型：
 *   - choice：单选 4 选项
 *   - short：textarea 简答
 *   - code：代码题（代码编辑器 + Run 按钮 → Piston 真实运行 + 测试用例对照）
 *   - debug：buggy 代码题（同 code，但 starter_code 是有 bug 的代码）
 *   - fill：填空题（input）
 *   - sequence：排序题（点击选项加入序列 / 重置）
 *
 * 提交流程：
 *   1. 用户作答 → 点"提交本题" → 走 training_submit_attempt（LLM 评分 + 写 DB）
 *   2. 收到评分 → 显示 score / feedback / missed_points / 参考答案
 *   3. 提交后题目锁定，可"下一题"或"返回首页"
 *   4. 全部完成时显示总结 panel（总分 / 准确率 / 技能升级）
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronDown,
  Code2,
  Languages,
  Loader2,
  Play,
  RefreshCw,
  Send,
  Sparkles,
  Star,
  Terminal,
  TestTube2,
  Trophy,
  X,
} from 'lucide-react'
import { invoke } from '@/lib/tauri'
import { cn } from '@/lib/cn'
import CodeMirror from '@uiw/react-codemirror'
import { python } from '@codemirror/lang-python'
import { javascript } from '@codemirror/lang-javascript'
import { java } from '@codemirror/lang-java'
import { cpp } from '@codemirror/lang-cpp'
import { rust } from '@codemirror/lang-rust'
import { oneDark } from '@codemirror/theme-one-dark'
import type { Extension } from '@codemirror/state'
import {
  SUPPORTED_LANGUAGES,
  TYPE_LABELS,
  type CodeRunResult,
  type GradeResult,
  type SubmitAttemptResp,
  type TrainingQuestion,
} from './types'
import { TYPE_COLORS, TYPE_ICONS } from './theme'
import { MarkdownView } from '@/components/markdown/MarkdownView'

/** v6 (2026-05) #1: 兜底给参考答案加 fence。
 *  代码 / 调试题的参考答案如果裸文本没 ```lang```，自动包一层，让 MarkdownView 高亮。
 *  非代码题原样返回（LLM 写的 markdown 自己生效）。 */
function detectAnswerFence(answer: string, language: string | undefined, type: TrainingQuestion['type']): string {
  if (!answer) return ''
  const isCode = type === 'code' || type === 'debug'
  if (!isCode) return answer
  // 已经含围栏（任何 fence）→ 原样
  if (/^```/m.test(answer)) return answer
  const lang = language ?? 'python'
  return '```' + lang + '\n' + answer.replace(/\s+$/, '') + '\n```'
}

/** 把训练题题面里的 language 字段映射成 CodeMirror 6 的语言扩展。
 *  未知语言降级为 python（最常用），不抛错。 */
function langExtension(lang: string): Extension {
  switch (lang) {
    case 'python':
      return python()
    case 'javascript':
      return javascript()
    case 'typescript':
      return javascript({ typescript: true })
    case 'java':
      return java()
    case 'c':
    case 'cpp':
    case 'c++':
      return cpp()
    case 'rust':
      return rust()
    default:
      return python()
  }
}

// v5 (2026-05) B1: TYPE_TINT 重命名为 TYPE_COLORS、TYPE_ICON 为 TYPE_ICONS，由 ./theme 提供共享定义。
// 为局部使用保持原名，仅做 alias：
const TYPE_TINT = TYPE_COLORS
const TYPE_ICON = TYPE_ICONS

interface Props {
  sessionId: string
  questions: TrainingQuestion[]
  unitIndex: number | null
  language: string
  difficulty: number
  onExit: () => void
  onAttemptSubmitted: () => void
}

interface AttemptState {
  /** 用户答案（按题型不同含义不同：选择=字母、代码=源码、填空=文本、排序=步骤数组 join） */
  userAnswer: string
  /** 代码题：用户跑过的最近一次结果 */
  codeRun?: CodeRunResult
  /** 代码运行 / 提交评分中的 loading 状态 */
  running?: boolean
  submitting?: boolean
  /** 提交后的评分结果 */
  grade?: GradeResult
  submitError?: string
  /** 选择 / 排序题：当前已选选项 */
  selected?: string[]
}

export function TrainingSession({
  sessionId,
  questions: initialQuestions,
  unitIndex,
  language: _language,
  difficulty: _difficulty,
  onExit,
  onAttemptSubmitted,
}: Props) {
  void _language
  void _difficulty
  const [activeIdx, setActiveIdx] = useState(0)
  // v9 (2026-05) 单题语言翻译需要"可变的题目集合"：用户在某道代码题上点
  // 「换语言」时，LLM 翻译完成后就地替换该题。原 props.questions 不变，
  // 这份 localQuestions 仅在本会话内有效，退出后下次进来还是 initialQuestions。
  const [localQuestions, setLocalQuestions] = useState<TrainingQuestion[]>(initialQuestions)
  // 每题翻译中的 loading / 错误状态（按 question id 索引）
  const [translateState, setTranslateState] = useState<
    Record<string, { busy?: boolean; error?: string }>
  >({})
  // 每题独立状态，按 question id 索引
  const [attempts, setAttempts] = useState<Record<string, AttemptState>>(() => {
    const init: Record<string, AttemptState> = {}
    for (const q of initialQuestions) {
      init[q.id] = {
        userAnswer: q.type === 'code' || q.type === 'debug' ? (q.starter_code ?? '') : '',
        selected: [],
      }
    }
    return init
  })

  const activeQ = localQuestions[activeIdx]
  const activeAttempt = activeQ ? attempts[activeQ.id] : undefined

  const updateAttempt = useCallback((qid: string, patch: Partial<AttemptState>) => {
    setAttempts((m) => ({ ...m, [qid]: { ...(m[qid] ?? { userAnswer: '' }), ...patch } }))
  }, [])

  // v9 (2026-05) 单题语言翻译：调 training_translate_question 让 LLM 改写当前题
  // 到目标语言；成功后替换 localQuestions[idx] 并把 attempt.userAnswer 重置为
  // 新 starter_code / 清空 codeRun。
  const translateQuestion = useCallback(
    async (qid: string, targetLanguage: string) => {
      const idx = localQuestions.findIndex((q) => q.id === qid)
      if (idx < 0) return
      const cur = localQuestions[idx]
      if (cur.type !== 'code' && cur.type !== 'debug') return
      const curLang = cur.language ?? 'python'
      if (curLang.toLowerCase() === targetLanguage.toLowerCase()) return
      setTranslateState((m) => ({ ...m, [qid]: { busy: true, error: undefined } }))
      try {
        const newQ = await invoke<TrainingQuestion>('training_translate_question', {
          question: cur,
          targetLanguage,
        })
        setLocalQuestions((qs) => {
          const next = [...qs]
          next[idx] = newQ
          return next
        })
        // 重置 attempt：用新 starter_code 作为初始答案，清掉运行结果与评分
        setAttempts((m) => ({
          ...m,
          [qid]: {
            userAnswer: newQ.starter_code ?? '',
            selected: [],
          },
        }))
        setTranslateState((m) => ({ ...m, [qid]: { busy: false } }))
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        setTranslateState((m) => ({ ...m, [qid]: { busy: false, error: msg } }))
      }
    },
    [localQuestions],
  )

  // ── 代码运行（仅 code/debug 类型）──────────────────────────────
  const runCode = useCallback(
    async (q: TrainingQuestion) => {
      const att = attempts[q.id]
      if (!att || att.running) return
      const lang = q.language ?? 'python'
      // 拼接测试用例：让用户的代码 + 测试驱动一起跑
      // 简单策略：直接用用户代码 + 第一个测试用例的 stdin
      const firstTest = q.tests?.[0]
      const stdin = firstTest?.stdin ?? ''
      updateAttempt(q.id, { running: true })
      try {
        const result = await invoke<CodeRunResult>('training_code_run', {
          language: lang,
          source: att.userAnswer,
          stdin,
        })
        updateAttempt(q.id, { codeRun: result, running: false })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        updateAttempt(q.id, {
          codeRun: {
            success: false,
            stdout: '',
            stderr: `[Piston 调用失败] ${msg}\n（提示：Piston 公共节点可能限速 / 网络问题，可继续提交由 LLM 模拟评分）`,
            exit_code: null,
            time_ms: 0,
            language: lang,
            fallback_used: true,
          },
          running: false,
        })
      }
    },
    [attempts, updateAttempt],
  )

  // ── 提交评分 ──────────────────────────────────────────────────
  const submit = useCallback(
    async (q: TrainingQuestion) => {
      const att = attempts[q.id]
      if (!att || att.submitting || att.grade) return
      // 排序题：把 selected 数组 join 成 " -> " 格式
      let userAnswer = att.userAnswer
      if (q.type === 'sequence') {
        userAnswer = (att.selected ?? []).join(' -> ')
      }
      updateAttempt(q.id, { submitting: true, submitError: undefined })
      try {
        const r = await invoke<SubmitAttemptResp>('training_submit_attempt', {
          sessionId,
          unitIndex,
          question: q,
          userAnswer,
          codeResult: att.codeRun ?? null,
        })
        updateAttempt(q.id, { submitting: false, grade: r.grade })
        onAttemptSubmitted()
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        updateAttempt(q.id, { submitting: false, submitError: msg })
      }
    },
    [attempts, sessionId, unitIndex, updateAttempt, onAttemptSubmitted],
  )

  // ── v4 (2026-05) 全部提交：一次性把所有未判分题打包发后端，单次 LLM 评分 ────
  const submitAll = useCallback(async () => {
    // 找所有未判分 + 未在提交中的题
    const pending = localQuestions
      .map((q) => ({ q, att: attempts[q.id] }))
      .filter(({ att }) => att && !att.grade && !att.submitting)
    if (pending.length === 0) return
    // 全部标 submitting
    setAttempts((m) => {
      const next = { ...m }
      for (const { q } of pending) {
        next[q.id] = { ...(next[q.id] ?? { userAnswer: '' }), submitting: true, submitError: undefined }
      }
      return next
    })
    // 组装 items
    const items = pending.map(({ q, att }) => {
      let userAnswer = att.userAnswer
      if (q.type === 'sequence') {
        userAnswer = (att.selected ?? []).join(' -> ')
      }
      return {
        question: q,
        user_answer: userAnswer,
        code_result: att.codeRun ?? null,
      }
    })
    try {
      const grades = await invoke<SubmitAttemptResp[]>('training_submit_batch', {
        sessionId,
        unitIndex,
        items,
      })
      // 按返回顺序回填
      setAttempts((m) => {
        const next = { ...m }
        pending.forEach(({ q }, i) => {
          const g = grades[i]
          next[q.id] = {
            ...(next[q.id] ?? { userAnswer: '' }),
            submitting: false,
            grade: g?.grade,
            submitError: g?.grade ? undefined : '评分缺失',
          }
        })
        return next
      })
      onAttemptSubmitted()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      // 全部回退到失败态
      setAttempts((m) => {
        const next = { ...m }
        for (const { q } of pending) {
          next[q.id] = {
            ...(next[q.id] ?? { userAnswer: '' }),
            submitting: false,
            submitError: msg,
          }
        }
        return next
      })
    }
  }, [localQuestions, attempts, sessionId, unitIndex, onAttemptSubmitted])

  // 进度统计
  const completed = useMemo(
    () => localQuestions.filter((q) => !!attempts[q.id]?.grade).length,
    [localQuestions, attempts],
  )
  const totalScore = useMemo(
    () =>
      localQuestions.reduce((s, q) => s + (attempts[q.id]?.grade?.score ?? 0), 0),
    [localQuestions, attempts],
  )
  const allDone = completed === localQuestions.length && localQuestions.length > 0

  const correctCount = useMemo(
    () => localQuestions.filter((q) => attempts[q.id]?.grade?.is_correct).length,
    [localQuestions, attempts],
  )
  const progressPct = (completed / Math.max(1, localQuestions.length)) * 100

  return (
    <div className="flex h-full flex-col overflow-hidden bg-bg">
      {/* ╔══ 顶部 nav + 进度条（颜颜一眼看到进度）══╗ */}
      <header className="shrink-0 border-b border-border-1 bg-bg-1">
        <div className="flex items-center justify-between px-4 py-2">
          <button
            type="button"
            onClick={onExit}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11.5px] text-text-2 transition hover:bg-bg-2/80 hover:text-text-1"
          >
            <ArrowLeft className="size-3.5" />
            退出训练
          </button>
          <div className="flex items-center gap-3 text-[11px]">
            <span className="flex items-center gap-1 rounded-md bg-bg-2/60 px-2 py-0.5">
              <span className="text-text-3">进度</span>
              <span className="font-mono font-bold tabular-nums text-text-1">{completed}/{localQuestions.length}</span>
            </span>
            {completed > 0 && (
              <span className="flex items-center gap-1 rounded-md bg-emerald-500/12 px-2 py-0.5">
                <CheckCircle2 className="size-3 text-emerald-500" />
                <span className="font-mono font-bold tabular-nums text-emerald-600 dark:text-emerald-400">{correctCount}</span>
              </span>
            )}
            <span className="flex items-center gap-1 rounded-md bg-blue-500/12 px-2 py-0.5">
              <Trophy className="size-3 text-blue-500" />
              <span className="font-mono font-bold tabular-nums text-blue-600 dark:text-blue-400">{totalScore}</span>
            </span>
            {/* v4 (2026-05) 全部提交：剩余 N 题，一次性批量评分 */}
            {(() => {
              const pendingCount = localQuestions.filter((q) => {
                const a = attempts[q.id]
                return a && !a.grade && !a.submitting
              }).length
              const anySubmitting = localQuestions.some((q) => attempts[q.id]?.submitting)
              if (pendingCount === 0) return null
              return (
                <button
                  type="button"
                  disabled={anySubmitting}
                  onClick={() => void submitAll()}
                  className="inline-flex items-center gap-1 rounded-md bg-blue-500 px-2.5 py-1 text-[11px] font-medium text-white shadow-sm shadow-blue-500/30 transition hover:bg-blue-600 disabled:opacity-60"
                  title="一次性提交所有未判分题，后端按题型分桶后单次 LLM 评分"
                >
                  {anySubmitting ? <Loader2 className="size-3 animate-spin" /> : null}
                  全部提交（{pendingCount}）
                </button>
              )
            })()}
          </div>
        </div>
        {/* 进度条：背景色块 + 底色 */}
        <div className="h-1 overflow-hidden bg-bg-2/60">
          <div
            className={cn(
              'h-full transition-all duration-500',
              allDone
                ? 'bg-gradient-to-r from-emerald-500 to-cyan-500'
                : 'bg-gradient-to-r from-blue-500 to-purple-500',
            )}
            style={{ width: `${progressPct}%` }}
          />
        </div>
      </header>

      {/* 主体：左侧题目导航 + 右侧答题区 */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* 左侧题目缩略列表 */}
        <nav className="w-48 shrink-0 overflow-y-auto border-r border-border-1 bg-bg-1/40 p-2">
          <div className="mb-2 flex items-center justify-between px-1">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-text-3">题目列表</span>
            <span className="font-mono text-[9.5px] text-text-3">{localQuestions.length} 道</span>
          </div>
          {localQuestions.map((q, i) => {
            const att = attempts[q.id]
            const isActive = i === activeIdx
            const isDone = !!att?.grade
            const isCorrect = att?.grade?.is_correct
            const tint = TYPE_TINT[q.type]
            const Icon = TYPE_ICON[q.type]
            return (
              <button
                key={q.id}
                type="button"
                onClick={() => setActiveIdx(i)}
                className={cn(
                  'group mb-1 flex w-full items-start gap-2 rounded-lg border px-2 py-1.5 text-left transition',
                  isActive
                    ? cn('border-blue-500/40 bg-blue-500/[0.08] shadow-sm')
                    : 'border-transparent hover:border-border-2 hover:bg-bg-2/40',
                )}
              >
                <div
                  className={cn(
                    'mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-md text-[9.5px] font-bold ring-1',
                    isDone
                      ? isCorrect
                        ? 'bg-emerald-500/15 text-emerald-600 ring-emerald-500/40 dark:text-emerald-400'
                        : 'bg-amber-500/15 text-amber-600 ring-amber-500/40 dark:text-amber-400'
                      : isActive
                        ? 'bg-blue-500 text-white ring-blue-500/30 shadow-sm shadow-blue-500/30'
                        : 'bg-bg-2/60 text-text-3 ring-border-2',
                  )}
                >
                  {isDone ? (
                    isCorrect ? <Check className="size-3" strokeWidth={3} /> : <X className="size-3" strokeWidth={3} />
                  ) : (
                    i + 1
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1">
                    <span
                      className={cn(
                        'flex size-4 items-center justify-center rounded',
                        tint.bg,
                        tint.iconText,
                      )}
                    >
                      <Icon className="size-2.5" />
                    </span>
                    <span className={cn('text-[10.5px] font-bold', isActive ? 'text-text-1' : 'text-text-2')}>
                      {TYPE_LABELS[q.type]}
                    </span>
                    {/* 难度点：小点点表示难度等级 */}
                    <span className="ml-auto flex gap-0.5">
                      {Array.from({ length: 5 }).map((_, k) => (
                        <span
                          key={k}
                          className={cn(
                            'size-1 rounded-full',
                            k < q.difficulty ? 'bg-amber-500' : 'bg-border-2',
                          )}
                        />
                      ))}
                    </span>
                  </div>
                  <div className="mt-0.5 line-clamp-1 text-[10px] text-text-3">{q.prompt}</div>
                  {isDone && att?.grade && (
                    <div
                      className={cn(
                        'mt-0.5 inline-flex rounded-sm px-1 font-mono text-[9px] font-bold tabular-nums',
                        isCorrect
                          ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                          : 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
                      )}
                    >
                      {att.grade.score}/100
                    </div>
                  )}
                </div>
              </button>
            )
          })}

          {/* 总结 panel —— 全部完成 */}
          {allDone && (
            <div className="mt-3 overflow-hidden rounded-xl border border-emerald-500/30 bg-emerald-500/[0.06]">
              <div className="flex items-center gap-1.5 border-b border-emerald-500/20 bg-emerald-500/12 px-2.5 py-1.5">
                <Trophy className="size-3.5 text-emerald-500" />
                <span className="text-[11px] font-bold text-emerald-600 dark:text-emerald-400">完成训练</span>
              </div>
              <div className="px-2.5 py-2 text-[10.5px]">
                <div className="flex items-baseline gap-1">
                  <span className="text-[18px] font-bold leading-none text-text-1 tabular-nums">
                    {Math.round(totalScore / localQuestions.length)}
                  </span>
                  <span className="text-[10px] text-text-3">平均分</span>
                </div>
                <div className="mt-1 text-text-2">
                  正确 <span className="font-bold text-emerald-600 dark:text-emerald-400">{correctCount}</span>
                  <span className="text-text-3">/{localQuestions.length}</span>
                  <span className="ml-1 text-text-3">
                    ({Math.round((correctCount / localQuestions.length) * 100)}%)
                  </span>
                </div>
              </div>
              <button
                type="button"
                onClick={onExit}
                className="w-full border-t border-emerald-500/20 bg-emerald-500/15 px-2 py-1.5 text-[11px] font-semibold text-emerald-600 transition hover:bg-emerald-500/25 dark:text-emerald-400"
              >
                返回首页
              </button>
            </div>
          )}
        </nav>

        {/* 右侧当前题答题区 */}
        <main className="min-w-0 flex-1 overflow-y-auto px-5 py-4">
          {activeQ && activeAttempt && (
            <QuestionPanel
              q={activeQ}
              attempt={activeAttempt}
              onAnswerChange={(ans) => updateAttempt(activeQ.id, { userAnswer: ans })}
              onSelectedChange={(sel) => updateAttempt(activeQ.id, { selected: sel })}
              onRunCode={() => runCode(activeQ)}
              onSubmit={() => submit(activeQ)}
              onNext={() => setActiveIdx((i) => Math.min(localQuestions.length - 1, i + 1))}
              onPrev={() => setActiveIdx((i) => Math.max(0, i - 1))}
              hasNext={activeIdx < localQuestions.length - 1}
              hasPrev={activeIdx > 0}
              indexInList={activeIdx}
              total={localQuestions.length}
              translateBusy={!!translateState[activeQ.id]?.busy}
              translateError={translateState[activeQ.id]?.error}
              onTranslate={(target) => void translateQuestion(activeQ.id, target)}
            />
          )}
        </main>
      </div>
    </div>
  )
}

// ─── 单题面板 ───────────────────────────────────────────────────

interface QuestionPanelProps {
  q: TrainingQuestion
  attempt: AttemptState
  onAnswerChange: (ans: string) => void
  onSelectedChange: (sel: string[]) => void
  onRunCode: () => void
  onSubmit: () => void
  onNext: () => void
  onPrev: () => void
  hasNext: boolean
  hasPrev: boolean
  indexInList: number
  total: number
  /** v9 (2026-05) 单题语言翻译 */
  onTranslate?: (targetLanguage: string) => void
  translateBusy?: boolean
  translateError?: string
}

function QuestionPanel({
  q,
  attempt,
  onAnswerChange,
  onSelectedChange,
  onRunCode,
  onSubmit,
  onNext,
  onPrev,
  hasNext,
  hasPrev,
  indexInList,
  total,
  onTranslate,
  translateBusy,
  translateError,
}: QuestionPanelProps) {
  const judged = !!attempt.grade

  return (
    <div className="space-y-3">
      {/* 题面 header */}
      {(() => {
        const tint = TYPE_TINT[q.type]
        const Icon = TYPE_ICON[q.type]
        return (
          <div className="flex items-center gap-2">
            <div className={cn('flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[11.5px] font-bold ring-1', tint.bg, tint.iconText, tint.ring)}>
              <Icon className="size-3.5" />
              {TYPE_LABELS[q.type]}
            </div>
            <div className="rounded-lg bg-bg-2/60 px-2.5 py-1 text-[10.5px]">
              <span className="text-text-3">题 </span>
              <span className="font-mono font-bold text-text-1">{indexInList + 1}/{total}</span>
            </div>
            {/* 难度星 */}
            <div className="flex items-center gap-0.5 rounded-lg bg-amber-500/10 px-2.5 py-1">
              {Array.from({ length: 5 }).map((_, k) => (
                <Star
                  key={k}
                  className={cn(
                    'size-3',
                    k < q.difficulty ? 'fill-amber-500 text-amber-500' : 'text-text-3/40',
                  )}
                />
              ))}
            </div>
            {q.skills && q.skills.length > 0 && (
              <div className="ml-auto flex flex-wrap items-center gap-1">
                {q.skills.slice(0, 3).map((s) => (
                  <span
                    key={s}
                    className="rounded-md bg-purple-500/10 px-1.5 py-0.5 text-[9.5px] font-mono text-purple-600 dark:text-purple-400"
                  >
                    {s}
                  </span>
                ))}
              </div>
            )}
          </div>
        )
      })()}

      {/* 题面：左侧色条装饰 + 宝松的文本 */}
      {(() => {
        const tint = TYPE_TINT[q.type]
        return (
          <div className={cn('relative overflow-hidden rounded-xl border border-border-1 bg-bg-1 px-5 py-4')}>
            <div className={cn('absolute inset-y-0 left-0 w-1', tint.dot)} />
            {/* v6 (2026-05) #1: 题面走 MarkdownView，让 ```lang ...``` 走代码高亮，
                行内 `code`/列表/加粗也正常渲染。md-training-prompt 锁定字号 13.5px。 */}
            <div className="md-training-prompt">
              <MarkdownView content={q.prompt} />
            </div>
          </div>
        )
      })()}

      {/* 答题 UI（按题型分支） */}
      <div className="space-y-2">
        {q.type === 'choice' && q.choices && (
          <ChoiceAnswer q={q} attempt={attempt} judged={judged} onAnswerChange={onAnswerChange} />
        )}
        {q.type === 'short' && (
          <ShortAnswer attempt={attempt} judged={judged} onAnswerChange={onAnswerChange} />
        )}
        {q.type === 'fill' && (
          <FillAnswer attempt={attempt} judged={judged} onAnswerChange={onAnswerChange} />
        )}
        {q.type === 'sequence' && q.choices && (
          <SequenceAnswer
            q={q}
            attempt={attempt}
            judged={judged}
            onSelectedChange={onSelectedChange}
          />
        )}
        {(q.type === 'code' || q.type === 'debug') && (
          <CodeAnswer
            q={q}
            attempt={attempt}
            judged={judged}
            onAnswerChange={onAnswerChange}
            onRunCode={onRunCode}
            onTranslate={onTranslate}
            translateBusy={translateBusy}
            translateError={translateError}
          />
        )}
      </div>

      {/* 提交 + 下一题 按钮区 */}
      <div className="flex items-center gap-2 pt-1">
        <button
          type="button"
          onClick={onPrev}
          disabled={!hasPrev}
          className={cn(
            'inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-[12px] font-medium transition',
            hasPrev
              ? 'border-border-2 text-text-2 hover:border-border-1 hover:text-text-1'
              : 'cursor-not-allowed border-border-2/50 text-text-3',
          )}
        >
          <ArrowLeft className="size-3.5" />
          上一题
        </button>

        {!judged ? (
          <button
            type="button"
            onClick={onSubmit}
            disabled={attempt.submitting}
            className={cn(
              'inline-flex flex-1 items-center justify-center gap-1.5 rounded-md px-4 py-2 text-[13px] font-semibold transition',
              attempt.submitting
                ? 'cursor-not-allowed bg-bg-2/40 text-text-3'
                : 'bg-blue-500 text-white hover:bg-blue-600',
            )}
          >
            {attempt.submitting ? (
              <>
                <Loader2 className="size-3.5 animate-spin" />
                LLM 评分中…
              </>
            ) : (
              <>
                <Send className="size-3.5" />
                提交本题
              </>
            )}
          </button>
        ) : (
          <button
            type="button"
            onClick={onNext}
            disabled={!hasNext}
            className={cn(
              'inline-flex flex-1 items-center justify-center gap-1 rounded-md px-3 py-2 text-[12.5px] font-semibold transition',
              hasNext
                ? 'bg-emerald-500 text-white hover:bg-emerald-600'
                : 'cursor-not-allowed bg-bg-2/40 text-text-3',
            )}
          >
            下一题
            <ArrowRight className="size-3.5" />
          </button>
        )}
      </div>

      {attempt.submitError && (
        <div className="flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/8 px-3 py-2 text-[11.5px] text-red-600 dark:text-red-400">
          <AlertCircle className="mt-0.5 size-3.5" />
          <span>提交失败：{attempt.submitError}</span>
        </div>
      )}

      {/* 评分结果 */}
      {attempt.grade && <GradePanel grade={attempt.grade} q={q} />}
    </div>
  )
}

// ─── 子答题组件 ─────────────────────────────────────────────────

function ChoiceAnswer({
  q,
  attempt,
  judged,
  onAnswerChange,
}: {
  q: TrainingQuestion
  attempt: AttemptState
  judged: boolean
  onAnswerChange: (ans: string) => void
}) {
  const userVal = attempt.userAnswer
  return (
    <div className="space-y-1.5">
      {q.choices?.map((choice) => {
        const letter = choice.match(/^([A-D])[\.\s\u3001]/)?.[1] ?? choice.charAt(0)
        const isChosen = userVal === letter
        const isCorrectChoice = judged && letter === q.answer
        return (
          <label
            key={letter}
            className={cn(
              'flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2 text-[12.5px] transition',
              judged
                ? isCorrectChoice
                  ? 'border-emerald-500/50 bg-emerald-500/10 text-text-1'
                  : isChosen
                    ? 'border-red-500/50 bg-red-500/10 text-text-1'
                    : 'border-border-2 text-text-3'
                : isChosen
                  ? 'border-blue-500 bg-blue-500/10 text-text-1'
                  : 'border-border-2 text-text-2 hover:bg-bg-2/40',
            )}
          >
            <input
              type="radio"
              name={q.id}
              checked={isChosen}
              disabled={judged}
              onChange={() => onAnswerChange(letter)}
              className="mt-0.5"
            />
            <span>{choice}</span>
          </label>
        )
      })}
    </div>
  )
}

function ShortAnswer({
  attempt,
  judged,
  onAnswerChange,
}: {
  attempt: AttemptState
  judged: boolean
  onAnswerChange: (ans: string) => void
}) {
  return (
    <textarea
      value={attempt.userAnswer}
      onChange={(e) => onAnswerChange(e.target.value)}
      rows={5}
      disabled={judged}
      placeholder="用自己的话回答这道题…"
      className={cn(
        'w-full rounded-lg border bg-bg-2/30 px-3 py-2 text-[13px] placeholder:text-text-3 focus:outline-none',
        judged
          ? 'border-border-2/60 text-text-2'
          : 'border-border-2 text-text-1 focus:border-blue-500',
      )}
    />
  )
}

function FillAnswer({
  attempt,
  judged,
  onAnswerChange,
}: {
  attempt: AttemptState
  judged: boolean
  onAnswerChange: (ans: string) => void
}) {
  return (
    <input
      type="text"
      value={attempt.userAnswer}
      onChange={(e) => onAnswerChange(e.target.value)}
      disabled={judged}
      placeholder="填入答案…"
      className={cn(
        'w-full rounded-lg border bg-bg-2/30 px-3 py-2 text-[13px] placeholder:text-text-3 focus:outline-none',
        judged
          ? 'border-border-2/60 text-text-2'
          : 'border-border-2 text-text-1 focus:border-blue-500',
      )}
    />
  )
}

function SequenceAnswer({
  q,
  attempt,
  judged,
  onSelectedChange,
}: {
  q: TrainingQuestion
  attempt: AttemptState
  judged: boolean
  onSelectedChange: (sel: string[]) => void
}) {
  const selected = attempt.selected ?? []
  const remaining = (q.choices ?? []).filter((c) => !selected.includes(c))
  return (
    <div className="space-y-3">
      {/* 已选序列 */}
      <div>
        <div className="mb-1.5 text-[10.5px] font-medium text-text-3">你的排序</div>
        {selected.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border-2 px-3 py-3 text-center text-[11.5px] text-text-3">
            从下方点选步骤组成正确顺序
          </div>
        ) : (
          <div className="space-y-1.5">
            {selected.map((s, i) => (
              <div
                key={s + i}
                className="flex items-center gap-2 rounded-lg border border-blue-500/30 bg-blue-500/8 px-3 py-2 text-[12.5px] text-text-1"
              >
                <span className="rounded-full bg-blue-500 px-1.5 py-0.5 text-[10px] font-bold text-white">
                  {i + 1}
                </span>
                <span className="flex-1">{s}</span>
                {!judged && (
                  <button
                    type="button"
                    onClick={() => onSelectedChange(selected.filter((_, j) => j !== i))}
                    className="text-text-3 hover:text-red-500"
                  >
                    <X className="size-3.5" />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
        {!judged && selected.length > 0 && (
          <button
            type="button"
            onClick={() => onSelectedChange([])}
            className="mt-1.5 text-[10.5px] text-text-3 hover:text-text-1"
          >
            重置
          </button>
        )}
      </div>
      {/* 待选项 */}
      {!judged && remaining.length > 0 && (
        <div>
          <div className="mb-1.5 text-[10.5px] font-medium text-text-3">候选步骤</div>
          <div className="flex flex-wrap gap-1.5">
            {remaining.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => onSelectedChange([...selected, c])}
                className="rounded-md border border-border-2 bg-bg-2/30 px-2.5 py-1.5 text-[11.5px] text-text-2 transition hover:border-blue-500/40 hover:bg-blue-500/8 hover:text-text-1"
              >
                + {c}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function CodeAnswer({
  q,
  attempt,
  judged,
  onAnswerChange,
  onRunCode,
  onTranslate,
  translateBusy,
  translateError,
}: {
  q: TrainingQuestion
  attempt: AttemptState
  judged: boolean
  onAnswerChange: (ans: string) => void
  onRunCode: () => void
  /** v9 (2026-05) 单题语言翻译回调；不传则不显示语言切换按钮 */
  onTranslate?: (targetLanguage: string) => void
  translateBusy?: boolean
  translateError?: string
}) {
  const lang = q.language ?? 'python'
  // v4 (2026-05) 用 CodeMirror 6 替代 textarea：语法高亮 / 行号 / 自动缩进 / 括号匹配
  const cmExtensions = useMemo<Extension[]>(() => [langExtension(lang)], [lang])

  return (
    <div className="space-y-2.5">
      {/* 代码编辑器 —— GitHub Dark 风格：顶部假 tab 栏 + 下方 CodeMirror */}
      <div className="overflow-hidden rounded-lg border border-border-1">
        {/* 假 tab 栏 */}
        <div className="flex items-center gap-2 border-b border-[#30363d]/60 bg-[#161b22] px-3 py-1.5">
          {/* 仿 macOS 三个圆点 */}
          <div className="flex gap-1.5">
            <span className="size-2.5 rounded-full bg-[#ff5f56]/70" />
            <span className="size-2.5 rounded-full bg-[#ffbd2e]/70" />
            <span className="size-2.5 rounded-full bg-[#27c93f]/70" />
          </div>
          <div className="ml-2 flex items-center gap-1.5 rounded-md bg-[#0d1117] px-2.5 py-0.5">
            <Code2 className="size-3 text-emerald-400/80" />
            <span className="font-mono text-[10.5px] font-medium text-[#e6edf3]">
              main.{lang === 'cpp' ? 'cpp' : lang === 'javascript' ? 'js' : lang === 'typescript' ? 'ts' : lang === 'rust' ? 'rs' : lang === 'java' ? 'java' : lang === 'python' ? 'py' : lang}
            </span>
          </div>
          <span className="ml-2 font-mono text-[9.5px] uppercase text-[#7d8590]">{lang}</span>
          {/* v9 (2026-05) 单题语言切换：点击下拉切到其他语言，LLM 翻译 starter_code/answer/tests */}
          {onTranslate && !judged && (
            <LanguagePicker
              currentLanguage={lang}
              busy={!!translateBusy}
              error={translateError}
              onPick={onTranslate}
            />
          )}
          {q.tests && q.tests.length > 0 && (
            <span className="ml-auto inline-flex items-center gap-1 rounded-md bg-purple-500/15 px-1.5 py-0.5 text-[9.5px] text-purple-300">
              <TestTube2 className="size-2.5" />
              {q.tests.length} 个测试
            </span>
          )}
        </div>
        {/* 代码区：CodeMirror 6 */}
        <CodeMirror
          value={attempt.userAnswer}
          onChange={onAnswerChange}
          extensions={cmExtensions}
          theme={oneDark}
          editable={!judged}
          minHeight="220px"
          maxHeight="520px"
          basicSetup={{
            lineNumbers: true,
            foldGutter: true,
            highlightActiveLine: !judged,
            highlightActiveLineGutter: !judged,
            bracketMatching: true,
            closeBrackets: true,
            indentOnInput: true,
            autocompletion: false,
            tabSize: 4,
          }}
          className={cn('cm-training', judged && 'opacity-90')}
        />
      </div>

      {/* Run 按钮 + 输出区 */}
      {!judged && (
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onRunCode}
            disabled={attempt.running || !attempt.userAnswer.trim()}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[11.5px] font-medium transition',
              attempt.running
                ? 'cursor-wait border-border-2 bg-bg-2/40 text-text-3'
                : !attempt.userAnswer.trim()
                  ? 'cursor-not-allowed border-border-2/50 text-text-3'
                  : 'border-emerald-500/40 bg-emerald-500/8 text-emerald-600 hover:bg-emerald-500/15 dark:text-emerald-400',
            )}
          >
            {attempt.running ? (
              <>
                <Loader2 className="size-3 animate-spin" />
                Piston 编译运行中…
              </>
            ) : (
              <>
                <Play className="size-3" />
                运行（emkc/Piston）
              </>
            )}
          </button>
          {attempt.codeRun && !attempt.running && (
            <button
              type="button"
              onClick={onRunCode}
              className="inline-flex items-center gap-1 rounded text-[10.5px] text-text-3 hover:text-text-1"
            >
              <RefreshCw className="size-3" />
              重跑
            </button>
          )}
          <span className="ml-auto text-[10.5px] text-text-3">
            按 <kbd className="rounded bg-bg-2 px-1 py-0.5 text-[9px]">Tab</kbd> 缩进 4 空格
          </span>
        </div>
      )}

      {attempt.codeRun && <CodeRunOutput result={attempt.codeRun} tests={q.tests ?? []} />}

      {/* v9 (2026-05) 翻译失败提示：banner 形式显示在输出区下面 */}
      {translateError && (
        <div className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-[11.5px] text-red-700 dark:text-red-300">
          <div className="font-semibold">语言切换失败</div>
          <div className="mt-0.5 text-[11px] leading-relaxed">{translateError}</div>
        </div>
      )}
    </div>
  )
}

// ─── 单题语言切换下拉（仅 code/debug 题，集成在假 tab 栏） ──────────────────
//
// v9 (2026-05) 用户可临时把当前题切到其他语言，LLM 会翻译 starter_code / answer /
// tests / rubric。仅本会话内有效，不持久化。
function LanguagePicker({
  currentLanguage,
  busy,
  error,
  onPick,
}: {
  currentLanguage: string
  busy: boolean
  error?: string
  onPick: (lang: string) => void
}) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  // 点击外部关闭
  useEffect(() => {
    if (!open) return
    const onDocClick = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [open])

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => !busy && setOpen((v) => !v)}
        disabled={busy}
        title={busy ? 'LLM 翻译中…' : '切换到其他语言（LLM 会翻译题目）'}
        className={cn(
          'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[10px] font-medium transition',
          busy
            ? 'cursor-wait border-blue-400/40 bg-blue-500/15 text-blue-300'
            : 'border-[#30363d] bg-[#0d1117] text-[#7d8590] hover:border-blue-400/50 hover:bg-blue-500/10 hover:text-blue-300',
        )}
      >
        {busy ? <Loader2 className="size-3 animate-spin" /> : <Languages className="size-3" />}
        <span>{busy ? '翻译中' : '换语言'}</span>
        {!busy && <ChevronDown className="size-2.5" />}
      </button>
      {open && !busy && (
        <div className="absolute left-0 top-full z-50 mt-1 min-w-[160px] overflow-hidden rounded-lg border border-[#30363d] bg-[#161b22] shadow-xl shadow-black/40">
          <div className="border-b border-[#30363d]/60 px-2 py-1 text-[9.5px] uppercase tracking-wider text-[#7d8590]">
            切换到（{SUPPORTED_LANGUAGES.length - 1} 个目标语言）
          </div>
          {SUPPORTED_LANGUAGES.map((l) => {
            const isCur = l.value === currentLanguage
            return (
              <button
                key={l.value}
                type="button"
                disabled={isCur}
                onClick={() => {
                  setOpen(false)
                  onPick(l.value)
                }}
                className={cn(
                  'flex w-full items-center justify-between px-3 py-1.5 text-left text-[11.5px] transition',
                  isCur
                    ? 'cursor-default bg-emerald-500/10 text-emerald-300'
                    : 'text-[#e6edf3] hover:bg-blue-500/15 hover:text-blue-200',
                )}
              >
                <span>{l.label}</span>
                {isCur ? (
                  <span className="font-mono text-[9.5px] text-emerald-400/80">当前</span>
                ) : (
                  <span className="font-mono text-[9.5px] text-[#7d8590]">.{l.ext}</span>
                )}
              </button>
            )
          })}
          {error && (
            <div className="border-t border-red-500/30 bg-red-500/10 px-3 py-1.5 text-[10px] text-red-300">
              上次失败：{error.length > 60 ? error.slice(0, 60) + '…' : error}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// 代码运行结果输出区
//
// v7 (2026-05) 强化错误信息展示：
//   - stdout / stderr 总是显示一块（空时给"(无输出)"占位），让用户清楚
//     "代码到底打印了什么 / 报了什么错"
//   - 测试用例对比改成可滚动多行展示完整 expected
//   - exit_code 非 0 时给醒目的失败摘要
//   - 编译错误（stderr 含 "[编译错误]" 前缀）单独识别并标注
//
// v8 (2026-05) 用户反馈"日志区字体太浅根本看不清"：
//   - pre 字号从 11.5px 升到 13px / 行高加大
//   - 空输出占位用浅灰底 + 实色文字（不再 italic 半透明）
//   - 整体面板配色改为深黑底（GitHub Dark）+ 高对比度文字
//
// v9 (2026-05) 用户反馈"为什么没有日志信息"：
//   stdout 和 stderr 同时为空时不再分块各显示一遍"无输出"，而是合并成一条
//   信息密度更高的提示卡片，明确告诉用户「代码确实没产生任何输出 + 应该怎么办」。
//   只要任意一边非空就走分块展示。
function CodeRunOutput({ result, tests }: { result: CodeRunResult; tests: TrainingQuestion['tests'] }) {
  const isOk = result.success
  const expectedFirst = tests?.[0]?.expected_stdout ?? ''
  const matchesFirst = expectedFirst.length > 0 && result.stdout.trim() === expectedFirst.trim()
  const stdoutEmpty = result.stdout.length === 0
  const stderrEmpty = result.stderr.length === 0
  const bothEmpty = stdoutEmpty && stderrEmpty
  // 识别编译错误：piston_execute 在编译失败时会前置 "[编译错误]" 头
  const hasCompileError = result.stderr.includes('[编译错误]')
  // 识别信号终止：piston_execute 在收到 signal 时前置 "[运行被信号 X 终止]"
  const hasSignal = result.stderr.includes('[运行被信号')
  // 识别 output 兜底：用户该看到这点提醒"是从混合输出取的"
  const hasOutputFallback = result.stderr.includes('[Piston output 兜底]')

  return (
    <div className="space-y-2 rounded-lg border border-border-2 bg-bg-1 p-3">
      <div className="flex flex-wrap items-center gap-2 text-[12px] font-medium">
        <Terminal className="size-3.5 text-text-2" />
        <span className="text-text-1">运行结果</span>
        <span
          className={cn(
            'rounded-full px-2 py-0.5 text-[10.5px] font-bold',
            isOk
              ? 'bg-emerald-500/20 text-emerald-700 dark:text-emerald-300'
              : 'bg-red-500/20 text-red-600 dark:text-red-400',
          )}
        >
          {isOk ? '✓ 正常退出' : '✗ 失败'}
        </span>
        {result.exit_code !== null && (
          <span className="rounded bg-bg-2 px-1.5 py-0.5 font-mono text-[11px] text-text-2">
            exit={result.exit_code}
          </span>
        )}
        <span className="rounded bg-bg-2 px-1.5 py-0.5 font-mono text-[11px] text-text-2">
          {result.time_ms}ms
        </span>
        {hasCompileError && (
          <span className="rounded bg-red-500/20 px-2 py-0.5 text-[10.5px] font-medium text-red-600 dark:text-red-400">
            编译错误
          </span>
        )}
        {hasSignal && (
          <span className="rounded bg-red-500/20 px-2 py-0.5 text-[10.5px] font-medium text-red-600 dark:text-red-400">
            进程被信号终止
          </span>
        )}
        {hasOutputFallback && (
          <span
            className="rounded bg-blue-500/15 px-2 py-0.5 text-[10.5px] font-medium text-blue-600 dark:text-blue-400"
            title="单独的 stdout / stderr 字段为空，从 Piston 的混合 output 字段兜底取的"
          >
            混合输出
          </span>
        )}
        {result.fallback_used && (
          <span className="rounded bg-amber-500/20 px-2 py-0.5 text-[10.5px] font-medium text-amber-600 dark:text-amber-400">
            网络/API 失败
          </span>
        )}
      </div>

      {/* 两边都空时合并显示一条精简提示，避免"两块都说没东西"的冗余 */}
      {bothEmpty && (
        <EmptyOutputHint exitOk={isOk} />
      )}

      {/* 只要任一边有内容就分块展示 */}
      {!bothEmpty && (
        <>
          <CodeOutputBlock
            label="stdout"
            labelColor={stdoutEmpty ? 'text-text-2' : 'text-emerald-600 dark:text-emerald-400'}
            text={result.stdout}
            emptyHint="（无标准输出）程序未向 stdout 写入任何内容。"
            textColor="text-emerald-200"
          />
          <CodeOutputBlock
            label="stderr"
            labelColor={stderrEmpty ? 'text-text-2' : 'text-red-600 dark:text-red-400'}
            text={result.stderr}
            emptyHint="（无错误输出）程序未向 stderr 写入内容。"
            textColor="text-red-200"
          />
        </>
      )}

      {/* 与第一个测试用例对比 */}
      {expectedFirst && (
        <div
          className={cn(
            'rounded-md border px-3 py-2 text-[11.5px]',
            matchesFirst
              ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200'
              : 'border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-200',
          )}
        >
          <div className="font-semibold">
            {matchesFirst ? '✓ 与首个测试用例预期输出一致' : '⚠ 与首个测试用例不一致'}
          </div>
          {!matchesFirst && (
            <details className="mt-1.5" open>
              <summary className="cursor-pointer text-[11px] font-medium text-amber-700 dark:text-amber-300 hover:underline">
                查看预期输出（点击折叠）
              </summary>
              <pre className="mt-1 max-h-40 overflow-auto rounded bg-amber-500/10 px-2.5 py-2 font-mono text-[12px] leading-[1.55] whitespace-pre-wrap text-amber-900 dark:text-amber-100">
                {expectedFirst}
              </pre>
            </details>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * 两边都空时的合并提示卡片。
 *
 * 区分两种情况：
 *  - exitOk=true：代码"安静地"跑完了，最常见原因是用户没写 print/console.log
 *  - exitOk=false：进程被信号杀死 / 容器异常 / 超时，给出排查方向
 */
function EmptyOutputHint({ exitOk }: { exitOk: boolean }) {
  if (exitOk) {
    return (
      <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-[12px] leading-relaxed text-amber-900 dark:text-amber-100">
        <div className="font-semibold">代码正常退出（exit=0），但没有任何输出。</div>
        <div className="mt-1 text-[11.5px] text-amber-800/95 dark:text-amber-200/90">
          解释器加载并执行了模块顶层代码，但没有任何语句向 <span className="font-mono">stdout</span> 或{' '}
          <span className="font-mono">stderr</span> 写入。
          <strong className="ml-1">这不是错误</strong> —— 而是因为：
        </div>
        <ul className="mt-1 ml-4 list-disc space-y-0.5 text-[11.5px] text-amber-800/95 dark:text-amber-200/90">
          <li>函数定义里只有 <span className="font-mono">pass</span> 占位，且模块顶层没调用这些函数</li>
          <li>没有 <span className="font-mono">print()</span> / <span className="font-mono">console.log()</span> / <span className="font-mono">println!()</span> 等输出语句</li>
          <li>题目期望你在关键步骤打印中间状态 —— 请参考下方"预期输出"补全代码并加入打印</li>
        </ul>
        <div className="mt-1.5 text-[10.5px] text-amber-700 dark:text-amber-300/85">
          注：Python / JavaScript 等解释型语言只要语法正确就不会报"编译错误"；要看到错误信息，代码需要真正执行到出错的语句。
        </div>
      </div>
    )
  }
  return (
    <div className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2.5 text-[12px] leading-relaxed text-red-700 dark:text-red-300">
      <div className="font-semibold">进程异常退出（exit≠0），但没有输出任何内容。</div>
      <div className="mt-1 text-[11.5px] text-red-700/95 dark:text-red-300/90">可能原因：</div>
      <ul className="mt-1 ml-4 list-disc space-y-0.5 text-[11.5px] text-red-700/95 dark:text-red-300/90">
        <li>被运行时信号终止（如超时 SIGKILL / 内存超限）</li>
        <li>容器或运行时内部错误（请到「设置 → 代码运行」检查 Piston 容器状态）</li>
      </ul>
    </div>
  )
}

/**
 * 代码运行输出的单块（stdout / stderr 通用）。
 *
 * 视觉：黑底（GitHub Dark），文字字号 13px / line-height 1.55，对比度足够清晰。
 * 空输出时显示浅灰底 + 实色文字的提示卡片，不再用半透明 italic（用户反馈太浅）。
 */
function CodeOutputBlock({
  label,
  labelColor,
  text,
  emptyHint,
  textColor,
}: {
  label: string
  labelColor: string
  text: string
  emptyHint: string
  textColor: string
}) {
  const empty = text.length === 0
  return (
    <div>
      <div className="mb-1 flex items-center gap-2 text-[10.5px] font-bold uppercase tracking-wider">
        <span className={labelColor}>{label}</span>
        {empty && <span className="text-text-3 normal-case font-normal">— 空 —</span>}
      </div>
      {empty ? (
        <div className="rounded border border-border-2 bg-bg-2/60 px-3 py-2 text-[12px] leading-relaxed text-text-2">
          {emptyHint}
        </div>
      ) : (
        <pre
          className={cn(
            'max-h-56 overflow-auto rounded bg-[#0d1117] px-3 py-2.5 font-mono text-[13px] leading-[1.55] whitespace-pre-wrap',
            textColor,
          )}
        >
          {text}
        </pre>
      )}
    </div>
  )
}

// 评分结果面板 —— 大圆形分数 + 鲜明的反馈
function GradePanel({ grade, q }: { grade: GradeResult; q: TrainingQuestion }) {
  return (
    <div
      className={cn(
        'overflow-hidden rounded-xl border-2',
        grade.is_correct
          ? 'border-emerald-500/40'
          : 'border-amber-500/40',
      )}
    >
      {/* 上部：大分数 + 状态 */}
      <div
        className={cn(
          'flex items-center gap-3 border-b px-4 py-3',
          grade.is_correct
            ? 'border-emerald-500/20 bg-emerald-500/[0.06]'
            : 'border-amber-500/20 bg-amber-500/[0.06]',
        )}
      >
        {/* 大圆形分数徽章 */}
        <div
          className={cn(
            'flex size-14 shrink-0 flex-col items-center justify-center rounded-full ring-2',
            grade.is_correct
              ? 'bg-emerald-500/15 ring-emerald-500/40'
              : 'bg-amber-500/15 ring-amber-500/40',
          )}
        >
          <span
            className={cn(
              'text-[18px] font-bold leading-none tabular-nums',
              grade.is_correct ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400',
            )}
          >
            {grade.score}
          </span>
          <span className="text-[8px] font-medium uppercase tracking-wider text-text-3">
            /100
          </span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="mb-0.5 flex items-center gap-1.5">
            {grade.is_correct ? (
              <CheckCircle2 className="size-4 text-emerald-500" />
            ) : (
              <AlertCircle className="size-4 text-amber-500" />
            )}
            <span
              className={cn(
                'text-[14px] font-bold',
                grade.is_correct ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400',
              )}
            >
              {grade.is_correct ? '答对了！' : '需要改进'}
            </span>
          </div>
          <div className="text-[11.5px] text-text-2">
            {grade.is_correct ? '继续保持，下一道也要德住～' : '看下面反馈，找出问题点'}
          </div>
        </div>
      </div>

      {/* feedback + 遗漏要点 */}
      <div className="space-y-2.5 bg-bg-1 px-4 py-3">
        {/* v6 #1: feedback 走 MarkdownView，让评分里 LLM 引用的代码片段获得高亮 */}
        <div className="md-training-feedback text-text-1">
          <MarkdownView content={grade.feedback} />
        </div>
        {grade.missed_points && grade.missed_points.length > 0 && (
          <div className="rounded-lg border border-amber-500/20 bg-amber-500/[0.04] px-3 py-2">
            <div className="mb-1 flex items-center gap-1.5 text-[10.5px] font-bold uppercase tracking-wider text-amber-600 dark:text-amber-400">
              <AlertCircle className="size-3" />
              遗漏要点
            </div>
            <ul className="space-y-0.5 text-[11.5px] text-text-2">
              {grade.missed_points.map((m, i) => (
                <li key={i} className="flex items-start gap-1.5">
                  <span className="mt-1 size-1 shrink-0 rounded-full bg-amber-500" />
                  <span>{m}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        <details className="text-[11.5px]">
          <summary className="inline-flex cursor-pointer items-center gap-1 rounded-md bg-bg-2/60 px-2 py-1 text-text-3 hover:bg-bg-2 hover:text-text-2">
            <Sparkles className="size-3" />
            查看参考答案 / 评分细则
          </summary>
          <div className="mt-2 space-y-2 rounded-lg bg-bg-2/40 px-3 py-2.5">
            {q.answer && (
              <div>
                <div className="mb-1 text-[10px] font-bold uppercase tracking-wider text-text-3">参考答案</div>
                {/* v6 #1: 参考答案走 MarkdownView。如果 LLM 没写 fence，
                    我们用 detectAnswerFence 兜底自动加 fence 让代码也能高亮。 */}
                <div className="md-training-answer">
                  <MarkdownView content={detectAnswerFence(q.answer, q.language, q.type)} />
                </div>
              </div>
            )}
            {q.rubric && (
              <div>
                <div className="mb-1 text-[10px] font-bold uppercase tracking-wider text-text-3">评分细则</div>
                <div className="md-training-rubric text-text-2">
                  <MarkdownView content={q.rubric} />
                </div>
              </div>
            )}
          </div>
        </details>
      </div>
    </div>
  )
}
