/**
 * 训练 / 学习模块共享视觉底座（v5 2026-05 B1）
 *
 * 收敛 4 处分散的 TYPE_COLORS / TYPE_ICONS / 段位计算 / StatCard 定义。
 * 所有训练相关页面（TrainingHome / TrainingSession / TrainingHistory / SkillTreeView）
 * 以及 HomePage / SkillsPage 通用化的训练区都从这里 import。
 *
 * Tailwind JIT 限制：所有 class 必须**字面量**字符串，不能模板拼接（purge 会删）。
 * 因此每个 tone 都列完整 class 集合。
 */
import {
  Bug,
  Check,
  Code2,
  type LucideIcon,
  Pencil,
  Shuffle,
  FileText,
} from 'lucide-react'
import type { TrainingType } from './types'

// ─────────────────────────────────────────────────────────────────────────
// ① 题型 → 颜色调板
// ─────────────────────────────────────────────────────────────────────────

/** 单个题型的完整颜色集合。所有 class 字面量。 */
export interface TypeColor {
  /** 选中态边框 */
  border: string
  /** 选中态浅底 */
  bg: string
  /** 图标块底色（更深的浅色） */
  iconBg: string
  /** 图标 / 标签文字 */
  iconText: string
  /** 实心点（选中徽章 / dot indicator） */
  dot: string
  /** 主色 ring（hover / focus） */
  ring: string
}

export const TYPE_COLORS: Record<TrainingType, TypeColor> = {
  choice: {
    border: 'border-blue-500/50',
    bg: 'bg-blue-500/[0.06]',
    iconBg: 'bg-blue-500/15',
    iconText: 'text-blue-600 dark:text-blue-400',
    dot: 'bg-blue-500',
    ring: 'ring-blue-500/30',
  },
  short: {
    border: 'border-purple-500/50',
    bg: 'bg-purple-500/[0.06]',
    iconBg: 'bg-purple-500/15',
    iconText: 'text-purple-600 dark:text-purple-400',
    dot: 'bg-purple-500',
    ring: 'ring-purple-500/30',
  },
  code: {
    border: 'border-emerald-500/50',
    bg: 'bg-emerald-500/[0.06]',
    iconBg: 'bg-emerald-500/15',
    iconText: 'text-emerald-600 dark:text-emerald-400',
    dot: 'bg-emerald-500',
    ring: 'ring-emerald-500/30',
  },
  debug: {
    border: 'border-rose-500/50',
    bg: 'bg-rose-500/[0.06]',
    iconBg: 'bg-rose-500/15',
    iconText: 'text-rose-600 dark:text-rose-400',
    dot: 'bg-rose-500',
    ring: 'ring-rose-500/30',
  },
  fill: {
    border: 'border-amber-500/50',
    bg: 'bg-amber-500/[0.06]',
    iconBg: 'bg-amber-500/15',
    iconText: 'text-amber-600 dark:text-amber-400',
    dot: 'bg-amber-500',
    ring: 'ring-amber-500/30',
  },
  sequence: {
    border: 'border-cyan-500/50',
    bg: 'bg-cyan-500/[0.06]',
    iconBg: 'bg-cyan-500/15',
    iconText: 'text-cyan-600 dark:text-cyan-400',
    dot: 'bg-cyan-500',
    ring: 'ring-cyan-500/30',
  },
}

/** 题型 → lucide 图标 */
export const TYPE_ICONS: Record<TrainingType, LucideIcon> = {
  choice: Check,
  short: Pencil,
  code: Code2,
  debug: Bug,
  fill: FileText,
  sequence: Shuffle,
}

// ─────────────────────────────────────────────────────────────────────────
// ② 通用 tone（非题型场景使用，如 StatCard / EntryCard）
// ─────────────────────────────────────────────────────────────────────────

export type Tone = 'blue' | 'emerald' | 'purple' | 'amber' | 'rose' | 'cyan'

interface ToneClasses {
  bg: string
  text: string
  iconBg: string
  hoverBorder: string
  hoverBg: string
}

export const TONE_CLASSES: Record<Tone, ToneClasses> = {
  blue: {
    bg: 'bg-blue-500/10',
    text: 'text-blue-600 dark:text-blue-400',
    iconBg: 'bg-blue-500/15',
    hoverBorder: 'hover:border-blue-500/40',
    hoverBg: 'hover:bg-blue-500/[0.04]',
  },
  emerald: {
    bg: 'bg-emerald-500/10',
    text: 'text-emerald-600 dark:text-emerald-400',
    iconBg: 'bg-emerald-500/15',
    hoverBorder: 'hover:border-emerald-500/40',
    hoverBg: 'hover:bg-emerald-500/[0.04]',
  },
  purple: {
    bg: 'bg-purple-500/10',
    text: 'text-purple-600 dark:text-purple-400',
    iconBg: 'bg-purple-500/15',
    hoverBorder: 'hover:border-purple-500/40',
    hoverBg: 'hover:bg-purple-500/[0.04]',
  },
  amber: {
    bg: 'bg-amber-500/10',
    text: 'text-amber-600 dark:text-amber-400',
    iconBg: 'bg-amber-500/15',
    hoverBorder: 'hover:border-amber-500/40',
    hoverBg: 'hover:bg-amber-500/[0.04]',
  },
  rose: {
    bg: 'bg-rose-500/10',
    text: 'text-rose-600 dark:text-rose-400',
    iconBg: 'bg-rose-500/15',
    hoverBorder: 'hover:border-rose-500/40',
    hoverBg: 'hover:bg-rose-500/[0.04]',
  },
  cyan: {
    bg: 'bg-cyan-500/10',
    text: 'text-cyan-600 dark:text-cyan-400',
    iconBg: 'bg-cyan-500/15',
    hoverBorder: 'hover:border-cyan-500/40',
    hoverBg: 'hover:bg-cyan-500/[0.04]',
  },
}

// ─────────────────────────────────────────────────────────────────────────
// ③ 段位计算（用户级 / 单技能级）
// ─────────────────────────────────────────────────────────────────────────

/**
 * 用户段位（基于全局平均掌握度）：5 档。
 *
 * 阈值历史踩坑：HomePage 与 TrainingHome 各定义一份且阈值不一致
 * （0.3/0.55/0.75/0.9 vs 0.2/0.4/0.6/0.85）。本函数是**唯一来源**。
 */
export interface UserTier {
  level: number          // 1..5
  label: string          // 初学者 / 学徒 / 熟练 / 高手 / 大师
  iconClass: string
  bgClass: string
  ringClass: string
  barClass: string
  /** 距离下一档还差多少 % 掌握度（已到大师返回 '已达巅峰'） */
  nextHint: string
}

const TIER_THRESHOLDS = [0.3, 0.55, 0.75, 0.9] as const

export function computeUserTier(avgMastery: number): UserTier {
  const m = Math.max(0, Math.min(1, avgMastery))
  if (m >= TIER_THRESHOLDS[3]) {
    return {
      level: 5,
      label: '大师',
      iconClass: 'text-purple-600 dark:text-purple-400',
      bgClass: 'bg-purple-500/12',
      ringClass: 'ring-purple-500/30',
      barClass: 'bg-gradient-to-r from-purple-500 to-fuchsia-500',
      nextHint: '已达巅峰',
    }
  }
  if (m >= TIER_THRESHOLDS[2]) {
    return {
      level: 4,
      label: '高手',
      iconClass: 'text-blue-600 dark:text-blue-400',
      bgClass: 'bg-blue-500/12',
      ringClass: 'ring-blue-500/30',
      barClass: 'bg-blue-500',
      nextHint: `距大师 ${Math.round((TIER_THRESHOLDS[3] - m) * 100)}%`,
    }
  }
  if (m >= TIER_THRESHOLDS[1]) {
    return {
      level: 3,
      label: '熟练',
      iconClass: 'text-emerald-600 dark:text-emerald-400',
      bgClass: 'bg-emerald-500/12',
      ringClass: 'ring-emerald-500/30',
      barClass: 'bg-emerald-500',
      nextHint: `距高手 ${Math.round((TIER_THRESHOLDS[2] - m) * 100)}%`,
    }
  }
  if (m >= TIER_THRESHOLDS[0]) {
    return {
      level: 2,
      label: '学徒',
      iconClass: 'text-amber-600 dark:text-amber-400',
      bgClass: 'bg-amber-500/12',
      ringClass: 'ring-amber-500/30',
      barClass: 'bg-amber-500',
      nextHint: `距熟练 ${Math.round((TIER_THRESHOLDS[1] - m) * 100)}%`,
    }
  }
  return {
    level: 1,
    label: '初学者',
    iconClass: 'text-text-2',
    bgClass: 'bg-bg-2/60',
    ringClass: 'ring-border-1',
    barClass: 'bg-text-3/40',
    nextHint: m > 0 ? `距学徒 ${Math.round((TIER_THRESHOLDS[0] - m) * 100)}%` : '答题开启段位',
  }
}

/**
 * 单个技能段位（基于该技能的 mastery + practice_count）：4 档 + locked。
 * 用于 SkillTreeView 的 SkillBadge / SkillsPage 的技能分级显示。
 */
export interface SkillTier {
  /** 罗马数字徽章：? / I / II / III / IV */
  label: string
  tierLabel: string       // 未解锁 / 初识 / 熟悉 / 掌握 / 精通
  badgeClass: string
  badgeRing: string
  borderClass: string
  bgClass: string
  barClass: string
  tierTextClass: string
}

const SKILL_TIER_THRESHOLDS = [0.3, 0.6, 0.85] as const

export function computeSkillTier(mastery: number, practiceCount: number): SkillTier {
  if (practiceCount === 0) {
    return {
      label: '?',
      tierLabel: '未解锁',
      badgeClass: 'bg-bg-2/40 text-text-3',
      badgeRing: 'ring-border-2',
      borderClass: 'border-border-2/60 border-dashed',
      bgClass: 'bg-bg-1',
      barClass: 'bg-text-3/30',
      tierTextClass: 'text-text-3',
    }
  }
  const m = Math.max(0, Math.min(1, mastery))
  if (m < SKILL_TIER_THRESHOLDS[0]) {
    return {
      label: 'I',
      tierLabel: '初识',
      badgeClass: 'bg-rose-500/15 text-rose-600 dark:text-rose-400',
      badgeRing: 'ring-rose-500/30',
      borderClass: 'border-rose-500/30',
      bgClass: 'bg-rose-500/[0.04]',
      barClass: 'bg-rose-500',
      tierTextClass: 'text-rose-600 dark:text-rose-400',
    }
  }
  if (m < SKILL_TIER_THRESHOLDS[1]) {
    return {
      label: 'II',
      tierLabel: '熟悉',
      badgeClass: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
      badgeRing: 'ring-amber-500/30',
      borderClass: 'border-amber-500/30',
      bgClass: 'bg-amber-500/[0.04]',
      barClass: 'bg-amber-500',
      tierTextClass: 'text-amber-600 dark:text-amber-400',
    }
  }
  if (m < SKILL_TIER_THRESHOLDS[2]) {
    return {
      label: 'III',
      tierLabel: '掌握',
      badgeClass: 'bg-blue-500/15 text-blue-600 dark:text-blue-400',
      badgeRing: 'ring-blue-500/30',
      borderClass: 'border-blue-500/30',
      bgClass: 'bg-blue-500/[0.04]',
      barClass: 'bg-blue-500',
      tierTextClass: 'text-blue-600 dark:text-blue-400',
    }
  }
  return {
    label: 'IV',
    tierLabel: '精通',
    badgeClass: 'bg-emerald-500/20 text-emerald-600 dark:text-emerald-400',
    badgeRing: 'ring-emerald-500/40',
    borderClass: 'border-emerald-500/40',
    bgClass: 'bg-emerald-500/[0.06]',
    barClass: 'bg-gradient-to-r from-emerald-500 to-cyan-500',
    tierTextClass: 'text-emerald-600 dark:text-emerald-400',
  }
}

// ─────────────────────────────────────────────────────────────────────────
// ④ 公共 helpers
// ─────────────────────────────────────────────────────────────────────────

/** 0..1 mastery → 整数百分比 */
export const masteryPct = (m: number): number => Math.round(Math.max(0, Math.min(1, m)) * 100)

/** mastery 0..1 → bar 颜色 class（4 档） */
export function masteryBarClass(m: number): string {
  if (m >= 0.8) return 'bg-emerald-500'
  if (m >= 0.5) return 'bg-blue-500'
  if (m >= 0.2) return 'bg-amber-500'
  return 'bg-rose-500'
}
