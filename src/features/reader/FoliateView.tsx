import { useCallback, useEffect, useRef, useState } from 'react'
import {
  loadFoliate,
  loadOverlayer,
  loadFootnoteHandler,
  base64ToBlob,
  mimeFromFilename,
  type FoliateLoadDetail,
  type FoliateRelocateDetail,
  type FoliateTocItem,
  type FoliateViewElement,
  type FoliateDrawAnnotationDetail,
  type FoliateShowAnnotationDetail,
  type FootnoteHandlerInstance,
  type FootnoteRenderDetail,
  type OverlayerStatic,
} from '@/lib/foliate'
import { resourcesApi } from '@/lib/api'
import type { Resource } from '@/types/resource'
import type { MdTheme } from '@/components/markdown/MarkdownView'
import { buildFoliateThemeCSS } from './foliateThemes'
import type { ReaderPrefs } from './useReaderPrefs'
import { FootnotePopover, type FootnotePopoverData } from './FootnotePopover'

declare global {
  interface HTMLElementTagNameMap {
    'foliate-view': FoliateViewElement
  }
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      'foliate-view': React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>
    }
  }
}

interface FoliateViewProps {
  resource: Resource
  mdTheme?: MdTheme
  prefs?: ReaderPrefs
  /**
   * 续读起点 cfi（来自 reading_progress 表）。view.open 之后会调
   * `view.goTo(initialCfi)`；空串/undefined → 从书首开始。
   */
  initialCfi?: string
  onReady?: (view: FoliateViewElement, overlayer: OverlayerStatic) => void
  onRelocate?: (detail: FoliateRelocateDetail) => void
  onTocReady?: (toc: FoliateTocItem[]) => void
  onLoad?: (detail: FoliateLoadDetail) => void
  onShowAnnotation?: (detail: FoliateShowAnnotationDetail) => void
  onDrawAnnotation?: (detail: FoliateDrawAnnotationDetail, overlayer: OverlayerStatic) => void
  /**
   * 点击阅读区中央回调（C1 tap navigation）。
   * 仅当 prefs.tapNavigation === true 时生效；prev/next 在内部直接调 view.prev/next，
   * middle 由调用方决定（通常 toggle 工具栏可见）。
   */
  onTapMiddle?: () => void
  /**
   * 是否为触控布局。
   * - true (phone / tablet)：tap 分区 20/60/20（中央大区域切工具栏）
   * - false (desktop)：35/30/35（鼠标点击左右边很鲜翻页）
   * 详见 TABLET_DESIGN.md §3.3。
   */
  touchLayout?: boolean
}

type Status = 'loading' | 'success' | 'error'

export function FoliateView({
  resource,
  mdTheme,
  prefs,
  initialCfi,
  onReady,
  onRelocate,
  onTocReady,
  onLoad,
  onShowAnnotation,
  onDrawAnnotation,
  onTapMiddle,
  touchLayout,
}: FoliateViewProps) {
  // 续读起点用 ref 锁定第一次值：bootstrap 异步链路里读 ref 而不是闭包，
  // 避免 ReaderShell 后续刷新 progress 导致 cfi 变了又重跳。
  const initialCfiRef = useRef<string | undefined>(initialCfi)
  useEffect(() => {
    initialCfiRef.current = initialCfi
  }, [initialCfi])

  // tap-navigation 用 ref 记最新 prefs / 回调，避免 iframe 上注册的 listener
  // 闭包捕获到旧值（iframe 在 'load' 事件里注册一次，长期存在）
  const tapPrefsRef = useRef({
    enabled: prefs?.tapNavigation ?? true,
    onMiddle: onTapMiddle,
    touchLayout: !!touchLayout,
  })
  useEffect(() => {
    tapPrefsRef.current = {
      enabled: prefs?.tapNavigation ?? true,
      onMiddle: onTapMiddle,
      touchLayout: !!touchLayout,
    }
  }, [prefs?.tapNavigation, onTapMiddle, touchLayout])
  const containerRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<FoliateViewElement | null>(null)
  const footnoteHandlerRef = useRef<FootnoteHandlerInstance | null>(null)
  const [status, setStatus] = useState<Status>('loading')
  const [errorMsg, setErrorMsg] = useState<string>('')
  /** 当前显示的脚注弹层；null 表示不显示 */
  const [footnote, setFootnote] = useState<FootnotePopoverData | null>(null)
  const closeFootnote = useCallback(() => setFootnote(null), [])
  const jumpToFootnoteSource = useCallback((href: string) => {
    setFootnote(null)
    viewRef.current?.goTo(href).catch((err) =>
      console.warn('[FoliateView] footnote jump failed', err)
    )
  }, [])

  useEffect(() => {
    let cancelled = false
    let view: FoliateViewElement | null = null

    async function bootstrap() {
      try {
        setStatus('loading')
        await loadFoliate()
        const overlayer = await loadOverlayer()
        const FootnoteCtor = await loadFootnoteHandler()
        if (cancelled || !containerRef.current) return

        if (viewRef.current) {
          viewRef.current.remove()
          viewRef.current = null
        }

        view = document.createElement('foliate-view') as FoliateViewElement
        view.style.width = '100%'
        view.style.height = '100%'
        view.style.display = 'block'
        containerRef.current.appendChild(view)
        viewRef.current = view

        const handleLoad = (e: Event) => {
          const detail = (e as CustomEvent<FoliateLoadDetail>).detail
          // 切章 fade-in：每次新 section iframe 加载完，把 body opacity 从 0 过渡到 1。
          // 在 scrolled 连续阅读模式下，vendor paginator 触底自动续章时 iframe
          // 会被整体替换；直接展示新内容会让用户看到「瞬间跳变」。用 CSS transition
          // 做一个 ~220ms 淡入可显著缓解视觉断层感。paginated 模式已由 vendor 的
          // `animated` 属性处理滑动过渡，此处仅对 scrolled 模式生效，足够 subtle
          // 不会干扰分页切换。
          try {
            const body = detail?.doc?.body
            if (body) {
              body.style.opacity = '0'
              body.style.transition = 'opacity 220ms ease-out'
              requestAnimationFrame(() =>
                requestAnimationFrame(() => {
                  body.style.opacity = '1'
                })
              )
            }
          } catch (err) {
            console.warn('[FoliateView] section fade install failed', err)
          }
          // 把 iframe 内的 keydown 转发到主窗口，让全局快捷键可用
          // foliate 用沙箱 iframe 加载内容，键盘事件默认不会冒泡到父 window
          try {
            const doc = detail?.doc
            const iwin = doc?.defaultView as Window | null
            if (iwin) {
              iwin.addEventListener(
                'keydown',
                (ke: KeyboardEvent) => {
                  // 仅转发翻页相关键 + 让用户原本的输入仍可在 iframe 输入框使用
                  const t = ke.target as HTMLElement | null
                  if (
                    t &&
                    (t.tagName === 'INPUT' ||
                      t.tagName === 'TEXTAREA' ||
                      t.isContentEditable)
                  ) return
                  if (ke.ctrlKey || ke.metaKey || ke.altKey) return
                  const keys = [
                    'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
                    'PageUp', 'PageDown', ' ',
                  ]
                  if (keys.includes(ke.key)) {
                    window.dispatchEvent(
                      new KeyboardEvent('keydown', {
                        key: ke.key,
                        bubbles: true,
                      })
                    )
                  }
                },
                true
              )
            }
          } catch (err) {
            console.warn('[FoliateView] iframe keydown forward failed', err)
          }
          // C1：iframe 内点击区翻页（左 35% 上一页 / 中 30% toggle / 右 35% 下一页）。
          // 用 mousedown + mouseup 配对，按下/松手位置偏移过大或时间过长视为拖动/选择，跳过。
          // 链接（脚注） / 选中文本场景也跳过；不阻止 foliate 自身的 link click。
          try {
            const doc = detail?.doc
            const iwin = doc?.defaultView as Window | null
            if (iwin && doc) {
              let downX = 0
              let downY = 0
              let downT = 0
              const TAP_DIST = 6
              const TAP_MAX_MS = 500
              iwin.addEventListener(
                'mousedown',
                (me: MouseEvent) => {
                  if (me.button !== 0) return
                  downX = me.clientX
                  downY = me.clientY
                  downT = me.timeStamp
                },
                true
              )
              iwin.addEventListener(
                'mouseup',
                (me: MouseEvent) => {
                  if (me.button !== 0) return
                  const { enabled, onMiddle } = tapPrefsRef.current
                  if (!enabled) return
                  // 偏移 / 时长检查
                  const dx = Math.abs(me.clientX - downX)
                  const dy = Math.abs(me.clientY - downY)
                  if (dx > TAP_DIST || dy > TAP_DIST) return
                  if (downT && me.timeStamp - downT > TAP_MAX_MS) return
                  // 点到链接 / 输入框 → 不翻页（让 foliate 自身处理）
                  const t = me.target as HTMLElement | null
                  if (
                    t &&
                    (t.closest('a[href]') ||
                      t.tagName === 'INPUT' ||
                      t.tagName === 'TEXTAREA' ||
                      t.isContentEditable)
                  ) {
                    return
                  }
                  // 有选中文本 → 视作划选操作，不翻页
                  const sel = iwin.getSelection?.()
                  if (sel && sel.toString().trim().length > 0) return
                  // 按 X 分区。触控布局采 20/60/20（中央大区切工具栏）；
                  // 桌面采 35/30/35（鼠标点击依赖边缘翻页习惯）。
                  const w = doc.documentElement.clientWidth || iwin.innerWidth || 1
                  const x = me.clientX
                  const v = viewRef.current
                  const leftRatio = tapPrefsRef.current.touchLayout ? 0.2 : 0.35
                  const rightRatio = tapPrefsRef.current.touchLayout ? 0.8 : 0.65
                  if (x < w * leftRatio) {
                    v?.prev()
                  } else if (x > w * rightRatio) {
                    v?.next()
                  } else {
                    onMiddle?.()
                  }
                },
                true
              )
            }
          } catch (err) {
            console.warn('[FoliateView] tap navigation install failed', err)
          }
          // C2：触屏滑动手势翻页（横向滑动 > 50px 且 |dy| < 30 → next/prev）
          // 只读 single-finger touch；多指或大 dy 视为缩放 / 滚动，跳过
          try {
            const doc = detail?.doc
            const iwin = doc?.defaultView as Window | null
            if (iwin) {
              let sx = 0
              let sy = 0
              let st = 0
              const SWIPE_MIN = 50
              const SWIPE_DY_MAX = 30
              const SWIPE_MAX_MS = 600
              iwin.addEventListener(
                'touchstart',
                (te: TouchEvent) => {
                  if (te.touches.length !== 1) return
                  const tch = te.touches[0]
                  sx = tch.clientX
                  sy = tch.clientY
                  st = te.timeStamp
                },
                { passive: true, capture: true }
              )
              iwin.addEventListener(
                'touchend',
                (te: TouchEvent) => {
                  if (te.changedTouches.length !== 1 || !st) return
                  const { enabled } = tapPrefsRef.current
                  if (!enabled) return
                  const tch = te.changedTouches[0]
                  const dx = tch.clientX - sx
                  const dy = tch.clientY - sy
                  const dt = te.timeStamp - st
                  st = 0
                  if (dt > SWIPE_MAX_MS) return
                  if (Math.abs(dy) > SWIPE_DY_MAX) return
                  if (Math.abs(dx) < SWIPE_MIN) return
                  // 选区时不响应
                  const sel = iwin.getSelection?.()
                  if (sel && sel.toString().trim().length > 0) return
                  const v = viewRef.current
                  if (dx > 0) v?.prev()
                  else v?.next()
                },
                { passive: true, capture: true }
              )
            }
          } catch (err) {
            console.warn('[FoliateView] swipe install failed', err)
          }
          onLoad?.(detail)
        }
        const handleRelocate = (e: Event) => {
          const d = (e as CustomEvent<FoliateRelocateDetail>).detail
          // readest fork 的 view.js 不再把 spine `index` 直接展开到 detail，
          // 只通过 SectionProgress 的 `section.current` 暴露。为保持上层
          // (ReaderShell / useAnnotations) API 兼容，这里回填 index 字段。
          if (d && typeof d.index !== 'number' && typeof d.section?.current === 'number') {
            ;(d as FoliateRelocateDetail).index = d.section.current
          }
          onRelocate?.(d)
        }
        const handleDraw = (e: Event) => {
          const detail = (e as CustomEvent<FoliateDrawAnnotationDetail>).detail
          if (onDrawAnnotation) onDrawAnnotation(detail, overlayer)
          else {
            const color = detail.annotation.color ?? 'rgba(250, 204, 21, 0.45)'
            detail.draw(overlayer.highlight, { color })
          }
        }
        const handleShow = (e: Event) =>
          onShowAnnotation?.((e as CustomEvent<FoliateShowAnnotationDetail>).detail)

        view.addEventListener('load', handleLoad)
        view.addEventListener('relocate', handleRelocate)
        view.addEventListener('draw-annotation', handleDraw)
        view.addEventListener('show-annotation', handleShow)

        const { file_data, file_name } = await resourcesApi.readFile(resource.resource_id)
        if (cancelled) return
        const blob = base64ToBlob(file_data, mimeFromFilename(file_name))
        const file = new File([blob], file_name, { type: blob.type })

        await view.open(file)
        if (cancelled) return

        // 接入脚注处理：监听 view 'link' 事件 → handler.handle(book, e) →
        // handler 'render' 事件触发后，把 detached <foliate-view> 包到 popover 里。
        // handler.handle 会自动 e.preventDefault()，阻止 view 默认的 goTo(href)
        const fnHandler = new FootnoteCtor()
        footnoteHandlerRef.current = fnHandler
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const book = (view as any).book
        view.addEventListener('link', (e: Event) => {
          const ev = e as CustomEvent<{ a: HTMLAnchorElement; href: string }>
          // 先记下 anchor 的 viewport rect（叠加 iframe 偏移），
          // 在 'render' 事件触发时取用。
          const a = ev.detail?.a as HTMLAnchorElement | undefined
          let clientRect = { left: 0, top: 0, right: 0, bottom: 0 }
          if (a) {
            try {
              const r = a.getBoundingClientRect()
              // a 在 iframe 内：找到所属 iframe 元素，加上 iframe 自己的视口偏移
              const ownerWin = a.ownerDocument.defaultView as Window & {
                frameElement?: HTMLElement
              } | null
              const frame = ownerWin?.frameElement
              const fr = frame?.getBoundingClientRect()
              const ox = fr?.left ?? 0
              const oy = fr?.top ?? 0
              clientRect = {
                left: r.left + ox,
                top: r.top + oy,
                right: r.right + ox,
                bottom: r.bottom + oy,
              }
            } catch {
              /* ignore — fall back to (0,0) */
            }
          }
          // pendingRect 暂存到 handler 实例上，供下面 'render' 取用
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ;(fnHandler as any)._pendingRect = clientRect
          try {
            fnHandler.handle(book, ev)
          } catch (err) {
            console.warn('[FoliateView] footnote handle failed', err)
          }
        })
        fnHandler.addEventListener('render', (e: Event) => {
          const detail = (e as CustomEvent<FootnoteRenderDetail>).detail
          if (!detail?.view) return
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const cr = (fnHandler as any)._pendingRect ?? {
            left: window.innerWidth / 2,
            top: window.innerHeight / 2,
            right: window.innerWidth / 2,
            bottom: window.innerHeight / 2,
          }
          setFootnote({
            view: detail.view,
            href: detail.href,
            type: detail.type ?? null,
            clientRect: cr,
          })
        })

        // PDF 等固定布局：默认 spread="auto" 在宽屏上会显示双页，但用户可能在 prefs 切换。
        // C3：把 spread / zoom 都从 prefs 读，默认 spread="none" + zoom="fit-width"
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const isFixed = (view as any).isFixedLayout === true
        if (isFixed) {
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const bookFix = (view as any).book
            const desiredSpread = prefs?.fixedSpread ?? 'none'
            const desiredZoom = prefs?.fixedZoom ?? 'fit-width'
            if (bookFix) {
              if (!bookFix.rendition) bookFix.rendition = {}
              bookFix.rendition.spread = desiredSpread
            }
            const r = view.renderer as HTMLElement | undefined
            if (r) {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              ;(r as any).spread = desiredSpread
              r.setAttribute(
                'zoom',
                typeof desiredZoom === 'number' ? `${desiredZoom}%` : desiredZoom
              )
              // 重建 spreads 数组
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              ;(r as any).open?.(bookFix)
              // 续读：有 cfi 优先 view.goTo(cfi)，失败回退到首页
              const startCfi = initialCfiRef.current
              if (startCfi) {
                try {
                  await view.goTo(startCfi)
                } catch (err) {
                  console.warn('[FoliateView] resume goTo(cfi) failed → 首页', err)
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  await (r as any).goTo?.({ index: 0, anchor: 0 })
                }
              } else {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                await (r as any).goTo?.({ index: 0, anchor: 0 })
              }
            }
          } catch (err) {
            console.warn('[FoliateView] fixed-layout init failed', err)
          }
        } else {
          // 续读：paginator 直接 view.goTo(cfi)；失败/无 cfi → 默认 next 翻到首屏
          const startCfi = initialCfiRef.current
          if (startCfi) {
            try {
              await view.goTo(startCfi)
            } catch (err) {
              console.warn('[FoliateView] resume goTo(cfi) failed → 首屏', err)
              view.renderer?.next?.()
            }
          } else {
            view.renderer?.next?.()
          }
        }

        const toc = view.book?.toc as FoliateTocItem[] | undefined
        if (toc && toc.length > 0) onTocReady?.(toc)

        if (mdTheme) {
          try {
            view.renderer?.setStyles?.(buildFoliateThemeCSS(mdTheme, prefs))
          } catch (err) {
            console.warn('[FoliateView] setStyles failed', err)
          }
        }
        if (prefs) applyPrefs(view, prefs)

        onReady?.(view, overlayer)
        setStatus('success')
      } catch (e) {
        if (cancelled) return
        const msg = e instanceof Error ? e.message : String(e)
        console.error('[FoliateView]', msg, e)
        setErrorMsg(msg)
        setStatus('error')
      }
    }

    bootstrap()
    return () => {
      cancelled = true
      if (view) view.remove()
      viewRef.current = null
      footnoteHandlerRef.current = null
      setFootnote(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resource.resource_id])

  // 主题切换 / 排版 prefs 变更 时热更新样式（不重加载书籍）。
  // 排版 prefs 也通过 setStyles 注入（buildFoliateThemeCSS 把 prefs override 拼在 theme 之后），
  // 所以这俩共用同一个副作用。
  useEffect(() => {
    if (!mdTheme) return
    const v = viewRef.current
    if (!v) return
    try {
      v.renderer?.setStyles?.(buildFoliateThemeCSS(mdTheme, prefs))
    } catch (err) {
      console.warn('[FoliateView] setStyles hot-update failed', err)
    }
  }, [mdTheme, prefs])

  // 渲染器属性偏好（flow/columns/margin/gap）热更新，与 setStyles 分离
  useEffect(() => {
    if (!prefs) return
    const v = viewRef.current
    if (!v) return
    applyPrefs(v, prefs)
  }, [prefs])

  return (
    <div className="relative h-full w-full" data-selectable="true">
      <div ref={containerRef} className="h-full w-full" />
      {status === 'loading' && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-text-3">
          正在加载 {resource.title}…
        </div>
      )}
      {status === 'error' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-8 text-center">
          <p className="text-sm font-medium text-error">无法打开此资料</p>
          <p className="max-w-md text-xs text-text-3">{errorMsg}</p>
        </div>
      )}
      <FootnotePopover
        data={footnote}
        onClose={closeFootnote}
        onJumpToSource={jumpToFootnoteSource}
      />
    </div>
  )
}

function applyPrefs(view: FoliateViewElement, prefs: ReaderPrefs) {
  const r = view.renderer as HTMLElement | undefined
  if (!r) return
  // 区分两种渲染器：
  //  - paginator (EPUB/MOBI/FB2/CBZ 等可重流) 走 flow/max-column-count/margin/gap
  //  - fixed-layout (PDF 等预分页)         走 zoom/spread
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const isFixed = (view as any).isFixedLayout === true
  try {
    if (isFixed) {
      // C3 PDF / fixed-layout：spread 与 zoom 从 prefs 读
      const z = prefs.fixedZoom
      r.setAttribute('zoom', typeof z === 'number' ? `${z}%` : z)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(r as any).spread = prefs.fixedSpread
    } else {
      r.setAttribute('flow', prefs.flow)
      r.setAttribute('max-column-count', String(prefs.maxColumnCount))
      r.setAttribute('margin', `${prefs.margin}px`)
      r.setAttribute('gap', `${prefs.gap}%`)
    }
  } catch (err) {
    console.warn('[FoliateView] applyPrefs failed', err)
  }
}
