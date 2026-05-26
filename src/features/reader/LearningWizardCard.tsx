/**
 * LearningWizardCard —— 生成学习路线图前的简短预询问（v6 #3+ B 任务）
 *
 * 设计：
 *   - 调 agent_clarify_questions 让 LLM 基于书的内容动态出 3-5 道单选题
 *   - 用户作答 + 可选自由文本补充 → 拼成 user_preferences 字符串
 *   - 把 user_preferences 透传给 agent_plan_generate
 *
 * UX：
 *   - 顶部进度条「问题 i / N」
 *   - 卡片式题面，每题一组单选按钮
 *   - 底部「跳过 wizard」让用户绕过（直接 plan_generate(null)）
 *   - 全部答完前的"开始学习"按钮禁用；可选最后一题为补充框
 *
 * 失败兜底：LLM 失败 / 解析失败时直接给出"跳过 wizard, 直接开始学习"按钮。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowRight, Loader2, RotateCcw, Sparkles, SkipForward, AlertCircle } from 'lucide-react'
import { invoke } from '@/lib/tauri'
import { cn } from '@/lib/cn'

interface WizardQuestion {
  id: string
  prompt: string
  options: string[]
}

interface ClarifyResp {
  questions: WizardQuestion[]
}

interface Props {
  sessionId: string
  /**
   * 用户完成 wizard：把答案打包成 user_preferences 字符串透传给 plan 生成。
   * - null = 用户选择跳过 / LLM 失败兜底；后端将以无偏好生成
   */
  onSubmit: (userPreferences: string | null) => void | Promise<void>
  /** 关闭 wizard（不生成路线图，用于"返回上一步" / 用户改主意） */
  onCancel?: () => void
}

export function LearningWizardCard({ sessionId, onSubmit, onCancel }: Props) {
  const [questions, setQuestions] = useState<WizardQuestion[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [freeNote, setFreeNote] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const loadQuestions = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const r = await invoke<ClarifyResp>('agent_clarify_questions', { sessionId })
      const qs = Array.isArray(r?.questions) ? r.questions : []
      // LLM 偶尔会冗余字段，做一次类型清理
      const cleaned = qs
        .map((q) => ({
          id: typeof q.id === 'string' ? q.id : '',
          prompt: typeof q.prompt === 'string' ? q.prompt : '',
          options: Array.isArray(q.options) ? q.options.filter((o) => typeof o === 'string') : [],
        }))
        .filter((q) => q.id && q.prompt && q.options.length >= 2)
      setQuestions(cleaned)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [sessionId])

  useEffect(() => {
    void loadQuestions()
  }, [loadQuestions])

  const answeredCount = useMemo(
    () => questions.filter((q) => !!answers[q.id]).length,
    [questions, answers],
  )
  const allAnswered = answeredCount === questions.length && questions.length > 0

  const handleSelect = useCallback((qid: string, opt: string) => {
    setAnswers((prev) => ({ ...prev, [qid]: opt }))
  }, [])

  const buildUserPreferences = useCallback((): string => {
    const lines: string[] = []
    for (const q of questions) {
      const a = answers[q.id]
      if (!a) continue
      lines.push(`Q: ${q.prompt}\nA: ${a}`)
    }
    if (freeNote.trim()) {
      lines.push(`补充说明：${freeNote.trim()}`)
    }
    return lines.join('\n\n')
  }, [questions, answers, freeNote])

  const handleConfirm = useCallback(async () => {
    setSubmitting(true)
    try {
      const prefs = buildUserPreferences()
      await onSubmit(prefs.length > 0 ? prefs : null)
    } finally {
      setSubmitting(false)
    }
  }, [buildUserPreferences, onSubmit])

  const handleSkip = useCallback(async () => {
    setSubmitting(true)
    try {
      await onSubmit(null)
    } finally {
      setSubmitting(false)
    }
  }, [onSubmit])

  // ─── 渲染 ─────────────────────────────────────────────────────────
  // 注意：滚动容器**不能**用 `flex items-center`，否则当内容高于视口时，
  // 顶部会被 flex 居中算法推到容器外，滚动条到不了顶。
  // 解决：外层只做滚动，居中靠内层 `min-h-full + flex items-center`。
  return (
    <div className="h-full overflow-y-auto bg-bg">
      <div className="mx-auto flex min-h-full max-w-2xl items-center p-6">
        <div className="w-full">
        {/* 顶栏 */}
        <div className="mb-5 flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-purple-500 text-white shadow-md">
            <Sparkles className="size-5" />
          </div>
          <div className="flex-1">
            <h2 className="text-[15px] font-semibold text-text-1">先聊几句，再开始</h2>
            <p className="text-[11.5px] text-text-3">
              AI 会问 3-5 个问题了解你的学习偏好，然后生成专属路线图
            </p>
          </div>
          {questions.length > 0 && !loading && (
            <div className="rounded-full bg-bg-1 px-2.5 py-1 font-mono text-[10.5px] font-medium text-text-2">
              {answeredCount} / {questions.length}
            </div>
          )}
        </div>

        {/* 加载 */}
        {loading && (
          <div className="flex h-48 flex-col items-center justify-center gap-3 rounded-2xl border border-border-1 bg-bg-1 text-text-3">
            <Loader2 className="size-6 animate-spin" />
            <span className="text-[12px]">AI 正在阅读你的资料，准备问题…</span>
          </div>
        )}

        {/* 错误兜底：允许跳过直接开始 */}
        {!loading && error && (
          <div className="space-y-3">
            <div className="flex items-start gap-2 rounded-xl border border-red-500/30 bg-red-500/8 px-4 py-3 text-[12px] text-red-600 dark:text-red-400">
              <AlertCircle className="mt-0.5 size-4 shrink-0" />
              <div className="space-y-1">
                <div className="font-medium">Wizard 出题失败</div>
                <div className="text-[11px] opacity-90">{error}</div>
              </div>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => void loadQuestions()}
                className="flex items-center gap-1.5 rounded-lg border border-border-2 px-3 py-2 text-[12px] text-text-2 transition hover:border-border-1 hover:text-text-1"
              >
                <RotateCcw className="size-3.5" />
                重试
              </button>
              <button
                type="button"
                onClick={() => void handleSkip()}
                disabled={submitting}
                className="ml-auto flex items-center gap-1.5 rounded-lg bg-indigo-500 px-3 py-2 text-[12px] font-medium text-white shadow-sm transition hover:bg-indigo-600 disabled:cursor-wait disabled:opacity-60"
              >
                {submitting ? <Loader2 className="size-3.5 animate-spin" /> : <SkipForward className="size-3.5" />}
                跳过 wizard，直接开始
              </button>
            </div>
          </div>
        )}

        {/* 题目列表 */}
        {!loading && !error && questions.length > 0 && (
          <div className="space-y-4">
            {questions.map((q, qi) => (
              <div
                key={q.id}
                className="rounded-2xl border border-border-1 bg-bg-1 p-4 shadow-[0_1px_2px_rgba(0,0,0,0.03)]"
              >
                <div className="mb-3 flex items-start gap-2">
                  <span className="mt-0.5 inline-flex size-5 items-center justify-center rounded-full bg-indigo-500/10 font-mono text-[10.5px] font-bold text-indigo-600 dark:text-indigo-400">
                    {qi + 1}
                  </span>
                  <h3 className="text-[13.5px] font-medium leading-relaxed text-text-1">
                    {q.prompt}
                  </h3>
                </div>
                <div className="grid gap-1.5 pl-7">
                  {q.options.map((opt) => {
                    const selected = answers[q.id] === opt
                    return (
                      <button
                        key={opt}
                        type="button"
                        onClick={() => handleSelect(q.id, opt)}
                        className={cn(
                          'group flex items-center gap-2 rounded-lg border px-3 py-2 text-left text-[12.5px] transition',
                          selected
                            ? 'border-indigo-500/50 bg-indigo-500/10 text-text-1 ring-1 ring-indigo-500/30'
                            : 'border-border-1 bg-bg-2/30 text-text-2 hover:border-border-2 hover:text-text-1',
                        )}
                      >
                        <span
                          className={cn(
                            'inline-flex size-4 shrink-0 items-center justify-center rounded-full border-2 transition',
                            selected
                              ? 'border-indigo-500 bg-indigo-500'
                              : 'border-border-2 bg-bg-1 group-hover:border-text-3',
                          )}
                        >
                          {selected && <span className="size-1.5 rounded-full bg-white" />}
                        </span>
                        <span className="flex-1">{opt}</span>
                      </button>
                    )
                  })}
                </div>
              </div>
            ))}

            {/* 自由补充 */}
            <div className="rounded-2xl border border-border-1/70 bg-bg-1/60 p-4">
              <label className="mb-1.5 block text-[11.5px] font-medium text-text-2">
                还有其他想告诉 AI 的吗？<span className="ml-1 text-text-3">（可选）</span>
              </label>
              <textarea
                value={freeNote}
                onChange={(e) => setFreeNote(e.target.value)}
                rows={2}
                placeholder="例如：我已经熟悉 X，可以快速跳过；或我特别想搞清楚 Y..."
                className="w-full resize-none rounded-lg border border-border-2 bg-bg px-3 py-2 text-[12px] text-text-1 placeholder:text-text-3/70 focus:border-indigo-500/40 focus:outline-none focus:ring-1 focus:ring-indigo-500/20"
              />
            </div>

            {/* 操作栏 */}
            <div className="flex items-center gap-2 pt-1">
              {onCancel && (
                <button
                  type="button"
                  onClick={onCancel}
                  className="text-[12px] text-text-3 transition hover:text-text-2"
                >
                  ← 返回
                </button>
              )}
              <button
                type="button"
                onClick={() => void handleSkip()}
                disabled={submitting}
                className="ml-auto flex items-center gap-1.5 rounded-lg px-3 py-2 text-[12px] text-text-2 transition hover:bg-bg-1 disabled:cursor-wait"
              >
                <SkipForward className="size-3.5" />
                跳过
              </button>
              <button
                type="button"
                onClick={() => void handleConfirm()}
                disabled={!allAnswered || submitting}
                className={cn(
                  'flex items-center gap-1.5 rounded-lg px-4 py-2 text-[12px] font-medium shadow-sm transition',
                  allAnswered && !submitting
                    ? 'bg-indigo-500 text-white hover:bg-indigo-600'
                    : 'cursor-not-allowed bg-bg-2/60 text-text-3',
                )}
              >
                {submitting ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <ArrowRight className="size-3.5" />
                )}
                开始生成路线图
              </button>
            </div>
            {!allAnswered && (
              <p className="pl-1 text-[10.5px] text-text-3">
                提示：全部答完才能进入路线图生成；不想答可点「跳过」。
              </p>
            )}
          </div>
        )}

        {/* 无题兜底：LLM 返回空数组 */}
        {!loading && !error && questions.length === 0 && (
          <div className="rounded-2xl border border-border-1 bg-bg-1 p-6 text-center text-[12px] text-text-3">
            <p>AI 没有出题，直接开始学习吧。</p>
            <button
              type="button"
              onClick={() => void handleSkip()}
              disabled={submitting}
              className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-indigo-500 px-3 py-2 text-[12px] font-medium text-white shadow-sm transition hover:bg-indigo-600 disabled:cursor-wait"
            >
              {submitting ? <Loader2 className="size-3.5 animate-spin" /> : <SkipForward className="size-3.5" />}
              直接开始
            </button>
          </div>
        )}
        </div>
      </div>
    </div>
  )
}
