import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Type } from 'lucide-react'
import { cn } from '@/lib/cn'
import {
  type NotesPrefs,
  type NotesFontFamily,
  NOTES_PREFS_DEFAULT,
} from './notesPrefs'

interface Props {
  prefs: NotesPrefs
  onChange: (patch: Partial<NotesPrefs>) => void
}

const FONT_OPTIONS: Array<{ id: NotesFontFamily; label: string; preview: string }> = [
  { id: 'system', label: '系统默认', preview: 'Aa 默认' },
  { id: 'sans', label: '无衬线', preview: 'Aa 现代' },
  { id: 'serif', label: '衬线（思源宋体）', preview: 'Aa 学术' },
  { id: 'mono', label: '等宽（代码）', preview: 'Aa Mono' },
]

/**
 * 笔记区设置浮层 —— 字号 / 行距 / 字间距 / 字体族。
 *
 * 设计说明：
 * - 与 `ReaderSettingsPopover` 风格保持一致（齿轮按钮 + portal 浮层），但简化
 *   到只有 4 个核心轴：字号 / 行距 / 字间距 / 字体。笔记区比阅读区使用频率低，
 *   过多选项反而干扰；这 4 个能覆盖 90% 的可读性诉求。
 * - 通过 `notesPrefsToStyle()` 把值映射到 CSS 变量，markdown.css 用 var() 消费。
 * - 状态持久化在 localStorage（不持久化到后端）—— 笔记区写量不大，
 *   跨设备同步不是核心需求。
 */
export function NotesSettingsPopover({ prefs, onChange }: Props) {
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ top: 0, left: 0, width: 280 })

  useLayoutEffect(() => {
    if (!open) return
    const update = () => {
      const r = btnRef.current?.getBoundingClientRect()
      if (!r) return
      const W = 280
      const top = r.bottom + 4
      let left = r.right - W
      if (left < 8) left = Math.min(r.left, window.innerWidth - W - 8)
      setPos({ top, left, width: W })
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node | null
      if (!t) return
      if (panelRef.current?.contains(t)) return
      if (btnRef.current?.contains(t)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="笔记排版（字号 / 行距 / 字体）"
        className={cn(
          'flex items-center gap-1 rounded-md border border-border-1 bg-surface-1 px-2 py-1 text-xs text-text-1 hover:bg-surface-2',
          open && 'bg-surface-2'
        )}
      >
        <Type className="h-3 w-3" />
        <span className="hidden sm:inline">排版</span>
      </button>
      {open &&
        createPortal(
          <div
            ref={panelRef}
            style={{ top: pos.top, left: pos.left, width: pos.width }}
            className="fixed z-[1000] flex flex-col gap-3 rounded-lg border border-border-1 bg-popover p-3 text-xs shadow-2xl"
          >
            <Slider
              label="字号"
              value={prefs.fontSize}
              min={12}
              max={22}
              step={1}
              suffix="px"
              onChange={(v) => onChange({ fontSize: v })}
            />
            <Slider
              label="行距"
              value={prefs.lineHeight}
              min={1.3}
              max={2.6}
              step={0.05}
              format={(v) => v.toFixed(2)}
              onChange={(v) => onChange({ lineHeight: v })}
            />
            <Slider
              label="字间距"
              value={prefs.letterSpacing}
              min={0}
              max={0.1}
              step={0.005}
              suffix="em"
              format={(v) => v.toFixed(3)}
              onChange={(v) => onChange({ letterSpacing: v })}
            />
            <div>
              <label className="mb-1 flex justify-between text-text-3">
                <span>字体</span>
                <span className="text-text-2">
                  {FONT_OPTIONS.find((o) => o.id === prefs.fontFamily)?.label}
                </span>
              </label>
              <div className="grid grid-cols-2 gap-1.5">
                {FONT_OPTIONS.map((o) => (
                  <button
                    key={o.id}
                    type="button"
                    onClick={() => onChange({ fontFamily: o.id })}
                    className={cn(
                      'rounded-md border px-2 py-1.5 text-left transition-colors',
                      prefs.fontFamily === o.id
                        ? 'border-accent bg-accent/10 text-text-1'
                        : 'border-border-1 text-text-2 hover:bg-surface-2'
                    )}
                  >
                    <div className="text-[11px]">{o.label}</div>
                    <div
                      className="text-[13px] text-text-1"
                      style={{ fontFamily: previewFontFor(o.id) }}
                    >
                      {o.preview}
                    </div>
                  </button>
                ))}
              </div>
            </div>
            <button
              type="button"
              onClick={() => onChange(NOTES_PREFS_DEFAULT)}
              className="text-[11px] text-text-3 hover:text-text-1 underline-offset-2 hover:underline self-end"
            >
              恢复默认
            </button>
          </div>,
          document.body
        )}
    </>
  )
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  suffix,
  format,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  suffix?: string
  format?: (v: number) => string
  onChange: (v: number) => void
}) {
  return (
    <div>
      <label className="mb-1 flex justify-between text-text-3">
        <span>{label}</span>
        <span className="text-text-2 tabular-nums">
          {format ? format(value) : value}
          {suffix}
        </span>
      </label>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full accent-accent"
      />
    </div>
  )
}

function previewFontFor(id: NotesFontFamily): string {
  switch (id) {
    case 'system':
      return "'Inter', sans-serif"
    case 'sans':
      return "'Inter', 'Helvetica Neue', sans-serif"
    case 'serif':
      return "'Source Serif 4', Georgia, serif"
    case 'mono':
      return "'JetBrains Mono', Consolas, monospace"
  }
}
