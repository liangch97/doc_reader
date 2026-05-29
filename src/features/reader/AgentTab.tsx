/**
 * 学习 Agent 面板（DESIGN.md §13 v2 Auto-Pilot）
 *
 * 设计参考：vibe coding 平台的 auto-pilot 模式（Cursor / Cascade / v0）。
 *   - 极简：顶部一行进度 + 主区流式 markdown + 题目浮出
 *   - 全自动：进入面板 → 生成路线图 → 流式讲解 → 出题 → 答题 →（答对 1.5s 后）→ 下一单元
 *   - 用户唯一介入点 = 答题；以及顶部的"暂停 / 重置"小图标
 *
 * 后端契约（commands.rs §13 v2）：
 *   - agent_get_state                : 取整体状态 { plan, unit_states[] }
 *   - agent_plan_generate            : 生成路线图（outline.units + skip_pages）
 *   - agent_teach_unit_stream        : 流式生成单元教学。立即返回 turn_id；
 *                                      后端 emit token / done / error / reasoning
 *   - agent_submit_answers           : 提交本单元答案 → 判分
 *   - agent_advance(next/retry/pause): 推进 / 重生成 / 暂停。next/retry 后 phase=idle，
 *                                      Auto-Pilot useEffect 自动触发下一单元 / 当前单元的流。
 *   - agent_reset                    : 清空全部
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircle,
  Archive,
  ArrowUp,
  Check,
  BookOpen,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Dumbbell,
  HelpCircle,
  Lightbulb,
  Link2,
  Loader2,
  Map,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  Sparkles,
  X,
} from 'lucide-react'
import { invoke } from '@/lib/tauri'
import type { RagSource } from '@/lib/tauri'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { MarkdownView, type MdTheme } from '@/components/markdown/MarkdownView'
import { MarkdownEditor } from '@/components/markdown/MarkdownEditor'
import { notebooksApi } from '@/lib/api'
import { cn } from '@/lib/cn'
import { getKeyboardOwner } from './keyboardFocus'
import { LearningWizardCard } from './LearningWizardCard'

// ── 类型 ────────────────────────────────────────────────────────────────

type AgentPhase =
  | 'idle'
  | 'planning'
  | 'teaching'
  | 'probing'
  | 'grading'
  | 'reviewing'
  | 'done'

interface AgentUnit {
  id: string
  title: string
  pages: number[]
  key_points: string[]
  needs_quiz: boolean
  difficulty: number
}

interface AgentOutline {
  thesis: string
  skip_pages?: number[]
  skip_reason?: string
  units: AgentUnit[]
}

interface AgentPlan {
  outline: AgentOutline | null
  page_total: number
  current_unit: number
  current_phase: AgentPhase
  created_at?: string
  updated_at?: string
}

// v5 (2026-05) B3: 题目全部搬到训练板块后，学习区不再需要 Question / AnswerEntry 类型。
// teach_pack.questions / extra_questions 字段仅作为后端旧数据兼容，前端走不到。
interface TeachPack {
  explanation: string
  unit_title?: string
}

interface UnitState {
  unit_index: number
  teach_pack: TeachPack | null
  status: 'pending' | 'teaching' | 'probing' | 'grading' | 'done'
  retries: number
  /**
   * v10 (2026-05) 学习流断点续传：流式被网络中断 / app 崩溃打断时，
   * 后端把已生成的 raw markdown 落盘到这一字段，前端识别后展示「继续生成」按钮，
   * 调用 agent_teach_unit_stream(resume=true) 让模型从断点接着写。
   * 流自然完成时该字段被清空。
   */
  partial_explanation?: string
}

interface AgentTabProps {
  sessionId: string
  currentDisplayPageIndex?: number
  visibleContent?: string
  onJumpPage?: (pageIndex: number) => void
  /**
   * Agent tab 是否处于激活态（用户当前 right pane 选的是"学习"）。
   *
   * AiPaneContainer 用 `hidden` class 切换可见性，所以 AgentTab 组件**一直 mount**。
   * 没有这个 flag 的话，键盘翻屏 effect 在 chat / note tab 激活时也会监听 window，
   * 导致：用户在 ChatTab 按方向键，PDF 翻页同时**后台**的 Agent 屏也偷偷翻了。
   * 同时 ReaderShell 也有 window keydown → 翻 PDF；不区分 active 的话会同时翻 PDF
   * 和 Agent 屏（用户报告的 bug）。
   *
   * 用法：仅在 isActive=true 时拦截方向键，并用 capture phase + stopImmediatePropagation
   * 阻止 ReaderShell 的 PDF 翻页处理。
   */
  isActive?: boolean
}

// 追问轮次：用户发起 → 后端流式 → done / error
interface FollowupItem {
  id: string                 // 客户端生成的 uuid，作为 React key + 事件匹配
  turn_id: string | null     // 后端 turn_id；null 表示尚未拿到（极短时间窗口）
  question: string
  answer: string             // 累积的 markdown 答案
  streaming: boolean
  reasoning?: boolean        // 思考中…
  error?: string
  /** RAG 检索来源（命令返回时带上；点击可跳页） */
  sources?: RagSource[]
  /** screenKey = `${unitIdx}-${localIdx}`，让同一 unit 不同屏的追问可隔离展示 */
  screenKey: string
}

// ── 单元 markdown → 子卡片切分 ─────────────────────────────────────────
//
// 后端 prompt 要求 LLM 按这套锚点输出：
//   ## 第 N 页 · 标题       → page 卡（带正文）
//   ### 第 N 页（跳过：xxx）→ skip 单行
//   ## 本单元概括           → summary 卡（在所有页之后）
//
// 流式中：随着 token 推入，锚点会逐步出现；当前"还没闭合"的最后一段标记 isStreaming = true，
// 这样前端在该子卡尾部显示流式光标。

// v3：以"知识点"为切分锚点（不再按页）。每个 knowledge 段 = 一个 LLM 划分的知识点 +
//   关联页码（标题中给出）+ 富排版正文。
// v5 B3: 题目抽取逻辑移除 —— 后端已不再输出 quiz 围栏，前端仅需从旧数据中
// 剥离可能残留的 quiz / mindmap 围栏文本，避免渲染原始 JSON / mindmap bullet。
export type UnitSection =
  | { kind: 'preface'; body: string; isStreaming?: boolean }
  | {
      kind: 'knowledge'
      kIdx: number
      title?: string
      pages: number[]                 // 关联页码（从标题里解析；可能为空）
      body: string                    // 已剥离旧 quiz / mindmap 围栏后的 clean markdown
      isStreaming?: boolean
    }
  | { kind: 'page'; page: number; title?: string; body: string; isStreaming?: boolean } // 旧数据兼容
  | { kind: 'skip'; page: number; reason?: string }
  | { kind: 'summary'; body: string; isStreaming?: boolean }

// 新锚点：## 知识点 N · 标题（来自 P3-P5 / P3、P5 / P3）
//   - N 数字，可连续；分隔符宽松（· • － - —）
//   - 标题部分尾部圆括号内的 P\d+ 列表会被提取为 pages
const RE_KNOWLEDGE = /^##\s*知识点\s*(\d+)\s*(?:[·•・\-—–]\s*(.+?))?\s*$/
// 旧 v2 page 锚点（保持兼容，迁移期内同时支持）
const RE_PAGE = /^##\s*第\s*(\d+)\s*页(?:\s*[·•・\-—–]\s*(.+?))?\s*$/
const RE_SKIP = /^###\s*第\s*(\d+)\s*页\s*[（(]\s*跳过[:：]?\s*(.*?)\s*[)）]\s*$/
const RE_SUMMARY = /^##\s*本单元(?:概括|小结|总结)\s*$/

// v5 (2026-05) B3: 仅剥离旧数据中可能残留的 quiz / mindmap 围栏。
// 题目抽取逻辑已移除——题目现以训练板块为唯一出口。流式期间未闭合
// 的半开 fence 也顺手抹掉，避免中间态渲染 ```quiz` 这种不完整的原始片段。
const QUIZ_FENCE_RE = /```\s*quiz\s*\r?\n[\s\S]*?\r?\n```/gi
const QUIZ_FENCE_OPEN_RE = /```\s*quiz\s*\r?\n[\s\S]*$/i
const MINDMAP_FENCE_RE = /```\s*mindmap\s*\r?\n[\s\S]*?\r?\n```/gi
const MINDMAP_FENCE_OPEN_RE = /```\s*mindmap\s*\r?\n[\s\S]*$/i
function stripLegacyFences(body: string): string {
  let clean = body.replace(QUIZ_FENCE_RE, '')
  clean = clean.replace(MINDMAP_FENCE_RE, '')
  clean = clean.replace(QUIZ_FENCE_OPEN_RE, '')
  clean = clean.replace(MINDMAP_FENCE_OPEN_RE, '')
  return clean.replace(/\n{3,}/g, '\n\n').trim()
}

// 从知识点标题中抽取关联页码：例如 "标题（来自 P3-P5）" / "标题（P3、P5）" / "标题 P3"
function extractPagesFromTitle(title: string | undefined): { pages: number[]; cleanTitle: string } {
  if (!title) return { pages: [], cleanTitle: '' }
  let cleanTitle = title
  const pages: number[] = []
  // 抓括号内 "来自 P3-P5" / "P3、P5" / "P3, P5"
  const paren = cleanTitle.match(/[（(]\s*(?:来自\s*)?([^()）]*)\s*[)）]\s*$/)
  if (paren) {
    const inside = paren[1]
    const rangeMatches = [...inside.matchAll(/P(\d+)\s*[-–—]\s*P?(\d+)/gi)]
    for (const m of rangeMatches) {
      const a = Number(m[1]), b = Number(m[2])
      const [lo, hi] = a <= b ? [a, b] : [b, a]
      for (let p = lo; p <= hi; p++) pages.push(p)
    }
    // 剩下单独的 P\d+（去除已被 range 吃掉的部分）
    const restStr = inside.replace(/P\d+\s*[-–—]\s*P?\d+/gi, '')
    const singleMatches = [...restStr.matchAll(/P(\d+)/gi)]
    for (const m of singleMatches) pages.push(Number(m[1]))
    cleanTitle = cleanTitle.replace(paren[0], '').trim()
  } else {
    // 没括号，尾部直接 "P3" 形式
    const tail = cleanTitle.match(/\s+P(\d+)(?:\s*[-–—]\s*P?(\d+))?\s*$/)
    if (tail) {
      const a = Number(tail[1])
      const b = tail[2] ? Number(tail[2]) : a
      const [lo, hi] = a <= b ? [a, b] : [b, a]
      for (let p = lo; p <= hi; p++) pages.push(p)
      cleanTitle = cleanTitle.replace(tail[0], '').trim()
    }
  }
  // 去重 + 排序
  const uniq = Array.from(new Set(pages)).sort((a, b) => a - b)
  return { pages: uniq, cleanTitle }
}

export function splitUnitMarkdown(md: string): UnitSection[] {
  if (!md) return []
  const lines = md.split('\n')
  const out: UnitSection[] = []
  type CurKind = 'preface' | 'knowledge' | 'page' | 'summary'
  let cur: {
    kind: CurKind
    body: string
    page?: number
    kIdx?: number
    pages?: number[]
    title?: string
  } | null = null

  const push = () => {
    if (!cur) return
    const body = cur.body.replace(/^\n+|\n+$/g, '')
    if (cur.kind === 'knowledge') {
      // v5 B3: 仅剥离旧 quiz / mindmap 围栏（题目已走训练路径）
      out.push({
        kind: 'knowledge',
        kIdx: cur.kIdx!,
        title: cur.title,
        pages: cur.pages ?? [],
        body: stripLegacyFences(body),
      })
    } else if (cur.kind === 'page') {
      out.push({ kind: 'page', page: cur.page!, title: cur.title, body })
    } else if (cur.kind === 'summary') {
      out.push({ kind: 'summary', body })
    } else if (body) {
      out.push({ kind: 'preface', body })
    }
    cur = null
  }

  for (const line of lines) {
    // ① 知识点锚点（v3 新协议）
    const mK = RE_KNOWLEDGE.exec(line)
    if (mK) {
      push()
      const rawTitle = mK[2]?.trim() ?? ''
      const { pages, cleanTitle } = extractPagesFromTitle(rawTitle)
      cur = {
        kind: 'knowledge',
        kIdx: Number(mK[1]),
        title: cleanTitle || undefined,
        pages,
        body: '',
      }
      continue
    }
    // ② 旧 page 锚点（v2 兼容）
    const mPage = RE_PAGE.exec(line)
    if (mPage) {
      push()
      cur = { kind: 'page', page: Number(mPage[1]), title: mPage[2]?.trim() || undefined, body: '' }
      continue
    }
    // ③ skip 单行
    const mSkip = RE_SKIP.exec(line)
    if (mSkip) {
      push()
      out.push({ kind: 'skip', page: Number(mSkip[1]), reason: mSkip[2]?.trim() || undefined })
      continue
    }
    // ④ 单元小结
    const mSum = RE_SUMMARY.exec(line)
    if (mSum) {
      push()
      cur = { kind: 'summary', body: '' }
      continue
    }
    if (!cur) cur = { kind: 'preface', body: '' }
    cur.body += (cur.body ? '\n' : '') + line
  }
  push()
  return out
}

// 流式态：把最后一个"可流式"的子段标记 isStreaming，用于在尾部展示光标
function markStreamingTail(sections: UnitSection[]): UnitSection[] {
  if (sections.length === 0) return sections
  for (let i = sections.length - 1; i >= 0; i--) {
    const s = sections[i]
    if (s.kind === 'skip') continue
    return sections.map((x, j) => (j === i ? { ...x, isStreaming: true } : x))
  }
  return sections
}

// ── 主组件 ──────────────────────────────────────────────────────────────

// 把后端可能返回的部分 / 旧版 plan 行归一化，保证 outline.units / skip_pages 永远是数组。
// 关键：如果 outline 没有有效的 units（v1 残留行 / LLM 解析失败 / 旧 schema），
//      把 outline 视为 null，让 useEffect 自动 force-regenerate 一份新的 v2 outline，
//      避免前端永远卡在"准备中…"
function normalizePlan(p: AgentPlan | null | undefined): AgentPlan | null {
  if (!p) return null
  const o = p.outline
  if (!o) return { ...p, outline: null }
  const rawUnits = Array.isArray(o.units) ? o.units : []
  if (rawUnits.length === 0) {
    // v1 残留 / 解析失败：当作没有 plan，触发重新生成
    return { ...p, outline: null }
  }
  return {
    ...p,
    outline: {
      thesis: typeof o.thesis === 'string' ? o.thesis : '',
      skip_pages: Array.isArray(o.skip_pages) ? o.skip_pages : [],
      skip_reason: typeof o.skip_reason === 'string' ? o.skip_reason : undefined,
      units: rawUnits.map((u, i) => ({
        id: u?.id ?? `u${i}`,
        title: u?.title ?? `单元 ${i + 1}`,
        pages: Array.isArray(u?.pages) ? u.pages : [],
        key_points: Array.isArray(u?.key_points) ? u.key_points : [],
        needs_quiz: u?.needs_quiz !== false,
        difficulty: typeof u?.difficulty === 'number' ? u.difficulty : 2,
      })),
    },
  }
}

export function AgentTab({ sessionId, isActive = true, onJumpPage }: AgentTabProps) {
  const [plan, setPlan] = useState<AgentPlan | null>(null)
  const [unitStatesMap, setUnitStatesMap] = useState<Record<number, UnitState>>({})

  // 流式状态
  const [streamingText, setStreamingText] = useState('')
  const [streamingTurnId, setStreamingTurnId] = useState<string | null>(null)
  const [reasoning, setReasoning] = useState(false)

  // v4 (2026-05): 题目搬到训练板块；学习区不再答题，原 userAnswers / extraUserAnswers
  // / extraQuestionsMap / extraGenMap / submit callback 已全部移除

  // 追问（不持久化，仅本次会话内）
  // suggestions: 后端讲解 done 后异步生成的 3 条智能追问，按 unit_index 索引
  // items:       用户实际发起的追问 + LLM 回答（按 unit_index 索引）
  const [followupSuggestions, setFollowupSuggestions] = useState<Record<number, string[]>>({})
  const [followupItems, setFollowupItems] = useState<Record<number, FollowupItem[]>>({})

  // 杂项
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [paused, setPaused] = useState(false)
  const [outlineOpen, setOutlineOpen] = useState(false)
  const [mdTheme] = useState<MdTheme>('vibe')
  // v6 (2026-05) #3+ B：生成路线图前先问几个偏好问题
  //   - wizardOpen   : 当前是否在显示 wizard
  //   - wizardForce  : 用户点击「重新生成」时为 true，submit 时 plan_generate(force=true)
  //
  // v6 (2026-05) #3++ 修订（用户反馈："每次进入都强制弹 wizard"）：
  //   - 删除 sessionStorage `wizardSeen` 标志 —— 这个概念本身错了：
  //     它会让"已有 active plan 但 sessionStorage 被清"也强制弹 wizard。
  //   - 真正的判断条件是「**后端是否已经有 active plan + 有效 outline**」。
  //   - 加 `loaded` 状态避免首屏 plan 还在 loading 时被误判为 planInvalid。
  //
  // v9 (2026-05) 用户反馈："切到其他标签页再回来，wizard 又关闭了"：
  //   - wizardOpen / wizardForce 持久化到 sessionStorage（按 sessionId 隔离）
  //   - 这是为了 plan 仍有效但用户已点「重新生成」的场景：
  //       用户点 → wizardOpen=true + wizardForce=true → 切走 → unmount 丢 state
  //       → 切回来 plan 还在，Auto-Pilot 不会自动重开 wizard
  //       → 没持久化的话用户的「重新生成」意图被吞掉，看到的是旧学习屏
  //   - 提交 / 取消 / 自动关闭时已有 set(false) 调用，配合 effect 自动清 storage
  //   - sessionStorage 在窗口关闭时清，符合"软件没关就不丢"的语义
  const [wizardOpen, setWizardOpen] = useState<boolean>(() => {
    try {
      return sessionStorage.getItem(`agent:wizardOpen:${sessionId}`) === '1'
    } catch {
      return false
    }
  })
  const [wizardForce, setWizardForce] = useState<boolean>(() => {
    try {
      return sessionStorage.getItem(`agent:wizardForce:${sessionId}`) === '1'
    } catch {
      return false
    }
  })

  // wizardOpen / wizardForce → sessionStorage 同步
  useEffect(() => {
    try {
      const k = `agent:wizardOpen:${sessionId}`
      if (wizardOpen) sessionStorage.setItem(k, '1')
      else sessionStorage.removeItem(k)
    } catch {
      /* ignore quota / privacy mode */
    }
  }, [wizardOpen, sessionId])
  useEffect(() => {
    try {
      const k = `agent:wizardForce:${sessionId}`
      if (wizardForce) sessionStorage.setItem(k, '1')
      else sessionStorage.removeItem(k)
    } catch {
      /* ignore quota / privacy mode */
    }
  }, [wizardForce, sessionId])
  const [loaded, setLoaded] = useState(false)
  // v6 (2026-05) #3++ 修复（用户反馈："完成态面板妨碍重温讲解"）：
  //   phase==='done' 时不再 early return DoneReport 全屏挡住讲解；
  //   改为顶部一条可关闭的 sticky banner，主屏继续渲染讲解屏，用户可滚动重温。
  const [doneBannerDismissed, setDoneBannerDismissed] = useState(false)

  // v6 (2026-05) #3+ 修订：'agent-open-archive' 事件改由 LearningHistoryPanel 监听并处理。
  // AgentTab 不再持有覆盖式档案弹层；这里删掉旧 listener 避免双触发。

  // 防抖：每个 unit 仅触发一次 teach_stream（手动 retry 时清掉对应项）
  const teachStartedRef = useRef<Set<number>>(new Set())
  const planRequestedRef = useRef(false)
  const autoNextTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const planRef = useRef<AgentPlan | null>(null)
  // 预生成调度：当前正在 prefetch 的 unit_index（串行；事件 done/error 时清掉）
  const prefetchingRef = useRef<Set<number>>(new Set())

  // ── v4 (2026-05) 学习↔笔记双向同步 ──────────────────────────────────────
  // 注意：本文件从 lucide-react 导入了 `Map` 图标，遮蔽了 ES 全局 Map 构造函数，
  // 所以下面用 plain Record / object 替代。
  // 每个 unit 的 notebook_entry_id 缓存（按需异步拉取；deterministic 后不变）
  const unitEntryIdsRef = useRef<Record<number, string>>({})
  const entryFetchingRef = useRef<Set<number>>(new Set())
  // 用户编辑期间防抖 autosave 计时器（按 unitIdx 隔离）
  const saveTimersRef = useRef<Record<number, ReturnType<typeof setTimeout>>>({})
  // 自身刚 update_entry 触发的回声：忽略短期内（1500ms）的 agent-unit-explanation-updated 事件
  const lastSelfEditAtRef = useRef<Record<number, number>>({})
  // 编辑器 epoch（按 unitIdx 隔离）：外部回写时 +1 让该 unit 的所有 MarkdownEditor remount
  const [editorEpochs, setEditorEpochs] = useState<Record<number, number>>({})
  // 已 reveal 完打字机的 screen.id 集合：再次翻回该屏直接全显，不重复打字
  const revealedScreensRef = useRef<Set<string>>(new Set())

  // ── v5 (2026-05) B2: 学习↔训练同步生成 pack ─────────────────────────────
  // 后端在每个单元讲解 done 后异步调 LLM 生成训练 pack 并写入 training_unit_packs；
  // 前端在每个单元最后一屏底部显示「练习本单元 →」按钮，按 ready 状态切换 UI。
  const [unitPacksReady, setUnitPacksReady] = useState<Record<number, number>>({})  // unitIdx → questionCount

  useEffect(() => {
    planRef.current = plan
  }, [plan])

  // ── 状态拉取 ───────────────────────────────────────────────────────
  const refresh = useCallback(async () => {
    try {
      const r = await invoke<{ plan: AgentPlan | null; unit_states: UnitState[] }>(
        'agent_get_state',
        { sessionId },
      )
      setPlan(normalizePlan(r.plan))
      const map: Record<number, UnitState> = {}
      for (const us of r.unit_states ?? []) {
        map[us.unit_index] = us
      }
      setUnitStatesMap(map)
    } catch (e) {
      console.error('agent_get_state 失败', e)
    } finally {
      // v6 #3++：标记首屏数据已 settle，Auto-Pilot 才能据此判断 planInvalid
      setLoaded(true)
    }
  }, [sessionId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // v5 (2026-05) B2: 初次加载时拉已 ready 的 unit packs（前端首次进入 / 路由跳转）
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const list = await invoke<Array<{ unit_index: number; question_count: number }>>(
          'training_list_unit_packs',
          { sessionId },
        )
        if (cancelled) return
        const next: Record<number, number> = {}
        for (const r of list ?? []) next[r.unit_index] = r.question_count
        setUnitPacksReady(next)
      } catch (e) {
        console.warn('[AgentTab] training_list_unit_packs 失败', e)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [sessionId])

  // ── 流式事件订阅（一次安装，永久有效） ──────────────────────────────
  useEffect(() => {
    const unlistens: UnlistenFn[] = []
    let cancelled = false

    void (async () => {
      // v10 (2026-05) 断点续传：start 事件可能带 resumed=true + partial 字段，
      // 表示这次 teach_stream 是从已有断点续写。把 streamingText 初始化为 partial，
      // 后续 token 自动拼到尾部，UI 看到的内容连贯。
      const startU = await listen<{
        turn_id: string
        unit_index: number
        resumed?: boolean
        partial?: string
      }>('agent-teach-start', (ev) => {
        if (ev.payload.resumed && typeof ev.payload.partial === 'string' && ev.payload.partial.length > 0) {
          setStreamingTurnId(ev.payload.turn_id)
          setStreamingText(ev.payload.partial)
        }
      })
      const tokenU = await listen<{ turn_id: string; delta: string }>(
        'agent-teach-token',
        (ev) => {
          // 只接受当前 turn 的 token（避免老 turn 的尾包污染）
          setStreamingTurnId((cur) => {
            if (cur && ev.payload.turn_id !== cur) return cur
            setStreamingText((t) => t + ev.payload.delta)
            return cur ?? ev.payload.turn_id
          })
        },
      )
      const reasoningU = await listen<{ turn_id: string; phase: string }>(
        'agent-teach-reasoning',
        (ev) => {
          setStreamingTurnId((cur) => cur ?? ev.payload.turn_id)
          setReasoning(ev.payload.phase === 'start')
        },
      )
      const doneU = await listen<{ turn_id: string }>('agent-teach-done', () => {
        setStreamingTurnId(null)
        setReasoning(false)
        setStreamingText('')
        // 后端在 emit done 之前已持久化 teach_pack，这里 refresh 拿到最终态
        void refresh()
      })
      const errorU = await listen<{
        turn_id: string
        error: string
        unit_index?: number
        has_partial?: boolean
        partial_len?: number
      }>(
        'agent-teach-error',
        (ev) => {
          setStreamingTurnId(null)
          setReasoning(false)
          setStreamingText('')
          // v10 (2026-05) 断点续传：错误信息里如果带 has_partial，UI 提示用户可以续传
          const baseMsg = ev.payload.error
          const friendly = ev.payload.has_partial
            ? `${baseMsg}\n\n已为你保留断点（约 ${ev.payload.partial_len ?? 0} 字），可点击「继续生成」从断点续写。`
            : baseMsg
          setError(friendly)
          // 释放当前单元的 ref，让用户可以 retry / resume
          const cu = planRef.current?.current_unit
          if (typeof cu === 'number') teachStartedRef.current.delete(cu)
          // 拿到最新 partial_explanation（让「继续生成」按钮立刻可见）
          void refresh()
        },
      )
      // ── 追问相关事件 ──────────────────────────────────────────────
      // 后端讲解 done 后异步推送智能追问建议（3 个）
      const fpSuggU = await listen<{ unit_index: number; followups: string[] }>(
        'agent-teach-followups',
        (ev) => {
          setFollowupSuggestions((m) => ({
            ...m,
            [ev.payload.unit_index]: ev.payload.followups,
          }))
        },
      )

      // 匹配策略：优先按 turn_id 精确匹配；没注入 turn_id 时（短暂窗口）回退到
      // "该单元内 streaming=true 的项"。每个单元同时只允许 1 个进行中追问。
      const patchFollowup = (
        unitIndex: number,
        turnId: string,
        patch: (it: FollowupItem) => FollowupItem,
      ) => {
        setFollowupItems((m) => {
          const list = m[unitIndex] ?? []
          if (list.length === 0) return m
          const byTurn = list.find((it) => it.turn_id === turnId)
          const target = byTurn ?? list.find((it) => it.streaming)
          if (!target) return m
          return {
            ...m,
            [unitIndex]: list.map((it) => (it.id === target.id ? patch(it) : it)),
          }
        })
      }

      const fpTokU = await listen<{ turn_id: string; unit_index: number; delta: string }>(
        'agent-followup-token',
        (ev) => {
          patchFollowup(ev.payload.unit_index, ev.payload.turn_id, (it) => ({
            ...it,
            // 第一次见到 token 时也把 turn_id 锁住（避免之后跑题）
            turn_id: it.turn_id ?? ev.payload.turn_id,
            answer: it.answer + ev.payload.delta,
          }))
        },
      )
      const fpReasonU = await listen<{ turn_id: string; unit_index: number; phase: string }>(
        'agent-followup-reasoning',
        (ev) => {
          patchFollowup(ev.payload.unit_index, ev.payload.turn_id, (it) => ({
            ...it,
            turn_id: it.turn_id ?? ev.payload.turn_id,
            reasoning: ev.payload.phase === 'start',
          }))
        },
      )
      const fpDoneU = await listen<{ turn_id: string; unit_index: number; full: string; sources?: RagSource[] }>(
        'agent-followup-done',
        (ev) => {
          patchFollowup(ev.payload.unit_index, ev.payload.turn_id, (it) => ({
            ...it,
            turn_id: ev.payload.turn_id,
            answer: ev.payload.full,
            streaming: false,
            reasoning: false,
            sources: ev.payload.sources ?? it.sources,
          }))
        },
      )
      const fpErrU = await listen<{ turn_id: string; unit_index: number; error: string }>(
        'agent-followup-error',
        (ev) => {
          patchFollowup(ev.payload.unit_index, ev.payload.turn_id, (it) => ({
            ...it,
            turn_id: ev.payload.turn_id,
            streaming: false,
            reasoning: false,
            error: ev.payload.error,
          }))
        },
      )

      // ── Prefetch 事件 ──────────────────────────────────────────────
      // prefetch-done: 静默生成完成 → 清掉 in-flight ref + refresh 拿新 teach_pack
      const prefDoneU = await listen<{ unit_index: number }>(
        'agent-prefetch-done',
        (ev) => {
          prefetchingRef.current.delete(ev.payload.unit_index)
          void refresh()
        },
      )
      const prefErrU = await listen<{ unit_index: number; error: string }>(
        'agent-prefetch-error',
        (ev) => {
          prefetchingRef.current.delete(ev.payload.unit_index)
          console.warn(`prefetch u${ev.payload.unit_index} 失败:`, ev.payload.error)
        },
      )
      // teach-cached: prefetch 已就绪的单元再被 teach_stream 触发时短路命中
      const cachedU = await listen<{ unit_index: number; phase: string }>(
        'agent-teach-cached',
        () => {
          void refresh()
        },
      )

      // v4 (2026-05): agent-extra-quiz-* 系列事件已废弃 —— 题目搬到训练板块

      // ── 笔记本 → 学习区反向同步 ──────────────────────────────────────
      // notebook_update_entry 后端会回写 teach_pack.explanation 并 emit 此事件。
      // 处理：① 短期回声忽略（1500ms 内自身 update 触发的不计）；
      //       ② 真正外部更新：refresh 拉新 explanation + 该 unit 的 editor epoch +1
      //          让 MarkdownEditor remount 用新内容 defaultValue。
      const explUpdU = await listen<{ session_id: string; unit_index: number }>(
        'agent-unit-explanation-updated',
        (ev) => {
          if (ev.payload.session_id !== sessionId) return
          const ui = ev.payload.unit_index
          const lastSelf = lastSelfEditAtRef.current[ui] ?? 0
          if (Date.now() - lastSelf < 1500) return // 自身回声，忽略
          void refresh()
          setEditorEpochs((m) => ({ ...m, [ui]: (m[ui] ?? 0) + 1 }))
        },
      )

      // v5 (2026-05) B2: 训练 pack 就绪事件 —— 后端生成完单元训练题后推送
      const tpReadyU = await listen<{
        session_id: string
        unit_index: number
        question_count: number
      }>('training-pack-ready', (ev) => {
        if (ev.payload.session_id !== sessionId) return
        setUnitPacksReady((m) => ({ ...m, [ev.payload.unit_index]: ev.payload.question_count }))
      })

      // v7 (2026-05) 档案管理鲁棒性：监听 agent-archive-changed
      //   - reason="restored" : 档案恢复 → 清理所有 in-memory 流式状态 + refresh，
      //                         避免恢复后看到旧的 streaming text / followup 残留
      //   - reason="saved"    : 主动归档（一般在 reset 前）→ refresh 即可
      //   - reason="deleted"/"renamed" : 不影响 active state，仍 refresh 一次保持一致
      const archiveChangedU = await listen<{
        session_id: string
        archive_id: string
        reason: 'saved' | 'restored' | 'deleted' | 'renamed'
      }>('agent-archive-changed', (ev) => {
        if (ev.payload.session_id !== sessionId) return
        if (ev.payload.reason === 'restored') {
          // 恢复后用户期望从干净状态开始；清理流式 + 错误 + 已渲染屏标记
          setStreamingTurnId(null)
          setStreamingText('')
          setReasoning(false)
          setError('')
          setFollowupItems({})
          setFollowupSuggestions({})
          teachStartedRef.current.clear()
          prefetchingRef.current.clear()
          revealedScreensRef.current.clear()
          setCurrentScreenIdx(0)
          prevScreensLenRef.current = 0
          setDoneBannerDismissed(false)
          // 触发所有 unit 的 editor epoch +1 → MarkdownEditor 全部 remount，
          // 用新 defaultValue 显示档案里的内容
          setEditorEpochs((m) => {
            const next: Record<number, number> = {}
            for (const k of Object.keys(m)) next[+k] = (m[+k] ?? 0) + 1
            return next
          })
        }
        void refresh()
      })

      if (cancelled) {
        startU(); tokenU(); reasoningU(); doneU(); errorU()
        fpSuggU(); fpTokU(); fpReasonU(); fpDoneU(); fpErrU()
        prefDoneU(); prefErrU(); cachedU()
        explUpdU(); tpReadyU(); archiveChangedU()
      } else {
        unlistens.push(
          startU, tokenU, reasoningU, doneU, errorU,
          fpSuggU, fpTokU, fpReasonU, fpDoneU, fpErrU,
          prefDoneU, prefErrU, cachedU,
          explUpdU, tpReadyU, archiveChangedU,
        )
      }
    })()

    return () => {
      cancelled = true
      unlistens.forEach((fn) => fn?.())
    }
  }, [refresh, sessionId])

  // v4 (2026-05): 加题持久化合并 + generateExtraQuizzes 已移除（题目搬到训练板块）

  // ── v4 (2026-05) 学习→笔记本前向同步 ─────────────────────────────────
  // 用户在 knowledge 屏 MarkdownEditor 编辑后，800ms 防抖后 update notebook entry。
  // 后端 notebook_update_entry 会自动回写 teach_pack.explanation 实现双向一致；
  // 同时 emit agent-unit-explanation-updated 事件 —— 我们用 lastSelfEditAtRef 时间戳
  // 抑制 1.5s 内的回声（避免本地编辑器刚刚 commit 又被 remount）。
  const ensureUnitEntry = useCallback(
    async (unitIdx: number): Promise<string | null> => {
      const cached = unitEntryIdsRef.current[unitIdx]
      if (cached) return cached
      if (entryFetchingRef.current.has(unitIdx)) return null
      entryFetchingRef.current.add(unitIdx)
      try {
        const r = await invoke<{ entry_id: string; notebook_id: string; exists: boolean }>(
          'agent_get_unit_entry_id',
          { sessionId, unitIndex: unitIdx },
        )
        if (r.exists) {
          unitEntryIdsRef.current[unitIdx] = r.entry_id
          return r.entry_id
        }
        return null
      } catch (e) {
        console.warn(`[ensureUnitEntry u${unitIdx}] 失败:`, e)
        return null
      } finally {
        entryFetchingRef.current.delete(unitIdx)
      }
    },
    [sessionId],
  )

  const saveExplanation = useCallback(
    (unitIdx: number, content: string) => {
      // 取消上次未完成的 timer
      const existing = saveTimersRef.current[unitIdx]
      if (existing) clearTimeout(existing)
      saveTimersRef.current[unitIdx] = setTimeout(async () => {
        delete saveTimersRef.current[unitIdx]
        const entryId = await ensureUnitEntry(unitIdx)
        if (!entryId) return // entry 还没生成（流式中或 LLM 失败）跳过
        const title =
          planRef.current?.outline?.units?.[unitIdx]?.title ?? `单元 ${unitIdx + 1}`
        try {
          lastSelfEditAtRef.current[unitIdx] = Date.now()
          await notebooksApi.updateEntry({ entryId, title, content })
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e))
        }
      }, 800)
    },
    [ensureUnitEntry],
  )

  // 卸载时清理所有挂着的 save timers（防止 setError 在 unmount 后调用）
  useEffect(
    () => () => {
      for (const t of Object.values(saveTimersRef.current)) clearTimeout(t)
      saveTimersRef.current = {}
    },
    [],
  )

  // ── 派生数据 ──────────────────────────────────────────────────────
  const phase: AgentPhase = plan?.current_phase ?? 'idle'
  const currentUnitIndex = plan?.current_unit ?? 0
  const units = plan?.outline?.units ?? []
  const currentUnit = units[currentUnitIndex] ?? null
  const currentUnitState = unitStatesMap[currentUnitIndex]
  const teachPack = currentUnitState?.teach_pack ?? null

  // v4 (2026-05): answers / allCorrect 已移除 —— 学习区不再答题，原 auto-next 全对 1.5s 分支已删

  // ── Auto-Pilot：phase=idle 时自动下一步 ─────────────────────────────
  useEffect(() => {
    if (paused || busy || streamingTurnId) return

    // (1) 没路线图（或 outline 无效）→ 弹 Wizard 收集偏好
    //
    // v6 (2026-05) #3++ 修订（用户反馈："每次进入都强制弹 wizard"）：
    //   - 必须等 `loaded=true`（首次 refresh 已 settle）后才能判断 planInvalid，
    //     否则 plan 还在 loading 时被误判成无 plan，强制弹 wizard。
    //   - 删除 sessionStorage `wizardSeen` 标志：有 active plan 就**永远不弹**，
    //     无 plan 才弹 —— 这是符合用户直觉的真实判断条件。
    //   - 用户主动点「重新生成」走 reopenWizardForceRegenerate，独立路径。
    if (!loaded) return
    const planInvalid = !plan || !plan.outline
    if (planInvalid && !planRequestedRef.current && !wizardOpen) {
      setWizardOpen(true)
      setWizardForce(false)
      return
    }

    // (2) 路线图已就绪 + phase=idle + 当前单元尚未启动流 → 触发流式教学
    //     如果当前单元已被 prefetch（teach_pack 非空），后端会立即短路返回 status=cached
    //     并把 phase 推到 probing/reviewing，前端 refresh 后 quiz 屏自动显示。
    //
    // v10 (2026-05) 断点续传：当前单元如果存在 partial_explanation（上次因网络中断
    //   留下的断点），**不**自动重新拉流 —— 那会让模型从头再来一遍，丢失已生成内容。
    //   交给用户主动点「继续生成」按钮（调 startTeachStream(resume=true)）。
    const hasPartialPending =
      !!currentUnitState?.partial_explanation &&
      currentUnitState.partial_explanation.trim().length > 0 &&
      !currentUnitState?.teach_pack?.explanation
    if (
      plan &&
      phase === 'idle' &&
      currentUnit &&
      !hasPartialPending &&
      !teachStartedRef.current.has(currentUnitIndex)
    ) {
      teachStartedRef.current.add(currentUnitIndex)
      void (async () => {
        setError('')
        try {
          const r = await invoke<{
            turn_id?: string
            status?: string
            needs_quiz?: boolean
          }>('agent_teach_unit_stream', { sessionId, unitIndex: currentUnitIndex })
          // Prefetch 命中：status=cached，没有 turn_id；只需 refresh 拿新 phase
          if (r.status === 'cached') {
            await refresh()
            return
          }
          // 立即固定 turnId 防 race
          if (r.turn_id) {
            setStreamingTurnId(r.turn_id)
            setStreamingText('')
          }
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e))
          teachStartedRef.current.delete(currentUnitIndex)
        }
      })()
    }
  }, [loaded, paused, busy, streamingTurnId, plan, phase, currentUnit, currentUnitIndex, currentUnitState?.partial_explanation, currentUnitState?.teach_pack?.explanation, refresh, sessionId, wizardOpen])

  // ── Prefetch 调度：后台串行生成 currentUnit 之后的单元 ──────────────
  //   - 串行（同一时刻只跑一个），避免 LLM 限速 / 过载
  //   - 跳过 currentUnit（由 teach_stream 接管）+ 已有 teach_pack 的单元
  //   - 完成由 agent-prefetch-done 事件触发 refresh，本 effect 重跑找下一个
  useEffect(() => {
    if (!plan?.outline) return
    if (paused) return
    if (prefetchingRef.current.size > 0) return // 串行：等当前完成
    const total = plan.outline.units.length
    for (let i = currentUnitIndex + 1; i < total; i++) {
      const us = unitStatesMap[i]
      if (us?.teach_pack?.explanation) continue
      prefetchingRef.current.add(i)
      void (async () => {
        try {
          const r = await invoke<{ status: string }>('agent_prefetch_unit', {
            sessionId,
            unitIndex: i,
          })
          if (r.status === 'cached') {
            // 命中数据库缓存（无需 LLM）→ 立即清理并刷新
            prefetchingRef.current.delete(i)
            await refresh()
          }
          // 否则等 agent-prefetch-done 事件触发清理 + refresh
        } catch (e) {
          console.warn(`prefetch u${i} 启动失败:`, e)
          prefetchingRef.current.delete(i)
        }
      })()
      break // 只启动一个，等它结束本 effect 会重跑
    }
  }, [plan, currentUnitIndex, unitStatesMap, paused, sessionId, refresh])

  // ── advance ───────────────────────────────────────────────────────
  const advance = useCallback(
    async (action: 'next' | 'retry' | 'pause') => {
      setBusy(true)
      setError('')
      if (autoNextTimerRef.current) {
        clearTimeout(autoNextTimerRef.current)
        autoNextTimerRef.current = null
      }
      try {
        await invoke('agent_advance', { sessionId, action })
        // next / retry 都需要让 useEffect 在下一帧重新触发流
        if (action === 'next' || action === 'retry') {
          teachStartedRef.current.delete(currentUnitIndex)
        }
        await refresh()
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setBusy(false)
      }
    },
    [sessionId, currentUnitIndex, refresh],
  )

  // ── 断点续传：从已有 partial 接着流式生成（v10 2026-05） ─────────────
  // 触发时机：
  //   1. 用户点击错误条 / 中断提示中的「继续生成」按钮
  //   2. 进入面板时检测到当前单元有 partial_explanation 但无 teach_pack（页面刷新后的恢复路径）
  //
  // 与「重试」的区别：retry 会清空 partial 重头生成；resume 把 partial 作为续写起点。
  const resumeTeach = useCallback(
    async (unitIdx: number) => {
      setError('')
      teachStartedRef.current.add(unitIdx)
      try {
        const r = await invoke<{
          turn_id?: string
          status?: string
          resumed?: boolean
        }>('agent_teach_unit_stream', {
          sessionId,
          unitIndex: unitIdx,
          resume: true,
        })
        if (r.status === 'cached') {
          await refresh()
          return
        }
        // streamingText 由 agent-teach-start 事件统一注入 partial（resumed=true 时）
        if (r.turn_id && !r.resumed) {
          // 后端没识别到 partial（DB 已被清空或别的并发原因）→ 当作普通新流
          setStreamingTurnId(r.turn_id)
          setStreamingText('')
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
        teachStartedRef.current.delete(unitIdx)
      }
    },
    [sessionId, refresh],
  )

  // v4 (2026-05): submit / agent_submit_answers 已移除（题目搬到训练板块）

  // ── pause / resume ────────────────────────────────────────────────
  const togglePause = useCallback(async () => {
    if (paused) {
      setPaused(false) // useEffect 自动续上
    } else {
      setPaused(true)
      try {
        await invoke('agent_advance', { sessionId, action: 'pause' })
      } catch {
        /* 忽略 */
      }
    }
  }, [paused, sessionId])

  // ── reset ─────────────────────────────────────────────────────────
  //
  // v6 (2026-05) #3+ 行为变更：
  //   - 之前 reset 会**直接丢失**学习流（plan + units 全删）
  //   - 现在后端 agent_reset 内部已经自动归档；前端只需 reset 本地 state，
  //     下一轮 Auto-Pilot 检测到 plan 为空会自动弹 wizard。
  const resetAll = useCallback(async () => {
    if (!window.confirm('确定重置学习流？当前进度会自动归档到「档案」面板，可随时回看。')) return
    setBusy(true)
    setError('')
    try {
      await invoke('agent_reset', { sessionId })
      teachStartedRef.current.clear()
      planRequestedRef.current = false
      setStreamingText('')
      setStreamingTurnId(null)
      setUnitStatesMap({})
      setPlan(null)
      setPaused(false)
      setFollowupSuggestions({})
      setFollowupItems({})
      setUnitPacksReady({})
      prefetchingRef.current.clear()
      revealedScreensRef.current.clear()
      setCurrentScreenIdx(0)
      prevScreensLenRef.current = 0
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [sessionId, refresh])

  // ── Wizard 提交：把 user_preferences 透传给 agent_plan_generate ───
  const handleWizardSubmit = useCallback(
    async (userPreferences: string | null) => {
      setWizardOpen(false)
      planRequestedRef.current = true
      setBusy(true)
      setError('')
      try {
        await invoke('agent_plan_generate', {
          sessionId,
          force: wizardForce,
          userPreferences,
        })
        await refresh()
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
        planRequestedRef.current = false
      } finally {
        setBusy(false)
        setWizardForce(false)
      }
    },
    [sessionId, refresh, wizardForce],
  )

  // 显式重新生成（顶栏「重新生成」按钮）：清当前 plan，弹 wizard force 流程
  const reopenWizardForceRegenerate = useCallback(() => {
    setWizardForce(true)
    setWizardOpen(true)
  }, [])

  // ── 追问发起 ──────────────────────────────────────────────────────
  // 按 (unitIndex, screenKey) 隔离：同一屏内同时只允许一个 in-flight 追问；
  // 不同屏可并发。后端不感知 screenKey，仅前端用来分桶展示。
  const startFollowup = useCallback(
    async (unitIndex: number, screenKey: string, question: string) => {
      const q = question.trim()
      if (!q) return
      const existing = followupItems[unitIndex] ?? []
      // 该屏已有 in-flight → 拒绝
      if (existing.some((it) => it.screenKey === screenKey && it.streaming)) return

      const id = `fp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
      const newItem: FollowupItem = {
        id,
        turn_id: null,
        question: q,
        answer: '',
        streaming: true,
        screenKey,
      }
      setFollowupItems((m) => ({ ...m, [unitIndex]: [...existing, newItem] }))

      // 给后端的 prev_followups：同屏已答完的（保持每屏对话连续性）
      const prev: Array<[string, string]> = existing
        .filter(
          (it) =>
            it.screenKey === screenKey &&
            !it.streaming &&
            !it.error &&
            it.answer.trim().length > 0,
        )
        .map((it) => [it.question, it.answer])

      try {
        const r = await invoke<{ turn_id: string; unit_index: number; sources?: RagSource[] }>('agent_followup_stream', {
          sessionId,
          unitIndex,
          question: q,
          prevFollowups: prev,
        })
        setFollowupItems((m) => ({
          ...m,
          [unitIndex]: (m[unitIndex] ?? []).map((it) =>
            it.id === id ? { ...it, turn_id: r.turn_id, sources: r.sources ?? it.sources } : it,
          ),
        }))
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        setFollowupItems((m) => ({
          ...m,
          [unitIndex]: (m[unitIndex] ?? []).map((it) =>
            it.id === id ? { ...it, streaming: false, error: msg } : it,
          ),
        }))
      }
    },
    [sessionId, followupItems],
  )

  // ── 渲染辅助 ──────────────────────────────────────────────────────
  const totalUnits = units.length
  const completedUnits = Object.values(unitStatesMap).filter((u) => u.status === 'done').length
  const progressPct = totalUnits > 0 ? (completedUnits / totalUnits) * 100 : 0

  // ── Screens 模型：跨 unit 拉平的"翻页阅读"序列 ──────────────────────
  // 每屏 = 一个 page section / summary / preface / quiz；skip 不独占屏，
  // 而是吸附在下一个 page 屏顶部作为"跳过提示带"。
  // 整本书形成一个连续 pager：用户向左翻可一直翻到第 1 屏（复习），
  // 向右翻不能超过当前 LLM 已生成的最后一屏（流式中会持续追加）。
  type ScreenSkip = { page: number; reason?: string }
  type Screen =
    | {
        id: string
        kind: 'knowledge'
        unitIdx: number
        localIdx: number
        kIdx: number                  // 知识点编号（在 unit 内 1..6）
        title?: string
        pages: number[]               // 关联页码
        body: string
        skipsAbove: ScreenSkip[]      // 该知识点之前出现的 skip 行
        isStreaming?: boolean
      }
    | {
        id: string
        kind: 'page'               // 旧数据兼容
        unitIdx: number
        localIdx: number
        pageNum: number
        title?: string
        body: string
        skipsAbove: ScreenSkip[]
        isStreaming?: boolean
      }
    | {
        id: string
        kind: 'summary'
        unitIdx: number
        localIdx: number
        body: string
        isStreaming?: boolean
      }
    | {
        id: string
        kind: 'preface'
        unitIdx: number
        localIdx: number
        body: string
        isStreaming?: boolean
      }

  const screens: Screen[] = useMemo(() => {
    const arr: Screen[] = []
    // v11 (2026-05) 修复"前端只能看到一个单元"：原版上限 i <= currentUnitIndex 把
    //   已 prefetched 的未来单元从 screens 排除，导致 PagerBar/RoadmapNav 都翻/跳不过去。
    //   改为遍历全部 units —— md 为空（未来单元尚未 prefetch 完成）时下方 if(md) 自动跳过，
    //   不会插入空屏；prefetched 完成的单元则正常加入，让翻页/路线图导航真正可用。
    for (let i = 0; i < units.length; i++) {
      const u = units[i]
      if (!u) continue
      const us = unitStatesMap[i]
      const persisted = us?.teach_pack?.explanation ?? ''
      const isStreamingThis = i === currentUnitIndex && !!streamingTurnId
      // v10 (2026-05) 断点续传：当前单元正在 streaming 用 streamingText；
      // 否则优先 persisted（teach_pack 完整）；都没有时回退到 partial_explanation
      // —— 让用户在网络中断后仍能看见已生成的部分内容（只读，等待「继续生成」）
      // 未来单元（i > currentUnitIndex）只有 persisted 才会有内容，partial 不参与。
      const partial = i === currentUnitIndex ? (us?.partial_explanation ?? '') : ''
      const md = isStreamingThis
        ? streamingText
        : persisted || (partial.trim().length > 0 ? partial : '')
      let localIdx = 0
      if (md) {
        let sections = splitUnitMarkdown(md)
        if (isStreamingThis) sections = markStreamingTail(sections)
        let pendingSkips: ScreenSkip[] = []
        for (const sec of sections) {
          if (sec.kind === 'skip') {
            pendingSkips.push({ page: sec.page, reason: sec.reason })
            continue
          }
          // ★ v3 知识点屏（主路径）
          if (sec.kind === 'knowledge') {
            // v5 B3: 题目走训练路径后，这里不再需要 inlineQuestions。
            arr.push({
              id: `u${i}-l${localIdx}`,
              kind: 'knowledge',
              unitIdx: i,
              localIdx,
              kIdx: sec.kIdx,
              title: sec.title,
              pages: sec.pages,
              body: sec.body,
              skipsAbove: pendingSkips,
              isStreaming: sec.isStreaming,
            })
            pendingSkips = []
            localIdx++
            continue
          }
          // 旧 v2 page 数据兼容
          if (sec.kind === 'page') {
            arr.push({
              id: `u${i}-l${localIdx}`,
              kind: 'page',
              unitIdx: i,
              localIdx,
              pageNum: sec.page,
              title: sec.title,
              body: sec.body,
              skipsAbove: pendingSkips,
              isStreaming: sec.isStreaming,
            })
            pendingSkips = []
            localIdx++
            continue
          }
          if (sec.kind === 'summary') {
            arr.push({
              id: `u${i}-l${localIdx}`,
              kind: 'summary',
              unitIdx: i,
              localIdx,
              body: sec.body,
              isStreaming: sec.isStreaming,
            })
            localIdx++
            continue
          }
          // preface（罕见：流式还没看到第一个锚点时的承接句）
          arr.push({
            id: `u${i}-l${localIdx}`,
            kind: 'preface',
            unitIdx: i,
            localIdx,
            body: sec.body,
            isStreaming: sec.isStreaming,
          })
          localIdx++
        }
      }

      // v4 (2026-05): 题目搬到训练板块 —— 学习区不再 push 'quiz' 屏
      // 旧数据兼容：us.teach_pack.questions 仍可能有值（老会话存留），但学习区不再呈现
    }
    return arr
  }, [units, currentUnitIndex, unitStatesMap, streamingTurnId, streamingText])

  // ── 当前屏指针 + 自动跟随末屏 ─────────────────────────────────────
  const [currentScreenIdx, setCurrentScreenIdx] = useState(0)
  const prevScreensLenRef = useRef(0)
  // v8 (2026-05) 修复"LLM 流式生成时自动翻页跟随最新内容"：
  //   原版只要新增屏（哪怕 currentScreenIdx 巧合等于 prevLen-1）就跟到末屏。
  //   streaming 期间这意味着用户读着屏 0，下一个屏出现时被推到屏 1，
  //   不停被追翻。
  //
  //   新逻辑：
  //   - **streaming 期间一律不跟随**（保持用户阅读位置；用户可用 PagerBar
  //     看到"生成中… 还有 N 屏未读"提示，主动按下一屏翻）
  //   - 非 streaming 一次性扩展（如档案恢复后拉到全量讲解、prefetch 命中）→
  //     按"用户在原末屏才跟"的旧逻辑
  useLayoutEffect(() => {
    const prevLen = prevScreensLenRef.current
    prevScreensLenRef.current = screens.length
    if (screens.length === 0) {
      setCurrentScreenIdx(0)
      return
    }
    // 越界纠正（screens 缩短，比如 reset / restore 后）
    if (currentScreenIdx >= screens.length) {
      setCurrentScreenIdx(screens.length - 1)
      return
    }
    // streaming 中保持指针不动
    if (streamingTurnId) return
    // 非 streaming 一次性扩展：用户在原末屏 → 跟到新末屏
    if (currentScreenIdx === prevLen - 1 && screens.length > prevLen) {
      setCurrentScreenIdx(screens.length - 1)
    }
  }, [screens.length, currentScreenIdx, streamingTurnId])

  const canPrev = currentScreenIdx > 0
  const canNext = currentScreenIdx < screens.length - 1
  const goPrev = useCallback(() => {
    setCurrentScreenIdx((i) => Math.max(0, i - 1))
  }, [])
  const goNext = useCallback(() => {
    setCurrentScreenIdx((i) => Math.min(screens.length - 1, i + 1))
  }, [screens.length])
  const jumpToUnit = useCallback(
    (unitIdx: number) => {
      const idx = screens.findIndex((s) => s.unitIdx === unitIdx)
      if (idx >= 0) setCurrentScreenIdx(idx)
    },
    [screens],
  )

  // ── v11 (2026-05) 后台同步 backend current_unit ──────────────────────────
  // screens 现在包含已 prefetched 的未来单元，用户可通过 PagerBar / RoadmapNav
  // 翻 / 跳到 unitIdx > currentUnitIndex 的屏。但 backend 的 plan.current_unit
  // 不会自动推进 —— 用户刷新 / 重启 app 后会回到旧位置，进度丢失。
  //
  // 解决：检测到当前屏的 unitIdx 超过 backend currentUnitIndex 时，串行调
  // agent_advance('next') 把 backend 推到目标单元（一次最多推到 screen.unitIdx）。
  // 用 syncingTargetRef 锁防止同一目标被重复触发；refresh 后 currentUnitIndex
  // 增加，effect 重跑但 target 已对齐，不再 fire。
  const syncingTargetRef = useRef<number | null>(null)
  useEffect(() => {
    const screen = screens[currentScreenIdx]
    if (!screen) return
    if (screen.unitIdx <= currentUnitIndex) return
    if (syncingTargetRef.current !== null) return // 已有同步在飞，等它完成后 effect 会重跑
    if (paused) return // 暂停态不偷推进
    if (streamingTurnId) return // 正在流式生成时也不动 backend
    // v11 (2026-05) 与断点续传兼容：当前单元若处于 partial-pending（中断态）
    // 不偷推进 backend —— 否则 backend current_unit 越过该单元后，partial
    // 状态会被孤立（前端 currentUnitState 指向新单元，「继续生成」按钮永不显示）。
    // 用户仍能用 PagerBar 翻到未来单元*查看*内容，但需先 resume / retry 处理本单元。
    const cuState = unitStatesMap[currentUnitIndex]
    const cuHasPartial =
      !!cuState?.partial_explanation &&
      cuState.partial_explanation.trim().length > 0 &&
      !cuState?.teach_pack?.explanation
    if (cuHasPartial) return
    const target = screen.unitIdx
    syncingTargetRef.current = target
    void (async () => {
      try {
        const steps = target - currentUnitIndex
        for (let s = 0; s < steps; s++) {
          await invoke('agent_advance', { sessionId, action: 'next' })
        }
        await refresh()
      } catch (e) {
        console.warn('[AgentTab] sync advance backend failed', e)
      } finally {
        // 即使失败也清锁，避免永久卡住；下次 currentScreenIdx 变化会重试
        if (syncingTargetRef.current === target) {
          syncingTargetRef.current = null
        }
      }
    })()
  }, [currentScreenIdx, screens, currentUnitIndex, unitStatesMap, paused, streamingTurnId, sessionId, refresh])

  // 键盘翻页：←/PageUp 前一屏，→/PageDown/空格 后一屏
  //
  // 关键设计：
  //   1. **仅在 isActive=true 时挂 listener**。AgentTab 被 AiPaneContainer 用 `hidden`
  //      隐藏时仍 mount；没这层 guard 会导致 chat / note tab 时后台 Agent 屏也偷偷翻。
  //   2. **capture phase + stopImmediatePropagation**：ReaderShell 也在 window 上挂了
  //      箭头键 handler（翻 PDF）。bubble phase 注册顺序无法保证，所以 AgentTab 用 capture
  //      抢在前面 → stopImmediatePropagation 阻断 ReaderShell。
  //   3. **键盘所有权（鼠标 hover 路由）**：仅当 `getKeyboardOwner() === 'agent'` 时才抢键盘。
  //      用户 hover 在 PDF 区时 owner='pdf'，AgentTab listener 直接放行 → ReaderShell 翻 PDF。
  //      mode 切换时 AiPaneContainer 已经把 owner reset 为默认值（agent tab → 'agent'）。
  //   4. 输入元素（INPUT / TEXTAREA / contentEditable）一律放行 —— 让原生光标移动正常工作。
  useEffect(() => {
    if (!isActive) return // Agent tab 不在前台 → 不参与键盘抢占
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      if (e.ctrlKey || e.metaKey || e.altKey) return
      if (getKeyboardOwner() !== 'agent') return // 鼠标在 PDF 区 → 放行给 ReaderShell
      if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        e.preventDefault()
        e.stopImmediatePropagation() // 阻断 ReaderShell 翻 PDF
        goPrev()
      } else if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') {
        e.preventDefault()
        e.stopImmediatePropagation()
        goNext()
      }
    }
    window.addEventListener('keydown', onKey, true) // capture phase
    return () => window.removeEventListener('keydown', onKey, true)
  }, [goPrev, goNext, isActive])

  // ── Auto-next：移除自动推进逻辑 ─────────────────────────────────────────────
  //
  // v4 (2026-05): 题目搬到训练板块后，学习区不再有 quiz 屏，
  // 原"答对 1.5s 后 auto-next" 分支已移除。
  //
  // v6 (2026-05) #3++ 修复（用户反馈："llm 生成完讲解就自动标志学习结束"）：
  //   原版 reviewing → 0.8s auto-next 一视同仁，**最后一个单元也会被自动 advance**，
  //   后端 agent_advance("next") 检测到越界直接推 phase=done，用户来不及反应。
  //   折中方案：最后一个单元的 reviewing 阶段不自动 advance，等用户主动点。
  //
  // v8 (2026-05) 彻底修复（用户反馈："LLM 生成结束就标识学习完成，体验突兀"）：
  //   **取消所有自动 advance**。中间单元的 reviewing 也不再 0.8s 自动跳下一单元，
  //   等用户主动点「下一单元」按钮。这样用户能完整读完每个单元的讲解。
  //   保留 autoNextTimerRef.cleanup（reset / 档案恢复时仍用）以兼容旧代码。
  useEffect(() => {
    // 阶段切换 / 暂停 / 忙碌时清理可能残留的 timer
    if (autoNextTimerRef.current) {
      clearTimeout(autoNextTimerRef.current)
      autoNextTimerRef.current = null
    }
  }, [phase, paused, busy])

  // 单元级进度：当前所在 unit 的局部屏数 / 该 unit 总屏数
  const screenUnitInfo = useMemo(() => {
    // 每个 unit 在 screens 中占的连续段：[start, end)
    const ranges: Record<number, { start: number; end: number }> = {}
    for (let i = 0; i < screens.length; i++) {
      const ui = screens[i].unitIdx
      if (!ranges[ui]) ranges[ui] = { start: i, end: i + 1 }
      else ranges[ui].end = i + 1
    }
    return ranges
  }, [screens])

  // ── v6 #3+ 修订：覆盖式档案面板已移除 —— 主面板上移到右栏 'vibe' tab。

  // ── 早退：Wizard 优先（v6 #3+ B） ──────────────────────────────────
  if (wizardOpen) {
    return (
      <LearningWizardCard
        sessionId={sessionId}
        onSubmit={handleWizardSubmit}
        onCancel={() => {
          setWizardOpen(false)
          setWizardForce(false)
          // 用户取消但没标 wizardSeen → 下次 Auto-Pilot 还会弹
        }}
      />
    )
  }

  // ── 早退：路线图加载中 ───────────────────────────────────────────
  if (!plan && busy) {
    return (
      <CenteredHint
        icon={<Loader2 className="size-5 animate-spin text-blue-500" />}
        text="正在通读全本资料并规划学习路线…"
      />
    )
  }
  if (!plan && error) {
    return (
      <CenteredHint
        icon={<AlertCircle className="size-5 text-red-500" />}
        text={error}
        action={
          <button
            onClick={() => {
              setError('')
              planRequestedRef.current = false
            }}
            className="rounded border border-border-2 px-3 py-1 text-xs hover:bg-bg-3"
          >
            重试
          </button>
        }
      />
    )
  }

  // ── 完成态 ─────────────────────────────────────────────────────
  // v6 (2026-05) #3++ 修订：原 DoneReport 全屏 early return 改为下方主屏顶部的 banner，
  // 用户能继续滚动 / 翻屏重温讲解，互不干扰。

  return (
    <div className="relative flex h-full flex-col bg-bg-2/30">
      {/* 完成态横幅（用户反馈："不要妨碍重温学习流"）：sticky 顶部，可关闭 */}
      {phase === 'done' && !doneBannerDismissed && (
        <DoneBanner
          unitsTotal={units.length}
          onReset={resetAll}
          onDismiss={() => setDoneBannerDismissed(true)}
        />
      )}
      {/* ── 顶部细条：进度 + 当前单元 + 控制 ── */}
      <div className="flex items-center gap-2 border-b border-border-2 bg-bg-1/60 px-3 py-2 backdrop-blur">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 overflow-hidden text-xs">
            <span className="shrink-0 font-medium text-text-2">
              {currentUnit ? `单元 ${currentUnitIndex + 1} / ${totalUnits}` : '准备中…'}
            </span>
            {currentUnit && (
              <>
                <span className="shrink-0 text-text-3/60">·</span>
                <span className="truncate text-text-2">{currentUnit.title}</span>
              </>
            )}
            {streamingTurnId && (
              <span className="ml-auto flex shrink-0 items-center gap-1 text-blue-500">
                {reasoning ? (
                  <>
                    <Loader2 className="size-3 animate-spin" />
                    思考中
                  </>
                ) : (
                  <>
                    <Sparkles className="size-3" />
                    讲解中
                  </>
                )}
              </span>
            )}
            {!streamingTurnId && phase === 'probing' && (
              <span className="ml-auto shrink-0 text-text-3">答题中</span>
            )}
            {!streamingTurnId && phase === 'reviewing' && (
              <span className="ml-auto shrink-0 text-text-3">复盘中</span>
            )}
          </div>
          <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-bg-3">
            <div
              className="h-full bg-blue-500 transition-all duration-500"
              style={{ width: `${progressPct}%` }}
            />
          </div>
        </div>
        <button
          onClick={() => setOutlineOpen((v) => !v)}
          className="rounded p-1.5 text-text-3 hover:bg-bg-3 hover:text-text-1"
          title="路线图"
        >
          <Map className="size-4" />
        </button>
        {/* v6 (2026-05) #3+ C: 学习档案快捷入口 → 切到右栏「档案」tab。
            档案管理主面板已上移到右栏 tab 层级（LearningHistoryPanel），
            这里只做快捷跳转，避免双入口重复。 */}
        <button
          onClick={() =>
            window.dispatchEvent(
              new CustomEvent('reader-pane-change', { detail: { pane: 'vibe' } }),
            )
          }
          className="rounded p-1.5 text-text-3 hover:bg-bg-3 hover:text-indigo-500"
          title="学习档案：浏览 / 复习 / 恢复历次学习流"
        >
          <Archive className="size-4" />
        </button>
        <button
          onClick={() => void togglePause()}
          className="rounded p-1.5 text-text-3 hover:bg-bg-3 hover:text-text-1"
          title={paused ? '继续' : '暂停'}
        >
          {paused ? <Play className="size-4" /> : <Pause className="size-4" />}
        </button>
        {/* v6 (2026-05) #3+ B: 重新生成路线图（先弹 wizard 重选偏好） */}
        <button
          onClick={reopenWizardForceRegenerate}
          className="rounded p-1.5 text-text-3 hover:bg-bg-3 hover:text-emerald-500"
          title="重新生成路线图（当前进度会自动归档）"
        >
          <RefreshCw className="size-4" />
        </button>
        <button
          onClick={() => void resetAll()}
          className="rounded p-1.5 text-text-3 hover:bg-bg-3 hover:text-red-500"
          title="重置（当前进度会自动归档）"
        >
          <RotateCcw className="size-4" />
        </button>
      </div>

      {/* ── 路线图浮层 ── */}
      {outlineOpen && (
        <OutlinePopover
          plan={plan}
          unitStatesMap={unitStatesMap}
          currentUnitIndex={currentUnitIndex}
          onClose={() => setOutlineOpen(false)}
        />
      )}

      {/* ── 分段进度条：每个 unit 一段，当前 unit 段填充到当前屏 ── */}
      <UnitProgressBar
        units={units}
        unitStatesMap={unitStatesMap}
        screenUnitInfo={screenUnitInfo}
        currentUnitIndex={currentUnitIndex}
        currentScreenIdx={currentScreenIdx}
        onJumpToUnit={jumpToUnit}
      />

      {/* ── 单屏阅读区 ── */}
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-4 px-5 py-6">
          {/* 错误条 */}
          {error && (
            <div className="flex items-start gap-2 rounded border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-500">
              <AlertCircle className="mt-0.5 size-4 shrink-0" />
              <div className="flex-1">
                <div className="whitespace-pre-line">{error}</div>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {/* v10 (2026-05) 断点续传：当前单元有 partial 时优先展示「继续生成」；
                      retry 是兜底（清空 partial 重头再来） */}
                  {currentUnitState?.partial_explanation &&
                    currentUnitState.partial_explanation.trim().length > 0 &&
                    !currentUnitState?.teach_pack?.explanation && (
                      <button
                        className="inline-flex items-center gap-1 rounded border border-emerald-500/50 bg-emerald-500/10 px-2 py-1 text-xs font-medium text-emerald-600 hover:bg-emerald-500/20 dark:text-emerald-400"
                        onClick={() => {
                          setError('')
                          void resumeTeach(currentUnitIndex)
                        }}
                      >
                        <Play className="size-3" />
                        从断点继续生成
                      </button>
                    )}
                  <button
                    className="rounded border border-red-500/40 px-2 py-1 text-xs hover:bg-red-500/20"
                    onClick={() => {
                      setError('')
                      void advance('retry')
                    }}
                  >
                    重试本单元
                  </button>
                </div>
              </div>
              <button onClick={() => setError('')}>
                <X className="size-4" />
              </button>
            </div>
          )}

          {/* v10 (2026-05) 断点中断态横幅：error 已被清掉、但 DB 仍留 partial（如刷新后恢复）→
              主动给一个「继续生成」CTA，避免用户卡住 */}
          {!error &&
            !streamingTurnId &&
            !busy &&
            currentUnitState?.partial_explanation &&
            currentUnitState.partial_explanation.trim().length > 0 &&
            !currentUnitState?.teach_pack?.explanation && (
              <div className="flex items-start gap-2 rounded border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm text-emerald-700 dark:text-emerald-400">
                <Sparkles className="mt-0.5 size-4 shrink-0" />
                <div className="flex-1">
                  <div className="font-medium">检测到上次未写完的讲解</div>
                  <div className="mt-0.5 text-xs opacity-80">
                    上次因网络中断断开了，已保留约
                    {' '}
                    {currentUnitState.partial_explanation.length}
                    {' '}
                    字。点「继续生成」从断点接着写下去。
                  </div>
                  <button
                    className="mt-2 inline-flex items-center gap-1 rounded border border-emerald-500/50 bg-emerald-500/15 px-2 py-1 text-xs font-medium hover:bg-emerald-500/25"
                    onClick={() => void resumeTeach(currentUnitIndex)}
                  >
                    <Play className="size-3" />
                    从断点继续生成
                  </button>
                </div>
              </div>
            )}

          {/* 暂停态 */}
          {paused && (
            <div className="rounded border border-amber-500/40 bg-amber-500/10 p-4 text-center text-sm text-amber-700 dark:text-amber-400">
              已暂停。点击顶部 <Play className="inline size-3" /> 恢复学习。
            </div>
          )}

          {/* 空态：还没生成任何屏 */}
          {!paused && screens.length === 0 && (
            <CenteredHint
              icon={<Loader2 className="size-5 animate-spin text-blue-500" />}
              text={
                phase === 'planning'
                  ? '正在规划学习路线…'
                  : streamingTurnId
                  ? '讲解生成中…'
                  : '准备讲解第 1 单元…'
              }
            />
          )}

          {/* 当前屏 */}
          {screens.length > 0 && (() => {
            const screen = screens[currentScreenIdx]
            if (!screen) return null
            const unit = units[screen.unitIdx]
            const range = screenUnitInfo[screen.unitIdx]
            const localCount = range ? range.end - range.start : 1
            const localPos = range ? currentScreenIdx - range.start + 1 : 1
            const fpKey = `${screen.unitIdx}-${screen.localIdx}`
            const screenFollowups =
              (followupItems[screen.unitIdx] ?? []).filter((it) => it.screenKey === fpKey)
            const screenSuggestions = followupSuggestions[screen.unitIdx] ?? []

            return (
              <article key={screen.id} className="agent-screen-enter space-y-3">
                {/* 屏顶单元胶囊：第 N 单元 · 标题 · P 起–止 · 本单元 X/Y 屏 */}
                <header className="flex items-center gap-2 px-1">
                  <span
                    className={cn(
                      'inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-semibold tracking-wide',
                      screen.unitIdx === currentUnitIndex
                        ? 'bg-blue-500/15 text-blue-600 dark:text-blue-400'
                        : 'bg-bg-3/70 text-text-3',
                    )}
                  >
                    {screen.unitIdx < currentUnitIndex && <Check className="size-3" />}
                    第 {screen.unitIdx + 1} 单元
                  </span>
                  <h3 className="flex-1 truncate text-[13px] font-semibold text-text-1">
                    {unit?.title}
                  </h3>
                  {/* 屏类型徽章 + 单元内位置 */}
                  <span
                    className={cn(
                      'shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] tabular-nums',
                      screen.kind === 'summary'
                        ? 'bg-blue-500/15 text-blue-600 dark:text-blue-400'
                        : 'bg-bg-3/50 text-text-3',
                    )}
                  >
                    {screen.kind === 'summary'
                      ? '小结'
                      : screen.kind === 'knowledge'
                        ? `知识点 ${localPos}/${localCount}`
                        : `${localPos}/${localCount}`}
                  </span>
                </header>

                {/* 屏主内容：knowledge / page / summary / preface 共用一个组件 */}
                {/* key=screen.id 让切换屏时组件 remount，触发新一轮打字机判定 */}
                {(screen.kind === 'knowledge' ||
                  screen.kind === 'page' ||
                  screen.kind === 'summary' ||
                  screen.kind === 'preface') && (
                  <ContentScreen
                    key={screen.id}
                    kind={screen.kind}
                    body={screen.body}
                    title={'title' in screen ? screen.title : undefined}
                    pages={'pages' in screen ? screen.pages : undefined}
                    pageNum={'pageNum' in screen ? screen.pageNum : undefined}
                    kIdx={'kIdx' in screen ? screen.kIdx : undefined}
                    skipsAbove={'skipsAbove' in screen ? screen.skipsAbove : undefined}
                    isStreaming={screen.isStreaming}
                    alreadyRevealed={revealedScreensRef.current.has(screen.id)}
                    onRevealed={() => revealedScreensRef.current.add(screen.id)}
                    mdTheme={mdTheme}
                    unitIdx={screen.unitIdx}
                    editorEpoch={editorEpochs[screen.unitIdx] ?? 0}
                    onSaveExplanation={saveExplanation}
                  />
                )}

                {/* v4 (2026-05): 题目搬迁到训练板块 —— 学习区不再渲染 InlineQuizCard / QuizScreen */}

                {/* 追问区：所有讲解屏都显示 */}
                <FollowupArea
                  suggestions={screenSuggestions}
                  items={screenFollowups}
                  onAsk={(q) =>
                    void startFollowup(screen.unitIdx, fpKey, q)
                  }
                  mdTheme={mdTheme}
                  onJumpPage={onJumpPage}
                />

                {/* v5 (2026-05) B2: 单元最后一屏底部 →「练习本单元」按钮（学习↔训练联动）*/}
                {localPos === localCount && (
                  <PracticeUnitCta
                    unitIdx={screen.unitIdx}
                    questionCount={unitPacksReady[screen.unitIdx]}
                    isUnitDone={!screen.isStreaming && !!unit && currentUnitState?.teach_pack !== null}
                  />
                )}
              </article>
            )
          })()}
        </div>
      </div>

      {/* v9 (2026-05) 用户反馈："蓝色置底标签占地方"：删除中间单元的「继续下一单元」CTA。
          翻屏（PagerBar / 键盘 →）已能顺序看到 prefetch 就绪的下一单元内容；
          想显式推进 plan.current_unit 仍可走顶部 Map 路线图按钮。
          仅最后一单元保留绿色「前往训练面板」CTA —— 这是去训练板块的引导，性质不同。 */}
      {phase === 'reviewing' &&
        units.length > 0 &&
        teachPack &&
        currentUnitIndex >= units.length - 1 && (
          <div className="shrink-0 border-t border-border-1 bg-emerald-500/5 px-5 py-3">
            <button
              type="button"
              onClick={() => void advance('next')}
              disabled={busy}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-500 py-2.5 text-sm font-medium text-white shadow-sm transition hover:bg-emerald-600 disabled:cursor-wait disabled:opacity-60"
            >
              <Check className="size-4" />
              已学完最后一单元，前往训练面板
            </button>
            <p className="mt-1.5 text-center text-[10.5px] text-text-3">
              提示：所有单元讲解已结束。点击后会进入完成态，并引导你去「训练」面板巩固。
            </p>
          </div>
        )}

      {/* ── 翻页栏：贴底 ── */}
      {screens.length > 0 && (
        <PagerBar
          canPrev={canPrev}
          canNext={canNext}
          onPrev={goPrev}
          onNext={goNext}
          currentScreenIdx={currentScreenIdx}
          totalScreens={screens.length}
          streaming={!!streamingTurnId}
          unreadAhead={Math.max(0, screens.length - 1 - currentScreenIdx)}
        />
      )}
    </div>
  )
}

// ── 子组件 ──────────────────────────────────────────────────────────────

// 打字机效果 hook：把已生成的整段文本逐字 reveal，营造"持续生成"的错觉。
//   - enabled = false → 直接全显
//   - enabled = true  → 每帧推进 step 字符，完成时调 onDone
//   - cps：每秒字符数（默认 220）；markdown 语法字符 + 中文字符混合
function useTypewriter(
  text: string,
  enabled: boolean,
  onDone?: () => void,
): { display: string; done: boolean } {
  const [display, setDisplay] = useState(enabled ? '' : text)
  const [done, setDone] = useState(!enabled)
  const onDoneRef = useRef(onDone)
  onDoneRef.current = onDone

  useEffect(() => {
    if (!enabled) {
      setDisplay(text)
      setDone(true)
      return
    }
    setDisplay('')
    setDone(false)
    const total = text.length
    if (total === 0) {
      setDone(true)
      onDoneRef.current?.()
      return
    }
    // 220 字符/秒，60 fps → 每帧 ≈ 4 字符；短文本会更慢"打"，长文本一拍 4 字
    const cps = 220
    const stepPerFrame = Math.max(1, Math.round(cps / 60))
    let i = 0
    let rafId = 0
    let lastTs = performance.now()
    const tick = (ts: number) => {
      const elapsed = ts - lastTs
      if (elapsed >= 16) {
        const frames = Math.floor(elapsed / 16)
        i = Math.min(total, i + stepPerFrame * frames)
        setDisplay(text.slice(0, i))
        lastTs = ts
      }
      if (i < total) {
        rafId = requestAnimationFrame(tick)
      } else {
        setDone(true)
        onDoneRef.current?.()
      }
    }
    rafId = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafId)
  }, [text, enabled])

  return { display, done }
}

// 屏顶 skip 提示带
function SkipBanner({ skips }: { skips: Array<{ page: number; reason?: string }> }) {
  if (!skips.length) return null
  return (
    <div className="space-y-1">
      {skips.map((sk, i) => (
        <div
          key={`sk-${i}`}
          className="flex items-center gap-2 rounded-md border border-border-1/60 bg-bg-2/40 px-3 py-1.5 text-[12px] text-text-3"
        >
          <span className="rounded bg-bg-3/70 px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-text-3">
            P{sk.page}
          </span>
          <span className="truncate">跳过{sk.reason ? `：${sk.reason}` : ''}</span>
        </div>
      ))}
    </div>
  )
}

// ── 知识点屏 / 单元小结屏 / preface 屏 / 旧 page 屏的统一渲染组件 ─────────
// 设计要点：
//   1. 真流式（当前 unit 正在被 LLM 流式生成）→ 不启用打字机，body 已经在逐 token 增长
//   2. 非真流式 + 用户首次到达 → 启用打字机，营造"慢慢吐字"的错觉
//   3. 非真流式 + 用户曾翻回过 → 直接全显，不重复打字
//   4. 切换屏（key 变化）→ 组件实例重建，自动决定是否打字
type ContentKind = 'knowledge' | 'page' | 'summary' | 'preface'
function ContentScreen({
  kind,
  body,
  title,
  pages,
  pageNum,
  kIdx,
  skipsAbove,
  isStreaming,
  alreadyRevealed,
  onRevealed,
  mdTheme,
  unitIdx,
  editorEpoch,
  onSaveExplanation,
}: {
  kind: ContentKind
  body: string
  title?: string
  pages?: number[]            // knowledge：关联页码
  pageNum?: number            // 旧 page 屏
  kIdx?: number               // knowledge：序号
  skipsAbove?: Array<{ page: number; reason?: string }>
  isStreaming?: boolean       // 真流式中（LLM 正在 push token）
  alreadyRevealed: boolean    // 用户曾到达过此屏 → 直接全显
  onRevealed: () => void
  mdTheme: MdTheme
  // v4 (2026-05) 学习↔笔记本绑定（仅 knowledge 屏使用）
  unitIdx: number             // 当前屏所属单元（用于 saveExplanation 路由 entry_id）
  editorEpoch: number         // 父级递增计数器，外部回写时 +1 让编辑器 remount 拿新 defaultValue
  onSaveExplanation: (unitIdx: number, content: string) => void
}) {
  const typewriterEnabled = !isStreaming && !alreadyRevealed
  const { display, done } = useTypewriter(body, typewriterEnabled, onRevealed)
  const showCursor = isStreaming || (typewriterEnabled && !done)

  if (kind === 'knowledge') {
    // v6 (2026-05) #3++ 修订（用户反馈："讲解内容一直在可编辑/只读之间跳转"）：
    //   原版流式中用 MarkdownView，流式结束切 MarkdownEditor。这导致：
    //     ① 排版瞬变（编辑器 vs 渲染器字距 / 列表样式不一致）
    //     ② 外部回写时 editorEpoch+1 让编辑器 remount，又一次跳变
    //   现在统一为 **MarkdownView 只读**，需要编辑请去笔记 tab 的「学习流」子 tab。
    //   保留 onSaveExplanation / editorEpoch 参数以兼容上层（暂未删，避免连带改动 props 链）。
    void editorEpoch
    void onSaveExplanation
    // v6 (2026-05) #2: 知识屏视觉升级
    //   - 顶部彩条改为更细更柔和的双色渐变
    //   - header 区独立背景 + 底部分隔线，与正文形成"杂志页眉"层级
    //   - K{n} 改为左侧大号月牙徽章，标题用更大字号 + 杂志衬线感的字体强调
    //   - 页码 / 关联范围用胶囊样式
    //   - 卡片整体增加 padding，正文左右内边距留出"阅读栏宽"
    return (
      <>
        <SkipBanner skips={skipsAbove ?? []} />
        <article className="md-knowledge-card overflow-hidden rounded-2xl border border-blue-500/20 bg-bg-1 shadow-[0_1px_2px_rgba(0,0,0,0.03),0_8px_24px_rgba(15,23,42,0.04)]">
          {/* 顶部 accent 条：更细、双色 */}
          <div className="md-knowledge-accent h-[3px] bg-gradient-to-r from-blue-500 via-indigo-500/70 to-transparent" />
          {/* 杂志页眉：徽章 + 标题 + 元数据 */}
          <header className="md-knowledge-header flex items-center gap-3 border-b border-border-1/60 bg-gradient-to-b from-blue-500/[0.04] to-transparent px-7 pb-3 pt-4">
            <span className="md-knowledge-badge flex size-9 shrink-0 flex-col items-center justify-center rounded-xl bg-blue-500/12 ring-1 ring-blue-500/30">
              <span className="font-mono text-[9.5px] font-medium uppercase tracking-wider text-blue-500/70 dark:text-blue-400/70">
                K
              </span>
              <span className="-mt-0.5 font-mono text-[14px] font-bold tabular-nums text-blue-600 dark:text-blue-400">
                {kIdx ?? '?'}
              </span>
            </span>
            <div className="min-w-0 flex-1">
              {title && (
                <h2 className="md-knowledge-title truncate text-[17px] font-semibold leading-snug tracking-tight text-text-1">
                  {title}
                </h2>
              )}
              <div className="mt-0.5 flex items-center gap-1.5 text-[10.5px] text-text-3">
                <span className="font-medium uppercase tracking-wider">知识点</span>
                {pages && pages.length > 0 && (
                  <>
                    <span className="text-text-3/40">·</span>
                    <span className="inline-flex items-center gap-0.5 rounded-md bg-bg-2/70 px-1.5 py-0.5 font-mono tabular-nums text-text-2">
                      <span className="text-text-3">P</span>
                      {pages.length === 1
                        ? pages[0]
                        : `${pages[0]}–${pages[pages.length - 1]}`}
                    </span>
                  </>
                )}
              </div>
            </div>
          </header>
          {/* 正文区：左右留更多内边距，营造阅读栏宽。统一只读 MarkdownView，去掉 view/editor 跳变。 */}
          <div className="md-knowledge-body px-7 pb-6 pt-4">
            <MarkdownView content={display} theme={mdTheme} />
            {showCursor && (
              <span className="ml-1 inline-block size-2 animate-pulse rounded-sm bg-blue-500 align-middle" />
            )}
          </div>
        </article>
      </>
    )
  }

  if (kind === 'page') {
    return (
      <>
        <SkipBanner skips={skipsAbove ?? []} />
        <div className="rounded-xl border border-border-2 bg-bg-1 px-6 py-5 shadow-sm">
          <div className="mb-2.5 flex items-center gap-2">
            <span className="inline-flex items-center gap-1 rounded-md bg-blue-500/12 px-2 py-0.5 font-mono text-[11px] font-semibold tabular-nums text-blue-600 dark:text-blue-400">
              P{pageNum}
            </span>
            {title && (
              <span className="truncate text-[14px] font-semibold text-text-1">{title}</span>
            )}
          </div>
          <MarkdownView content={display} theme={mdTheme} />
          {showCursor && (
            <span className="ml-1 inline-block size-2 animate-pulse rounded-sm bg-blue-500 align-middle" />
          )}
        </div>
      </>
    )
  }

  if (kind === 'summary') {
    return (
      <div className="overflow-hidden rounded-2xl border border-blue-500/30 bg-gradient-to-br from-blue-500/8 via-blue-500/4 to-transparent">
        <div className="px-6 pb-5 pt-4">
          <header className="mb-2 flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wider text-blue-600 dark:text-blue-400">
            <Sparkles className="size-3.5" />
            本单元小结
          </header>
          <MarkdownView content={display} theme={mdTheme} />
          {showCursor && (
            <span className="ml-1 inline-block size-2 animate-pulse rounded-sm bg-blue-500 align-middle" />
          )}
        </div>
      </div>
    )
  }

  // preface
  return (
    <div className="rounded-xl border border-border-2 bg-bg-1 px-6 py-5 shadow-sm">
      <MarkdownView content={display} theme={mdTheme} />
      {showCursor && (
        <span className="ml-1 inline-block size-2 animate-pulse rounded-sm bg-blue-500 align-middle" />
      )}
    </div>
  )
}


function CenteredHint({
  icon,
  text,
  action,
}: {
  icon: React.ReactNode
  text: string
  action?: React.ReactNode
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <div className="flex items-center gap-2 text-sm text-text-3">
        {icon}
        <span>{text}</span>
      </div>
      {action}
    </div>
  )
}

function OutlinePopover({
  plan,
  unitStatesMap,
  currentUnitIndex,
  onClose,
}: {
  plan: AgentPlan | null
  unitStatesMap: Record<number, UnitState>
  currentUnitIndex: number
  onClose: () => void
}) {
  const outline = plan?.outline
  if (!outline) return null
  const units = Array.isArray(outline.units) ? outline.units : []
  const skipPages = Array.isArray(outline.skip_pages) ? outline.skip_pages : []
  return (
    <div className="absolute right-3 top-14 z-20 max-h-[70vh] w-80 overflow-y-auto rounded-lg border border-border-2 bg-bg-1 p-3 shadow-lg">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-xs font-medium text-text-2">学习路线图</div>
        <button onClick={onClose}>
          <X className="size-4 text-text-3" />
        </button>
      </div>
      {outline.thesis && <div className="mb-2 text-xs text-text-3">{outline.thesis}</div>}
      {skipPages.length > 0 && (
        <div className="mb-2 rounded bg-bg-3/40 px-2 py-1 text-[11px] text-text-3">
          已跳过 {skipPages.length} 页：{skipPages.slice(0, 8).join(', ')}
          {skipPages.length > 8 ? '…' : ''}
        </div>
      )}
      {units.length === 0 ? (
        <div className="rounded bg-bg-3/40 px-2 py-2 text-[11px] text-text-3">
          路线图为空（可能仍在生成或解析失败）
        </div>
      ) : (
      <ul className="space-y-1">
        {units.map((u, i) => {
          const status = unitStatesMap[i]?.status ?? 'pending'
          const isCurrent = i === currentUnitIndex
          return (
            <li
              key={u.id}
              className={cn(
                'rounded px-2 py-1.5 text-xs',
                isCurrent && 'bg-blue-500/10 text-blue-600',
                !isCurrent && status === 'done' && 'text-text-3',
                !isCurrent && status !== 'done' && 'text-text-2',
              )}
            >
              <div className="flex items-center gap-1.5">
                {status === 'done' && <Check className="size-3 shrink-0 text-emerald-500" />}
                {isCurrent && status !== 'done' && (
                  <Loader2 className="size-3 shrink-0 animate-spin text-blue-500" />
                )}
                <span className="truncate font-medium">{u.title}</span>
                {!u.needs_quiz && (
                  <span className="ml-auto shrink-0 rounded bg-bg-3 px-1 text-[10px] text-text-3">
                    略读
                  </span>
                )}
              </div>
              {u.pages && u.pages.length > 0 && (
                <div className="mt-0.5 text-[10px] text-text-3">
                  P{u.pages[0]}
                  {u.pages.length > 1 ? `–${u.pages[u.pages.length - 1]}` : ''}
                </div>
              )}
            </li>
          )
        })}
      </ul>
      )}
    </div>
  )
}

// 追问区（FollowupArea）：参考 RAG ChatTab 的追问形态，但每个 unit 独立上下文。
// 结构：
//   ┌─ 智能建议 chip（LLM 生成的 3 个） + 4 个预设 chip
//   ├─ 已发起的追问历史：用户气泡 → AI 答案小卡（流式渲染）
//   └─ 自由输入框：textarea + send 按钮
//
// 设计语言：低调、不抢戏；hover / focus 时上浮；用 ↗ 箭头暗示"问出去"
const CHIP_PRESETS: { icon: React.ComponentType<{ className?: string }>; label: string }[] = [
  { icon: HelpCircle, label: '我没懂这段' },
  { icon: Lightbulb, label: '举个例子' },
  { icon: Link2, label: '跟前面联系' },
  { icon: ChevronDown, label: '再深入' },
]

function FollowupArea({
  suggestions,
  items,
  onAsk,
  mdTheme,
  onJumpPage,
}: {
  suggestions: string[]
  items: FollowupItem[]
  onAsk: (q: string) => void
  mdTheme: MdTheme
  onJumpPage?: (pageIndex: number) => void
}) {
  const [draft, setDraft] = useState('')
  const taRef = useRef<HTMLTextAreaElement>(null)
  const inFlight = items.some((it) => it.streaming)

  const submit = (q: string) => {
    const trimmed = q.trim()
    if (!trimmed || inFlight) return
    onAsk(trimmed)
    setDraft('')
  }

  return (
    <div className="space-y-2.5">
      {/* ── 历史追问轮次 ───────────────────────────────────────── */}
      {items.map((it) => (
        <div key={it.id} className="space-y-1.5">
          {/* 用户问题气泡 */}
          <div className="flex items-start gap-2">
            <div className="ml-auto max-w-[88%] rounded-2xl rounded-tr-sm border border-blue-500/30 bg-blue-500/10 px-3 py-1.5 text-[12px] leading-relaxed text-text-1">
              {it.question}
            </div>
          </div>
          {/* AI 答案卡 */}
          <article className="rounded-xl border border-border-1 bg-bg-2/40 px-4 py-3">
            <header className="mb-1.5 flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-text-3">
              <Sparkles className="size-3 text-blue-500" />
              追问回答
              {it.streaming && (
                <Loader2 className="size-3 animate-spin text-blue-500" />
              )}
              {it.reasoning && it.answer.length === 0 && (
                <span className="text-blue-500">思考中…</span>
              )}
            </header>
            {it.error ? (
              <div className="flex items-start gap-1.5 text-[12px] text-red-500">
                <AlertCircle className="mt-0.5 size-3 shrink-0" />
                <span>{it.error}</span>
              </div>
            ) : it.answer ? (
              <>
                {/* ASCII 图 / 宽表格在窄卡里可能溢出 → 允许横向滚动，不折行错乱 */}
                <div className="fp-answer overflow-x-auto">
                  <MarkdownView content={it.answer} theme={mdTheme} />
                </div>
                {it.streaming && (
                  <span className="ml-1 inline-block size-2 animate-pulse rounded-sm bg-blue-500 align-middle" />
                )}
                {!it.streaming && it.sources && it.sources.length > 0 && (
                  <FollowupSourceList sources={it.sources} onJumpPage={onJumpPage} />
                )}
              </>
            ) : (
              <div className="text-[12px] text-text-3">…</div>
            )}
          </article>
        </div>
      ))}

      {/* ── chip 行：智能建议（LLM）+ 预设 ────────────────────── */}
      <div className="flex flex-wrap items-center gap-1.5 px-1 pt-1">
        <span className="select-none text-[11px] text-text-3">想追问？</span>
        {suggestions.map((q, i) => (
          <button
            key={`sg-${i}`}
            type="button"
            disabled={inFlight}
            onClick={() => submit(q)}
            title={q}
            className="group inline-flex max-w-[260px] items-center gap-1 rounded-full border border-blue-500/30 bg-blue-500/8 px-2.5 py-1 text-[11px] font-medium text-blue-600 shadow-sm transition hover:-translate-y-0.5 hover:border-blue-500/60 hover:bg-blue-500/15 disabled:cursor-not-allowed disabled:opacity-40 active:translate-y-0 dark:text-blue-400"
          >
            <Sparkles className="size-3 shrink-0 text-blue-500" />
            <span className="truncate">{q}</span>
          </button>
        ))}
        {CHIP_PRESETS.map((p) => {
          const Icon = p.icon
          return (
            <button
              key={p.label}
              type="button"
              disabled={inFlight}
              onClick={() => submit(p.label)}
              className="group inline-flex items-center gap-1 rounded-full border border-border-2/70 bg-bg-1 px-2.5 py-1 text-[11px] text-text-2 shadow-sm transition hover:-translate-y-0.5 hover:border-blue-500/50 hover:bg-blue-500/5 hover:text-blue-600 disabled:cursor-not-allowed disabled:opacity-40 active:translate-y-0"
            >
              <Icon className="size-3 text-text-3 transition-colors group-hover:text-blue-500" />
              {p.label}
            </button>
          )
        })}
      </div>

      {/* ── 自由输入框 ────────────────────────────────────────── */}
      <div className="flex items-stretch gap-1.5 px-1 pt-0.5">
        <textarea
          ref={taRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit(draft)
            }
          }}
          placeholder={inFlight ? '追问回答中…' : '问点别的（Enter 发送，Shift+Enter 换行）'}
          rows={1}
          disabled={inFlight}
          className="flex-1 resize-none rounded-lg border border-border-2/60 bg-bg-1 px-3 py-1.5 text-[12px] leading-relaxed text-text-1 outline-none transition focus:border-blue-500/60 disabled:opacity-50"
        />
        <button
          type="button"
          disabled={inFlight || !draft.trim()}
          onClick={() => submit(draft)}
          title="发送 (Enter)"
          className="inline-flex shrink-0 items-center justify-center rounded-lg bg-blue-500 px-3 text-white shadow-sm transition hover:bg-blue-600 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <ArrowUp className="size-3.5" />
        </button>
      </div>
    </div>
  )
}

// v5 (2026-05) B3: FollowupHistory 未被引用，已删除。

// 追问回答的 RAG 来源列表：与 ChatTab 的 SourceList 同形态，点击页码标签跳页。
function FollowupSourceList({
  sources,
  onJumpPage,
}: {
  sources: RagSource[]
  onJumpPage?: (pageIndex: number) => void
}) {
  return (
    <div className="mt-2 border-t border-border-1/60 pt-2">
      <div className="mb-1 text-[9px] uppercase tracking-wide text-text-3">参考原文</div>
      <ul className="space-y-1">
        {sources.map((src) => {
          const label =
            src.page_start === src.page_end
              ? `P${src.page_start + 1}`
              : `P${src.page_start + 1}-${src.page_end + 1}`
          const canJump = !!onJumpPage && src.page_start >= 0
          return (
            <li key={src.chunk_id} className="flex items-start gap-1.5 text-[11px] leading-relaxed">
              <button
                type="button"
                disabled={!canJump}
                onClick={() => canJump && onJumpPage!(src.page_start)}
                title={canJump ? '点击跳到该页' : 'EPUB / 流式资料无法精确跳页'}
                className={cn(
                  'shrink-0 rounded border px-1.5 py-0.5 font-medium transition',
                  canJump
                    ? 'border-blue-500/30 bg-blue-500/8 text-blue-600 hover:bg-blue-500/15 dark:text-blue-400'
                    : 'cursor-default border-border-2/60 text-text-3',
                )}
              >
                {label}
              </button>
              <span className="truncate text-text-3">{src.snippet}</span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

// ── 顶部分段进度条 ─────────────────────────────────────────────────────
// 每个 unit 一段（等宽）：已完成 = 蓝实心，当前 = 渐进填充到当前屏，未到 = 浅灰
// 已 prefetched 但未到 = 浅蓝点缀（提示用户：已经准备好了）
// 点击段 → 跳到该 unit 第一屏（只允许跳到已生成区间）
function UnitProgressBar({
  units,
  unitStatesMap,
  screenUnitInfo,
  currentUnitIndex,
  currentScreenIdx,
  onJumpToUnit,
}: {
  units: AgentUnit[]
  unitStatesMap: Record<number, UnitState>
  screenUnitInfo: Record<number, { start: number; end: number }>
  currentUnitIndex: number
  currentScreenIdx: number
  onJumpToUnit: (unitIdx: number) => void
}) {
  if (units.length === 0) return null
  return (
    <div className="border-b border-border-1/60 bg-bg-2/30 px-4 py-2">
      <div className="mx-auto flex max-w-3xl items-center gap-1">
        {units.map((u, i) => {
          const range = screenUnitInfo[i]
          const isCurrent = i === currentUnitIndex
          const isPast = i < currentUnitIndex
          const us = unitStatesMap[i]
          const prefetched = !!us?.teach_pack?.explanation && i > currentUnitIndex
          // 当前 unit 在 screens 中的填充比
          let fill = 0
          if (isPast) {
            fill = 1
          } else if (isCurrent && range) {
            const total = range.end - range.start
            const localPos = currentScreenIdx - range.start + 1
            fill = total > 0 ? Math.min(1, Math.max(0, localPos / total)) : 0
          }
          return (
            <button
              key={i}
              type="button"
              disabled={!range && !prefetched}
              onClick={() => onJumpToUnit(i)}
              title={`第 ${i + 1} 单元 · ${u.title}`}
              className="group relative h-1.5 flex-1 overflow-hidden rounded-full bg-bg-3/60 transition disabled:cursor-not-allowed"
            >
              {/* 已 prefetch 但未到：浅蓝底色提示 */}
              {prefetched && (
                <span className="absolute inset-0 bg-blue-500/15" />
              )}
              {/* 已读 / 当前填充 */}
              {(isPast || isCurrent) && (
                <span
                  className={cn(
                    'absolute inset-y-0 left-0 transition-[width] duration-300',
                    isCurrent ? 'bg-blue-500' : 'bg-blue-500/70',
                  )}
                  style={{ width: `${fill * 100}%` }}
                />
              )}
              {/* hover ring */}
              <span className="absolute inset-0 opacity-0 ring-1 ring-blue-500/50 transition-opacity group-hover:opacity-100" />
            </button>
          )
        })}
      </div>
      {/* 行下方一行：第 X / 总 Y 单元 · 整书进度 */}
      <div className="mx-auto mt-1 flex max-w-3xl items-center justify-between text-[10px] text-text-3">
        <span>
          第 <span className="font-mono tabular-nums">{currentUnitIndex + 1}</span> / {units.length} 单元
        </span>
        <span className="font-mono tabular-nums">
          {/* prefetched 计数 */}
          {(() => {
            const ready = Object.values(unitStatesMap).filter(
              (us) => !!us.teach_pack?.explanation,
            ).length
            return `${ready}/${units.length} 已生成`
          })()}
        </span>
      </div>
    </div>
  )
}


// ── 底部翻页栏 ────────────────────────────────────────────────────────
// 显示当前屏 / 总屏数，左右按钮 + 键盘提示
//
// v8 (2026-05) UX 改进：
//   - streaming 中始终显示"生成中…"小提示（不限于末屏）
//   - 当用户落后于末屏（unreadAhead > 0）时显示"还有 N 屏未读"，提示用户主动翻页
function PagerBar({
  canPrev,
  canNext,
  onPrev,
  onNext,
  currentScreenIdx,
  totalScreens,
  streaming,
  unreadAhead,
}: {
  canPrev: boolean
  canNext: boolean
  onPrev: () => void
  onNext: () => void
  currentScreenIdx: number
  totalScreens: number
  streaming: boolean
  unreadAhead: number
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-t border-border-1/60 bg-bg-2/40 px-4 py-2.5">
      <button
        type="button"
        onClick={onPrev}
        disabled={!canPrev}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[12px] font-medium transition',
          canPrev
            ? 'border-border-2 bg-bg-1 text-text-1 hover:-translate-y-0.5 hover:border-blue-500/50 hover:text-blue-600'
            : 'cursor-not-allowed border-border-1 text-text-3 opacity-50',
        )}
        title="上一屏 (←)"
      >
        <ChevronLeft className="size-3.5" />
        上一屏
      </button>

      <div className="flex flex-col items-center gap-0.5 text-[11px] text-text-3">
        <span className="font-mono tabular-nums">
          {currentScreenIdx + 1} / {totalScreens}
        </span>
        {streaming && (
          <span className="inline-flex items-center gap-1 text-blue-500">
            <Loader2 className="size-2.5 animate-spin" />
            生成中{unreadAhead > 0 ? `（还有 ${unreadAhead} 屏未读）` : '…'}
          </span>
        )}
        {!streaming && unreadAhead > 0 && (
          <span className="text-amber-600 dark:text-amber-400">
            后面还有 {unreadAhead} 屏
          </span>
        )}
      </div>

      <button
        type="button"
        onClick={onNext}
        disabled={!canNext}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[12px] font-medium transition',
          canNext
            ? 'border-border-2 bg-bg-1 text-text-1 hover:-translate-y-0.5 hover:border-blue-500/50 hover:text-blue-600'
            : 'cursor-not-allowed border-border-1 text-text-3 opacity-50',
        )}
        title="下一屏 (→)"
      >
        下一屏
        <ChevronRight className="size-3.5" />
      </button>
    </div>
  )
}


// ── v5 (2026-05) B2: 学习单元末「练习本单元」按钮 ───────────────────────────
//
// 行为：
//   - 单元已完成讲解 + pack 已 ready → 蓝色 active，点击跳到 ?pane=training&unit=N
//   - 单元已完成讲解 + pack 未 ready → 灰色 disabled，显示"训练题生成中…"
//   - 单元未完成讲解 → 不显示（FollowupArea 已经覆盖未完态）
//
// 跳转用 location.search 设置 ?pane=training&unit=N，再用 dispatch event 通知
// RightPane 切换 pane（避免重新走 router 导致 reader 重 mount）。
function PracticeUnitCta({
  unitIdx,
  questionCount,
  isUnitDone,
}: {
  unitIdx: number
  questionCount?: number
  isUnitDone: boolean
}) {
  if (!isUnitDone) return null
  const ready = typeof questionCount === 'number' && questionCount > 0

  const handleClick = () => {
    if (!ready) return
    // 设置 URL 参数，让 RightPane 检测到切到 training tab + unitIndex 透传给 TrainingHome
    const url = new URL(window.location.href)
    url.searchParams.set('pane', 'training')
    url.searchParams.set('unit', String(unitIdx))
    window.history.replaceState({}, '', url.toString())
    // 派发自定义事件让 RightPane 立即响应（避免依赖 popstate 时机）
    window.dispatchEvent(new CustomEvent('reader-pane-change', { detail: { pane: 'training', unit: unitIdx } }))
  }

  return (
    <div className="mt-3 px-1">
      <button
        type="button"
        onClick={handleClick}
        disabled={!ready}
        className={cn(
          'group flex w-full items-center justify-between gap-2 rounded-xl border px-4 py-2.5 text-left transition',
          ready
            ? 'border-emerald-500/40 bg-emerald-500/[0.06] text-emerald-700 hover:border-emerald-500/60 hover:bg-emerald-500/10 hover:shadow-sm dark:text-emerald-400'
            : 'cursor-not-allowed border-border-2 bg-bg-2/30 text-text-3',
        )}
      >
        <div className="flex items-center gap-2.5">
          <div
            className={cn(
              'flex size-8 shrink-0 items-center justify-center rounded-lg',
              ready ? 'bg-emerald-500/15' : 'bg-bg-2/60',
            )}
          >
            {ready ? (
              <Dumbbell className="size-4 text-emerald-500" />
            ) : (
              <Loader2 className="size-4 animate-spin text-text-3" />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className={cn('text-[13px] font-semibold', ready ? '' : 'text-text-2')}>
              {ready ? '练习本单元' : '训练题生成中…'}
            </div>
            <div className="mt-0.5 text-[11px] text-text-3">
              {ready
                ? `${questionCount} 道针对本单元的训练题已就绪`
                : '后台正在为本单元出题，稍后可练习'}
            </div>
          </div>
        </div>
        {ready && (
          <ChevronRight className="size-4 shrink-0 text-emerald-500/70 transition group-hover:translate-x-0.5" />
        )}
      </button>
    </div>
  )
}

// v6 (2026-05) #3++ 完成态横幅：贴顶 sticky，**不挡讲解内容**，用户可关闭后自由翻屏重温。
//   - 行内 3 个紧凑按钮：去训练 / 重新学习 / 关闭
//   - 关闭后用户可继续滚动 / 翻屏；想再看完成提示需要刷新或 reset 重来
//   - 取消阶段 B（"已完成"绿色横幅）—— 用户实测里它再次抢屏没必要
function DoneBanner({
  unitsTotal,
  onReset,
  onDismiss,
}: {
  unitsTotal: number
  onReset: () => void
  onDismiss: () => void
}) {
  const gotoTraining = () => {
    window.dispatchEvent(
      new CustomEvent('reader-pane-change', { detail: { pane: 'training' } }),
    )
  }
  return (
    <div className="sticky top-0 z-20 flex shrink-0 items-center gap-2 border-b border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-[12px] text-text-1 backdrop-blur">
      <Check className="size-4 shrink-0 text-emerald-500" />
      <span className="truncate font-medium">
        路线图讲解全部完成
        <span className="ml-2 text-text-3">· 共 {unitsTotal} 个单元 · 接下来去「训练」答题巩固</span>
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-1.5">
        <button
          type="button"
          onClick={gotoTraining}
          className="inline-flex items-center gap-1 rounded-md bg-indigo-500 px-2.5 py-1 text-[11.5px] font-medium text-white shadow-sm transition hover:bg-indigo-600"
        >
          <Dumbbell className="size-3" /> 去训练
        </button>
        <button
          type="button"
          onClick={onReset}
          className="inline-flex items-center gap-1 rounded-md border border-border-2 px-2 py-1 text-[11.5px] text-text-2 transition hover:bg-bg-2"
          title="重置后会自动归档当前学习流"
        >
          重新学习
        </button>
        <button
          type="button"
          onClick={onDismiss}
          className="inline-flex items-center rounded-md border border-border-2 px-1.5 py-1 text-text-3 transition hover:text-text-1"
          title="关闭提示，继续重温讲解"
        >
          <X className="size-3" />
        </button>
      </span>
    </div>
  )
}
