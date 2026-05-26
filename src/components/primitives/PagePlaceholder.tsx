import { cn } from '@/lib/cn'
import type { ReactNode } from 'react'

/**
 * PagePlaceholder — P0 阶段所有页面共用的占位
 * 后续阶段会被真实页面替换
 */
export function PagePlaceholder({
  title,
  subtitle,
  icon,
  className,
}: {
  title: string
  subtitle?: string
  icon?: ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        'flex h-full w-full flex-col items-center justify-center gap-4 p-10 text-center',
        className
      )}
    >
      <div className="glass-card flex h-20 w-20 items-center justify-center text-accent shadow-glow">
        {icon}
      </div>
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold text-text-1">{title}</h1>
        {subtitle && <p className="text-sm text-text-3">{subtitle}</p>}
      </div>
      <p className="rounded-md border border-border-1 bg-surface-1 px-3 py-1.5 text-xs text-text-3">
        P0 骨架就位 · 真实功能将在后续阶段填充
      </p>
    </div>
  )
}
