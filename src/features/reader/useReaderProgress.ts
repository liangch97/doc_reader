import { useCallback, useEffect, useRef, useState } from 'react'
import { progressApi } from '@/lib/api'
import type { FoliateRelocateDetail } from '@/lib/foliate'
import type { ReadingProgress } from '@/types/annotation'

interface ProgressState {
  cfi?: string
  pageIndex?: number
  percent?: number
}

/**
 * 阅读进度持久化 + 续读初始位置加载。
 *
 * 写：
 *  - EPUB/MOBI 路径调 `onRelocate(detail)`（绑给 FoliateView.onRelocate）
 *  - PDF 路径调 `onPdfPageChange(pageIndex, totalPages)`（绑给 PdfPptxAdapter.onPageChange）
 *  - 两条路径共用同一 debounce 2s 的 upsert 逻辑
 *  - 卸载/切书时立即 flush（防止用户没等 2s 就关掉书）
 *
 * 读：
 *  - 挂钩 mount 时一次 progressApi.get(resourceId)，结果暴露在 `initialProgress`
 *  - ReaderShell 把 initialProgress 透传给 FoliateView / PdfPptxAdapter，
 *    在它们 ready 时跳到上次位置（cfi for foliate / page_index for pdf）
 */
export function useReaderProgress(resourceId: string) {
  const timerRef = useRef<number | null>(null)
  const latestRef = useRef<ProgressState | null>(null)
  const startTimeRef = useRef<number>(Date.now())
  const [initialProgress, setInitialProgress] = useState<ReadingProgress | null>(null)
  const [initialLoaded, setInitialLoaded] = useState(false)

  // 续读：mount 时拉一次进度，ReaderShell 用它做"打开后跳转"
  useEffect(() => {
    let cancelled = false
    setInitialLoaded(false)
    progressApi
      .get(resourceId)
      .then((p) => {
        if (cancelled) return
        setInitialProgress(p ?? null)
        setInitialLoaded(true)
      })
      .catch(() => {
        if (!cancelled) setInitialLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [resourceId])

  const flush = useCallback(() => {
    if (timerRef.current) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
    const last = latestRef.current
    if (!last) return
    const seconds = Math.max(1, Math.round((Date.now() - startTimeRef.current) / 1000))
    startTimeRef.current = Date.now()
    progressApi
      .upsert({
        resourceId,
        cfi: last.cfi,
        pageIndex: last.pageIndex,
        percent: last.percent,
        addSeconds: seconds,
      })
      .catch(console.warn)
  }, [resourceId])

  useEffect(() => {
    startTimeRef.current = Date.now()
    return () => {
      // 卸载时立即落盘
      flush()
    }
  }, [resourceId, flush])

  const scheduleSave = useCallback(() => {
    if (timerRef.current) window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(flush, 2000)
  }, [flush])

  const onRelocate = useCallback(
    (detail: FoliateRelocateDetail) => {
      latestRef.current = {
        cfi: detail.cfi,
        pageIndex:
          typeof detail.index === 'number' ? detail.index : latestRef.current?.pageIndex,
        percent: typeof detail.fraction === 'number' ? detail.fraction : undefined,
      }
      scheduleSave()
    },
    [scheduleSave]
  )

  /** PDF 视图调用：当前可见页变化时记录 page_index + percent。 */
  const onPdfPageChange = useCallback(
    (pageIndex: number, totalPages: number) => {
      latestRef.current = {
        // PDF 没有 cfi，保留之前的（通常是空）
        cfi: latestRef.current?.cfi,
        pageIndex,
        percent: totalPages > 0 ? (pageIndex + 1) / totalPages : undefined,
      }
      scheduleSave()
    },
    [scheduleSave]
  )

  return { onRelocate, onPdfPageChange, initialProgress, initialLoaded }
}
