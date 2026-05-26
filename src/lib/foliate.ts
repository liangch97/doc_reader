/**
 * foliate-js 加载器 — 将 vendor/foliate-js/view.js 当作 ESM 动态加载，
 * 并定义 `<foliate-view>` 自定义元素的最小 TypeScript 类型。
 *
 * 注意：foliate-js 是 vanilla ES Module（无 npm 包），
 * 通过动态 import 直接加载 /vendor/foliate-js/view.js
 * 让浏览器解析它内部的相对 import；Vite 不会处理 public/ 下的文件。
 */

let loadingPromise: Promise<void> | null = null

export interface FoliateRelocateDetail {
  /** 当前可见区域 Range */
  range?: Range
  /**
   * 当前 section 在 spine 中的索引。
   *
   * readest fork 的 view.js 不再把 paginator 给的 `index` 直接展开到对外
   * `relocate` detail，但 `section.current` 与之等价。`FoliateView`
   * 在派发前会用 `section.current` 回填本字段以兼容旧调用方；当书籍没有
   * spine 概念（比如纯文本流式）时仍可能为 undefined，故改为 optional。
   */
  index?: number
  /** 阅读进度 (0..1) 在当前 section 内 */
  fraction: number
  /** CFI 字符串（来自 view.getCFI(index, range)） */
  cfi?: string
  tocItem?: { label: string; href: string } | null
  /** 由 SectionProgress 计算的章节进度（来自 vendor/foliate-js/progress.js） */
  section?: { current: number; total: number }
  /**
   * 由 SectionProgress 计算的「位置 / 页码」估算。
   * - current：当前阅读位置序号（0 起）
   * - total：全书估算总位置数
   * - 这是 foliate "Location" 概念，在固定字号下基本等同于"伪页码"
   */
  location?: { current: number; next?: number; total: number }
  /** 估算的剩余阅读时间（分钟，按 sizePerTimeUnit 校准） */
  time?: { section: number; total: number }
  /** 来自 epub `page-list` 的实际页码（如有） */
  pageItem?: { label: string; href: string } | null
}

export interface FoliateLoadDetail {
  doc: Document
  index: number
}

/** 最小 TOC 项类型 */
export interface FoliateTocItem {
  label: string
  href: string
  subitems?: FoliateTocItem[] | null
}

/** foliate-view 内部用来标记"搜索结果"型 annotation 的 CFI 前缀 */
export const FOLIATE_SEARCH_PREFIX = 'foliate-search:'

/** 搜索单条命中（属于某 section） */
export interface FoliateSearchHit {
  cfi: string
  excerpt: { pre: string; match: string; post: string }
}

/** 搜索某 section 的聚合结果（view.search 每章 yield 一次） */
export interface FoliateSearchSection {
  /** 章节标签（来自 TOC，可能为空字符串） */
  label: string
  /** 该章节内的所有命中（已含 SEARCH_PREFIX） */
  subitems: Array<{ cfi: string; excerpt: FoliateSearchHit['excerpt'] }>
  /** spine index（来自 view.search 内部 yield 的 progress） */
  progress?: number
}

/** view.search 的可选项（与 foliate-js searchMatcher 保持一致） */
export interface FoliateSearchOptions {
  query: string
  /** 仅限指定 section；不传则全书搜索 */
  index?: number
  matchCase?: boolean
  matchDiacritics?: boolean
  matchWholeWords?: boolean
  acceptNode?: (node: Node) => number
  /** 自定义高亮 draw（默认 Overlayer.outline） */
  draw?: unknown
  drawOptions?: Record<string, unknown>
  defaultLocale?: string
}

/** foliate-view 的运行时元素接口（部分） */
export interface FoliateViewElement extends HTMLElement {
  open(file: File | Blob | string): Promise<void>
  goTo(target: string | number | { index: number; anchor?: unknown }): Promise<void>
  next(): Promise<void>
  prev(): Promise<void>
  goLeft(): void
  goRight(): void
  addAnnotation(annotation: FoliateAnnotation, remove?: boolean): Promise<unknown>
  deleteAnnotation(annotation: FoliateAnnotation): Promise<unknown>
  showAnnotation(annotation: FoliateAnnotation): Promise<unknown>
  getCFI(index: number, range?: Range): string
  /**
   * 全书或单章搜索。
   *  - 返回 async generator，每章 yield 一次 `{ label, subitems }`，全部完成后 yield 'done'。
   *  - 命中文本会被 view 自动加为 search-prefix annotation（在文档上显示 outline / 自定义 draw）。
   *  - 跳到某条命中：`view.goTo(item.cfi)`（item.cfi 已含 'foliate-search:' 前缀）。
   *  - 调用 `view.clearSearch()` 清除高亮。
   */
  search(opts: FoliateSearchOptions): AsyncGenerator<FoliateSearchSection | 'done'>
  clearSearch(): void
  lastLocation?: {
    cfi?: string
    fraction?: number
    tocItem?: { label: string; href: string } | null
    range?: Range
  }
  renderer?: {
    setStyles?: (css: string) => void
    next?: () => void
    prev?: () => void
    getContents?: () => Array<{ doc: Document; index: number; overlayer?: unknown }>
  }
  book?: {
    metadata?: Record<string, unknown>
    toc?: FoliateTocItem[]
    dir?: string
  }
}

export interface FoliateAnnotation {
  value: string // CFI
  color?: string
  note?: string
  /** 自定义字段：高亮 / 划线 / 行内笔记 */
  kind?: 'highlight' | 'underline' | 'note' | 'strikethrough'
}

export interface FoliateDrawAnnotationDetail {
  draw: (func: unknown, opts?: Record<string, unknown>) => void
  annotation: FoliateAnnotation
  doc: Document
  range: Range
}

export interface FoliateShowAnnotationDetail {
  value: string
  index: number
  range: Range
}

/** Overlayer 类（作为绘图函数容器） */
export interface OverlayerStatic {
  highlight: unknown
  underline: unknown
  strikethrough: unknown
  squiggly: unknown
}

let overlayerCache: OverlayerStatic | null = null
export async function loadOverlayer(): Promise<OverlayerStatic> {
  if (overlayerCache) return overlayerCache
  const url = '/vendor/foliate-js/overlayer.js'
  const mod = (await dynImport(url)) as { Overlayer: OverlayerStatic }
  overlayerCache = mod.Overlayer
  return overlayerCache
}

/** FootnoteHandler（vendor/foliate-js/footnotes.js）类型 */
export interface FootnoteHandlerInstance extends EventTarget {
  detectFootnotes: boolean
  /**
   * 处理一次 link 事件。返回 Promise<void> 表示完成；若不是脚注 a 则返回 undefined。
   * - 内部会在 e 上调 preventDefault → view 不会跳转
   * - 之后会 dispatch 'render' / 'before-render'
   */
  handle(book: unknown, e: CustomEvent): Promise<void> | undefined
}

export interface FootnoteRenderDetail {
  /** detached <foliate-view> 元素，已渲染目标脚注片段 */
  view: HTMLElement
  href: string
  type?: string | null
  /** epub 内 `aside epub:type=footnote` 这种「页内本就隐藏的脚注」标记 */
  hidden?: boolean
  /** 原 anchor 元素（在 detached doc 内） */
  target?: Element | null
}

let footnoteCtorCache: (new () => FootnoteHandlerInstance) | null = null
export async function loadFootnoteHandler(): Promise<new () => FootnoteHandlerInstance> {
  if (footnoteCtorCache) return footnoteCtorCache
  const url = '/vendor/foliate-js/footnotes.js'
  const mod = (await dynImport(url)) as { FootnoteHandler: new () => FootnoteHandlerInstance }
  footnoteCtorCache = mod.FootnoteHandler
  return footnoteCtorCache
}

/**
 * 高亮颜色（5 选 1）—— 浅色亮调，配合 `drawHighlightHalfHeight` / PdfAnnotationOverlay
 * 的 `opacity 0.55 + mix-blend-mode: multiply` 在白底上呈现 marker pen 视觉。
 *
 * 调色史：
 *   - v1: rgba(.., .45) 实际可见 alpha ≈ .135，PDF 看不到
 *   - v2: 饱和实色（#FACC15 等），multiply 后变深，用户反馈"黄色饱和度太高"
 *   - v3（当前）: Tailwind *-300 / *-200 浅色版，multiply 后呈柔和的 marker pen 色
 */
export const HIGHLIGHT_COLORS = {
  yellow: '#FDE047', // amber-300
  green: '#86EFAC', // green-300
  blue: '#93C5FD', // blue-300
  pink: '#FBCFE8', // pink-200
  purple: '#D8B4FE', // purple-300
} as const
export type HighlightColorKey = keyof typeof HIGHLIGHT_COLORS

/**
 * 自定义高亮绘制：半高 + 圆角，覆盖文字下半部分（marker pen 风格）。
 *
 * 替代 vendor 的 `Overlayer.highlight`：上游默认全行高 + 透明度 0.3 的方块，
 * 视觉上太淡且没有"标记笔"质感。这里：
 *  - y = top + h * 0.40，h = h * 0.60  → 覆盖下半部分（避开字母 ascender 区）
 *  - rx = 2                            → 圆角
 *  - opacity = 0.55                    → 既能透出文字，又比之前明显得多
 *  - mix-blend-mode: multiply          → 在白底上颜色更鲜，重叠区域自然加深
 *
 * 函数签名遵循 foliate Overlayer 的 draw 协议：
 *   `(rects: DOMRectList, opts: { color }) => SVGElement`
 */
const SVG_NS = 'http://www.w3.org/2000/svg'
export function drawHighlightHalfHeight(
  rects: DOMRectList | DOMRect[],
  opts: { color?: string } = {}
): SVGGElement {
  const color = opts.color ?? HIGHLIGHT_COLORS.yellow
  const g = document.createElementNS(SVG_NS, 'g')
  g.setAttribute('fill', color)
  g.style.opacity = 'var(--overlayer-highlight-opacity, .55)'
  g.style.mixBlendMode = 'var(--overlayer-highlight-blend-mode, multiply)'
  for (const r of rects) {
    const rect = document.createElementNS(SVG_NS, 'rect')
    const h = r.height * 0.6
    rect.setAttribute('x', String(r.left))
    rect.setAttribute('y', String(r.top + r.height * 0.4))
    rect.setAttribute('width', String(r.width))
    rect.setAttribute('height', String(h))
    rect.setAttribute('rx', '2')
    rect.setAttribute('ry', '2')
    g.append(rect)
  }
  return g
}

/**
 * 动态加载 foliate-js view.js 并注册 `<foliate-view>` 自定义元素。
 * 多次调用幂等，仅首次会真正发请求。
 */
export function loadFoliate(): Promise<void> {
  if (loadingPromise) return loadingPromise
  loadingPromise = (async () => {
    if (typeof window === 'undefined') return
    if (customElements.get('foliate-view')) return
    // /vendor/foliate-js/view.js 由 Vite public/ 直接服务
    // 必须用 new Function 包裹 import，否则 Vite dev 会拦截 /public/ 路径
    const url = '/vendor/foliate-js/view.js'
    await dynImport(url)
    // view.js 在文件末尾会 customElements.define('foliate-view', View)
  })()
  return loadingPromise
}

/**
 * 通过 new Function 构造 native import，绕过 Vite dev 对 /public/ 资源的拦截。
 * 浏览器原生执行，仍然走 dev-server 静态文件路径。
 */
const dynImport: (url: string) => Promise<unknown> = new Function(
  'u',
  'return import(u)'
) as (u: string) => Promise<unknown>

/**
 * 把 base64 字符串转为 Blob —— 用于把 Tauri 返回的二进制喂给 foliate-view.open()
 */
export function base64ToBlob(b64: string, mime = 'application/octet-stream'): Blob {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type: mime })
}

/**
 * 用 mobi.js 解析 MOBI/AZW3 文件，返回封面 Blob（不存在 / 解析失败 → null）。
 *
 * 后端没有轻量 MOBI 解析库（PalmDB + LZ77 + EXTH），用 foliate-js 在前端做。
 * 调用点：`ImportDialog.handleFiles` 在导入完成后异步调用，失败不阻塞主流程。
 */
export async function extractMobiCover(file: File): Promise<Blob | null> {
  try {
    const mobiMod = (await dynImport('/vendor/foliate-js/mobi.js')) as {
      isMOBI: (f: File) => Promise<boolean>
      MOBI: new (opts: { unzlib: (data: Uint8Array) => Uint8Array }) => {
        open: (f: File) => Promise<{ getCover?: () => Promise<Blob | null> }>
      }
    }
    if (!(await mobiMod.isMOBI(file))) return null
    const fflate = (await dynImport('/vendor/foliate-js/vendor/fflate.js')) as {
      unzlibSync: (data: Uint8Array) => Uint8Array
    }
    const book = await new mobiMod.MOBI({ unzlib: fflate.unzlibSync }).open(file)
    if (!book.getCover) return null
    return await book.getCover()
  } catch (e) {
    console.warn('[extractMobiCover] failed', e)
    return null
  }
}

/** 根据 filename 猜测 MIME（仅用于 Blob 标记） */
export function mimeFromFilename(filename: string): string {
  const ext = filename.toLowerCase().split('.').pop() ?? ''
  const map: Record<string, string> = {
    epub: 'application/epub+zip',
    mobi: 'application/x-mobipocket-ebook',
    azw3: 'application/vnd.amazon.ebook',
    cbz: 'application/vnd.comicbook+zip',
    pdf: 'application/pdf',
    fb2: 'application/x-fictionbook+xml',
    txt: 'text/plain',
    html: 'text/html',
    htm: 'text/html',
  }
  return map[ext] ?? 'application/octet-stream'
}
