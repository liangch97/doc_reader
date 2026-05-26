import { useCallback, useEffect, useRef, useState } from 'react'
import { annotationsApi, bookmarksApi } from '@/lib/api'
import type {
  FoliateDrawAnnotationDetail,
  FoliateViewElement,
  OverlayerStatic,
} from '@/lib/foliate'
import { HIGHLIGHT_COLORS, drawHighlightHalfHeight } from '@/lib/foliate'
import type { Annotation, Bookmark, AnnotationKind, PdfNormRect } from '@/types/annotation'

type ViewSnapshot = { view: FoliateViewElement; overlayer: OverlayerStatic } | null

/**
 * 标注 + 书签数据钩子。
 * - 进入时拉取列表
 * - view ready 时把已存在的 annotation 喂给 foliate
 * - 暴露 add/remove 接口给外部按钮
 */
export function useAnnotations(resourceId: string) {
  const [annotations, setAnnotations] = useState<Annotation[]>([])
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([])
  const viewRef = useRef<ViewSnapshot>(null)
  /**
   * 当前 spine / page 索引（来自 relocate 事件）。
   *
   * 为什么需要保存：foliate-js 的 fixed-layout 渲染器（PDF）在 getContents()
   * 里返回的对象 **没有** `index` 字段（参见 vendor/foliate-js/fixed-layout.js
   * `getContents()` 实现）。直接调 `view.getCFI(undefined, range)` 会抛
   * `Cannot read properties of undefined (reading 'cfi')`，结果是 PDF 区无法高亮。
   *
   * 同时书签也需要这个索引作为 fallback —— 当 cfi 解析失败时，可以靠
   * `view.goTo(pageIndex)` 直接跳到第 N 页。
   */
  const currentIndexRef = useRef<number>(0)
  const setCurrentIndex = useCallback((idx: number) => {
    if (Number.isFinite(idx)) currentIndexRef.current = idx
  }, [])

  const reload = useCallback(async () => {
    try {
      const [an, bm] = await Promise.all([
        annotationsApi.list(resourceId),
        bookmarksApi.list(resourceId),
      ])
      setAnnotations(an)
      setBookmarks(bm)
    } catch (e) {
      console.warn('useAnnotations reload', e)
    }
  }, [resourceId])

  useEffect(() => {
    reload()
  }, [reload])

  /** 当 FoliateView ready 后调用 */
  const bindView = useCallback((view: FoliateViewElement, overlayer: OverlayerStatic) => {
    viewRef.current = { view, overlayer }
    // 把已存在的标注全部 addAnnotation
    annotations.forEach((a) => {
      if (!a.cfi_start) return
      view
        .addAnnotation({
          value: a.cfi_start,
          color: HIGHLIGHT_COLORS[(a.color as keyof typeof HIGHLIGHT_COLORS) ?? 'yellow'] ?? a.color,
          kind: (a.kind as AnnotationKind) ?? 'highlight',
        })
        .catch(console.warn)
    })
  }, [annotations])

  /** draw-annotation 事件回调：根据 kind 选择绘制函数 */
  const onDraw = useCallback(
    (detail: FoliateDrawAnnotationDetail, overlayer: OverlayerStatic) => {
      const kind = detail.annotation.kind ?? 'highlight'
      const color = detail.annotation.color ?? HIGHLIGHT_COLORS.yellow
      // highlight 走我们自己的 draw（半高 + 圆角 + 高饱和），
      // underline / strikethrough 仍用 vendor 默认形状。
      let fn: unknown = drawHighlightHalfHeight
      if (kind === 'underline') fn = overlayer.underline
      else if (kind === 'strikethrough') fn = overlayer.strikethrough
      detail.draw(fn, { color })
    },
    []
  )

  /** 添加高亮 / 划线 / 笔记：取当前选区 */
  const addFromSelection = useCallback(
    async (
      kind: AnnotationKind,
      colorKey: keyof typeof HIGHLIGHT_COLORS = 'yellow',
      noteContent?: string
    ) => {
      const snap = viewRef.current
      if (!snap) return null
      const { view } = snap
      const contents = view.renderer?.getContents?.() ?? []
      let cfi: string | null = null
      let selectedText = ''
      for (const c of contents) {
        const sel = c.doc.defaultView?.getSelection()
        if (sel && sel.rangeCount > 0 && !sel.isCollapsed) {
          const range = sel.getRangeAt(0)
          // PDF (fixed-layout) 的 getContents 不会返回 `index`——退回到
          // relocate 事件里记下的 currentIndexRef，以免抹黑 getCFI。
          const idx = typeof c.index === 'number' ? c.index : currentIndexRef.current
          try {
            cfi = view.getCFI(idx, range)
          } catch (err) {
            console.warn('[useAnnotations] getCFI failed', { idx, err })
          }
          selectedText = sel.toString()
          // 添加完清掉选区
          sel.removeAllRanges()
          break
        }
      }
      if (!cfi) {
        console.warn('没有选中文本（或 getCFI 失败）')
        return null
      }
      const annotationId = await annotationsApi.create({
        resourceId,
        kind,
        color: colorKey,
        cfiStart: cfi,
        selectedText,
        noteContent,
      })
      // 绘制
      view.addAnnotation({
        value: cfi,
        color: HIGHLIGHT_COLORS[colorKey],
        kind,
      })
      reload()
      return annotationId
    },
    [resourceId, reload]
  )

  /**
   * 添加 PDF 批注：foliate 路径用不上（没 cfi），直接用 pageIndex + 归一化 rects。
   * 调用点：`PdfPageCanvas` 在文字选中后组装 rects 和 selectedText。
   */
  const addPdfHighlight = useCallback(
    async (args: {
      pageIndex: number
      rects: PdfNormRect[]
      selectedText: string
      color?: keyof typeof HIGHLIGHT_COLORS
      noteContent?: string
      kind?: AnnotationKind
    }) => {
      const color = args.color ?? 'yellow'
      const kind = args.kind ?? 'highlight'
      await annotationsApi.create({
        resourceId,
        kind,
        color,
        pageIndex: args.pageIndex,
        selectedText: args.selectedText,
        noteContent: args.noteContent,
        pdfRects: JSON.stringify(args.rects),
      })
      reload()
    },
    [resourceId, reload]
  )

  /** 删除标注 */
  const removeAnnotation = useCallback(
    async (a: Annotation) => {
      await annotationsApi.remove(a.annotation_id)
      const snap = viewRef.current
      if (snap && a.cfi_start) {
        snap.view
          .deleteAnnotation({ value: a.cfi_start, kind: a.kind as AnnotationKind })
          .catch(console.warn)
      }
      reload()
    },
    [reload]
  )

  /** 跳到标注 */
  const showAnnotation = useCallback((a: Annotation) => {
    const snap = viewRef.current
    if (!snap || !a.cfi_start) return
    snap.view.showAnnotation({ value: a.cfi_start }).catch(console.warn)
  }, [])

  /** 添加书签：取当前 lastLocation.cfi + 当前 page index */
  const addBookmark = useCallback(
    async (label?: string) => {
      const snap = viewRef.current
      if (!snap) return
      const cfi = snap.view.lastLocation?.cfi ?? ''
      // 为 PDF / fixed-layout 场景提供 page_index fallback：
      // 部分 PDF 的 cfi 可能是 fake-cfi，后期 goTo 解析不稳定。
      const pageIndex = currentIndexRef.current
      const tocLabel =
        label || snap.view.lastLocation?.tocItem?.label || `${new Date().toLocaleString()}`
      await bookmarksApi.create({
        resourceId,
        cfi,
        pageIndex,
        label: tocLabel,
      })
      reload()
    },
    [resourceId, reload]
  )

  const removeBookmark = useCallback(
    async (b: Bookmark) => {
      await bookmarksApi.remove(b.bookmark_id)
      reload()
    },
    [reload]
  )

  const goToBookmark = useCallback(async (b: Bookmark) => {
    const snap = viewRef.current
    if (!snap) return
    // 1) 先试 cfi（EPUB / 能解析的 PDF cfi）
    if (b.cfi) {
      try {
        await snap.view.goTo(b.cfi)
        return
      } catch (e) {
        console.warn('[useAnnotations] goTo(cfi) failed, fallback to page_index', e)
      }
    }
    // 2) 回退 page_index：foliate-js 的 goTo 接受数字作为 section/page index
    if (typeof b.page_index === 'number' && b.page_index >= 0) {
      try {
        await snap.view.goTo(b.page_index)
        return
      } catch (e) {
        console.error('[useAnnotations] goTo(page_index) failed', e)
      }
    }
    console.warn('[useAnnotations] 书签无有效 cfi / page_index，无法跳转', b)
  }, [])

  return {
    annotations,
    bookmarks,
    bindView,
    onDraw,
    addFromSelection,
    addPdfHighlight,
    removeAnnotation,
    showAnnotation,
    addBookmark,
    removeBookmark,
    goToBookmark,
    reload,
    setCurrentIndex,
  }
}
