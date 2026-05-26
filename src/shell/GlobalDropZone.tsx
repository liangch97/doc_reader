import { useEffect, useRef, useState } from 'react'
import { UploadCloud, Loader2, X } from 'lucide-react'
import { importFiles } from '@/lib/fileImport'

/**
 * 全局拖拽文件导入组件。
 *
 * 背景：
 *   - Tauri 2 的 `dragDropEnabled` 默认开启，会**吞掉** webview 的 HTML5 drop 事件 →
 *     `dataTransfer.files` 拿不到文件。我们在 `tauri.conf.json` 里把它关了（见该文件），
 *     让 HTML5 drop 直接生效。
 *   - 之前只有 `ImportDialog` 里那个小 dropzone 能拖，用户必须先点"新建"打开对话框
 *     才能拖放 → 体验差。本组件让**窗口任意位置**都能收 drop。
 *
 * 行为：
 *   - 用户拖文件进入窗口 → 全屏浮现半透明遮罩"释放以导入"
 *   - 拖离 / 取消 → 遮罩消失（通过计数 enter/leave 准确判断是否真的离开窗口）
 *   - drop → 调 `importFiles`，遮罩变成"正在导入"，完成后自动隐藏并广播
 *     `resources-changed` 事件让 LibraryPage / HomePage / CourseWorkspacePage reload
 *
 * 不直接打开 ImportDialog：
 *   - 减少点击。用户已经做出"拖文件"这个明确动作 → 直接导入更自然。
 */
export function GlobalDropZone() {
  const [state, setState] = useState<'idle' | 'hover' | 'importing' | 'done' | 'error'>('idle')
  const [error, setError] = useState('')
  const [progress, setProgress] = useState('')
  // 精确追踪 dragenter / dragleave：子元素的 enter/leave 会导致计数波动，
  // 用 counter 反映"当前窗口边界内有多少层 drag 目标"——降到 0 才真正离开窗口。
  const counterRef = useRef(0)

  useEffect(() => {
    // 只处理包含 Files 的拖拽（忽略文本 / 链接等其他拖拽源）
    const hasFiles = (e: DragEvent) =>
      !!e.dataTransfer?.types && Array.from(e.dataTransfer.types).includes('Files')

    const onDragEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      counterRef.current++
      setState((s) => (s === 'importing' || s === 'done' ? s : 'hover'))
    }
    const onDragOver = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      // 必须明确告诉浏览器接收 copy，否则 drop 不会触发
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    }
    const onDragLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return
      counterRef.current = Math.max(0, counterRef.current - 1)
      if (counterRef.current === 0) {
        setState((s) => (s === 'importing' || s === 'done' ? s : 'idle'))
      }
    }
    const onDrop = async (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      counterRef.current = 0
      const files = e.dataTransfer?.files
      if (!files || files.length === 0) {
        setState('idle')
        return
      }
      setState('importing')
      setError('')
      try {
        const res = await importFiles(files, {
          onProgress: (p) => setProgress(`(${p.index}/${p.total}) ${p.name}`),
        })
        if (res.imported > 0) {
          // 通知所有使用资源列表的页面刷新
          window.dispatchEvent(new CustomEvent('doc-reader:resources-changed'))
        }
        if (res.blocked.length > 0 && res.imported === 0) {
          setError(`Android 平台暂不支持：${res.blocked.join('、')}`)
          setState('error')
          setTimeout(() => setState('idle'), 3000)
          return
        }
        setState('done')
        setTimeout(() => setState('idle'), 1200)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
        setState('error')
        setTimeout(() => setState('idle'), 3000)
      }
    }

    window.addEventListener('dragenter', onDragEnter)
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onDragEnter)
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('drop', onDrop)
    }
  }, [])

  if (state === 'idle') return null

  const active = state === 'hover' || state === 'importing'
  return (
    <div
      className="pointer-events-none fixed inset-0 z-[9998] flex items-center justify-center bg-black/55 backdrop-blur-sm"
      aria-live="polite"
    >
      <div
        className={
          'flex max-w-md flex-col items-center gap-3 rounded-lg border-2 px-10 py-8 shadow-2xl ' +
          (state === 'error'
            ? 'border-error/60 bg-popover text-error'
            : state === 'done'
              ? 'border-success/60 bg-popover text-success'
              : 'border-dashed border-accent bg-popover text-text-1')
        }
      >
        {state === 'importing' ? (
          <Loader2 className="h-10 w-10 animate-spin text-accent" />
        ) : state === 'error' ? (
          <X className="h-10 w-10" />
        ) : (
          <UploadCloud className={'h-10 w-10 ' + (active ? 'text-accent' : '')} />
        )}
        <div className="text-sm font-medium">
          {state === 'hover' && '释放以导入文件'}
          {state === 'importing' && `正在导入… ${progress}`}
          {state === 'done' && '导入完成 ✓'}
          {state === 'error' && error}
        </div>
        <div className="text-xs text-text-3">
          {state === 'hover' && '支持 EPUB / PDF / DOCX / MOBI / AZW3 / CBZ / TXT / HTML'}
        </div>
      </div>
    </div>
  )
}
