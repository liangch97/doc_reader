import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Settings as SettingsIcon, Check } from 'lucide-react'
import { cn } from '@/lib/cn'
import type { ReaderPrefs } from './useReaderPrefs'
import { MD_THEMES, type MdTheme } from '@/components/markdown/MarkdownView'
import { FONT_FAMILIES } from './foliateThemes'
import { READER_THEME_LIST, type ReaderThemeKey } from './readerThemes'

interface Props {
  prefs: ReaderPrefs
  onChange: (patch: Partial<ReaderPrefs>) => void
  /** 阅读区 Markdown 主题（仅影响 EPUB / PDF 主区，与「笔记样式」独立） */
  readerMdTheme?: MdTheme
  onReaderMdThemeChange?: (t: MdTheme) => void
  /**
   * 当前阅读资料的 kind，用来条件显示对应控件：
   *   - 'pdf' → 显示"PDF / 固定布局"section（缩放档位 / 跨页）
   *   - 其他 / undefined → 隐藏 PDF section，只保留 EPUB 排版
   */
  resourceKind?: string
}

/**
 * 阅读设置浮层。
 *
 * 设计要点：
 * 1. **Portal 到 document.body** —— 外部工具栏为了折叠动画加了 `overflow-hidden`，
 *    原本靠 `absolute top-full` 会被工具栏裁掉 → 动该面板几乎看不到。
 *    Portal 走 `position: fixed` 从顶层贴出，根本不受父级 overflow 的限制。
 * 2. **位置根据齿轮按钮 rect 计算**，贴在其正下方；在右侧越界时自动齐右。
 * 3. **点击面板外 / 按 Esc** 关闭；不再使用脆弱的 onBlur 延迟关闭 trick。
 */
export function ReaderSettingsPopover({
  prefs,
  onChange,
  readerMdTheme,
  onReaderMdThemeChange,
  resourceKind,
}: Props) {
  const isPdf = resourceKind === 'pdf'
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number; width: number }>(
    { top: 0, left: 0, width: 288 }
  )

  // 计算 popover 位置：贴在齿轮按钮下方，右边与按钮右边对齐，防越出右侧可视区。
  useLayoutEffect(() => {
    if (!open) return
    const update = () => {
      const r = btnRef.current?.getBoundingClientRect()
      if (!r) return
      const W = 288
      const top = r.bottom + 4
      // 优先顶右边与按钮右对齐；若不够就贴左。
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

  // 点击面板外 / 按 Esc 关闭。注意过滤掉点齿轮按钮本身的事件（该事件已被 onClick toggle 处理）。
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
        className="flex h-8 w-8 items-center justify-center rounded-md text-text-2 hover:bg-surface-2 hover:text-text-1"
        title="阅读设置"
      >
        <SettingsIcon className="h-4 w-4" />
      </button>
      {open && createPortal(
        <div
          ref={panelRef}
          role="dialog"
          aria-label="阅读设置"
          className="fixed z-[1000] overflow-y-auto rounded-md border border-border-1 bg-bg p-3 shadow-2xl ring-1 ring-black/5"
          style={{
            top: pos.top,
            left: pos.left,
            width: pos.width,
            maxHeight: `calc(100vh - ${pos.top + 16}px)`,
          }}
        >
          <Section title="配色">
            <button
              type="button"
              onClick={() => onChange({ theme: 'auto' as ReaderThemeKey })}
              title="跟随系统"
              className={cn(
                'flex h-8 items-center justify-center rounded-md border-2 px-2 text-[11px] transition-colors',
                prefs.theme === 'auto'
                  ? 'border-accent bg-accent/10 text-text-1'
                  : 'border-border-1 bg-surface-2 text-text-2 hover:bg-surface-3',
              )}
            >
              跟随系统
            </button>
            {READER_THEME_LIST.map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => onChange({ theme: t.key })}
                title={t.label}
                aria-label={t.label}
                className={cn(
                  'flex h-8 w-8 items-center justify-center rounded-full border-2 transition-transform',
                  prefs.theme === t.key
                    ? 'scale-110 border-accent'
                    : 'border-border-1 hover:border-text-3',
                )}
                style={{ backgroundColor: t.bg, color: t.fg }}
              >
                <span className="text-[11px] font-medium">A</span>
              </button>
            ))}
          </Section>

          {readerMdTheme && onReaderMdThemeChange && (
            <div className="mb-3">
              <div className="mb-1.5 text-[11px] font-medium text-text-3">
                阅读样式（仅影响 EPUB / PDF 主区）
              </div>
              <div className="flex flex-wrap gap-1">
                {MD_THEMES.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => onReaderMdThemeChange(t.id)}
                    title={t.hint}
                    className={cn(
                      'rounded-md border px-2 py-1 text-[11px] transition-colors',
                      readerMdTheme === t.id
                        ? 'border-accent bg-accent/15 text-text-1'
                        : 'border-border-1 bg-surface-2 text-text-2 hover:bg-surface-3'
                    )}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
              <p className="mt-1.5 text-[10px] text-text-3">
                笔记样式请在右侧「笔记」面板内调整，两者独立不互相影响。
              </p>
            </div>
          )}

          <Section title="翻页模式">
            <SegBtn
              active={prefs.flow === 'paginated'}
              onClick={() => onChange({ flow: 'paginated' })}
            >
              分页
            </SegBtn>
            <SegBtn
              active={prefs.flow === 'scrolled'}
              onClick={() => onChange({ flow: 'scrolled' })}
            >
              滚动连续
            </SegBtn>
          </Section>

          <Section title="列数">
            <SegBtn
              active={prefs.maxColumnCount === 1}
              onClick={() => onChange({ maxColumnCount: 1 })}
            >
              单页
            </SegBtn>
            <SegBtn
              active={prefs.maxColumnCount === 2}
              onClick={() => onChange({ maxColumnCount: 2 })}
            >
              双页
            </SegBtn>
          </Section>

          <Section title={`页边距 ${prefs.margin}px`}>
            <input
              type="range"
              min={0}
              max={120}
              step={4}
              value={prefs.margin}
              onChange={(e) => onChange({ margin: Number(e.target.value) })}
              className="w-full accent-accent"
            />
          </Section>

          <Section title={`列间距 ${prefs.gap}%`}>
            <input
              type="range"
              min={0}
              max={20}
              step={1}
              value={prefs.gap}
              onChange={(e) => onChange({ gap: Number(e.target.value) })}
              className="w-full accent-accent"
            />
          </Section>

          <div className="my-3 h-px bg-border-1/60" />
          <div className="mb-1.5 text-[11px] font-medium text-text-3">排版细节</div>

          <Section title={`字号 ${Math.round(prefs.fontScale * 100)}%`}>
            <input
              type="range"
              min={70}
              max={160}
              step={5}
              value={Math.round(prefs.fontScale * 100)}
              onChange={(e) => onChange({ fontScale: Number(e.target.value) / 100 })}
              className="w-full accent-accent"
            />
          </Section>

          <Section title={`行高 ${prefs.lineHeight.toFixed(2)}`}>
            <input
              type="range"
              min={100}
              max={240}
              step={5}
              value={Math.round(prefs.lineHeight * 100)}
              onChange={(e) => onChange({ lineHeight: Number(e.target.value) / 100 })}
              className="w-full accent-accent"
            />
          </Section>

          <Section title={`字间距 ${prefs.letterSpacing.toFixed(2)}em`}>
            <input
              type="range"
              min={-5}
              max={20}
              step={1}
              value={Math.round(prefs.letterSpacing * 100)}
              onChange={(e) =>
                onChange({ letterSpacing: Number(e.target.value) / 100 })
              }
              className="w-full accent-accent"
            />
          </Section>

          <Section title={`段间距 ${prefs.paragraphSpacing.toFixed(1)}em`}>
            <input
              type="range"
              min={0}
              max={20}
              step={1}
              value={Math.round(prefs.paragraphSpacing * 10)}
              onChange={(e) =>
                onChange({ paragraphSpacing: Number(e.target.value) / 10 })
              }
              className="w-full accent-accent"
            />
          </Section>

          <Section title={`首行缩进 ${prefs.textIndent}em`}>
            <input
              type="range"
              min={0}
              max={4}
              step={1}
              value={prefs.textIndent}
              onChange={(e) => onChange({ textIndent: Number(e.target.value) })}
              className="w-full accent-accent"
            />
          </Section>

          <Section title="文本对齐">
            <SegBtn active={!prefs.justify} onClick={() => onChange({ justify: false })}>
              左对齐
            </SegBtn>
            <SegBtn active={prefs.justify} onClick={() => onChange({ justify: true })}>
              两端对齐
            </SegBtn>
          </Section>

          <Section title="字体覆盖">
            <SegBtn
              active={!prefs.overrideFont}
              onClick={() => onChange({ overrideFont: false })}
            >
              用书自带
            </SegBtn>
            <SegBtn
              active={prefs.overrideFont}
              onClick={() => onChange({ overrideFont: true })}
            >
              用阅读样式
            </SegBtn>
          </Section>

          <div className="mb-3">
            <div className="mb-1.5 text-[11px] font-medium text-text-3">
              正文字体（覆盖开启时生效）
            </div>
            <div className="flex flex-wrap gap-1">
              {FONT_FAMILIES.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => onChange({ bodyFontFamily: f.id })}
                  className={cn(
                    'rounded-md border px-2 py-1 text-[11px] transition-colors',
                    prefs.bodyFontFamily === f.id
                      ? 'border-accent bg-accent/15 text-text-1'
                      : 'border-border-1 bg-surface-2 text-text-2 hover:bg-surface-3'
                  )}
                  style={f.family ? { fontFamily: f.family } : undefined}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          <Section title="点击翻页">
            <SegBtn
              active={prefs.tapNavigation}
              onClick={() => onChange({ tapNavigation: true })}
            >
              开启
            </SegBtn>
            <SegBtn
              active={!prefs.tapNavigation}
              onClick={() => onChange({ tapNavigation: false })}
            >
              关闭
            </SegBtn>
          </Section>
          <p className="mb-2 text-[10px] text-text-3">
            开启后：点左 35% 上一页，右 35% 下一页，中央切换工具栏。
          </p>

          {isPdf && (
            <>
              <div className="my-3 h-px bg-border-1/60" />
              <div className="mb-1.5 text-[11px] font-medium text-text-3">PDF 页面</div>

              {/* 缩放档位 —— 常用 7 档 + 自适应；比旧的"适宽/适页/百分比"三按钮再
                  拉 slider 要直观得多。选中 fit-width 时各固定档变成次要选项。 */}
              <div className="mb-1.5 text-[11px] font-medium text-text-3">页面大小</div>
              <div className="mb-3 grid grid-cols-4 gap-1">
                <ZoomBtn
                  active={prefs.fixedZoom === 'fit-width'}
                  onClick={() => onChange({ fixedZoom: 'fit-width' })}
                  title="按容器宽度自动缩放"
                >
                  自适应
                </ZoomBtn>
                {PDF_ZOOM_PRESETS.map((pct) => (
                  <ZoomBtn
                    key={pct}
                    active={prefs.fixedZoom === pct}
                    onClick={() => onChange({ fixedZoom: pct })}
                  >
                    {pct}%
                  </ZoomBtn>
                ))}
              </div>

              {/* 自定义滑杆：只在选了固定百分比档时才显示 */}
              {typeof prefs.fixedZoom === 'number' && (
                <Section title={`自定义缩放 ${prefs.fixedZoom}%`}>
                  <input
                    type="range"
                    min={40}
                    max={300}
                    step={5}
                    value={prefs.fixedZoom}
                    onChange={(e) =>
                      onChange({ fixedZoom: Number(e.target.value) })
                    }
                    className="w-full accent-accent"
                  />
                </Section>
              )}
            </>
          )}

          <p className="mt-2 flex items-start gap-1 text-[10px] text-text-3">
            <Check className="mt-0.5 h-3 w-3 shrink-0 text-success" />
            {isPdf
              ? 'PDF 走「页面大小」；排版/字体对 PDF 不生效。'
              : '排版/字体仅对流式电子书（EPUB / MOBI / FB2 / CBZ）生效。'}
          </p>
        </div>,
        document.body
      )}
    </>
  )
}

/**
 * PDF 页面缩放常用档位（百分比）。从最常用的 100% 向两边扩展：
 *   75 / 100 / 125 / 150 / 200 / 250 / 300
 * 这 7 档 + "自适应"（fit-width）共 8 个按钮恰好 2 行 × 4 列。
 */
const PDF_ZOOM_PRESETS: number[] = [75, 100, 125, 150, 200, 250, 300]

/** PDF 缩放档位按钮 —— 与 SegBtn 同款，但更紧凑、为 4 列网格设计 */
function ZoomBtn({
  children,
  active,
  onClick,
  title,
}: {
  children: React.ReactNode
  active?: boolean
  onClick?: () => void
  title?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        'rounded-md border px-1.5 py-1.5 text-[11px] transition-colors',
        active
          ? 'border-accent bg-accent/15 text-text-1'
          : 'border-border-1 bg-surface-2 text-text-2 hover:bg-surface-3'
      )}
    >
      {children}
    </button>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-3">
      <div className="mb-1.5 text-[11px] font-medium text-text-3">{title}</div>
      <div className="flex gap-1">{children}</div>
    </div>
  )
}

function SegBtn({
  children,
  active,
  onClick,
}: {
  children: React.ReactNode
  active?: boolean
  onClick?: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex-1 rounded-md border px-2 py-1.5 text-xs transition-colors',
        active
          ? 'border-accent bg-accent/15 text-text-1'
          : 'border-border-1 bg-surface-2 text-text-2 hover:bg-surface-3'
      )}
    >
      {children}
    </button>
  )
}
