import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Type, ChevronRight, X } from 'lucide-react'
import { cn } from '@/lib/cn'
import type { ReaderPrefs } from '../useReaderPrefs'
import { MD_THEMES, type MdTheme } from '@/components/markdown/MarkdownView'
import { READER_THEME_LIST, type ReaderThemeKey } from '../readerThemes'
import { FONT_CATALOG, loadFont, ensureFontStylesheet } from '@/lib/fontLoader'

/**
 * 平板端阅读设置 Bottom Sheet（TABLET_DESIGN.md §3.5）
 *
 * 自身渲染触发按钮（"Aa"），点击后从底部升起 70vh 抽屉。
 *
 * 一级面板 5 主项：
 *   1. 主题色卡（7 套，源自 readerThemes.ts）
 *   2. 字体卡（7 款，源自 fontLoader.FONT_CATALOG，懒加载）
 *   3. 字号滑块（±）
 *   4. 行距滑块（±）
 *   5. 翻页模式（分页 / 连续）
 *
 * "更多设置" 二级面板：列数 / 页边距 / 字间距 / 段间距 / 首行缩进 / 对齐 /
 * PDF 缩放（如 isPdf） / Md 主题。
 *
 * 所有触控靶 ≥ 44px。颜色走 tokens.css 与 readerThemes 真相源，无硬编码。
 *
 * 注意 fontTouched：用户主动调整字号/行距/字间距时设 true；切字体时若为 false
 * 则套该字体的 recommended 排版，否则保留用户的手调值。
 */
interface Props {
  prefs: ReaderPrefs
  onChange: (patch: Partial<ReaderPrefs>) => void
  readerMdTheme?: MdTheme
  onReaderMdThemeChange?: (t: MdTheme) => void
  resourceKind?: string
}

type View = 'main' | 'more'

export function ReaderSettingsSheet({
  prefs,
  onChange,
  readerMdTheme,
  onReaderMdThemeChange,
  resourceKind,
}: Props) {
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<View>('main')
  const isPdf = resourceKind === 'pdf'
  const btnRef = useRef<HTMLButtonElement>(null)

  // 每次打开重置到主面板
  useEffect(() => {
    if (open) setView('main')
  }, [open])

  // 打开时 Esc 关闭
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  // 进入时预注入 fonts.css，让字体卡的 font-family 预览立刻能拿到真实字形
  useEffect(() => {
    if (open) ensureFontStylesheet()
  }, [open])

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="阅读设置"
        className="flex h-11 w-11 items-center justify-center rounded-md text-text-2 hover:bg-surface-2 hover:text-text-1"
      >
        <Type className="h-5 w-5" />
      </button>
      {open &&
        createPortal(
          <AnchoredPanel
            anchorRef={btnRef}
            onClose={() => setOpen(false)}
          >
            {view === 'main' ? (
              <MainPanel
                prefs={prefs}
                onChange={onChange}
                onMore={() => setView('more')}
                onClose={() => setOpen(false)}
              />
            ) : (
              <MorePanel
                prefs={prefs}
                onChange={onChange}
                readerMdTheme={readerMdTheme}
                onReaderMdThemeChange={onReaderMdThemeChange}
                isPdf={isPdf}
                onBack={() => setView('main')}
              />
            )}
          </AnchoredPanel>,
          document.body,
        )}
    </>
  )
}

/**
 * 锚点弹出面板 —— 用户诉求：
 *   "修改设置不能弹出这么大个半透明悬浮窗然后让背景模糊，应该弹出纯色小一点的菜单，
 *    而且菜单不能再屏幕中央挡住视线，并且让背景清晰"
 *
 * 做法：
 *  - 不再渲染全屏 backdrop / 模糊层 —— 整个阅读区保持清晰可见
 *  - 面板靠右锚定在 "Aa" 按钮下方；最大宽度 360px，最大高度 70vh
 *  - 点击面板外部或按 Esc 自动关闭，但点击不会被 backdrop 吃掉（可继续翻页/选词）
 *  - 背景用 `bg-popover` 纯色 —— 已被 applyReaderThemeToRoot 写为当前阅读主题色
 */
function AnchoredPanel({
  anchorRef,
  onClose,
  children,
}: {
  anchorRef: React.RefObject<HTMLButtonElement | null>
  onClose: () => void
  children: React.ReactNode
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number; width: number }>(
    { top: 56, left: 0, width: 360 }
  )

  useEffect(() => {
    const update = () => {
      const r = anchorRef.current?.getBoundingClientRect()
      if (!r) return
      const W = Math.min(360, window.innerWidth - 16)
      let left = r.right - W
      if (left < 8) left = 8
      if (left + W > window.innerWidth - 8) left = window.innerWidth - W - 8
      const top = r.bottom + 6
      setPos({ top, left, width: W })
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [anchorRef])

  useEffect(() => {
    const onDown = (e: MouseEvent | TouchEvent) => {
      const t = e.target as Node | null
      if (!t) return
      if (panelRef.current?.contains(t)) return
      if (anchorRef.current?.contains(t)) return
      onClose()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('touchstart', onDown)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('touchstart', onDown)
    }
  }, [anchorRef, onClose])

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label="阅读设置"
      className="fixed z-[1000] flex flex-col overflow-hidden rounded-lg border border-border-1 bg-popover shadow-lg"
      style={{
        top: pos.top,
        left: pos.left,
        width: pos.width,
        maxHeight: `min(70vh, calc(100vh - ${pos.top + 16}px))`,
      }}
    >
      {children}
    </div>
  )
}

// =============== 主面板 ===============

function MainPanel({
  prefs,
  onChange,
  onMore,
  onClose,
}: {
  prefs: ReaderPrefs
  onChange: (p: Partial<ReaderPrefs>) => void
  onMore: () => void
  onClose: () => void
}) {
  return (
    <div className="flex h-full flex-col">
      <SheetHeader title="阅读设置" right={<CloseButton onClick={onClose} />} />
      <div className="flex-1 overflow-y-auto px-4 pb-4">
        <Row label="主题">
          <ThemeRow theme={prefs.theme} onPick={(t) => onChange({ theme: t })} />
        </Row>
        <Row label="字体">
          <FontRow
            fontKey={prefs.fontKey}
            fontTouched={prefs.fontTouched}
            onPick={(key) => {
              const item = FONT_CATALOG.find((f) => f.key === key)
              const patch: Partial<ReaderPrefs> = { fontKey: key }
              // 若用户从未手调过排版，切字体时自动应用推荐值
              if (item && !prefs.fontTouched) {
                patch.fontScale = item.recommended.fontScale
                patch.lineHeight = item.recommended.lineHeight
                patch.letterSpacing = item.recommended.letterSpacing
              }
              onChange(patch)
              if (key !== 'system') void loadFont(key)
            }}
          />
        </Row>
        <Row label="字号">
          <StepperRow
            value={prefs.fontScale}
            min={0.7}
            max={1.6}
            step={0.05}
            format={(v) => `${Math.round(v * 16)}px`}
            onChange={(v) => onChange({ fontScale: v, fontTouched: true })}
          />
        </Row>
        <Row label="行距">
          <StepperRow
            value={prefs.lineHeight}
            min={1.0}
            max={2.4}
            step={0.1}
            format={(v) => v.toFixed(1)}
            onChange={(v) => onChange({ lineHeight: v, fontTouched: true })}
          />
        </Row>
        <Row label="翻页">
          <SegmentRow
            options={[
              { value: 'paginated', label: '分页' },
              { value: 'scrolled', label: '连续' },
            ]}
            value={prefs.flow}
            onChange={(v) => onChange({ flow: v as ReaderPrefs['flow'] })}
          />
        </Row>
        <button
          type="button"
          onClick={onMore}
          className="mt-2 flex h-12 w-full items-center justify-between rounded-md px-3 text-sm text-text-2 hover:bg-surface-2"
        >
          <span>更多设置</span>
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
}

// =============== 二级面板（更多设置） ===============

function MorePanel({
  prefs,
  onChange,
  readerMdTheme,
  onReaderMdThemeChange,
  isPdf,
  onBack,
}: {
  prefs: ReaderPrefs
  onChange: (p: Partial<ReaderPrefs>) => void
  readerMdTheme?: MdTheme
  onReaderMdThemeChange?: (t: MdTheme) => void
  isPdf: boolean
  onBack: () => void
}) {
  return (
    <div className="flex h-full flex-col">
      <SheetHeader
        title="更多设置"
        left={
          <button
            type="button"
            onClick={onBack}
            className="flex h-11 w-11 items-center justify-center rounded-md text-text-2 hover:bg-surface-2"
            title="返回"
          >
            <ChevronRight className="h-5 w-5 rotate-180" />
          </button>
        }
      />
      <div className="flex-1 overflow-y-auto px-4 pb-4">
        <Row label="列数">
          <SegmentRow
            options={[
              { value: '1', label: '单页' },
              { value: '2', label: '双页' },
            ]}
            value={String(prefs.maxColumnCount)}
            onChange={(v) => onChange({ maxColumnCount: Number(v) as 1 | 2 })}
          />
        </Row>
        <Row label="页边距">
          <StepperRow
            value={prefs.margin}
            min={0}
            max={120}
            step={8}
            format={(v) => `${v}px`}
            onChange={(v) => onChange({ margin: v })}
          />
        </Row>
        <Row label="字间距">
          <StepperRow
            value={prefs.letterSpacing}
            min={-0.05}
            max={0.2}
            step={0.01}
            format={(v) => `${v.toFixed(2)}em`}
            onChange={(v) => onChange({ letterSpacing: v, fontTouched: true })}
          />
        </Row>
        <Row label="段间距">
          <StepperRow
            value={prefs.paragraphSpacing}
            min={0}
            max={2.0}
            step={0.1}
            format={(v) => `${v.toFixed(1)}em`}
            onChange={(v) => onChange({ paragraphSpacing: v })}
          />
        </Row>
        <Row label="首行缩进">
          <StepperRow
            value={prefs.textIndent}
            min={0}
            max={4}
            step={0.5}
            format={(v) => `${v.toFixed(1)}em`}
            onChange={(v) => onChange({ textIndent: v })}
          />
        </Row>
        <Row label="对齐">
          <SegmentRow
            options={[
              { value: 'left', label: '左对齐' },
              { value: 'justify', label: '两端对齐' },
            ]}
            value={prefs.justify ? 'justify' : 'left'}
            onChange={(v) => onChange({ justify: v === 'justify' })}
          />
        </Row>
        <Row label="点击翻页">
          <SegmentRow
            options={[
              { value: 'on', label: '开' },
              { value: 'off', label: '关' },
            ]}
            value={prefs.tapNavigation ? 'on' : 'off'}
            onChange={(v) => onChange({ tapNavigation: v === 'on' })}
          />
        </Row>
        {isPdf && (
          <Row label="PDF 缩放">
            <SegmentRow
              options={[
                { value: 'fit-width', label: '满宽' },
                { value: '1', label: '100%' },
                { value: '1.5', label: '150%' },
                { value: '2', label: '200%' },
              ]}
              value={String(prefs.fixedZoom)}
              onChange={(v) => {
                if (v === 'fit-width') onChange({ fixedZoom: 'fit-width' })
                else onChange({ fixedZoom: Number(v) })
              }}
            />
          </Row>
        )}
        {onReaderMdThemeChange && (
          <Row label="Md 主题">
            <SegmentRow
              options={[
                { value: 'default', label: '默认' },
                { value: 'newspaper', label: '汉仪' },
                { value: 'minimal', label: '学术' },
              ]}
              value={readerMdTheme || 'default'}
              onChange={(v) => {
                // 设计文档要求平板砍到 3 种，但 MdTheme 联合类型未变；安全 cast
                const ok = MD_THEMES.some((t) => t.id === v) ? (v as MdTheme) : 'default'
                onReaderMdThemeChange(ok)
              }}
            />
          </Row>
        )}
      </div>
    </div>
  )
}

// =============== 复用小组件 ===============

function SheetHeader({
  title,
  left,
  right,
}: {
  title: string
  left?: React.ReactNode
  right?: React.ReactNode
}) {
  return (
    <header className="flex h-14 shrink-0 items-center border-b border-border-1 px-2">
      <div className="w-11">{left}</div>
      <div className="flex-1 text-center text-sm font-medium text-text-1">{title}</div>
      <div className="w-11 text-right">{right}</div>
    </header>
  )
}

function CloseButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-11 w-11 items-center justify-center rounded-md text-text-2 hover:bg-surface-2"
      title="关闭"
    >
      <X className="h-5 w-5" />
    </button>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-[56px] items-center justify-between gap-3 border-b border-border-1/60 py-2">
      <span className="shrink-0 text-sm text-text-2">{label}</span>
      <div className="flex-1">{children}</div>
    </div>
  )
}

function ThemeRow({
  theme,
  onPick,
}: {
  theme: ReaderThemeKey
  onPick: (k: ReaderThemeKey) => void
}) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <ThemeChip active={theme === 'auto'} onClick={() => onPick('auto')} label="跟随系统" />
      {READER_THEME_LIST.map((t) => (
        <button
          key={t.key}
          type="button"
          onClick={() => onPick(t.key)}
          title={t.label}
          aria-label={t.label}
          className={cn(
            'flex h-11 w-11 items-center justify-center rounded-full border-2 transition-transform',
            theme === t.key ? 'scale-110 border-accent' : 'border-border-1 hover:border-text-3',
          )}
          style={{ backgroundColor: t.bg, color: t.fg }}
        >
          <span className="text-sm font-medium">A</span>
        </button>
      ))}
    </div>
  )
}

function ThemeChip({
  active,
  onClick,
  label,
}: {
  active: boolean
  onClick: () => void
  label: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'h-11 rounded-full border px-3 text-xs',
        active
          ? 'border-accent text-accent'
          : 'border-border-1 text-text-2 hover:text-text-1',
      )}
    >
      {label}
    </button>
  )
}

function FontRow({
  fontKey,
  fontTouched: _fontTouched,
  onPick,
}: {
  fontKey: string
  fontTouched: boolean
  onPick: (key: string) => void
}) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {FONT_CATALOG.map((f) => (
        <button
          key={f.key}
          type="button"
          onClick={() => onPick(f.key)}
          className={cn(
            'flex h-11 min-w-[88px] items-center justify-center rounded-md border px-3 text-sm',
            fontKey === f.key
              ? 'border-accent bg-accent/10 text-accent'
              : 'border-border-1 text-text-1 hover:bg-surface-2',
          )}
          style={f.family ? { fontFamily: f.family } : undefined}
        >
          {f.label}
        </button>
      ))}
    </div>
  )
}

function StepperRow({
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  value: number
  min: number
  max: number
  step: number
  format: (v: number) => string
  onChange: (v: number) => void
}) {
  const clamp = (v: number) => Math.min(max, Math.max(min, Math.round(v / step) * step))
  return (
    <div className="flex items-center justify-end gap-2">
      <button
        type="button"
        onClick={() => onChange(clamp(value - step))}
        className="flex h-11 w-11 items-center justify-center rounded-md border border-border-1 text-text-1 hover:bg-surface-2"
        disabled={value <= min}
      >
        −
      </button>
      <span className="min-w-[3rem] text-center text-sm tabular-nums text-text-1">
        {format(value)}
      </span>
      <button
        type="button"
        onClick={() => onChange(clamp(value + step))}
        className="flex h-11 w-11 items-center justify-center rounded-md border border-border-1 text-text-1 hover:bg-surface-2"
        disabled={value >= max}
      >
        +
      </button>
    </div>
  )
}

function SegmentRow({
  options,
  value,
  onChange,
}: {
  options: { value: string; label: string }[]
  value: string
  onChange: (v: string) => void
}) {
  return (
    <div className="flex items-center justify-end gap-1 rounded-md border border-border-1 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cn(
            'h-10 min-w-[60px] rounded px-3 text-xs',
            value === o.value
              ? 'bg-accent text-bg shadow-sm'
              : 'text-text-2 hover:bg-surface-2',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
