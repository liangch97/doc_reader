import { Children, isValidElement, memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import rehypeHighlight from 'rehype-highlight'
import rehypeRaw from 'rehype-raw'
import { Check, Copy } from 'lucide-react'
import { cn } from '@/lib/cn'
import { preprocessMarkdown } from './preprocessor'
import { InlineIcon } from './IconRegistry'
import { AsciiDiagram, isAsciiDiagram } from './AsciiDiagram'
import './markdown.css'
import 'katex/dist/katex.min.css'
import 'highlight.js/styles/github.css'
import 'heti/umd/heti.min.css'

export type MdTheme =
  | 'default'
  | 'github'
  | 'academic'
  | 'typora'
  | 'heti'
  | 'notion'
  | 'obsidian'
  | 'newspaper'
  | 'mono'
  | 'handwriting'
  | 'minimal'
  /** 内部主题：仅 Agent 学习面板使用，不在选择器里暴露 */
  | 'vibe'

export const MD_THEMES: { id: MdTheme; label: string; hint: string }[] = [
  { id: 'default', label: '默认', hint: '紧凑无衡线，适合速读' },
  { id: 'github', label: 'GitHub', hint: '类 GitHub Markdown 风格' },
  { id: 'academic', label: '学术', hint: '衡线两端对齐，论文体' },
  { id: 'typora', label: 'Typora', hint: '柔和留白，编辑器质感' },
  { id: 'heti', label: '汉仪', hint: '中文排版，标点压缩' },
  { id: 'notion', label: 'Notion', hint: '圆角块·彩色引用' },
  { id: 'obsidian', label: 'Obsidian', hint: 'Wiki 风 + Callout' },
  { id: 'newspaper', label: '报纸', hint: '双栏·大报题·首字下沉' },
  { id: 'mono', label: '终端', hint: '全等宽·暗底绿字' },
  { id: 'handwriting', label: '手帐', hint: '手写体·纸纹背景' },
  { id: 'minimal', label: '极简', hint: '无边框·大留白' },
]

interface Props {
  content: string
  theme?: MdTheme
  className?: string
  /** 启用代码高亮（默认 true）。文档极长时可关闭 */
  highlight?: boolean
}

// KaTeX strict-mode handler: silence the noisy unicodeTextInMathMode warnings
// (very common when AI-generated content puts Chinese inside `$...$`), but
// keep `warn` behavior for genuine LaTeX issues.
const KATEX_OPTIONS = {
  strict: (errCode: string): 'ignore' | 'warn' =>
    errCode === 'unicodeTextInMathMode' ? 'ignore' : 'warn',
}

/**
 * 通用 Markdown 渲染器。
 * - GFM 表格 / 任务列表 / 删除线
 * - KaTeX 数学公式（$...$, $$...$$）
 * - highlight.js 代码高亮
 * - 5 种排版主题
 */
function MarkdownViewImpl({ content, theme = 'default', className, highlight = true }: Props) {
  const processed = useMemo(() => preprocessMarkdown(content || ''), [content])
  const rootRef = useRef<HTMLDivElement>(null)
  const rehypePlugins = useMemo(
    () =>
      highlight
        ? [
            rehypeRaw,
            [rehypeKatex, KATEX_OPTIONS] as const,
            // detect:false —— 不强行自动检测语言。无 ``` 语言标识 / 仅含 ASCII art /
            // 框线字符（┌─┐│└┘ 等）的代码块保持纯文本，不会被误识别成某种语言
            // 而被 highlight.js 拆成一堆 hljs-... span，破坏 ASCII 图的列对齐。
            [rehypeHighlight, { detect: false, ignoreMissing: true }] as const,
          ]
        : [rehypeRaw, [rehypeKatex, KATEX_OPTIONS] as const],
    [highlight]
  )
  const components = useMemo<Components>(
    () => ({
      span: ({ node, className: spanClass, children, ...rest }) => {
        const dataIcon = (rest as Record<string, unknown>)['data-icon']
        if (typeof dataIcon === 'string' && dataIcon) {
          return <InlineIcon name={dataIcon} className={spanClass} />
        }
        void node
        return (
          <span className={spanClass} {...rest}>
            {children}
          </span>
        )
      },
      // 代码块处理：
      //   1. 检测是否是 ASCII 流程图 / 框线图 → AsciiDiagram 高级渲染
      //   2. 其他 → CodeBlockPre（带右上角复制按钮的普通代码块）
      // 行内 <code> 不受影响（react-markdown 把 inline code 直接渲成 <code>）。
      pre: ({ node, children, ...rest }) => {
        void node
        const text = extractText(children)
        const lang = extractLanguage(children)
        if (isAsciiDiagram(text, lang)) {
          return <AsciiDiagram code={text} language={lang} />
        }
        return <CodeBlockPre {...rest}>{children}</CodeBlockPre>
      },
    }),
    []
  )

  // Apply Heti CJK auto-spacing when the heti theme is active.
  useEffect(() => {
    if (theme !== 'heti') return
    const el = rootRef.current
    if (!el) return
    let cancelled = false
    let timer: number | undefined
    timer = window.setTimeout(() => {
      if (cancelled) return
      import('heti/js/heti-addon.js')
        .then((mod) => {
          if (cancelled) return
          const HetiCtor = (mod as { default?: new (root: HTMLElement) => { autoSpacing: () => void } }).default
          if (!HetiCtor) return
          try {
            const heti = new HetiCtor(el)
            heti.autoSpacing()
          } catch {
            /* ignore — heti gracefully no-ops on stale DOM */
          }
        })
        .catch(() => {
          /* dynamic import failed — fallback to plain styling */
        })
    }, 30)
    return () => {
      cancelled = true
      if (timer) window.clearTimeout(timer)
    }
  }, [theme, processed])

  return (
    <div
      ref={rootRef}
      className={cn('md-root', `md-theme-${theme}`, theme === 'heti' && 'heti', className)}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={rehypePlugins as never}
        components={components}
      >
        {processed}
      </ReactMarkdown>
    </div>
  )
}

export const MarkdownView = memo(MarkdownViewImpl)

// 递归提取任意 React 节点的纯文本。用于从 <pre> 子树（可能被 hljs
// 拆成嵌套 span）提出原始代码文本。
function extractText(node: ReactNode): string {
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (node == null || typeof node === 'boolean') return ''
  if (Array.isArray(node)) return node.map(extractText).join('')
  if (isValidElement(node)) {
    const props = node.props as { children?: ReactNode }
    return extractText(props.children)
  }
  return ''
}

// 从 <pre> 的子节点里找到 <code> 元素的 className 中 `language-xxx` 的 xxx。
// react-markdown 把 fenced 代码块的 language 存在 <code className="language-xxx"> 上。
function extractLanguage(node: ReactNode): string | undefined {
  if (isValidElement(node)) {
    const props = node.props as { className?: string; children?: ReactNode }
    if (typeof props.className === 'string') {
      const m = /\blanguage-([\w-]+)/.exec(props.className)
      if (m) return m[1]
    }
    // 偶尔 children 中还能堆一层 hljs span，递归下去也不会错
    const sub = extractLanguage(props.children)
    if (sub) return sub
  }
  if (Array.isArray(node)) {
    for (const c of node) {
      const r = extractLanguage(c)
      if (r) return r
    }
  }
  // 使用 Children helper 处理 React.Children iterable
  if (node && typeof node === 'object' && Symbol.iterator in (node as object)) {
    let found: string | undefined
    Children.forEach(node as ReactNode, (c) => {
      if (!found) {
        const r = extractLanguage(c)
        if (r) found = r
      }
    })
    if (found) return found
  }
  return undefined
}

/**
 * 代码块容器：右上角浮一个「复制」按钮。
 * 走原生 navigator.clipboard.writeText（Tauri / WebView 都支持）。
 */
function CodeBlockPre({
  children,
  ...rest
}: React.HTMLAttributes<HTMLPreElement> & { children?: React.ReactNode }) {
  const ref = useRef<HTMLPreElement>(null)
  const [copied, setCopied] = useState(false)
  const onCopy = async () => {
    const text = ref.current?.innerText ?? ''
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      try {
        const ta = document.createElement('textarea')
        ta.value = text
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        document.body.removeChild(ta)
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1500)
      } catch {
        /* ignore */
      }
    }
  }
  return (
    <pre ref={ref} {...rest} className={cn('md-code-pre group relative', rest.className)}>
      <button
        type="button"
        onClick={onCopy}
        aria-label={copied ? '已复制' : '复制代码'}
        title={copied ? '已复制' : '复制代码'}
        className="md-code-copy absolute right-2 top-2 z-10 flex h-7 w-7 items-center justify-center rounded border border-border-1 bg-bg/80 text-text-2 opacity-0 shadow-sm backdrop-blur transition-opacity hover:bg-bg hover:text-text-1 group-hover:opacity-100 focus-visible:opacity-100"
      >
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
      {children}
    </pre>
  )
}

/**
 * 主题作用域：
 *   - `notes`  影响 AI 笔记 / Notebook 条目 / Markdown 编辑器（默认）
 *   - `reader` 影响 EPUB / PDF 主阅读区（与"笔记样式"分开存储，避免在阅读器里改一下影响所有笔记）
 *
 * 为了向后兼容，无 scope 调用沿用旧的全局键，并在首次读取 `reader` 时回落到旧键。
 */
export type MdThemeScope = 'notes' | 'reader'

const LEGACY_KEY = 'doc-reader.md-theme'
const STORAGE_KEYS: Record<MdThemeScope, string> = {
  notes: 'doc-reader.md-theme', // 复用旧键，老用户无感
  reader: 'doc-reader.md-theme.reader',
}

export function loadMdTheme(scope: MdThemeScope = 'notes'): MdTheme {
  try {
    const key = STORAGE_KEYS[scope]
    const v = localStorage.getItem(key)
    if (v && MD_THEMES.some((t) => t.id === v)) return v as MdTheme
    // reader scope 第一次：回落到旧的全局键，让阅读器初始体验一致
    if (scope === 'reader') {
      const legacy = localStorage.getItem(LEGACY_KEY)
      if (legacy && MD_THEMES.some((t) => t.id === legacy)) return legacy as MdTheme
    }
  } catch {
    /* ignore */
  }
  return 'default'
}

export function saveMdTheme(t: MdTheme, scope: MdThemeScope = 'notes') {
  try {
    localStorage.setItem(STORAGE_KEYS[scope], t)
  } catch {
    /* ignore */
  }
}
