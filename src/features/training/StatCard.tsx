/**
 * 统计卡（v5 2026-05 B1 共享底座）
 *
 * 此前在 HomePage / TrainingHome / TrainingHistory 各定义一份 StatCard，
 * 视觉细节略有差异。本组件统一接口，所有训练相关统计卡都用它。
 */
import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { TONE_CLASSES, type Tone } from './theme'

interface StatCardProps {
  /** 主标题（小字 uppercase） */
  label: string
  /** 主数字 / 主内容 */
  value: ReactNode
  /** 副标题（小字辅助说明） */
  sub?: ReactNode
  /** 左侧 lucide 图标（已自带尺寸 / 颜色由 tone 决定） */
  icon: ReactNode
  /** 颜色基调 */
  tone?: Tone
  /** 紧凑模式：纯小尺寸（用于 HomePage 等密集列表） */
  compact?: boolean
  className?: string
}

export function StatCard({ label, value, sub, icon, tone = 'blue', compact = false, className }: StatCardProps) {
  const c = TONE_CLASSES[tone]
  return (
    <div
      className={cn(
        'flex items-center gap-2.5 rounded-lg border border-border-2 bg-bg-1',
        compact ? 'px-2.5 py-1.5' : 'px-3 py-2',
        className,
      )}
    >
      <div
        className={cn(
          'flex shrink-0 items-center justify-center rounded-md',
          compact ? 'size-7' : 'size-8',
          c.iconBg,
          c.text,
        )}
      >
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1.5">
          <span
            className={cn(
              'font-bold leading-none text-text-1 tabular-nums',
              compact ? 'text-[13px]' : 'text-[15px]',
            )}
          >
            {value}
          </span>
          {sub && <span className="text-[9.5px] text-text-3 tabular-nums">{sub}</span>}
        </div>
        <div className="mt-0.5 truncate text-[10px] text-text-3">{label}</div>
      </div>
    </div>
  )
}
