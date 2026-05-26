import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Search as SearchIcon, X, Loader2 } from 'lucide-react'
import { cn } from '@/lib/cn'
import {
  FOLIATE_SEARCH_PREFIX,
  type FoliateSearchSection,
  type FoliateViewElement,
} from '@/lib/foliate'
import type * as pdfjsLib from 'pdfjs-dist'

type PdfJsDoc = Awaited<ReturnType<typeof pdfjsLib.getDocument>['promise']>

/**
 * 全书搜索面板。
 *
 * 设计参考 readest：
 *  - 输入即查（300ms 防抖），不必按回车
 *  - 结果按章节折叠展示，excerpt 三段（pre / match / post）
 *  - 点击命中条 → `view.goTo(prefixedCFI)` 同时跳转 + 让 search annotation 立即可见
 *  - 卸载 / 清空查询 → `view.clearSearch()` 移除文档上所有命中标记
 *  - 不阻塞 view 其他事件（search 是 async generator，可中途 break）
 *
 * UI 风格沿用 ReaderSettingsPopover，左栏占位（折叠 TOC 时也可以独立打开）。
 */

interface Props {
  /** Foliate (EPUB 类) view。与 pdfDoc 二选一。 */
  view: FoliateViewElement | null
  /** PDF 场景下上报的 pdfjs 文档句柄。提供后走 PDF 搜索分支。 */
  pdfDoc?: PdfJsDoc | null
  /** PDF 搜索点击跳转回调，传 0-based pageIndex。 */
  onJumpPdfPage?: (pageIndex: number) => void
  open: boolean
  onClose: () => void
}

interface SectionResult {
  label: string
  subitems: Array<{
    cfi: string
    /** PDF 分支下记录当前项所在页 (0-based)。Foliate 分支不填。 */
    pageIndex?: number
    excerpt: { pre: string; match: string; post: string }
  }>
}

const DEBOUNCE_MS = 300

export function SearchPanel({ view, pdfDoc, onJumpPdfPage, open, onClose }: Props) {
  const isPdfMode = !!pdfDoc && !view
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SectionResult[]>([])
  const [searching, setSearching] = useState(false)
  const [matchCase, setMatchCase] = useState(false)
  const [wholeWord, setWholeWord] = useState(false)
  const [activeCfi, setActiveCfi] = useState<string | null>(null)

  const inputRef = useRef<HTMLInputElement>(null)
  /**
   * 搜索运行 token：每次新查询自增。在 async iter 循环里检查 token 是否仍是当前值，
   * 否则提前 break，丢弃旧查询的剩余结果。
   */
  const tokenRef = useRef(0)

  // 打开时聚焦输入框
  useEffect(() => {
    if (open) {
      // 等 DOM 渲染完
      const t = setTimeout(() => inputRef.current?.focus(), 0)
      return () => clearTimeout(t)
    }
  }, [open])

  // Esc 关闭
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  // 关闭面板时清除 view 上的搜索高亮（PDF 分支无高亮需清）
  useEffect(() => {
    if (!open) {
      if (view) {
        try {
          view.clearSearch()
        } catch {
          /* view 可能已卸载 */
        }
      }
      setResults([])
      setActiveCfi(null)
    }
  }, [open, view])

  const totalHits = useMemo(
    () => results.reduce((sum, s) => sum + s.subitems.length, 0),
    [results]
  )

  const runSearch = useCallback(
    async (q: string) => {
      // PDF 分支优先：未提供 view，传了 pdfDoc 就走 pdfjs getTextContent
      if (isPdfMode && pdfDoc) {
        const myToken = ++tokenRef.current
        if (!q.trim()) {
          setResults([])
          setSearching(false)
          return
        }
        setSearching(true)
        setResults([])
        const needle = matchCase ? q : q.toLowerCase()
        const re = wholeWord
          ? new RegExp(
              `(?:^|\\b)${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\b|$)`,
              matchCase ? 'g' : 'gi'
            )
          : null
        const collected: SectionResult[] = []
        // 按批刷新：每扫 8 页 yield 一次，体现渐进式结果
        const BATCH = 8
        try {
          for (let i = 1; i <= pdfDoc.numPages; i++) {
            if (myToken !== tokenRef.current) break
            const page = await pdfDoc.getPage(i)
            const tc = await page.getTextContent()
            // 拼接页文本：items[].str 以空格连接
            const fullText = tc.items.map((it) => (it as { str?: string }).str ?? '').join(' ')
            const haystack = matchCase ? fullText : fullText.toLowerCase()
            const matches: SectionResult['subitems'] = []
            if (re) {
              re.lastIndex = 0
              let m: RegExpExecArray | null
              while ((m = re.exec(fullText)) !== null) {
                const idx = m.index
                matches.push({
                  cfi: `pdfpage:${i - 1}:${idx}`,
                  pageIndex: i - 1,
                  excerpt: {
                    pre: fullText.slice(Math.max(0, idx - 30), idx),
                    match: m[0],
                    post: fullText.slice(idx + m[0].length, idx + m[0].length + 40),
                  },
                })
                if (m[0].length === 0) re.lastIndex++ // 防死循环
                if (matches.length >= 50) break // 单页限 50 条
              }
            } else {
              let from = 0
              while (from < haystack.length) {
                const idx = haystack.indexOf(needle, from)
                if (idx === -1) break
                matches.push({
                  cfi: `pdfpage:${i - 1}:${idx}`,
                  pageIndex: i - 1,
                  excerpt: {
                    pre: fullText.slice(Math.max(0, idx - 30), idx),
                    match: fullText.slice(idx, idx + needle.length),
                    post: fullText.slice(idx + needle.length, idx + needle.length + 40),
                  },
                })
                from = idx + Math.max(1, needle.length)
                if (matches.length >= 50) break
              }
            }
            if (matches.length > 0) {
              collected.push({ label: `第 ${i} 页`, subitems: matches })
            }
            if (i % BATCH === 0 || i === pdfDoc.numPages) {
              if (myToken !== tokenRef.current) break
              setResults([...collected])
            }
          }
        } catch (e) {
          console.warn('[SearchPanel] pdf search error', e)
        } finally {
          if (myToken === tokenRef.current) setSearching(false)
        }
        return
      }
      if (!view) return
      // 取消旧任务
      const myToken = ++tokenRef.current
      try {
        view.clearSearch()
      } catch {
        /* 忽略 */
      }
      if (!q.trim()) {
        setResults([])
        setSearching(false)
        return
      }
      setSearching(true)
      setResults([])
      const collected: SectionResult[] = []
      try {
        const iter = view.search({
          query: q,
          matchCase,
          matchWholeWords: wholeWord,
        })
        for await (const item of iter) {
          if (myToken !== tokenRef.current) break // 被新查询替代
          if (item === 'done') break
          const sec = item as FoliateSearchSection
          if (!sec.subitems || sec.subitems.length === 0) continue
          collected.push({
            label: sec.label || '（未命名章节）',
            subitems: sec.subitems.map((s) => ({
              cfi: s.cfi,
              excerpt: s.excerpt,
            })),
          })
          // 渐进展示：每章 yield 完就刷新
          setResults([...collected])
        }
      } catch (e) {
        console.warn('[SearchPanel] search error', e)
      } finally {
        if (myToken === tokenRef.current) setSearching(false)
      }
    },
    [view, pdfDoc, isPdfMode, matchCase, wholeWord]
  )

  // 输入防抖
  useEffect(() => {
    if (!open) return
    const h = window.setTimeout(() => {
      runSearch(query)
    }, DEBOUNCE_MS)
    return () => window.clearTimeout(h)
  }, [query, open, matchCase, wholeWord, runSearch])

  const onJump = useCallback(
    (cfi: string, pageIndex?: number) => {
      if (isPdfMode) {
        if (typeof pageIndex === 'number') {
          onJumpPdfPage?.(pageIndex)
          setActiveCfi(cfi)
        }
        return
      }
      if (!view) return
      const target = cfi.startsWith(FOLIATE_SEARCH_PREFIX) ? cfi : FOLIATE_SEARCH_PREFIX + cfi
      view.goTo(target).catch((err) => console.warn('[SearchPanel] goTo failed', err))
      setActiveCfi(cfi)
    },
    [view, isPdfMode, onJumpPdfPage]
  )

  if (!open) return null

  return (
    <div className="absolute inset-y-0 left-0 z-40 flex h-full w-72 flex-col border-r border-border-1 bg-bg shadow-2xl">
      <div className="flex shrink-0 items-center gap-2 border-b border-border-1 px-3 py-2">
        <SearchIcon className="h-4 w-4 text-text-3" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="全书搜索…"
          className="min-w-0 flex-1 bg-transparent text-sm text-text-1 outline-none placeholder:text-text-3"
        />
        {searching && <Loader2 className="h-3.5 w-3.5 animate-spin text-text-3" />}
        <button
          type="button"
          onClick={onClose}
          title="关闭搜索"
          className="flex h-6 w-6 items-center justify-center rounded text-text-3 hover:bg-surface-2 hover:text-text-1"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="flex shrink-0 items-center gap-1 border-b border-border-1 px-3 py-1.5">
        <FilterChip active={matchCase} onClick={() => setMatchCase((v) => !v)} title="区分大小写">
          Aa
        </FilterChip>
        <FilterChip active={wholeWord} onClick={() => setWholeWord((v) => !v)} title="全字匹配">
          W
        </FilterChip>
        <span className="ml-auto text-[10px] text-text-3">
          {query.trim() ? (
            searching ? '搜索中…' : totalHits > 0 ? `${totalHits} 条命中` : '无结果'
          ) : (
            '输入即搜'
          )}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {results.map((sec, si) => (
          <div key={si} className="border-b border-border-1/60 last:border-0">
            <div className="sticky top-0 z-10 bg-surface-1/95 px-3 py-1.5 text-[11px] font-medium text-text-2 backdrop-blur">
              {sec.label}
              <span className="ml-1.5 text-text-3">·{sec.subitems.length}</span>
            </div>
            {sec.subitems.map((it) => (
              <button
                key={it.cfi}
                type="button"
                onClick={() => onJump(it.cfi, it.pageIndex)}
                className={cn(
                  'block w-full px-3 py-2 text-left text-xs leading-relaxed transition-colors',
                  'hover:bg-surface-2',
                  activeCfi === it.cfi && 'bg-accent/10 ring-1 ring-inset ring-accent/40'
                )}
              >
                <span className="text-text-3">{it.excerpt.pre}</span>
                <mark className="bg-accent/30 text-text-1">{it.excerpt.match}</mark>
                <span className="text-text-3">{it.excerpt.post}</span>
              </button>
            ))}
          </div>
        ))}
        {!searching && query.trim() && totalHits === 0 && (
          <div className="flex h-32 items-center justify-center text-xs text-text-3">
            没有匹配「{query}」
          </div>
        )}
        {!query.trim() && (
          <div className="flex h-32 items-center justify-center px-6 text-center text-[11px] text-text-3">
            输入关键词以搜索整本书；命中文本会在内容上标记。
          </div>
        )}
      </div>
    </div>
  )
}

function FilterChip({
  children,
  active,
  onClick,
  title,
}: {
  children: React.ReactNode
  active: boolean
  onClick: () => void
  title: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        'flex h-5 items-center justify-center rounded border px-1.5 text-[10px] font-medium transition-colors',
        active
          ? 'border-accent bg-accent/15 text-text-1'
          : 'border-border-1 bg-surface-2 text-text-3 hover:text-text-2'
      )}
    >
      {children}
    </button>
  )
}
