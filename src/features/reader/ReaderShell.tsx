import { useEffect, useState, useCallback, useRef } from 'react'
import { ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { resourcesApi } from '@/lib/api'
import type { Resource } from '@/types/resource'
import type {
  FoliateTocItem,
  FoliateRelocateDetail,
  FoliateViewElement,
  HighlightColorKey,
  OverlayerStatic,
} from '@/lib/foliate'
import { FoliateView } from './FoliateView'
import { PdfPptxAdapter, type PdfPptxAdapterHandle } from './PdfPptxAdapter'
import { setKeyboardOwner } from './keyboardFocus'
import type * as pdfjsLib from 'pdfjs-dist'
type PdfJsDoc = Awaited<ReturnType<typeof pdfjsLib.getDocument>['promise']>
import { ReaderToolbar } from './ReaderToolbar'
import { TocPanel } from './TocPanel'
import { RightPane } from './RightPane'
import { ReaderSelectionPopover } from './ReaderSelectionPopover'
import { SearchPanel } from './SearchPanel'
import { useReaderProgress } from './useReaderProgress'
import { chromeStore } from '@/shell/chromeStore'
import { useAnnotations } from './useAnnotations'
import type { Annotation, Bookmark as BookmarkT } from '@/types/annotation'
import { useReaderPrefs } from './useReaderPrefs'
import { ensureFontStylesheet, loadFont } from '@/lib/fontLoader'
import { emitAiExplain } from './readerAiBus'
import { ResizeHandle } from './ResizeHandle'
import { useLayoutMode } from '@/lib/useLayoutMode'
import { cn } from '@/lib/cn'
import { loadMdTheme, saveMdTheme, type MdTheme } from '@/components/markdown/MarkdownView'
import { applyReaderThemeToRoot, resolveReaderTheme } from './readerThemes'

// PDF 不在此列：readest fork 的 vendor/foliate-js/pdf.js 使用 `import
// '@pdfjs/pdf.min.mjs'` 这种 vite alias specifier，依赖
// public/vendor/pdfjs/ 下的完整 pdfjs-dist 资产（worker + cmaps +
// standard_fonts + 扁平 css）。我们目前未引入这套资产，所以 PDF 仍走
// PdfPptxAdapter（后端 pdf-extract 抽文本展示）。如未来要在 foliate-view
// 内渲染 PDF（享受 readest 的 spread/zoom/批注），需先：
//   1. `npm i pdfjs-dist`
//   2. 把 legacy/build/{pdf.min.mjs,pdf.worker.min.mjs}、wasm、cmaps、
//      standard_fonts copy 到 public/vendor/pdfjs/
//   3. 把 vendor/foliate-js/pdf.js 第 3 行的 `'@pdfjs/pdf.min.mjs'` 改成
//      `'/vendor/pdfjs/pdf.min.mjs'`
//   4. 把 'pdf' 加回 FOLIATE_KINDS
const FOLIATE_KINDS = new Set(['epub', 'mobi', 'azw3', 'cbz', 'fb2'])
const LEGACY_KINDS = new Set(['docx', 'pptx', 'txt', 'html', 'pdf'])

interface Props {
  resourceId: string
}

type LoadStatus = 'loading' | 'success' | 'error' | 'empty'

export function ReaderShell({ resourceId }: Props) {
  const [resource, setResource] = useState<Resource | null>(null)
  const [status, setStatus] = useState<LoadStatus>('loading')
  const [error, setError] = useState('')
  const layoutMode = useLayoutMode()
  /**
   * 触控布局（phone / tablet）— 决定是否启用触控翻页分区、隐藏鼠标 hover 召回按钮等。
   * desktop 永远 false。
   */
  const touchLayout = layoutMode !== 'desktop'
  /**
   * 侧栏抽屉态判定（TABLET_DESIGN.md §3.2）：
   *   - phone        → 永远抽屉
   *   - tablet < 1024px → 抽屉（主区保底要求 ≥ 900px）
   *   - tablet ≥ 1024px → 钉住分屏（与桌面同款 CSS 流，但禁用 ResizeHandle）
   *   - desktop      → 钉住（保持现状）
   *
   * 监听 resize 以在横竖屏切换时实时切档。
   */
  const [winW, setWinW] = useState<number>(() =>
    typeof window === 'undefined' ? 1024 : window.innerWidth
  )
  useEffect(() => {
    const onResize = () => setWinW(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  const drawerMode =
    layoutMode === 'phone' || (layoutMode === 'tablet' && winW < 1024)
  const [showLeft, setShowLeft] = useState(true)
  const [showRight, setShowRight] = useState(true)
  const [toc, setToc] = useState<FoliateTocItem[]>([])
  const [pageHint, setPageHint] = useState('')
  const [currentPageIndex, setCurrentPageIndex] = useState(0)
  /**
   * 阅读进度（0..1）。供阅读区左下角的浮动进度条用。
   * - EPUB/MOBI: 来自 foliate `relocate` 的 `detail.fraction`
   * - PDF: `(pageIndex + 1) / page_count`
   * 未就绪时为 null，UI 隐藏 bar。
   */
  const [readingFraction, setReadingFraction] = useState<number | null>(null)
  /**
   * 当前可见页/区段的纯文本内容。
   *
   * 用于 AI 笔记生成时的"以当前页为依据"——Foliate 的 spine `index` 与
   * doc_session 的页索引并不一一对应（EPUB 的一章常常有多屏），如果只用
   * `currentPageIndex` 去 `doc_reader_get_page(idx)` 拿内容，会拿到错配
   * 的 chunk，造成"AI 永远基于第一页生成笔记"的现象。
   *
   * 改为：在 Foliate `relocate` 事件里直接读 `detail.range?.toString()`，
   * 把"用户视野内的真实文本"传给 AI。PdfPptxAdapter 走 DB 路径不受影响。
   */
  const [currentPageContent, setCurrentPageContent] = useState<string>('')
  /** 当前阅读位置对应的 TOC 项 href，用于左栏高亮 */
  const [currentTocHref, setCurrentTocHref] = useState<string | null>(null)
  // 阅读器 Markdown 主题使用独立作用域（'reader'），与右侧笔记/Notebook 主题独立。
  const [mdTheme, setMdTheme] = useState<MdTheme>(() => loadMdTheme('reader'))
  const onMdThemeChange = useCallback((t: MdTheme) => {
    setMdTheme(t)
    saveMdTheme(t, 'reader')
  }, [])

  const { prefs, setPrefs } = useReaderPrefs()

  /**
   * 沉浸模式（默认开启 / 默认隐藏菜单）：
   *  - immersive=true  → 工具栏 + 全局 chrome 默认隐藏；只有用户点了右上角浮按钮 / 工具栏内的「退出沉浸」按钮才会显示
   *  - immersive=false → 工具栏 + chrome 常驻
   *  - **不再有任何 3s 自动隐藏 / 鼠标近顶自动展开** —— 完全由按钮操控
   *  - 桌面端进入沉浸时仍会顺手收起两侧面板
   */
  // 沉浸模式默认开启；UI 上不再提供「退出沉浸」按钮（用户嫌它冗余），
  // `prefs.immersive` 仍保留作为偏好持久化字段，仅由历史 / 调试入口写入。
  const immersive = prefs.immersive
  const [toolbarVisible, setToolbarVisible] = useState(!prefs.immersive)
  const [searchOpen, setSearchOpen] = useState(false)
  /** PDF 打开后由 PdfPptxAdapter 上报的 pdfjs 文档句柄，供 SearchPanel 做全书搜索。 */
  const [pdfDoc, setPdfDoc] = useState<PdfJsDoc | null>(null)
  /**
   * PDF 阅读模式：直接从 prefs.flow 派生 —— 用户在「阅读设置」弹窗里点
   * 「分页 / 滚动连续」就能切换 PDF（不只是 EPUB）。
   *
   * 修复 issue 2：之前 PDF 有独立 pdfPageMode 状态，只有左下角小按钮能切，
   * 设置弹窗的「分页 / 滚动连续」对 PDF 不起作用 —— 用户改设置看不到效果，
   * 误以为「单页模式没实现，永远滚动」。统一到 prefs.flow 之后，
   * 设置弹窗 + 左下角按钮都能控制 PDF 翻页模式。
   */
  const pdfPageMode: 'scroll' | 'single' = prefs.flow === 'paginated' ? 'single' : 'scroll'
  const togglePdfPageMode = useCallback(() => {
    setPrefs({ flow: prefs.flow === 'paginated' ? 'scrolled' : 'paginated' })
  }, [prefs.flow, setPrefs])

  // 抽屉态默认收起两侧面板（phone / 窄平板）；钉住态（桌面 / 横屏大平板）保持展开
  useEffect(() => {
    if (drawerMode) {
      setShowLeft(false)
      setShowRight(false)
    }
  }, [drawerMode])

  // 字体懒加载：进入阅读器后注入 fonts.css，并按当前 prefs.fontKey 主动预热。
  // 'system' 不做任何事。失败静默回退到 fallback 字体。
  useEffect(() => {
    ensureFontStylesheet()
    if (prefs.fontKey && prefs.fontKey !== 'system') {
      void loadFont(prefs.fontKey)
    }
  }, [prefs.fontKey])

  // 进入 / 退出沉浸时同步默认状态：
  //  - 进入沉浸 → 工具栏隐藏；桌面端两侧面板也收起
  //  - 退出沉浸 → 工具栏显示
  useEffect(() => {
    if (immersive) {
      setToolbarVisible(false)
      // 抽屉态下侧栏本来就是覆盖式，不需要二次收起（避免重复触发动画）
      if (!drawerMode) {
        setShowLeft(false)
        setShowRight(false)
      }
    } else {
      setToolbarVisible(true)
    }
  }, [immersive, drawerMode])

  /**
   * 全局 chrome（TitleBar / AppSidebar / MobileTabBar）—— 用户要求：
   * 进入阅读页后**任何情况下**都不显示主菜单左侧栏。
   * 不再跟随沉浸/工具栏可见性切换；mount 时直接隐藏，卸载时还原。
   */
  useEffect(() => {
    chromeStore.setHidden(true)
    return () => chromeStore.setHidden(false)
  }, [])

  /**
   * 把当前阅读主题（paper/cream/sepia/moss/mist/dusk/midnight/auto）的
   * bg/fg/accent/divider 写入根 :root CSS 变量，让 toolbar / 设置弹窗 /
   * 笔记区 / 整张屏幕都跟着阅读底色走 —— 桌面端同理。
   *
   * 不在 cleanup 还原 —— 离开阅读器后仍保持当前主题色（用户要求"笔记区
   * 也不能做色差"）。
   */
  useEffect(() => {
    const t = resolveReaderTheme(prefs.theme)
    applyReaderThemeToRoot(t)
  }, [prefs.theme])

  const viewSnap = useRef<{ view: FoliateViewElement; overlayer: OverlayerStatic } | null>(null)
  // 为 SelectionPopover 提供 view 引用；onReady 后不为 null
  const [viewForSelection, setViewForSelection] = useState<FoliateViewElement | null>(null)

  const {
    onRelocate: onProgressRelocate,
    onPdfPageChange: onProgressPdfPageChange,
    initialProgress,
    initialLoaded: progressLoaded,
  } = useReaderProgress(resourceId)
  // 初始 readingFraction：用上次保存的 percent，避免 relocate 第一次触发前进度条空白
  useEffect(() => {
    if (initialProgress && typeof initialProgress.percent === 'number') {
      setReadingFraction(initialProgress.percent)
    }
  }, [initialProgress])
  const ann = useAnnotations(resourceId)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        setStatus('loading')
        const r = await resourcesApi.get(resourceId)
        if (cancelled) return
        if (!r) {
          setStatus('empty')
          return
        }
        setResource(r)
        setStatus('success')
      } catch (e) {
        if (cancelled) return
        setError(e instanceof Error ? e.message : String(e))
        setStatus('error')
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [resourceId])

  const handleRelocate = useCallback(
    (detail: FoliateRelocateDetail) => {
      // pageHint 优先级：epub 自带 page-list > foliate 估算的 location > 章节序号 > 进度百分比
      // 这是 readest / 苹果图书 同款的"页码气泡"显示方案
      if (detail.pageItem?.label) {
        setPageHint(`第 ${detail.pageItem.label} 页`)
      } else if (detail.location && detail.location.total > 0) {
        const pct = typeof detail.fraction === 'number' ? Math.round(detail.fraction * 100) : 0
        setPageHint(
          `${detail.location.current + 1} / ${detail.location.total} · ${pct}%`
        )
      } else if (detail.section && detail.section.total > 0) {
        const pct = typeof detail.fraction === 'number' ? Math.round(detail.fraction * 100) : 0
        setPageHint(
          `章 ${detail.section.current + 1}/${detail.section.total} · ${pct}%`
        )
      } else if (typeof detail.fraction === 'number') {
        setPageHint(`${Math.round(detail.fraction * 100)}%`)
      }
      if (typeof detail.index === 'number') {
        setCurrentPageIndex(detail.index)
        // 同步给 useAnnotations，让 PDF (fixed-layout) 没 c.index 时
        // addFromSelection / addBookmark 仍能拿到正确的 spine index
        ann.setCurrentIndex(detail.index)
      }
      // 同步阅读进度 fraction 给浮动进度条
      if (typeof detail.fraction === 'number') {
        setReadingFraction(detail.fraction)
      }
      // 用「视野内真实文本」喂 AI——优先选中 range，回退到当前 section 全文。
      try {
        const visibleText = detail.range?.toString().trim() || ''
        if (visibleText) {
          setCurrentPageContent(visibleText)
        }
      } catch {
        /* range 可能跨 iframe / 已失效，忽略 */
      }
      // 跟踪当前章节以供左栏 TOC 高亮使用
      const nextHref = detail.tocItem?.href ?? null
      setCurrentTocHref((prev) => (prev === nextHref ? prev : nextHref))
      onProgressRelocate(detail)
    },
    [onProgressRelocate, ann]
  )

  const handleReady = useCallback(
    (view: FoliateViewElement, overlayer: OverlayerStatic) => {
      viewSnap.current = { view, overlayer }
      ann.bindView(view, overlayer)
      setViewForSelection(view)
    },
    [ann]
  )

  /** PDF 适配器 ref：TocPanel 点击 `pdfpage:N` 走这条路径，foliate view 则走 goTo(href) */
  const pdfAdapterRef = useRef<PdfPptxAdapterHandle | null>(null)
  /**
   * Legacy（PDF/DOCX/PPTX）中央点击切换工具栏所用的 pointerdown 起点。
   * 记录 (x, y, timeStamp)，pointerup 时再判位移 / 时长 / 选区，决定是否切换。
   */
  const legacyTapRef = useRef<{ x: number; y: number; t: number } | null>(null)

  // 翻页统一入口：方向键 / 工具栏按钮 / 触摸点按 都走这里。
  //
  // Legacy（PDF/DOCX/PPTX/TXT/HTML）**无论 single 还是 scroll 模式**都按页跳：
  //   - single 模式：goToPage 直接换页
  //   - scroll 模式：goToPage 自动 scroll 到那一页（PdfCanvasView 内已实现）
  // 之前只在 PDF + single 模式下接管，导致默认（scroll）模式按方向键 PDF/DOCX
  // 不翻 —— viewSnap 对 legacy 资料是空的，view.prev() 是 noop。
  //
  // Foliate（EPUB/MOBI/...）走 viewSnap.view.prev/next（按章节内部排版翻）。
  const isLegacyResource = !!resource && LEGACY_KINDS.has(resource.kind)
  const onPrev = useCallback(() => {
    if (isLegacyResource) {
      if (currentPageIndex > 0) pdfAdapterRef.current?.goToPage(currentPageIndex - 1)
      return
    }
    viewSnap.current?.view.prev()
  }, [isLegacyResource, currentPageIndex])
  const onNext = useCallback(() => {
    if (isLegacyResource) {
      const total = resource?.page_count ?? 0
      if (total > 0 && currentPageIndex < total - 1) {
        pdfAdapterRef.current?.goToPage(currentPageIndex + 1)
      }
      return
    }
    viewSnap.current?.view.next()
  }, [isLegacyResource, resource, currentPageIndex])
  const onJumpToc = useCallback((href: string) => {
    // PDF outline 用 `pdfpage:<n>` 协议（见 PdfCanvasView.getOutline 转换）
    if (href.startsWith('pdfpage:')) {
      const n = Number(href.slice('pdfpage:'.length))
      if (Number.isFinite(n)) pdfAdapterRef.current?.goToPage(n)
      return
    }
    viewSnap.current?.view.goTo(href).catch(console.warn)
  }, [])

  /**
   * 标注 / 书签的"跳转"在 ReaderShell 层做路由分发：
   *  - Foliate 资料（EPUB / MOBI / ...）→ 走 useAnnotations 内的 view.showAnnotation/goTo
   *  - Legacy 资料（PDF / DOCX / PPTX）→ useAnnotations 里的 viewRef 永远是 null（从未 bindView），
   *    必须改走 pdfAdapterRef 暴露的 goToPage(pageIndex)
   *
   * 这是修复"点击标注/书签无法跳转到指定页面"的关键路径——之前所有 legacy 资料
   * 的跳转事件都被 useAnnotations 静默丢弃。
   */
  const isLegacyKind = resource ? LEGACY_KINDS.has(resource.kind) : false
  const onJumpAnnotation = useCallback(
    (a: Annotation) => {
      if (isLegacyKind) {
        if (typeof a.page_index === 'number' && a.page_index >= 0) {
          pdfAdapterRef.current?.goToPage(a.page_index)
        }
        return
      }
      ann.showAnnotation(a)
    },
    [isLegacyKind, ann]
  )
  const onJumpBookmark = useCallback(
    (b: BookmarkT) => {
      if (isLegacyKind) {
        if (typeof b.page_index === 'number' && b.page_index >= 0) {
          pdfAdapterRef.current?.goToPage(b.page_index)
        }
        return
      }
      ann.goToBookmark(b)
    },
    [isLegacyKind, ann]
  )

  /**
   * RAG 来源跳转：用户在 ChatTab 点了"来源 [P12-13]"标签时调用。
   *  - Legacy（PDF/DOCX/PPTX）：直接 pdfAdapterRef.goToPage(page_index)
   *  - Foliate（EPUB/MOBI/...）：spine page_index 与 doc_session.page_index 不一一对应；
   *    暂不支持精确跳页，console.warn 提示，未来可扩展为按章节跳转。
   */
  const onJumpPage = useCallback(
    (pageIndex: number) => {
      if (typeof pageIndex !== 'number' || pageIndex < 0) return
      if (isLegacyKind) {
        pdfAdapterRef.current?.goToPage(pageIndex)
      } else {
        console.warn('[ReaderShell] EPUB 暂不支持按 page_index 精确跳转', { pageIndex })
      }
    },
    [isLegacyKind]
  )

  // 全局键盘翻页：← ↑ PageUp = 上一页；→ ↓ PageDown Space = 下一页
  // 仅在焦点不在输入框/编辑器时生效
  // 注意：AgentTab 用 capture phase 在 hover 'agent' 时会 stopImmediatePropagation 抢键盘。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t) {
        const tag = t.tagName
        if (
          tag === 'INPUT' ||
          tag === 'TEXTAREA' ||
          tag === 'SELECT' ||
          t.isContentEditable
        ) {
          return
        }
      }
      // Ctrl/Cmd+F：唤起全书搜索（Foliate / PDF 都支持）
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'f') {
        if (resource && (FOLIATE_KINDS.has(resource.kind) || resource.kind === 'pdf')) {
          e.preventDefault()
          setSearchOpen(true)
        }
        return
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return
      switch (e.key) {
        case 'ArrowLeft':
        case 'ArrowUp':
        case 'PageUp':
          e.preventDefault()
          onPrev()
          break
        case 'ArrowRight':
        case 'ArrowDown':
        case 'PageDown':
        case ' ':
          e.preventDefault()
          onNext()
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onPrev, onNext, resource])

  const onAddHighlight = useCallback(
    (color: HighlightColorKey) => {
      ann.addFromSelection('highlight', color)
    },
    [ann]
  )

  /**
   * 选区 "AI 解释" 入口：
   * - 触发事件总线（RightPane 监听 → 切到 chat tab；ChatTab 监听 → prefill input）
   * - 抽屉模式（phone / tablet 窄屏）下右栏默认隐藏，这里强制打开抽屉
   * - 桌面 / 平板宽屏：若右栏被用户折叠，也强制展开
   */
  const onAIExplain = useCallback(
    (text: string, source: 'epub' | 'pdf') => {
      emitAiExplain(text, source)
      setShowRight(true)
    },
    []
  )
  const onAIExplainEpub = useCallback((text: string) => onAIExplain(text, 'epub'), [onAIExplain])
  const onAIExplainPdf = useCallback((text: string) => onAIExplain(text, 'pdf'), [onAIExplain])

  if (status === 'loading') {
    return <CenterMsg>加载资料…</CenterMsg>
  }
  if (status === 'error') {
    return <CenterMsg variant="error">{error}</CenterMsg>
  }
  if (status === 'empty' || !resource) {
    return <CenterMsg>未找到该资料（resourceId={resourceId}）</CenterMsg>
  }

  const useFoliate = FOLIATE_KINDS.has(resource.kind)
  const useLegacy = LEGACY_KINDS.has(resource.kind)

  return (
    <div className="relative flex h-full min-h-0 w-full flex-col">
      {/*
        工具栏：
          - 不再用 `position: absolute` 浮在顶部 —— 旧设计的磨砂浮层在沉浸模式下会
            盖住右栏顶部的 4-tab，视觉混乱
          - 改成「高度折叠」：可见时正常占据 flex 行，隐藏时 `max-height: 0` 平滑收掉
          - `overflow-hidden` 防止收起过程中内部图标外溢
      */}
      <div
        className={cn(
          'shrink-0 overflow-hidden transition-[max-height,opacity] duration-200',
          toolbarVisible ? 'max-h-14 opacity-100' : 'max-h-0 opacity-0'
        )}
      >
        <ReaderToolbar
          resource={resource}
          pageHint={pageHint}
          showLeft={showLeft}
          showRight={showRight}
          prefs={prefs}
          onPrefsChange={setPrefs}
          readerMdTheme={mdTheme}
          onReaderMdThemeChange={onMdThemeChange}
          onToggleLeft={() => setShowLeft((v) => !v)}
          onToggleRight={() => setShowRight((v) => !v)}
          onCollapseToolbar={
            // 仅在沉浸态下才提供「收起」按钮；非沉浸态工具栏常驻无需收起
            immersive ? () => setToolbarVisible(false) : undefined
          }
          onPrev={onPrev}
          onNext={onNext}
          onAddBookmark={() => ann.addBookmark()}
          searchActive={searchOpen}
          onToggleSearch={
            FOLIATE_KINDS.has(resource.kind) || resource.kind === 'pdf'
              ? () => setSearchOpen((v) => !v)
              : undefined
          }
          /* v4 (2026-05): onAiNote 入口已移除 —— 笔记同步由学习 Agent 接管 */
        />
      </div>
      {/*
        沉浸模式三个浮动「召回」按钮：顶部工具栏 / 左栏 / 右栏。
        共用 ImmersiveExpandButton 组件，避免三处重复样式。
        移动端下两侧栏是覆盖式 drawer，进入沉浸后无需召回按钮（可点工具栏的左/右栏切换）。
      */}
      <ImmersiveExpandButton
        visible={immersive && !toolbarVisible}
        position="top-right"
        icon={ChevronDown}
        label="展开工具栏"
        onClick={() => setToolbarVisible(true)}
      />
      <ImmersiveExpandButton
        visible={immersive && !touchLayout && !showLeft}
        position="left-center"
        icon={ChevronRight}
        label="展开左栏"
        onClick={() => setShowLeft(true)}
      />
      <ImmersiveExpandButton
        visible={immersive && !touchLayout && !showRight}
        position="right-center"
        icon={ChevronLeft}
        label="展开右栏"
        onClick={() => setShowRight(true)}
      />
      {/* 阅读区选区高亮浮层（替代旧版工具栏的高亮 popover） */}
      <ReaderSelectionPopover view={viewForSelection} onAddHighlight={onAddHighlight} onAIExplain={onAIExplainEpub} />
      <div className="relative flex min-h-0 flex-1">
        <aside
          style={drawerMode || !showLeft ? undefined : { width: prefs.leftPaneWidth }}
          className={cn(
            'relative flex shrink-0 flex-col border-r border-border-1 bg-surface-1',
            drawerMode
              ? cn(
                  // 平板抽屉宽度 320px（设计文档 §3.2），phone 仍 256px
                  'absolute inset-y-0 left-0 z-30 shadow-2xl transition-transform',
                  layoutMode === 'tablet' ? 'w-80' : 'w-64',
                  showLeft ? 'translate-x-0' : '-translate-x-full'
                )
              : showLeft
                ? ''
                : 'w-0 overflow-hidden'
          )}
        >
          <TocPanel toc={toc} currentHref={currentTocHref} onJump={onJumpToc} />
          {!drawerMode && showLeft && (
            <ResizeHandle
              width={prefs.leftPaneWidth}
              min={180}
              max={420}
              side="right"
              onChange={(w) => setPrefs({ leftPaneWidth: w })}
              onCollapse={() => setShowLeft(false)}
              collapseLabel="收起左栏"
            />
          )}
        </aside>
        <section
          className="relative min-w-0 flex-1 bg-surface-1"
          // 鼠标进入阅读区 → 键盘所有权切到 'pdf'。这样无论右栏停在哪个 tab，
          // 只要鼠标 hover 在 PDF / DOCX / PPTX 上，方向键就翻文档；
          // 移到 Agent 区上方再变回翻学习屏。
          onMouseEnter={() => setKeyboardOwner('pdf')}
          /*
            Legacy 资料（PDF / DOCX / PPTX）的 tap 路由。
            - desktop 沉浸态：中央 1/3 × 1/3 区切工具栏；左右无翻页（PDF 是滚动视图，鼠标用滚轮）
            - touch 模式：20% 左 → 上一页；20% 右 → 下一页；中央 60% → 切工具栏（仅沉浸态）
            选区 / 长按 / >8px 位移 都视为非 tap，吃掉以避免误触。
          */
          onPointerDown={
            useLegacy && (immersive || touchLayout)
              ? (e) => {
                  legacyTapRef.current = {
                    x: e.clientX,
                    y: e.clientY,
                    t: e.timeStamp,
                  }
                }
              : undefined
          }
          onPointerUp={
            useLegacy && (immersive || touchLayout)
              ? (e) => {
                  const start = legacyTapRef.current
                  legacyTapRef.current = null
                  if (!start) return
                  const dx = e.clientX - start.x
                  const dy = e.clientY - start.y
                  if (dx * dx + dy * dy > 64) return // 移动超过 8px → 视为滑动 / 选区
                  if (e.timeStamp - start.t > 500) return // 长按 → 不切换
                  const sel = window.getSelection?.()
                  if (sel && !sel.isCollapsed) return
                  const rect = e.currentTarget.getBoundingClientRect()
                  const fx = (e.clientX - rect.left) / rect.width
                  const fy = (e.clientY - rect.top) / rect.height
                  if (touchLayout) {
                    // 触控：左 20% 上一页 / 右 20% 下一页 / 中央 60% 切工具栏
                    if (fx < 0.2) {
                      if (resource && currentPageIndex > 0) {
                        pdfAdapterRef.current?.goToPage(currentPageIndex - 1)
                      }
                    } else if (fx > 0.8) {
                      const total = resource?.page_count ?? 0
                      if (total > 0 && currentPageIndex < total - 1) {
                        pdfAdapterRef.current?.goToPage(currentPageIndex + 1)
                      }
                    } else if (immersive) {
                      setToolbarVisible((v) => !v)
                    }
                  } else {
                    // 桌面沉浸：只在中央 1/3 × 1/3 切工具栏
                    if (fx < 1 / 3 || fx > 2 / 3) return
                    if (fy < 1 / 3 || fy > 2 / 3) return
                    setToolbarVisible((v) => !v)
                  }
                }
              : undefined
          }
        >
          {useFoliate && (
            <SearchPanel
              view={viewForSelection}
              open={searchOpen}
              onClose={() => setSearchOpen(false)}
            />
          )}
          {useLegacy && resource.kind === 'pdf' && (
            <SearchPanel
              view={null}
              pdfDoc={pdfDoc}
              open={searchOpen}
              onClose={() => setSearchOpen(false)}
              onJumpPdfPage={(idx) => pdfAdapterRef.current?.goToPage(idx)}
            />
          )}
          {useFoliate && progressLoaded && (
            <FoliateView
              resource={resource}
              mdTheme={mdTheme}
              prefs={prefs}
              // 续读：把 reading_progress.cfi 传给 view，view.open 后 goTo(cfi)
              initialCfi={initialProgress?.cfi || undefined}
              onReady={handleReady}
              onTocReady={setToc}
              onRelocate={handleRelocate}
              onDrawAnnotation={ann.onDraw}
              onShowAnnotation={(d) => {
                const found = ann.annotations.find((a) => a.cfi_start === d.value)
                if (found) ann.showAnnotation(found)
              }}
              // C1 中央点击：沉浸态切换工具栏；非沉浸态不动作
              onTapMiddle={() => {
                if (immersive) setToolbarVisible((v) => !v)
              }}
              // 触控分区（20/60/20），desktop 沿用原 35/30/35
              touchLayout={touchLayout}
            />
          )}
          {useLegacy && progressLoaded && (
            <PdfPptxAdapter
              ref={pdfAdapterRef}
              resource={resource}
              mdTheme={mdTheme}
              fullWidth={!showLeft && !showRight}
              // 续读：把 reading_progress.page_index 传给 PDF 视图，doc 加载后 scrollToPage
              initialPageIndex={initialProgress?.page_index ?? undefined}
              onPageChange={(idx, content) => {
                setPageHint(`第 ${idx + 1} 页`)
                setCurrentPageIndex(idx)
                // cache miss 时主动清空 currentPageContent，让 ChatTab 不传 pageContent，
                // 后端走 DB 路径（parser 已修复对齐）；保留旧值会让 AI 误用上一页。
                setCurrentPageContent(content ?? '')
                // PDF 进度持久化 + 同步浮动进度条
                if (resource && resource.kind === 'pdf') {
                  const total = resource.page_count || 0
                  onProgressPdfPageChange(idx, total)
                  if (total > 0) setReadingFraction((idx + 1) / total)
                }
              }}
              onTocReady={(toc) => setToc(toc as FoliateTocItem[])}
              // PDF 批注系统接通：annotations 来自 useAnnotations，addPdfHighlight 是
              // 新加的"PDF selection → DB"路径，cfi_* 为空，用 page_index + 归一化 rects 定位
              pdfAnnotations={ann.annotations}
              onAddPdfHighlight={ann.addPdfHighlight}
              onPdfAIExplain={onAIExplainPdf}
              pdfZoom={prefs.fixedZoom}
              pdfPageMode={pdfPageMode}
              onPdfDocReady={setPdfDoc}
            />
          )}
          {(useFoliate || useLegacy) && !progressLoaded && (
            <CenterMsg>正在加载阅读进度…</CenterMsg>
          )}
          {!useFoliate && !useLegacy && (
            <CenterMsg>暂不支持的格式：{resource.kind}</CenterMsg>
          )}
          {/* 阅读区左下角浮动进度条 + 当前页徽章：
              - 非 PDF：只显示 % 圆形进度条
              - PDF：显示 "第 N / 共 M 页 · X%"，并允许点击展开跳页输入
              点击区有 pointer-events，跳页是显式动作 */}
          {readingFraction != null && (
            <PageProgressBadge
              fraction={readingFraction}
              currentIndex={currentPageIndex}
              totalPages={resource?.kind === 'pdf' ? resource.page_count ?? 0 : 0}
              isPdf={resource?.kind === 'pdf'}
              pageHint={pageHint}
              onJump={(idx) => {
                pdfAdapterRef.current?.goToPage(idx)
              }}
            />
          )}
          {/* PDF 阅读模式切换：滚动 / 单页。仅 PDF 资料可见。 */}
          {resource?.kind === 'pdf' && (
            <button
              type="button"
              onClick={togglePdfPageMode}
              title={
                pdfPageMode === 'scroll'
                  ? '切换为单页模式（← / → 翻页）'
                  : '切换为连续滚动模式'
              }
              className="absolute bottom-1.5 left-32 z-10 rounded-full border border-border-1/40 bg-bg/40 px-2 py-0.5 text-[10px] text-text-2/70 shadow-sm backdrop-blur-sm transition-all hover:bg-bg/90 hover:text-text-1 hover:opacity-100 opacity-70"
            >
              {pdfPageMode === 'scroll' ? '滚动' : '单页'}
            </button>
          )}
          {/*
            阅读区底部全宽进度条（2px 高）。设计上比左下角胶囊徽章更直观：
            横向占满底部，左侧填充色显示已读比例 —— 类似浏览器的页面加载条。
            徽章和这条同时存在，互不冲突：徽章给精确数字，底条给"看一眼就知道"。
          */}
          {readingFraction != null && (
            <div
              aria-hidden
              className="pointer-events-none absolute bottom-0 left-0 right-0 z-10 h-[2px] bg-surface-3/40"
            >
              <div
                className="h-full bg-accent transition-[width] duration-150"
                style={{ width: `${Math.round(Math.min(100, Math.max(0, readingFraction * 100)))}%` }}
              />
            </div>
          )}
        </section>
        <aside
          style={drawerMode || !showRight ? undefined : { width: prefs.rightPaneWidth }}
          className={cn(
            'relative flex shrink-0 flex-col border-l border-border-1 bg-surface-1',
            drawerMode
              ? cn(
                  'absolute inset-y-0 right-0 z-30 shadow-2xl transition-transform',
                  layoutMode === 'tablet' ? 'w-80' : 'w-72',
                  showRight ? 'translate-x-0' : 'translate-x-full'
                )
              : showRight
                ? ''
                : 'w-0 overflow-hidden'
          )}
        >
          {!drawerMode && showRight && (
            <ResizeHandle
              width={prefs.rightPaneWidth}
              min={220}
              max={640}
              side="left"
              onChange={(w) => setPrefs({ rightPaneWidth: w })}
              onCollapse={() => setShowRight(false)}
              collapseLabel="收起右栏"
            />
          )}
          <RightPane
            resource={resource}
            toc={toc}
            currentPageIndex={currentPageIndex}
            currentPageContent={currentPageContent}
            annotations={ann.annotations}
            bookmarks={ann.bookmarks}
            onJumpAnnotation={onJumpAnnotation}
            onDeleteAnnotation={ann.removeAnnotation}
            onJumpBookmark={onJumpBookmark}
            onDeleteBookmark={ann.removeBookmark}
            onJumpPage={onJumpPage}
          />
        </aside>
        {drawerMode && (showLeft || showRight) && (
          <button
            type="button"
            aria-label="关闭面板"
            onClick={() => {
              setShowLeft(false)
              setShowRight(false)
            }}
            className="absolute inset-0 z-20 bg-black/40"
          />
        )}
      </div>
    </div>
  )
}

function CenterMsg({
  children,
  variant,
}: {
  children: React.ReactNode
  variant?: 'error'
}) {
  return (
    <div
      className={cn(
        'flex h-full items-center justify-center p-6 text-center text-sm',
        variant === 'error' ? 'text-error' : 'text-text-3'
      )}
    >
      {children}
    </div>
  )
}

/**
 * 阅读区左下角浮动徽章：显示当前页/总页数（PDF）或百分比（EPUB），点击 PDF 徽章
 * 可弹出跳页输入框。这是用户"AI 用的是哪页"的可见信号源。
 *
 * 非 PDF 类型回退到旧版圆形进度条 + 百分比；PDF 类型显示
 *   [▓▓░░░░] 第 12 / 共 38 页 · 31%
 * 点击数字 → 出现输入框输入页号回车跳转。
 */
function PageProgressBadge({
  fraction,
  currentIndex,
  totalPages,
  isPdf,
  pageHint,
  onJump,
}: {
  fraction: number
  currentIndex: number
  totalPages: number
  isPdf: boolean
  pageHint?: string
  onJump?: (pageIndex: number) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const pct = Math.round(Math.min(100, Math.max(0, fraction * 100)))
  const canJump = isPdf && totalPages > 0 && !!onJump

  return (
    <div className="group absolute bottom-1.5 left-1.5 z-10 flex items-center gap-1.5 rounded-full border border-border-1/40 bg-bg/40 px-2 py-0.5 text-[10px] tabular-nums text-text-2/70 shadow-sm backdrop-blur-sm transition-all hover:bg-bg/90 hover:text-text-1 hover:opacity-100 opacity-70">
      <div className="h-0.5 w-14 overflow-hidden rounded-full bg-surface-3">
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-150"
          style={{ width: `${pct}%` }}
        />
      </div>
      {canJump ? (
        editing ? (
          <form
            onSubmit={(e) => {
              e.preventDefault()
              const n = Number(draft)
              if (Number.isFinite(n) && n >= 1 && n <= totalPages) {
                onJump!(n - 1)
              }
              setEditing(false)
              setDraft('')
            }}
            className="flex items-center gap-1"
          >
            <input
              autoFocus
              type="number"
              min={1}
              max={totalPages}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => {
                setEditing(false)
                setDraft('')
              }}
              className="h-4 w-10 rounded border border-accent bg-bg px-1 text-[10px] outline-none"
              placeholder={`${currentIndex + 1}`}
            />
            <span className="text-text-3">/ {totalPages}</span>
          </form>
        ) : (
          <button
            type="button"
            onClick={() => {
              setDraft(String(currentIndex + 1))
              setEditing(true)
            }}
            title="点击跳页"
            className="rounded px-0.5 font-medium text-text-1 hover:bg-surface-2"
          >
            {currentIndex + 1}/{totalPages}
          </button>
        )
      ) : pageHint ? (
        <span className="font-medium text-text-1">{pageHint}</span>
      ) : null}
      <span className="text-text-3">{pct}%</span>
    </div>
  )
}

// 旧 SidebarCollapseButton 已移除：折叠交互已合并进 ResizeHandle —— hover 分隔条
// 时中部自然浮现折叠按钮，拖是改宽度，点是折叠，一体化视觉，不再有"浮在栏内的
// 小 pill"视觉瑕疵。

function ImmersiveExpandButton({
  visible,
  position,
  icon: Icon,
  label,
  onClick,
}: {
  visible: boolean
  /** 按钮贴边位置 */
  position: 'top-right' | 'left-center' | 'right-center'
  icon: LucideIcon
  /** 用于 aria-label 和 title */
  label: string
  onClick: () => void
}) {
  if (!visible) return null
  // 三种位置共享外观；位置类用 cn 组合
  const posClass =
    position === 'top-right'
      ? 'right-2 top-2'
      : position === 'left-center'
      ? 'left-2 top-1/2 -translate-y-1/2'
      : 'right-2 top-1/2 -translate-y-1/2'
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        'absolute z-50 flex h-7 w-7 items-center justify-center rounded-full border border-border-1 bg-bg/85 text-text-2 shadow-md backdrop-blur transition-colors hover:text-text-1',
        posClass
      )}
    >
      <Icon className="h-4 w-4" />
    </button>
  )
}
