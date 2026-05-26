import { useEffect, useState, useRef, memo, forwardRef, useImperativeHandle, useMemo, useCallback } from 'react'
import { Loader2 } from 'lucide-react'
import { invoke } from '@/lib/tauri'
import { resourcesApi } from '@/lib/api'
import { convertFileSrc } from '@tauri-apps/api/core'
import type { Resource } from '@/types/resource'
import { cn } from '@/lib/cn'
import { MarkdownView, type MdTheme } from '@/components/markdown/MarkdownView'
import type { Annotation, PdfNormRect } from '@/types/annotation'
import { parsePdfRects, mergePdfRectsByLine } from '@/types/annotation'
import { HIGHLIGHT_COLORS, type HighlightColorKey } from '@/lib/foliate'
import { PdfSelectionPopover } from './PdfSelectionPopover'
// pdfjs-dist 4.x ESM。Worker 走 public/pdfjs/pdf.worker.patched.mjs ——
// 由 scripts/copy-pdfjs-assets.mjs 在 pdfjs 官方 worker 前拼接 polyfill
// (Promise.withResolvers / Object.groupBy 等)，给 Android WebView < Chromium 119
// 用。主线程的 polyfill (lib/androidPolyfills.ts) 不会传到 Worker 上下文，
// 必须用单独打补丁的 worker 文件。
import * as pdfjsLib from 'pdfjs-dist'
// 官方 text layer / annotation layer CSS（内置 RTL / 分段 span 定位规则）
import 'pdfjs-dist/web/pdf_viewer.css'
// docx-preview：Word .docx → 高保真 HTML（保留段落/字体/表格/图片）
import { renderAsync as renderDocx } from 'docx-preview'

/**
 * CJK 与标准字体的解析资源路径（pdfjs-dist 不内嵌字体，需要运行时拉取）。
 * 由 `scripts/copy-pdfjs-assets.mjs` 把 node_modules/pdfjs-dist/{cmaps,standard_fonts}
 * 复制到 `public/pdfjs/` 下；vite dev/build 都会 serve 成 `/pdfjs/...`。
 *
 * 不配这两项，中文 PDF 会大片字符缺失，嵌入标准字体的 PDF 会回退到空白。
 */
const PDFJS_CMAP_URL = '/pdfjs/cmaps/'
const PDFJS_STANDARD_FONT_URL = '/pdfjs/standard_fonts/'
/** Patched worker URL（与上面 cmap 同一目录，已 polyfill 旧 WebView）。 */
const PDFJS_WORKER_URL = '/pdfjs/pdf.worker.patched.mjs'

// ─── 类型别名（从 pdfjs-dist 官方类型抽出）───────────────────────────────
type PdfJsDoc = Awaited<ReturnType<typeof pdfjsLib.getDocument>['promise']>
type PdfJsPage = Awaited<ReturnType<PdfJsDoc['getPage']>>
type PdfJsViewport = ReturnType<PdfJsPage['getViewport']>
type PdfRenderTask = ReturnType<PdfJsPage['render']>

// 全局只设一次 worker；多组件实例共用同一 worker thread
if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL
}

/**
 * PdfPptxAdapter — 旧文档（PDF / PPTX / DOCX）走 Rust 抽取文本的 fallback 视图。
 * 通过 `doc_reader_get_page` 拉取每页 markdown/text，纯文本卡片化展示。
 * 后续 P5 会与 AI 面板/批注系统集成。
 */
export interface PdfPptxAdapterHandle {
  /** 跳转到指定页（0-based）。对 PDF 触发 scrollIntoView，对其他格式同理。 */
  goToPage: (pageIndex: number) => void
}

interface Props {
  resource: Resource
  mdTheme?: MdTheme
  fullWidth?: boolean
  /**
   * 续读起点 page_index。doc 加载完毕后会调 scrollToPage(initialPageIndex)。
   * 取值来自 reading_progress.page_index；新书/无进度 → 不传或传 undefined。
   */
  initialPageIndex?: number
  /**
   * 当前可见页变化时回调。第二个参数为该页文本（可选），
   * 用于把"用户当前真正在看的内容"传给上层做 AI 笔记生成。
   */
  onPageChange?: (pageIndex: number, content?: string) => void
  /**
   * PDF 的大纲（outline）就绪时回调，用于填充左侧 TOC 面板。
   * 非 PDF 不触发。item.href 形如 `pdfpage:<n>`，ReaderShell.onJumpToc 识别。
   */
  onTocReady?: (toc: PdfTocItem[]) => void
  /**
   * PDF 批注数据。ReaderShell 从 useAnnotations().annotations 透传进来，
   * PdfCanvasView 按 page_index 分派到对应 PdfPageCanvas 渲染覆盖层。
   */
  pdfAnnotations?: Annotation[]
  /**
   * PDF 批注创建回调：用户在 PdfSelectionPopover 选中颜色后调用。
   * ReaderShell 绑定到 useAnnotations().addPdfHighlight。
   */
  onAddPdfHighlight?: (args: {
    pageIndex: number
    rects: PdfNormRect[]
    selectedText: string
    color: HighlightColorKey
  }) => void | Promise<void>
  /**
   * 选区“AI 解释”入口（触控布局需要）。
   * 不传则 PdfSelectionPopover 不渲染 AI 按钮。
   */
  onPdfAIExplain?: (selectedText: string) => void
  /**
   * PDF 缩放模式。由顶部"阅读设置"Popover 下发：
   *   - 'fit-width'（默认）：自动满宽；侧栏开合 / 窗口 resize 会重算
   *   - 数字（0.5 / 0.75 / 1 / 1.25 / 1.5 / 2 / 3）：固定倍率（scale=1 表示 PDF 原始尺寸）
   *   - 'fit-page'：暂时按 'fit-width' 处理（当前版本先只实现 fit-width + 固定倍率）
   */
  pdfZoom?: 'fit-width' | 'fit-page' | number
  /**
   * PDF 阅读模式：
   *   - 'scroll'（默认）：连续滚动，所有页在同一个滚动容器里上下排列
   *   - 'single'：经典单页模式，一次只渲染一页，用 ← / → 或 prev/next 翻页
   * 默认 'scroll'。
   */
  pdfPageMode?: 'scroll' | 'single'
  /**
   * PDF 文档句柄就绪回调。上层（ReaderShell）记下后传给 SearchPanel 做全书搜索。
   * 仅 PDF 触发；卸载 / resource 切换时会以 null 重置。
   */
  onPdfDocReady?: (doc: PdfJsDoc | null) => void
}

/** 与 FoliateTocItem 对齐的最小 TOC 项结构（PDF 构造的版本） */
export interface PdfTocItem {
  label: string
  href: string
  subitems?: PdfTocItem[]
}

interface PageContent {
  page_index: number
  content: string
  word_count: number
}

export const PdfPptxAdapter = forwardRef<PdfPptxAdapterHandle, Props>(function PdfPptxAdapter(
  {
    resource,
    mdTheme,
    fullWidth,
    initialPageIndex,
    onPageChange,
    onTocReady,
    pdfAnnotations,
    onAddPdfHighlight,
    onPdfAIExplain,
    pdfZoom,
    pdfPageMode,
    onPdfDocReady,
  },
  ref,
) {
  const isPdf = resource.kind === 'pdf'
  const isDocx = resource.kind === 'docx'

  // 向父组件暴露 goToPage。对 PDF 转给 pdfScrollRef 实现。
  // docx 通过 docxScrollRef 类似机制（DocxView 自己注入）。
  useImperativeHandle(
    ref,
    () => ({
      goToPage: (pageIndex: number) => {
        if (isPdf) pdfScrollRef.current?.(pageIndex)
        else if (isDocx) docxScrollRef.current?.(pageIndex)
      },
    }),
    [isPdf, isDocx],
  )
  const [pages, setPages] = useState<PageContent[]>([])
  const [status, setStatus] = useState<'loading' | 'success' | 'error' | 'empty'>('loading')
  const [error, setError] = useState('')
  const [activePage, setActivePage] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)
  /**
   * 续读 scroll 守卫：进入 PDF 后 PdfCanvasView 会立即跑一次 updateActive
   * （初始同步）→ onPageChange(0, ...) 会被触发，2 秒后 debounce flush 把
   * `page_index=0` 写回数据库，**覆盖掉用户上次的 595**。
   *
   * 修复：在续读 scroll 成功落位前吞掉所有 onPageChange；scroll 完成或
   * initialPageIndex 不需要恢复（=0 / 未传）时立即放行。
   *
   * 默认 true（gate 开）—— PDF 续读路径会在 setPdfDoc 之前同步把它置 false
   * 拦截 PdfCanvasView 第一帧的 updateActive(0)；docx/pptx 路径不走 PDF 续读
   * 逻辑、也不需要拦截，必须保持 gate 打开，否则 onPageChange 永远被吞，
   * 父组件 currentPageIndex 卡死在 0 → 点击「下一页 / 翻页 / 跳页」都会
   * 「刷新到首页」。
   */
  const restoredRef = useRef<boolean>(true)
  const needsRestoreRef = useRef<boolean>(false)
  /**
   * 续读期间吞掉 onPageChange：scroll 真正落位（restoredRef=true）前所有
   * 「当前可视页」上报都被丢弃。这是修复"退出再进入跳到首页"的核心。
   */
  const gatedOnPageChange = useCallback(
    (idx: number, content?: string) => {
      if (!restoredRef.current) return
      onPageChange?.(idx, content)
    },
    [onPageChange],
  )
  /**
   * PDF 专用：pdf.js 的 PDFDocument 句柄。打开后供所有 `<PdfPageCanvas>`
   * 按需 `getPage(n).render()`。组件卸载时调 destroy() 释放 worker 内存。
   */
  const [pdfDoc, setPdfDoc] = useState<PdfJsDoc | null>(null)
  const [pdfError, setPdfError] = useState('')
  /**
   * PDF 加载进度（百分比 0-100）。pdfjs 在 Tauri asset:// 不一定支持 Range，
   * 大文件可能整文件下载——用进度条让用户知道在做什么，避免"白屏 10s 以为卡死"。
   */
  const [pdfLoadProgress, setPdfLoadProgress] = useState<number | null>(null)
  /**
   * PDF 缩放模式。由顶部"阅读设置"Popover 下发，默认 fit-width（自动满宽）。
   *
   * prefs.fixedZoom 语义（upstream）：
   *   - 'fit-width' / 'fit-page' → 同名字符串
   *   - number：**百分比**（如 100 表示 100%、150 表示 150%）
   *
   * 这里转换成 PdfCanvasView 理解的"倍率"语义（1.0 = 原生）：数字 / 100。
   * 'fit-page' 当前尚未实现差异化，作为 fit-width 的别名。
   */
  const effectivePdfZoom: 'fit-width' | number =
    typeof pdfZoom === 'number' ? pdfZoom / 100 : 'fit-width'
  /** PDF goto 的外部 ref，PdfCanvasView 把它绑到滚动实现上。 */
  const pdfScrollRef = useRef<((pageIndex: number) => void) | null>(null)
  /** docx goto 的外部 ref，DocxView 把它绑到滚动实现上。 */
  const docxScrollRef = useRef<((pageIndex: number) => void) | null>(null)
  /**
   * PPTX 专用：每页 slide 渲染成的 PNG（data URI 数组）。
   * 走 `doc_reader_export_ppt_slides` —— PowerShell 调 PowerPoint COM 导出，
   * 仅 Windows 桌面版可用；Android 直接返回错误。失败时 `slideImages` 维持空数组，
   * 渲染层会回退到「仅文本」模式（即旧行为），不会阻塞用户阅读。
   */
  const [slideImages, setSlideImages] = useState<string[]>([])
  const [slideStatus, setSlideStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>(
    'idle'
  )

  /**
   * PDF 拉原始文件、转 blob URL 交给 iframe。只在 resource.kind 是 pdf 时执行。
   * Base64 → Uint8Array → Blob → ObjectURL：iframe 的 `src="blob:..."`，
   * WebView 识别 `application/pdf` mime 后自动挂起内置 PDF viewer。
   *
   * ObjectURL 在组件卸载 / resource 切换时 revoke，避免泄漏几十 MB 的 PDF 字节。
   */
  useEffect(() => {
    if (!isPdf) return
    let cancelled = false
    let localDoc: PdfJsDoc | null = null
    ;(async () => {
      try {
        // 优先走 Tauri `asset://` 协议：pdfjs-dist 内部 fetch + Range 请求，
        // 按需分块读取而不是整个文件 base64 塞内存。一个 100MB PDF 原来要
        // 经历 `read_file → base64(133MB) → JSON IPC → atob → Uint8Array(100MB)`
        // 三次峰值副本；改走 asset 协议后直接流式。
        //
        // 退路：没有 file_path（老数据）才回退到 `resourcesApi.readFile` 的
        // base64 路径，保留兼容。
        const hasPath = !!resource.file_path
        const docParams: Parameters<typeof pdfjsLib.getDocument>[0] = {
          cMapUrl: PDFJS_CMAP_URL,
          cMapPacked: true,
          standardFontDataUrl: PDFJS_STANDARD_FONT_URL,
          // 禁用字体 hack 的默认开销；保留 system fonts 加载路径
          disableFontFace: false,
        }
        if (hasPath) {
          docParams.url = convertFileSrc(resource.file_path)
        } else {
          const file = await resourcesApi.readFile(resource.resource_id)
          if (cancelled) return
          // Uint8Array.from + charCodeAt 比逐元素赋值更快，且无需中间 String
          docParams.data = Uint8Array.from(atob(file.file_data), (c) => c.charCodeAt(0))
        }
        const t0 = performance.now()
        const loadingTask = pdfjsLib.getDocument(docParams)
        // 进度回调：onProgress({ loaded, total })。total 在 Range 不支持时为 0。
        loadingTask.onProgress = ({ loaded, total }: { loaded: number; total: number }) => {
          if (cancelled) return
          setPdfLoadProgress(total > 0 ? Math.round((loaded / total) * 100) : null)
        }
        const doc = await loadingTask.promise
        console.log(
          `[PDF] getDocument ${doc.numPages} 页 用时 ${Math.round(performance.now() - t0)}ms`
        )
        if (cancelled) {
          doc.destroy().catch(() => {})
          return
        }
        localDoc = doc
        setPdfLoadProgress(null)
        setPdfDoc(doc)
        onPdfDocReady?.(doc)
        // 续读：doc 加载完成、PdfCanvasView 把 scrollToPage 注入 pdfScrollRef
        // 后，跳到上次的 page_index。
        //
        // 关键 bug 修复（issue 10）：PDF 路径下 PdfPptxAdapter 自己的 containerRef
        // **从未挂载到 DOM**（PDF 渲染走 <PdfCanvasView>，它有自己的 containerRef）。
        // 旧逻辑用 `containerRef.current?.querySelector('[data-page-index=N]')` 永远拿到 null，
        // 重试 80 次全部失败 → 放弃恢复 → 用户每次重开都从第 0 页开始。
        //
        // 新逻辑：只检查 pdfScrollRef.current 是否就绪（PdfCanvasView mount + effect 注入），
        // 一旦就绪就调一次。元素是否真的存在交给 PdfCanvasView 内部的二级重试处理。
          const target = initialPageIndex ?? 0
          if (target > 0 && target < doc.numPages) {
            needsRestoreRef.current = true
            restoredRef.current = false
            const tryScroll = (attempt: number) => {
              if (cancelled) return
              if (pdfScrollRef.current) {
                pdfScrollRef.current(target)
                // 给 PdfCanvasView 内部重试 + scroll 落位留出余量
                window.setTimeout(() => {
                  if (cancelled) return
                  restoredRef.current = true
                  needsRestoreRef.current = false
                  // 关键修复：scrollToPageRef 内部只 setActivePage(target)，不会通过
                  // onPageChange 上抛；而 update() 在 bestIdx === activePage 时也不
                  // 触发上报 → 父组件 currentPageIndex 永远停在 0，点击「下一页 / 翻页 /
                  // 跳页输入框」都会基于 0 重新计算 → 用户感觉「跳回首页」。
                  // gate 解锁的同时显式同步一次目标页（绕过 gated 直接调 prop）。
                  onPageChange?.(target)
                }, 1200)
                return
              }
              // pdfScrollRef 未就绪：每 60ms 重试，最多 ~6s
              if (attempt < 100) {
                window.setTimeout(() => tryScroll(attempt + 1), 60)
              } else {
                restoredRef.current = true
                needsRestoreRef.current = false
              }
            }
            requestAnimationFrame(() => tryScroll(0))
          } else {
          // 不需要恢复（从头开始读 / 第一次打开），onPageChange 直接放行
          restoredRef.current = true
          needsRestoreRef.current = false
        }
      } catch (e) {
        if (!cancelled) {
          console.warn('[PdfPptxAdapter] pdf.js open failed', e)
          setPdfError(e instanceof Error ? e.message : String(e))
        }
      }
    })()
    return () => {
      cancelled = true
      setPdfDoc(null)
      onPdfDocReady?.(null)
      // destroy 要异步；不 await，出 render 边界即可
      localDoc?.destroy().catch(() => {})
    }
  }, [isPdf, resource.resource_id])

  useEffect(() => {
    // PDF 模式下主视图是 iframe，不走文本卡片；pages 数组仅供 AI 笔记偶尔用，
    // 而 AI 笔记面板自己会按需再查 `doc_reader_get_page`——这里就不预拉 505 次
    // 空 IPC 阻塞 CPU 了。非 PDF 走老逻辑。
    if (isPdf) {
      setStatus('success')
      return
    }
    let cancelled = false
    async function load() {
      const sessionId = resource.doc_session_id
      if (!sessionId) {
        setStatus('empty')
        return
      }
      try {
        setStatus('loading')
        const session: { pages?: { page_index: number }[] } = await invoke('doc_reader_get_session', {
          sessionId,
        })
        // 总页数：优先用 doc_sessions 里插入的 page row 数量；老数据 / 文本抽取
        // 失败时 session.pages 可能为空，此时回退到 resources.page_count（由
        // lopdf 读出的 PDF 真实页数），至少让 header 显示正确的 "/ N"。
        const total = Math.max(
          session.pages?.length ?? 0,
          resource.page_count ?? 0,
          0
        )
        const out: PageContent[] = []
        for (let i = 0; i < total; i++) {
          // `doc_reader_get_page` 返回 `{ page: PageContent, note: ... }`
          // （见 commands.rs），之前这里直接断言成 PageContent 导致
          // p.page_index/content/word_count 全 undefined → header 显示
          // "第 NaN 页"、正文渲染 "（本页无文本）"。正确做法是解包 page 字段。
          const wrapped = await invoke<{ page: PageContent | null }>('doc_reader_get_page', {
            sessionId,
            pageIndex: i,
          })
          if (cancelled) return
          // 后端在 row 缺失时也会回退成空 PageContent 占位（db.rs:dr_get_page），
          // 不会返回 null；加保护是为了未来 schema 变动不留暗坑。
          const page = wrapped?.page ?? { page_index: i, content: '', word_count: 0 }
          out.push(page)
        }
        if (!cancelled) {
          setPages(out)
          setStatus(out.length === 0 ? 'empty' : 'success')
        }
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
  }, [isPdf, resource.doc_session_id, resource.page_count])

  // PPTX 专属：拉取原生幻灯片图片（PowerPoint COM 导出 PNG）。
  // 不阻塞文本视图——文本会先于图片就绪展示。
  useEffect(() => {
    if (resource.kind !== 'pptx') return
    let cancelled = false
    async function loadSlides() {
      try {
        setSlideStatus('loading')
        const file = await resourcesApi.readFile(resource.resource_id)
        if (cancelled) return
        const result = await invoke<{ slides: string[]; count: number }>(
          'doc_reader_export_ppt_slides',
          { fileData: file.file_data, fileName: file.file_name }
        )
        if (cancelled) return
        setSlideImages(result.slides ?? [])
        setSlideStatus('ready')
      } catch (e) {
        if (cancelled) return
        // 失败不抛错（PPT 未安装 / Android 等），降级到「仅文本」展示
        console.warn('[PdfPptxAdapter] PPT slide export failed', e)
        setSlideStatus('error')
      }
    }
    loadSlides()
    return () => {
      cancelled = true
    }
  }, [resource.resource_id, resource.kind])

  // 当前页定位：原 `intersectionRatio` 最大值在「相邻两页各占 50%」时会抖动；
  // 改用 readest / Apple Books 同款做法：直接用 scroll 事件 + 计算"卡片中心距视口中心最近"。
  // 这是 O(N) 但 N 通常 < 1000 页，实际只取可见区域内卡片，开销可忽略。
  useEffect(() => {
    const root = containerRef.current
    if (!root || pages.length === 0) return
    let ticking = false
    const updateActive = () => {
      ticking = false
      const cards = Array.from(
        root.querySelectorAll<HTMLElement>('[data-page-index]')
      )
      if (cards.length === 0) return
      const rootRect = root.getBoundingClientRect()
      const targetY = rootRect.top + rootRect.height / 2
      let bestIdx = -1
      let bestDist = Number.POSITIVE_INFINITY
      for (const el of cards) {
        const rr = el.getBoundingClientRect()
        // 卡片完全在视口外（上方或下方）就跳过，避免极端情况误选
        if (rr.bottom < rootRect.top - 50) continue
        if (rr.top > rootRect.bottom + 50) break
        const mid = rr.top + rr.height / 2
        const d = Math.abs(mid - targetY)
        if (d < bestDist) {
          bestDist = d
          bestIdx = Number(el.dataset.pageIndex)
        }
      }
      if (bestIdx >= 0 && bestIdx !== activePage) {
        setActivePage(bestIdx)
        const page = pages.find((p) => p.page_index === bestIdx)
        gatedOnPageChange(bestIdx, page?.content)
      }
    }
    const onScroll = () => {
      if (ticking) return
      ticking = true
      requestAnimationFrame(updateActive)
    }
    // 初次同步一次（页面刚渲染时 activePage=0 但视口里可能不是 0）
    updateActive()
    root.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      root.removeEventListener('scroll', onScroll)
    }
  }, [pages, activePage, gatedOnPageChange])

  // DOCX：用 docx-preview 渲染，保留 Word 段落/表格/字体/图片
  if (isDocx) {
    return (
      <DocxView
        resource={resource}
        initialPageIndex={initialPageIndex}
        scrollToPageRef={docxScrollRef}
        onPageChange={gatedOnPageChange}
        annotations={pdfAnnotations}
        onAddHighlight={onAddPdfHighlight}
        onAIExplain={onPdfAIExplain}
      />
    )
  }

  // PDF：pdf.js 每页 canvas 渲染，IntersectionObserver 按需渲染避免
  // 一次性把 505 页全塞进 GPU。pages/status 只服务 AI 笔记文本抽取，
  // 失败不阻挡阅读。
  if (isPdf) {
    if (pdfError) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
          <p className="text-sm font-medium text-error">PDF 加载失败</p>
          <p className="text-xs text-text-3">{pdfError}</p>
        </div>
      )
    }
    if (!pdfDoc) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-text-3">
          <div className="flex items-center">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            正在加载 PDF{pdfLoadProgress != null ? `… ${pdfLoadProgress}%` : '…'}
          </div>
          {pdfLoadProgress != null && (
            <div className="h-1 w-48 overflow-hidden rounded-full bg-surface-3">
              <div
                className="h-full bg-accent transition-[width] duration-150"
                style={{ width: `${pdfLoadProgress}%` }}
              />
            </div>
          )}
        </div>
      )
    }
    return (
      <PdfCanvasView
        doc={pdfDoc}
        zoom={effectivePdfZoom}
        fullWidth={fullWidth}
        pageMode={pdfPageMode ?? 'scroll'}
        initialPageIndex={initialPageIndex}
        onPageChange={gatedOnPageChange}
        scrollToPageRef={pdfScrollRef}
        onTocReady={onTocReady}
        annotations={pdfAnnotations}
        onAddHighlight={onAddPdfHighlight}
        onAIExplain={onPdfAIExplain}
      />
    )
  }

  if (status === 'loading') {
    return (
      <div className="flex h-full items-center justify-center text-sm text-text-3">
        正在抽取文本…
      </div>
    )
  }
  if (status === 'error') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <p className="text-sm font-medium text-error">读取失败</p>
        <p className="text-xs text-text-3">{error}</p>
      </div>
    )
  }
  if (status === 'empty') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-text-3">
        <p>该资料尚未抽取文本</p>
        <p className="text-xs">请在导入时勾选「同时抽取文本供 AI 使用」</p>
      </div>
    )
  }

  const isPptx = resource.kind === 'pptx'
  return (
    <div ref={containerRef} className="h-full overflow-y-auto px-6 py-8" data-selectable="true">
      <div className={cn('mx-auto flex flex-col gap-6', fullWidth ? 'max-w-5xl' : 'max-w-3xl')}>
        {isPptx && slideStatus === 'loading' && (
          <div className="flex items-center justify-center gap-2 rounded-md border border-dashed border-border-1 px-4 py-3 text-xs text-text-3">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            正在调用 PowerPoint 导出原生幻灯片图片… 首次可能需要数十秒
          </div>
        )}
        {isPptx && slideStatus === 'error' && (
          <div className="rounded-md border border-dashed border-warning/60 px-4 py-2 text-xs text-text-3">
            幻灯片图片导出失败（PPT 未安装或非 Windows 平台）—— 已降级显示文本
          </div>
        )}
        {pages.map((p) => {
          const slideUri = isPptx ? slideImages[p.page_index] : undefined
          return (
            <article
              key={p.page_index}
              data-page-index={p.page_index}
              className={cn(
                'glass-card p-6 transition-shadow',
                p.page_index === activePage && 'shadow-glow'
              )}
            >
              <header className="mb-3 flex items-center justify-between text-xs text-text-3">
                <span>
                  {isPptx ? '幻灯片' : '第'} {p.page_index + 1} {isPptx ? '/' : '页 /'} {pages.length}
                </span>
                {p.word_count > 0 && <span>{p.word_count} 字</span>}
              </header>
              {/* PPTX：先渲染原生幻灯片图（如有），再附文本作为辅助/复制源 */}
              {slideUri && (
                <img
                  src={slideUri}
                  alt={`Slide ${p.page_index + 1}`}
                  loading="lazy"
                  className="mb-3 w-full rounded-md border border-border-1 bg-white shadow-sm"
                />
              )}
              {p.content ? (
                <MarkdownView content={p.content} theme={mdTheme} />
              ) : !slideUri ? (
                <em className="text-xs text-text-3">（本页无文本）</em>
              ) : null}
            </article>
          )
        })}
      </div>
    </div>
  )
})

// ═════════════════════════════════════════════════════════════════════════════
// PdfCanvasView — 每页按需用 pdf.js 渲染到 canvas，IntersectionObserver 懒加载
// ═════════════════════════════════════════════════════════════════════════════

interface PdfCanvasViewProps {
  doc: PdfJsDoc
  /**
   * 缩放模式：
   *   - 'fit-width'：自动满宽（按容器宽度 / PDF 原宽 计算 scale，clamp 到 [0.6, 4]）
   *   - number：固定倍率（1 = PDF 原生尺寸；超出 [0.2, 6] 会 clamp 防崩）
   */
  zoom: 'fit-width' | number
  fullWidth?: boolean
  /** 阅读模式：scroll = 连续滚动；single = 经典单页 */
  pageMode?: 'scroll' | 'single'
  /**
   * 续读起点（0-based）。作为 activePage 初始 state，
   * 避免"先渲染页 0 再跳"的位置竞争问题。
   * 滚动模式下 origDims 就绪后会再做一次精准 scrollIntoView。
   */
  initialPageIndex?: number
  onPageChange?: (pageIndex: number, content?: string) => void
  /** 向父组件暴露翻到第 N 页的能力（给 TOC 点击联动用） */
  scrollToPageRef?: React.MutableRefObject<((pageIndex: number) => void) | null>
  /** 大纲就绪回调：PDF outline → FoliateTocItem 兼容结构 */
  onTocReady?: (toc: PdfTocItem[]) => void
  /** 所有 PDF 批注。PdfCanvasView 按 page_index 分派。 */
  annotations?: Annotation[]
  /** 文字选中后创建批注的回调（ReaderShell 绑到 useAnnotations.addPdfHighlight） */
  onAddHighlight?: (args: {
    pageIndex: number
    rects: PdfNormRect[]
    selectedText: string
    color: HighlightColorKey
  }) => void | Promise<void>
  /** AI 解释选区入口。 */
  onAIExplain?: (selectedText: string) => void
}

function PdfCanvasView({
  doc,
  zoom,
  pageMode = 'scroll',
  initialPageIndex,
  onPageChange,
  scrollToPageRef,
  onTocReady,
  annotations,
  onAddHighlight,
  onAIExplain,
}: PdfCanvasViewProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  // 初始 activePage = initialPageIndex（避免"先 0 再跳"的闪烁）
  const [activePage, setActivePage] = useState(() => {
    const v = initialPageIndex ?? 0
    return Math.max(0, Math.min(doc.numPages - 1, v))
  })
  /**
   * 滚动模式下仅需一次的初始 scrollIntoView：
   * 等 origDims 就绪后再做，避免页高从 fallback 1100 跳到实际 ~715 后 scrollTop 错位。
   * 同时受"还未做过"状态保护，仅起作用于首次。
   */
  const initialScrollDoneRef = useRef(false)
  /**
   * 每页文本缓存：PdfPageCanvas 页面渲染后 getTextContent 的结果都沉下来。
   * 这样滚动模式下如果某页之前渲染过，后面滚回去能立即拿到它的 content
   * 上报给 AI，不再等 onText 第二次触发（渲染过一次不会再调）。
   * 这是修复「滚动模式下 AI 识别不准当前页」的核心。
   */
  const textCacheRef = useRef<Map<number, string>>(new Map())
  /**
   * 首页原始尺寸（scale=1）。用于：
   *  1. 计算 fit-width scale = containerWidth / origW
   *  2. 给所有未可见页做占位 dims（PDF 绝大多数页尺寸一致）
   * 避免一次 mount 就 fire N 次 getPage 拍马屁淹没 worker。
   */
  const [origDims, setOrigDims] = useState<{ w: number; h: number } | null>(null)
  /**
   * 容器可用宽度（px）。ResizeObserver 监测，window resize / 侧栏开合都会变。
   * 与 origDims 配合算出 fitScale = (containerW - 32) / origW，使 PDF 自适应满宽。
   * 这是本次 PDF 修复的核心：之前固定 scale=1.0 → 1080p 屏 + 600pt PDF 只占
   * 大约一半屏幕，看起来"清晰度低"（其实是 canvas 像素=PDF 原生像素就这么大）。
   */
  const [containerWidth, setContainerWidth] = useState(0)
  /**
   * activePage 的最新值 ref（每次 setActivePage 后同步），给 ResizeObserver / scrollToPage 等
   * 非 React 渲染路径用。直接读 state 会拿到 stale closure value。
   */
  const activePageRef = useRef(activePage)
  useEffect(() => { activePageRef.current = activePage }, [activePage])
  /**
   * 调整侧栏宽度时锁定阅读位置 —— 修复「拖动分隔条 PDF 页码大返回」(issue 1)。
   *
   * Bug 根因：scale 变更 → 所有 PdfPageCanvas 占位高度变化 → 浏览器 scrollTop 被钳制到
   * scrollHeight → 浏览器**先触发 scroll 事件** → 我们的 updateActive 用 scrollTop 中心
   * 算出错误的 activePage（往往是更小的页码）→ React 把 activePage state 改坏 →
   * 紧接着 scale effect 才 fire → 它读到的已经是被污染的 activePage →
   * scrollIntoView 到错误页（用户感知就是「大返回」）。
   *
   * 修复策略：
   *  1. ResizeObserver 第一次触发即视为「拖动突发」开始，**立刻** snapshot 当前 activePage 到
   *     restorePageRef，并把 lockActiveRef 拉起。
   *  2. 锁定期间 updateActive 提前 return，scroll 事件无法污染 activePage。
   *  3. flush 完成后用 restorePageRef（而非 state 中的 activePage）做位置恢复。
   *  4. 恢复 scroll 落位后再解锁（~250ms 余量）。
   */
  const restorePageRef = useRef<number | null>(null)
  const lockActiveRef = useRef(false)
  useEffect(() => {
    let cancelled = false
    doc.getPage(1).then((page) => {
      if (cancelled) return
      const vp = page.getViewport({ scale: 1 })
      setOrigDims({ w: vp.width, h: vp.height })
    }).catch(() => {})
    return () => {
      cancelled = true
    }
  }, [doc])
  /**
   * 滚动模式首次 scrollIntoView 到 initialPageIndex：等 origDims 加载完、页面高度稳定
   * 再做，避免 fallback height 1100 下算出错误 scrollTop。
   * initialPageIndex 为 0 / undefined 时跳过。
   */
  useEffect(() => {
    if (initialScrollDoneRef.current) return
    if (!origDims) return
    if (pageMode === 'single') {
      // 单页模式：activePage 已初始为 target，仅需 scrollTop=0
      initialScrollDoneRef.current = true
      const root = containerRef.current
      if (root) root.scrollTop = 0
      return
    }
    const target = initialPageIndex ?? 0
    if (target <= 0) {
      initialScrollDoneRef.current = true
      return
    }
    const root = containerRef.current
    if (!root) return
    // 等一个 rAF 让 PdfPageCanvas 用新 defaultDims 重排
    requestAnimationFrame(() => {
      const el = root.querySelector<HTMLElement>(`[data-page-index="${target}"]`)
      if (el) {
        el.scrollIntoView({ behavior: 'auto', block: 'start' })
        initialScrollDoneRef.current = true
      }
      // 若元素还不在，下次 effect re-run（origDims / pageMode 变化）会重试
    })
  }, [origDims, pageMode, initialPageIndex])
  // 监测容器宽度（侧栏开合 / 窗口 resize 都会变）
  // 关键：ResizeObserver 会随 mousemove 同步连珠炮触发（拖动分隔条时一秒能出几十次），
  // 每一次 setContainerWidth 都会重算 scale、进而让所有可见页 canvas 重渲染 —— 拖动体验平卡。1
  // 用 rAF + 120ms trailing debounce 合并多次调用。拖动过程中只在“最后一下”重排 PDF。
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    let raf = 0
    let timer: number | undefined
    let initialized = false  // 跳过 ResizeObserver.observe() 首次双发的 schedule
    const flush = () => {
      const next = el.clientWidth
      setContainerWidth((prev) => {
        if (prev === next) {
          // 宽度实际没变（初始化 / 伪触发）→ scale effect 不会 fire → 需手动解锁
          lockActiveRef.current = false
          restorePageRef.current = null
          return prev
        }
        return next
      })
    }
    const schedule = () => {
      // 跳过首次：ResizeObserver.observe() 会同步 fire 一次，宽度同 setContainerWidth(el.clientWidth)
      // 重复 → 不该锁住 activePage。下面 setContainerWidth 后才置 initialized=true。
      if (!initialized) return
      // 第一次真拖动触发：锁住 activePage，避免后续 scrollTop 钳制 → scroll 事件 → updateActive 改坏
      if (!lockActiveRef.current) {
        restorePageRef.current = activePageRef.current
        lockActiveRef.current = true
      }
      if (raf) cancelAnimationFrame(raf)
      if (timer) window.clearTimeout(timer)
      raf = requestAnimationFrame(() => {
        raf = 0
        timer = window.setTimeout(flush, 120)
      })
    }
    const ro = new ResizeObserver(schedule)
    ro.observe(el)
    setContainerWidth(el.clientWidth)
    initialized = true
    return () => {
      ro.disconnect()
      if (raf) cancelAnimationFrame(raf)
      if (timer) window.clearTimeout(timer)
    }
  }, [])
  /**
   * 最终 scale 计算。两种模式：
   *   1. zoom === 'fit-width'：scale = clamp((containerW - padding) / origW, 0.6, 4)
   *      —— 让 PDF 自适应容器宽度。初始化完成前（origDims 未就绪 / 容器未测量）
   *         暂时返回 1.0 避免页面闪烁成巨大占位。
   *   2. zoom 是数字（0.5 / 1.0 / 1.5 / 2 / ...）：直接用该倍率，clamp [0.2, 6] 防崩。
   */
  const scale = (() => {
    if (typeof zoom === 'number') {
      return Math.min(6, Math.max(0.2, zoom))
    }
    if (!origDims || containerWidth <= 0) return 1
    // 32px = padding 左右 16+16；预留滚动条 ~10px 以保险
    const target = Math.max(0, containerWidth - 32 - 10)
    const fit = target / origDims.w
    return Math.min(4, Math.max(0.6, fit))
  })()
  // 占位用 dims = 原始尺寸 × 当前 scale。useMemo 避免每次父 render 都新对象，
  // 让 PdfPageCanvas (memo) 的 props 引用稳定，减少不必要 reconciliation。
  const defaultDims = useMemo(
    () => (origDims ? { w: origDims.w * scale, h: origDims.h * scale } : null),
    [origDims, scale]
  )

  /**
   * 缩放变化后保持阅读位置：scale 因侧栏开合 / 缩放调整变化时，每页高度变化，
   * 浏览器保留的 scrollTop 会指向完全不同的内容（甚至被钳制到 scrollHeight）。
   * Fix：用 restorePageRef（在 ResizeObserver 起跑时已 snapshot 的「锁定页」）
   * 做 scrollIntoView，避免读到被 scroll 事件污染过的 activePage state。
   *
   * 首次渲染（prevScale=null）不动作，避免与续读 scrollToPage 抢路。
   */
  const prevScaleRef = useRef<number | null>(null)
  useEffect(() => {
    const prev = prevScaleRef.current
    prevScaleRef.current = scale
    if (prev == null) return
    if (Math.abs(prev - scale) < 1e-4) return
    // **关键**：只有 ResizeObserver 触发的 scale 变化才做位置恢复。
    // origDims 异步加载完成时 scale 从 fallback=1 变到 fit-width（~0.85），
    // 这次 effect 也会 fire，但 restorePageRef=null、activePage=0 → 会把刚刚续读到
    // 第 N 页的位置又强制冲回首页。lockActiveRef 由 ResizeObserver schedule() 设置，
    // 不会因 origDims 加载触发，正好用来区分两种 scale 变化来源。
    if (!lockActiveRef.current) return
    const root = containerRef.current
    if (!root) return
    // 锁定页优先于当前 activePage state（state 可能已被中间的 scroll 事件污染）
    const idx = restorePageRef.current ?? activePage
    // 用 rAF 等 PdfPageCanvas 的占位 height 应用完，再做一次校准滚动
    requestAnimationFrame(() => {
      const el = root.querySelector<HTMLElement>(`[data-page-index="${idx}"]`)
      if (el) el.scrollIntoView({ block: 'start', behavior: 'auto' })
      // scroll 落位后解锁 —— 给浏览器留 ~250ms 处理 scrollIntoView 引发的连锁 scroll 事件
      window.setTimeout(() => {
        // 解锁前同步把 activePage 校准回 idx（防止 state 还停留在被污染值）
        if (idx !== activePageRef.current) {
          setActivePage(idx)
        }
        lockActiveRef.current = false
        restorePageRef.current = null
      }, 250)
    })
    // 仅依赖 scale；activePage 通过闭包读最新值（每次 scale 变才重排）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scale])

  /**
   * 按 page_index 把 annotations 分桶 —— 每页 PdfPageCanvas 只接到自己那页的
   * 数组引用。useMemo 让分桶结果在 annotations 数组内容不变时引用稳定，
   * 避免之前每次父 render `(annotations ?? []).filter(...)` 给每个子组件都生
   * 新数组的 props 抖动。
   */
  const annotationsByPage = useMemo(() => {
    const map = new Map<number, Annotation[]>()
    for (const a of annotations ?? []) {
      const arr = map.get(a.page_index)
      if (arr) arr.push(a)
      else map.set(a.page_index, [a])
    }
    return map
  }, [annotations])

  const pageNums = useMemo(
    () => Array.from({ length: doc.numPages }, (_, i) => i),
    [doc.numPages]
  )

  // 暴露 scrollToPage 给父组件（TOC 点击 / 续读触发）
  useEffect(() => {
    if (!scrollToPageRef) return
    scrollToPageRef.current = (pageIndex: number) => {
      const clamped = Math.max(0, Math.min(doc.numPages - 1, pageIndex))
      // 单页模式：直接切活动页，不需要在 DOM 里找元素
      if (pageMode === 'single') {
        setActivePage(clamped)
        // 同时滚到顶（避免以前页裁剪位置遮挫）
        requestAnimationFrame(() => {
          const root = containerRef.current
          if (root) root.scrollTop = 0
        })
        return
      }
      // 滚动模式：目标元素可能尚未 mount（origDims / containerWidth 未就绪），
      // 在内部做 100ms × 60 次重试 —— 这是 issue 10 续读恢复的二级保险。
      const root = containerRef.current
      if (!root) return
      const attempt = (n: number) => {
        const el = root.querySelector<HTMLElement>(`[data-page-index="${clamped}"]`)
        if (el) {
          // 续读用 'auto' 避免长动画期间 onPageChange 误报；TOC 跳转有空间用 smooth，
          // 这里统一 auto，差异感弱。
          el.scrollIntoView({ behavior: 'auto', block: 'start' })
          // 同步 activePage，防止 scroll 事件竞争
          setActivePage(clamped)
          return
        }
        if (n < 60) window.setTimeout(() => attempt(n + 1), 100)
      }
      attempt(0)
    }
    return () => {
      if (scrollToPageRef) scrollToPageRef.current = null
    }
  }, [scrollToPageRef, pageMode, doc.numPages])

  // PDF outline → FoliateTocItem 兼容结构。对每个节点:
  // - dest 是数组 [pageRef, ...] 时直接 getPageIndex(pageRef[0])
  // - dest 是 string（named destination）时先 getDestination 解析再 getPageIndex
  // - 解析失败的节点仍保留 title，href="" 点击无响应（不丢结构）
  useEffect(() => {
    if (!onTocReady) return
    let cancelled = false
    ;(async () => {
      try {
        const outline = await doc.getOutline()
        if (cancelled || !outline || outline.length === 0) {
          onTocReady([])
          return
        }
        // pdfjs-dist 4.x 的 OutlineNode 类型较宽，此处用结构化最小接口避开
        type OutlineNode = {
          title: string
          dest: string | unknown[] | null
          items: OutlineNode[]
        }
        const resolve = async (item: OutlineNode): Promise<PdfTocItem> => {
          let href = ''
          try {
            let dest: unknown = item.dest
            if (typeof dest === 'string') {
              dest = await doc.getDestination(dest)
            }
            if (Array.isArray(dest) && dest.length > 0) {
              const pageRef = dest[0]
              const idx = await doc.getPageIndex(pageRef)
              if (typeof idx === 'number' && idx >= 0) href = `pdfpage:${idx}`
            }
          } catch {
            /* 解析失败的节点 href 留空 */
          }
          const subitems =
            item.items && item.items.length > 0
              ? await Promise.all(item.items.map(resolve))
              : undefined
          return { label: item.title, href, subitems }
        }
        const toc = await Promise.all(outline.map(resolve))
        if (!cancelled) onTocReady(toc)
      } catch (e) {
        console.warn('[PdfCanvasView] getOutline failed', e)
        if (!cancelled) onTocReady([])
      }
    })()
    return () => {
      cancelled = true
    }
  }, [doc, onTocReady])

  // 滚动时找到"卡片中心最接近视口中心"的页，上报 activePage，与文本卡片视图
  // 的逻辑一致。AI 笔记右侧面板据此更新 currentPageIndex。
  useEffect(() => {
    const root = containerRef.current
    if (!root) return
    let ticking = false
    const update = () => {
      ticking = false
      // 拖动侧栏锁定期间不更新 activePage —— 避免 scrollTop 被钳制 → scroll 事件 →
      // 算出错误的页码污染 state（见 lockActiveRef 注释）
      if (lockActiveRef.current) return
      // 续读初次 scrollIntoView 完成前不更新 activePage：
      // 否则 scrollTop=0 → bestIdx=0 → setActivePage(0) 会把已初始化为 target 的 activePage 冲回 0
      if (!initialScrollDoneRef.current) return
      const cards = Array.from(
        root.querySelectorAll<HTMLElement>('[data-page-index]')
      )
      if (cards.length === 0) return
      const rect = root.getBoundingClientRect()
      const targetY = rect.top + rect.height / 2
      let bestIdx = -1
      let bestDist = Number.POSITIVE_INFINITY
      for (const el of cards) {
        const rr = el.getBoundingClientRect()
        if (rr.bottom < rect.top - 50) continue
        if (rr.top > rect.bottom + 50) break
        const mid = rr.top + rr.height / 2
        const d = Math.abs(mid - targetY)
        if (d < bestDist) {
          bestDist = d
          bestIdx = Number(el.dataset.pageIndex)
        }
      }
      if (bestIdx >= 0 && bestIdx !== activePage) {
        setActivePage(bestIdx)
        // 优先从文本缓存拿：滚动回之前看过的页也能立即跟 AI 对齐
        const cached = textCacheRef.current.get(bestIdx)
        onPageChange?.(bestIdx, cached)
      }
    }
    const onScroll = () => {
      if (ticking) return
      ticking = true
      requestAnimationFrame(update)
    }
    update()
    root.addEventListener('scroll', onScroll, { passive: true })
    return () => root.removeEventListener('scroll', onScroll)
  }, [doc, activePage, onPageChange])

  return (
    <div className="flex h-full flex-col">
      {/* 页面区 — data-pdf-scroll-root 给子 PdfPageCanvas 的 IntersectionObserver
           作为 root 使用，保证懒渲染相对的是此滚动容器而非视口 */}
      <div
        ref={containerRef}
        data-pdf-scroll-root
        className="flex-1 overflow-y-auto bg-surface-2 px-4 py-4"
        // 关键：scrollbar-gutter: stable 让浏览器**永久**为滚动条保留一条 gutter，
        // 滚动条出现/消失不会再改变 clientWidth → ResizeObserver 不再连珠炮触发
        // → fit-width scale 不再在 100% ↔ 110% 之间反复弹跳。
        // overflow-y-auto 在 PDF 续读 / 切页时常出现 scrollbar 状态切换 ——
        // 在没有 stable gutter 时就是 PDF 抖动的根因。
        style={{ scrollbarGutter: 'stable' }}
      >
        {/* PDF 卡片永远满宽（fit-width 的前提）；fullWidth prop 已无意义但保留 props
            兼容。max-w-5xl 会和 fit-width scale 冲突 → 卡片溢出 → 水平滚动。
            单页模式额外加 min-h-full + justify-center 让唯一一页在视口里上下居中，
            避免页面贴顺出现「左上角顶在顶部」的藕颜体验。 */}
        <div className={cn(
          'mx-auto flex w-full flex-col items-center gap-4',
          pageMode === 'single' && 'min-h-full justify-center'
        )}>
          {pageMode === 'single' ? (
            // 单页模式：仅渲染 activePage 一页
            <PdfPageCanvas
              key={activePage}
              doc={doc}
              pageIndex={activePage}
              scale={scale}
              activePage={activePage}
              defaultDims={defaultDims}
              annotations={annotationsByPage.get(activePage) ?? EMPTY_ANNOTATIONS}
              onText={(content) => {
                if (content) textCacheRef.current.set(activePage, content)
                if (content) onPageChange?.(activePage, content)
              }}
            />
          ) : (
            pageNums.map((i) => (
              <PdfPageCanvas
                key={i}
                doc={doc}
                pageIndex={i}
                scale={scale}
                activePage={activePage}
                defaultDims={defaultDims}
                annotations={annotationsByPage.get(i) ?? EMPTY_ANNOTATIONS}
                onText={(content) => {
                  // 总在当前页文本缓存里记一笔，后续滚回可复用
                  if (content) textCacheRef.current.set(i, content)
                  // 如果刚好是当前页，立即上报给 AI / 笔记生成
                  if (i === activePage && content) onPageChange?.(i, content)
                }}
              />
            ))
          )}
        </div>
      </div>
      {/* 选区颜色 popover：监听 scrollRoot 范围内的 selection，提交时调 onAddHighlight */}
      {onAddHighlight && (
        <PdfSelectionPopover
          scrollRootRef={containerRef}
          onConfirm={onAddHighlight}
          onAIExplain={onAIExplain}
        />
      )}
    </div>
  )
}

// ─── PdfPageCanvas：单页懒渲染 ───────────────────────────────────────────────

interface PdfPageCanvasProps {
  doc: PdfJsDoc
  pageIndex: number // 0-based
  scale: number
  /** 视口当前页；超出 ±KEEP_WINDOW 的 canvas 会被释放（GPU 内存回收） */
  activePage: number
  /** 来自首页的默认占位尺寸；避免挂载时每页都 fire getPage 请求。 */
  defaultDims: { w: number; h: number } | null
  /** 属于本页的批注（上层已按 page_index 过滤） */
  annotations?: Annotation[]
  onText?: (text: string) => void
}

/** canvas 池窗口大小：当前页前后各保留 N 页的 canvas，其余 teardown。
 *  之前 3 太紧，PDF 翻页一旦快速滚动经常出现"已渲染→已释放→重新渲染"震荡。
 *  设为 6 兼顾内存占用（一页 canvas 约 fit-width 1280×1800×4B ≈ 9MB，6 页≈55MB） */
const KEEP_WINDOW = 6

/** 共用空数组常量 —— 给所有"无批注"的页用，引用稳定，让 React.memo 生效 */
const EMPTY_ANNOTATIONS: Annotation[] = []

/**
 * 单页 canvas 组件。策略：
 * 1. 先用 page.getViewport(scale) 拿 CSS 尺寸作为占位（维持滚动高度正确）
 * 2. IntersectionObserver 检测进视口（rootMargin: 1200px 提前预渲染）才跑 render
 * 3. 高清屏：canvas 内部像素 = CSS 尺寸 × dpr（≥2），保证 Retina 上不糊
 * 4. Text Layer：用 pdfjs-dist 4.x `TextLayer` 类；官方 pdf_viewer.css 自动生效
 * 5. Canvas 池：距 activePage > KEEP_WINDOW 的页释放 canvas（保留占位尺寸不抖动）
 *
 * memo 是为了避免 PdfCanvasView 每次 activePage 变化都 re-render 所有子组件。
 */
const PdfPageCanvas = memo(function PdfPageCanvas({
  doc,
  pageIndex,
  scale,
  activePage,
  defaultDims,
  annotations,
  onText,
}: PdfPageCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const textLayerRef = useRef<HTMLDivElement>(null)
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null)
  const [visible, setVisible] = useState(false)
  const pageRef = useRef<PdfJsPage | null>(null)
  const renderedRef = useRef<string>('') // 记已渲染的 (scale|dpr)
  /**
   * onText 用 ref 模式持有最新引用 —— 否则父组件每次 render 都会新建闭包
   * （activePage 变化、annotations.filter 新数组、defaultDims 新对象 都会触发
   * 父 render → 子 onText 是新函数引用 → 渲染 useEffect 把它当依赖 → cancel 当前
   * RenderTask 重启 → 队列里堆积 cancel/restart → "永远渲染不完，整页空白"）。
   *
   * 这是用户报告"PDF 显示加载成功但页面长时间空白"的根因。
   */
  const onTextRef = useRef(onText)
  useEffect(() => {
    onTextRef.current = onText
  }, [onText])

  /**
   * 当前正在进行 / 最近完成的 RenderTask。
   *
   * 关键修复：pdfjs 的 `task.cancel()` 是**异步**的——它只会标记 task 取消，
   * task.promise reject 在 worker 真正回到事件循环之后才到达。如果我们在
   * cancel 同步之后立即 `page.render(canvasContext)` 启动新 task，pdfjs 会抛
   * "Cannot use the same canvas during multiple page render() operations"
   * → 浏览器渲染层显示成黄色错误页。
   *
   * 现在的策略：每次启动新 render 前先 `await prev.task.promise.catch(noop)`
   * 确保上一个 task 真正退出。
   */
  const activeRenderRef = useRef<{
    task: PdfRenderTask | null
    textTask: { cancel: () => void } | null
  }>({ task: null, textTask: null })

  // 当前页是否在"保留窗口"内——超出则释放 canvas 节省内存
  const withinWindow = Math.abs(pageIndex - activePage) <= KEEP_WINDOW

  // 惰性加载真实页对象：只有 visible 触发后才 fire `doc.getPage()`。
  // 占位阶段用 defaultDims（首页尺寸）保证滚动条高度估算正确，等真实页对象
  // 返回后再 setDims 为本页实际尺寸（若和默认差异很小则不会视觉抖动）。
  useEffect(() => {
    if (!visible) return
    if (pageRef.current) return // 已加载
    let cancelled = false
    ;(async () => {
      const page = await doc.getPage(pageIndex + 1)
      if (cancelled) return
      pageRef.current = page
      const vp = page.getViewport({ scale })
      setDims({ w: vp.width, h: vp.height })
    })()
    return () => {
      cancelled = true
    }
  }, [doc, pageIndex, scale, visible])

  // scale 改变时，已加载的 page 需要刷新 dims（用缓存的 page 对象，无需 RPC）
  useEffect(() => {
    const page = pageRef.current
    if (!page) return
    const vp = page.getViewport({ scale })
    setDims({ w: vp.width, h: vp.height })
  }, [scale])

  // IntersectionObserver：rootMargin 1200px 提前预渲染附近页（配合 canvas 池使用）
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) setVisible(true)
          // 不自动 setVisible(false)：离开视口由 canvas 池逻辑管理
        }
      },
      // rootMargin 控制"提前预渲染范围"：值越大同时进入 visible 的页越多，
      // 越多的并发 page.render() 任务会塞进 worker 队列（worker 单线程串行处理）。
      // 1500px ≈ ±1.5 屏：用户翻页时大概率已渲好；首屏小 PDF（< 30 页）可几乎全可见。
      // 之前 600px → 中等 PDF 频繁出现"滚到位才开始渲染"白屏。
      { root: el.closest('[data-pdf-scroll-root]'), rootMargin: '1500px' }
    )
    io.observe(el)
    return () => io.disconnect()
  }, [])

  // 真实渲染：visible && dims && withinWindow 才画 canvas / textLayer
  // 离开窗口时 reset renderedRef，使得下次再进窗口重新渲染
  useEffect(() => {
    if (!visible || !dims || !withinWindow) {
      // 离开窗口：cancel 当前任务再释放 canvas bitmap 节省内存（保留占位尺寸不变）
      activeRenderRef.current.task?.cancel()
      activeRenderRef.current.textTask?.cancel()
      activeRenderRef.current = { task: null, textTask: null }
      const canvas = canvasRef.current
      if (canvas && canvas.width !== 0) {
        canvas.width = 0
        canvas.height = 0
      }
      renderedRef.current = ''
      return
    }
    const canvas = canvasRef.current
    const textLayer = textLayerRef.current
    const page = pageRef.current
    if (!canvas || !textLayer || !page) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // canvas 内部像素 = CSS 尺寸 × dpr。dpr 封顶 2，dpr=1 屏不放大、Retina 屏不爆炸
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const key = `${scale}|${dpr}`
    if (renderedRef.current === key) return // 已渲染过相同参数，跳过

    let cancelled = false
    /** 此次 effect 启动的 task 引用——用于在 cleanup 时定向 cancel，
     *  避免把同时间另一个 effect 已接管的 task 一起 cancel 掉 */
    let myTask: PdfRenderTask | null = null
    let myTextTask: { cancel: () => void } | null = null

    ;(async () => {
      // ① 等上一次 render task 真正退出再继续
      const prev = activeRenderRef.current
      if (prev.task) {
        try {
          prev.task.cancel()
          await prev.task.promise
        } catch {
          /* RenderingCancelledException 是预期的，忽略 */
        }
      }
      if (prev.textTask) {
        try {
          prev.textTask.cancel()
        } catch {
          /* TextLayer cancel 同步、不抛 */
        }
      }
      if (cancelled) return

      // ② 重新检查 DOM ref（async 间隙组件可能已卸载/重渲）
      const c = canvasRef.current
      const tl = textLayerRef.current
      const p = pageRef.current
      if (!c || !tl || !p) return
      const cx = c.getContext('2d')
      if (!cx) return

      // ③ 同步标记 key —— 防止 await 期间相同参数 effect 重跑导致重复启动
      renderedRef.current = key

      const cssViewport = p.getViewport({ scale })
      const hiViewport = p.getViewport({ scale: scale * dpr })
      c.width = Math.floor(hiViewport.width)
      c.height = Math.floor(hiViewport.height)
      c.style.width = `${Math.floor(cssViewport.width)}px`
      c.style.height = `${Math.floor(cssViewport.height)}px`
      cx.clearRect(0, 0, c.width, c.height)

      const renderStart = performance.now()
      myTask = p.render({ canvasContext: cx, viewport: hiViewport })
      activeRenderRef.current = { task: myTask, textTask: null }

      // text layer 容器
      tl.innerHTML = ''
      tl.style.width = `${Math.floor(cssViewport.width)}px`
      tl.style.height = `${Math.floor(cssViewport.height)}px`
      tl.style.setProperty('--scale-factor', String(scale))

      // canvas 渲染
      myTask.promise
        .then(() => {
          if (cancelled) return
          const renderMs = Math.round(performance.now() - renderStart)
          if (renderMs > 500) {
            console.log(`[PDF] page ${pageIndex + 1} canvas render ${renderMs}ms`)
          }
        })
        .catch(() => {
          /* cancel 或 pdfjs 内部错：忽略 */
        })

      // text layer 渲染
      const textStart = performance.now()
      try {
        const textContent = await p.getTextContent()
        if (cancelled) return
        // 仅当本次 effect 仍是"当前"时才接管 textLayer DOM
        if (activeRenderRef.current.task !== myTask) return
        const textMs = Math.round(performance.now() - textStart)
        if (textMs > 500) {
          console.log(`[PDF] page ${pageIndex + 1} textContent ${textMs}ms`)
        }
        const layer = new pdfjsLib.TextLayer({
          textContentSource: textContent,
          container: tl,
          viewport: cssViewport,
        })
        myTextTask = { cancel: () => layer.cancel() }
        activeRenderRef.current.textTask = myTextTask
        const cb = onTextRef.current
        if (cb) {
          const t = textContent.items
            .map((it) => ('str' in it ? it.str : ''))
            .join(' ')
          if (t.trim()) cb(t)
        }
        await layer.render()
      } catch {
        /* getTextContent / layer.render cancel：忽略 */
      }
    })()

    return () => {
      cancelled = true
      // 只 cancel 自己启动的 task —— 别动可能被新 effect 接管的引用
      myTask?.cancel()
      myTextTask?.cancel()
      // 让 next effect 知道 key 已失效（被 cancel 时不算"已渲染"）
      if (renderedRef.current === key) renderedRef.current = ''
    }
    // 故意 *不* 把 onText 列入依赖 —— 它走 ref 模式
  }, [visible, dims, scale, withinWindow, pageIndex])

  // Selection → 高亮的逻辑已上移到 PdfCanvasView 渲染的 `<PdfSelectionPopover>`：
  // 全局监听一次 selectionchange/mouseup，避免每页都挂监听器；
  // 用户选中后弹颜色 popover，点击颜色按钮才提交，行为与 EPUB 的 ReaderSelectionPopover 一致。

  // 展示尺寸：真实 dims > 默认 dims > 硬编码兜底
  const displayW = dims?.w ?? defaultDims?.w ?? 800
  const displayH = dims?.h ?? defaultDims?.h ?? 1100

  return (
    <div
      ref={containerRef}
      data-page-index={pageIndex}
      className="relative bg-white shadow-md"
      style={{
        width: displayW,
        height: displayH,
      }}
    >
      {visible && dims && (
        <>
          <canvas ref={canvasRef} className="block" />
          {/* 批注 overlay：叠在 canvas 上、textLayer 下；不拦截点击（pointer-events:none） */}
          {annotations && annotations.length > 0 && (
            <PdfAnnotationOverlay annotations={annotations} />
          )}
          {/* pdf.js 官方 textLayer 类 — 样式来自 pdf_viewer.css */}
          <div
            ref={textLayerRef}
            className="textLayer absolute left-0 top-0"
          />
        </>
      )}
      {!visible && (
        <div className="flex h-full items-center justify-center text-xs text-text-3">
          第 {pageIndex + 1} 页
        </div>
      )}
    </div>
  )
})

// ─── PdfAnnotationOverlay：画本页所有批注矩形 ───────────────────────────────

/**
 * 用 `position: absolute` + `left/top/width/height` 百分比定位每个 rect。
 * 放在 canvas 和 textLayer 之间的 z 层；pointer-events:none 保证文字仍可选。
 *
 * 视觉规范（与 EPUB `drawHighlightHalfHeight` 对齐，保证两端体验一致）：
 *   - 半高：覆盖每行下半部分 60%（避开 ascender 区，更像 marker pen）
 *   - 透明度：opacity 0.55 + mix-blend-mode multiply（白底变实色，多重叠加加深）
 *   - 颜色：直接用 HIGHLIGHT_COLORS（已是浅亮 hex）
 *
 * 历史脏数据兼容：旧版本写入的 rects 是 `Range.getClientRects()` 逐 span 切片
 * （视觉上有缝隙），渲染前再过一次 `mergePdfRectsByLine` 合并同行。
 */
function PdfAnnotationOverlay({ annotations }: { annotations: Annotation[] }) {
  return (
    <div
      className="pointer-events-none absolute inset-0"
      style={{ mixBlendMode: 'multiply' }}
    >
      {annotations.flatMap((a) => {
        const rects = mergePdfRectsByLine(parsePdfRects(a.pdf_rects))
        const color =
          HIGHLIGHT_COLORS[(a.color as HighlightColorKey) ?? 'yellow'] ?? HIGHLIGHT_COLORS.yellow
        return rects.map((r, idx) => (
          <div
            key={`${a.annotation_id}-${idx}`}
            title={a.selected_text}
            className="absolute"
            style={{
              left: `${r.x * 100}%`,
              // 半高：从矩形 40% 处开始，画 60% 高度
              top: `${(r.y + r.h * 0.4) * 100}%`,
              width: `${r.w * 100}%`,
              height: `${r.h * 0.6 * 100}%`,
              background: color,
              opacity: 0.55,
              borderRadius: 2,
            }}
          />
        ))
      })}
    </div>
  )
}

// ═════════════════════════════════════════════════════════════════════════════
// DocxView — 用 docx-preview 渲染 .docx，保留段落 / 字体 / 表格 / 图片
// ═════════════════════════════════════════════════════════════════════════════

interface DocxViewProps {
  resource: Resource
  /** 续读起点 (section index)。docx-preview 把每个 Word 逻辑页输出为一个 <section> */
  initialPageIndex?: number
  /** 父组件的 goto ref：docx 加载后注入 scrollToPage */
  scrollToPageRef?: React.MutableRefObject<((pageIndex: number) => void) | null>
  /** 当前可见 section 变化回调；第二个参数为 section 文本（给 AI 用） */
  onPageChange?: (pageIndex: number, content?: string) => void
  /**
   * DOCX 批注（与 PDF 共用后端字段：page_index + pdf_rects 归一化到 section 容器）。
   * 当前版本仅用于 selection popover 落库，覆盖层渲染留给后续迭代（和 PDF 同样的
   * DOM overlay 思路即可，因 section 容器尺寸在 docx-preview 渲染后是稳定的）。
   */
  annotations?: Annotation[]
  /**
   * 选区 popover 颜色按钮点击时触发。复用 PDF 的 addPdfHighlight 链路，把
   * 归一化到 section 的 rects + selectedText 写入 annotations 表。
   */
  onAddHighlight?: (args: {
    pageIndex: number
    rects: PdfNormRect[]
    selectedText: string
    color: HighlightColorKey
  }) => void | Promise<void>
  /** AI 解释选区入口。 */
  onAIExplain?: (selectedText: string) => void
}

/**
 * Word .docx 渲染策略：
 *
 * 1. **加载文件** — 优先 asset:// fetch ArrayBuffer；老数据回退到 readFile base64
 * 2. **renderAsync(buffer, container, styleContainer, options)** —— docx-preview 把
 *    .docx 解出，注入 CSS 到 `styleContainer`，把每个 Word 逻辑页渲染成
 *    `<section class="docx" />`。Section 之间靠 docx-preview 自带的页面间距样式
 *    (类似 Word 视图)。
 * 3. **每个 section 标 data-page-index**，给滚动定位 / 续读 / TOC 跳转使用
 * 4. **滚动监测当前 section** —— 与 PDF 完全相同的"卡片中心最接近视口中心"算法
 * 5. **续读** — initialPageIndex > 0 时，render 完成后 scrollIntoView
 * 6. **scrollToPageRef** — 暴露 scrollToPage(idx) 给父组件（TOC 联动）
 *
 * 文本选中默认可用（普通 HTML），后续如要做 docx 批注可参照 PdfSelectionPopover
 * 的归一化矩形思路（按 section 容器归一化）。
 */
function DocxView({
  resource,
  initialPageIndex,
  scrollToPageRef,
  onPageChange,
  onAddHighlight,
  onAIExplain,
}: DocxViewProps) {
  const scrollRootRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const styleRef = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState('')
  const [activePage, setActivePage] = useState(0)

  // 加载 + 渲染
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        setStatus('loading')
        // 拿 ArrayBuffer。asset:// 协议（streaming）优先，base64 走老路
        let buffer: ArrayBuffer
        if (resource.file_path) {
          const url = convertFileSrc(resource.file_path)
          const res = await fetch(url)
          if (!res.ok) throw new Error(`fetch ${url} → ${res.status}`)
          buffer = await res.arrayBuffer()
        } else {
          const file = await resourcesApi.readFile(resource.resource_id)
          const u8 = Uint8Array.from(atob(file.file_data), (c) => c.charCodeAt(0))
          buffer = u8.buffer
        }
        if (cancelled) return
        const container = containerRef.current
        const styleContainer = styleRef.current
        if (!container || !styleContainer) return
        // 清空（resource 切换时旧 DOM 残留会重叠样式）
        container.innerHTML = ''
        styleContainer.innerHTML = ''
        const t0 = performance.now()
        await renderDocx(buffer, container, styleContainer, {
          // inWrapper: true → 在 .docx-wrapper 里渲染所有页，便于统一定位
          inWrapper: true,
          ignoreWidth: false,
          ignoreHeight: false,
          // breakPages: true 让 docx-preview 按 Word 分页符切多 section
          breakPages: true,
          ignoreFonts: false,
          experimental: false,
          useBase64URL: true, // 内联图片用 data: URI，避免 blob 生命周期问题
        })
        if (cancelled) return
        console.log(`[DOCX] render 用时 ${Math.round(performance.now() - t0)}ms`)
        // 给所有 section 标 page-index
        const sections = container.querySelectorAll<HTMLElement>('section.docx')
        sections.forEach((s, i) => s.setAttribute('data-page-index', String(i)))
        setStatus('ready')
        // 续读：等一帧让 layout 稳定后跳转
        if (initialPageIndex && initialPageIndex > 0 && initialPageIndex < sections.length) {
          requestAnimationFrame(() => {
            if (cancelled) return
            sections[initialPageIndex]?.scrollIntoView({
              behavior: 'auto',
              block: 'start',
            })
          })
        }
      } catch (e) {
        if (cancelled) return
        console.warn('[DocxView] render failed', e)
        setError(e instanceof Error ? e.message : String(e))
        setStatus('error')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [resource.resource_id, resource.file_path, initialPageIndex])

  // 暴露 scrollToPage(idx) 给父组件（TOC 联动用）
  useEffect(() => {
    if (!scrollToPageRef) return
    scrollToPageRef.current = (pageIndex: number) => {
      const root = containerRef.current
      if (!root) return
      const el = root.querySelector<HTMLElement>(`[data-page-index="${pageIndex}"]`)
      el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
    return () => {
      if (scrollToPageRef) scrollToPageRef.current = null
    }
  }, [scrollToPageRef, status])

  // 滚动监测当前 section（与 PDF 同款"卡片中心最接近视口中心"算法）
  useEffect(() => {
    const root = scrollRootRef.current
    const container = containerRef.current
    if (!root || !container || status !== 'ready') return
    let ticking = false
    const update = () => {
      ticking = false
      const sections = Array.from(
        container.querySelectorAll<HTMLElement>('section.docx[data-page-index]')
      )
      if (sections.length === 0) return
      const rr = root.getBoundingClientRect()
      const targetY = rr.top + rr.height / 2
      let bestIdx = -1
      let bestDist = Number.POSITIVE_INFINITY
      let bestEl: HTMLElement | null = null
      for (const el of sections) {
        const r = el.getBoundingClientRect()
        if (r.bottom < rr.top - 50) continue
        if (r.top > rr.bottom + 50) break
        const mid = r.top + r.height / 2
        const d = Math.abs(mid - targetY)
        if (d < bestDist) {
          bestDist = d
          bestIdx = Number(el.dataset.pageIndex)
          bestEl = el
        }
      }
      if (bestIdx >= 0 && bestIdx !== activePage) {
        setActivePage(bestIdx)
        // section 文本作为内容传给 AI 笔记（截断到 4KB 避免大对象塞 prop）
        const text = bestEl?.textContent?.slice(0, 4096) ?? ''
        onPageChange?.(bestIdx, text || undefined)
      }
    }
    const onScroll = () => {
      if (ticking) return
      ticking = true
      requestAnimationFrame(update)
    }
    update()
    root.addEventListener('scroll', onScroll, { passive: true })
    return () => root.removeEventListener('scroll', onScroll)
  }, [status, activePage, onPageChange])

  return (
    <div
      ref={scrollRootRef}
      data-docx-scroll-root
      className="h-full overflow-y-auto bg-surface-2"
    >
      {status === 'loading' && (
        <div className="flex h-full items-center justify-center gap-2 text-sm text-text-3">
          <Loader2 className="h-4 w-4 animate-spin" />
          正在解析 Word 文档…
        </div>
      )}
      {status === 'error' && (
        <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
          <p className="text-sm font-medium text-error">DOCX 解析失败</p>
          <p className="text-xs text-text-3">{error}</p>
        </div>
      )}
      {/* docx-preview 把页面 CSS 注入到 styleRef；container 放实际内容。
          下面两个 div 始终挂在 DOM 上，loading/error 时只是空容器；
          status==='ready' 时内容已经被 renderAsync 注入。 */}
      <div ref={styleRef} aria-hidden />
      <div ref={containerRef} className="docx-render-root" />
      {/* 选区高亮 bubble menu：复用 PdfSelectionPopover（它对"含 data-page-index 的容器"
          归一化 rects，docx-preview 渲染出来的 <section class="docx"> 会被标 data-page-index，
          完全兼容）。点击颜色后走 useAnnotations.addPdfHighlight 入库，pageIndex 是 section
          序号。覆盖层渲染（DOM overlay 按归一化 rect 画色块）是后续工作，当前版本仅确保
          "选中文本 → popover → 入库"这条链路工作，解决"Word 无法使用 bubble menu"问题。 */}
      {onAddHighlight && status === 'ready' && (
        <PdfSelectionPopover
          scrollRootRef={scrollRootRef}
          onConfirm={onAddHighlight}
          onAIExplain={onAIExplain}
        />
      )}
    </div>
  )
}
