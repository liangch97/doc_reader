/// 训练模块共享类型（前后端契约）。

/** 题型扩展：选择 / 简答（复用 agent）+ 代码 / 调试 / 填空 / 排序（训练独有） */
export type TrainingType = 'choice' | 'short' | 'code' | 'debug' | 'fill' | 'sequence'

/** 代码题测试用例（仅 code/debug 类型有） */
export interface TestCase {
  stdin: string
  expected_stdout: string
  description?: string
}

/** 训练题（LLM 生成、用户答题、提交评分的核心数据结构） */
export interface TrainingQuestion {
  id: string
  type: TrainingType
  /** 关联的技能 id 列表（最多 3 个，对应后端 SE 技能树） */
  skills: string[]
  /** 难度 1-5 */
  difficulty: number
  prompt: string
  /** 选择题 4 选项 / 排序题待排步骤 */
  choices?: string[]
  /** 代码题语言（python/javascript/rust/...） */
  language?: string
  /** 代码题起始代码 */
  starter_code?: string
  /** 代码题测试用例 */
  tests?: TestCase[]
  /** 参考答案 */
  answer: string
  /** 评分细则 */
  rubric?: string
}

/** Piston 代码运行结果 */
export interface CodeRunResult {
  success: boolean
  stdout: string
  stderr: string
  exit_code: number | null
  time_ms: number
  language: string
  version?: string | null
  fallback_used: boolean
}

/** LLM 评分结果 */
export interface GradeResult {
  score: number
  is_correct: boolean
  feedback: string
  missed_points?: string[]
}

/** 提交答题后的返回 */
export interface SubmitAttemptResp {
  attempt_id: string
  grade: GradeResult
  score: number
  is_correct: boolean
  skills_updated: string[]
  delta_per_skill: number
}

/** 训练历史中的一条记录 */
export interface TrainingAttempt {
  attempt_id: string
  unit_index: number | null
  question_id: string
  question: TrainingQuestion | null
  user_answer: string
  code_run: CodeRunResult | null
  grade: GradeResult | null
  skills: string[]
  score: number
  is_correct: boolean
  created_at: string
}

/** 训练统计 */
export interface TrainingStats {
  total_attempts: number
  total_correct: number
  avg_score: number
  accuracy: number
}

/** 技能树单节点（合并预设 + 学生进度） */
export interface SkillNodeWithProgress {
  id: string
  name: string
  category: string
  description: string
  max_difficulty: number
  mastery: number  // 0-1
  practice_count: number
  correct_count: number
  last_practiced_at: string | null
}

/** 技能树分组 */
export interface SkillGroup {
  category: string
  skills: SkillNodeWithProgress[]
}

/** 技能树总览 */
export interface SkillOverview {
  groups: SkillGroup[]
  summary: {
    total_skills: number
    unlocked_skills: number
    avg_mastery: number
  }
}

/** 题型显示文案 */
export const TYPE_LABELS: Record<TrainingType, string> = {
  choice: '选择',
  short: '简答',
  code: '代码',
  debug: '调试',
  fill: '填空',
  sequence: '排序',
}

/** 题型 emoji 图标 */
export const TYPE_ICONS: Record<TrainingType, string> = {
  choice: '◯',
  short: '✎',
  code: '⌨',
  debug: '🪲',
  fill: '__',
  sequence: '↕',
}

/** 训练页面的"路由"状态 */
export type TrainingView =
  | { kind: 'home' }
  | { kind: 'session'; questions: TrainingQuestion[]; unitIndex: number | null; language: string; difficulty: number }
  | { kind: 'skill-tree' }
  | { kind: 'history' }

/** 支持的代码题语言（前端选择器用） */
export const SUPPORTED_LANGUAGES = [
  { value: 'python', label: 'Python', ext: 'py' },
  { value: 'javascript', label: 'JavaScript', ext: 'js' },
  { value: 'typescript', label: 'TypeScript', ext: 'ts' },
  { value: 'rust', label: 'Rust', ext: 'rs' },
  { value: 'java', label: 'Java', ext: 'java' },
  { value: 'cpp', label: 'C++', ext: 'cpp' },
  { value: 'c', label: 'C', ext: 'c' },
  { value: 'go', label: 'Go', ext: 'go' },
] as const

export type SupportedLanguage = typeof SUPPORTED_LANGUAGES[number]['value']
