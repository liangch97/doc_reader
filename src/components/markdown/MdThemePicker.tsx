import { useState } from 'react'
import { Type, Check } from 'lucide-react'
import { MD_THEMES, type MdTheme } from './MarkdownView'
import { cn } from '@/lib/cn'

interface Props {
  value: MdTheme
  onChange: (t: MdTheme) => void
}

/** 紧凑下拉风格的 Markdown 主题切换器 */
export function MdThemePicker({ value, onChange }: Props) {
  const [open, setOpen] = useState(false)
  const current = MD_THEMES.find((t) => t.id === value) ?? MD_THEMES[0]

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        className="flex items-center gap-1 rounded-md border border-border-1 bg-surface-1 px-2 py-1 text-[11px] text-text-2 hover:bg-surface-2"
        title="切换 Markdown 渲染样式"
      >
        <Type className="h-3 w-3" />
        {current.label}
      </button>
      {open && (
        <div className="absolute right-0 top-full z-30 mt-1 w-52 overflow-hidden rounded-md border border-border-1 bg-bg shadow-2xl backdrop-blur ring-1 ring-black/5">
          <div className="max-h-80 overflow-y-auto bg-surface-1">
          {MD_THEMES.map((t) => (
            <button
              key={t.id}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault()
                onChange(t.id)
                setOpen(false)
              }}
              className={cn(
                'flex w-full items-start gap-2 px-3 py-2 text-left text-xs transition-colors',
                t.id === value ? 'bg-accent/15 text-text-1' : 'text-text-2 hover:bg-surface-2'
              )}
            >
              <Check
                className={cn(
                  'mt-0.5 h-3 w-3 shrink-0',
                  t.id === value ? 'text-accent' : 'invisible'
                )}
              />
              <span className="flex-1">
                <span className="block font-medium">{t.label}</span>
                <span className="block text-[10px] text-text-3">{t.hint}</span>
              </span>
            </button>
          ))}
          </div>
        </div>
      )}
    </div>
  )
}
