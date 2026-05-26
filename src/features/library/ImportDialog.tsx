import { useRef, useState } from 'react'
import { Upload, X, Loader2 } from 'lucide-react'
import { cn } from '@/lib/cn'
import { importFiles, isAndroidPlatform } from '@/lib/fileImport'

interface Props {
  open: boolean
  onClose: () => void
  onImported?: (resourceId: string) => void
  defaultCourseId?: string
}

type Status = 'idle' | 'submitting' | 'error' | 'success'

/**
 * 简单导入对话框：
 * - 支持文件选择 / 拖拽
 * - 走 FileReader → base64 → resource_import
 */
export function ImportDialog({ open, onClose, onImported, defaultCourseId }: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [status, setStatus] = useState<Status>('idle')
  const [error, setError] = useState('')
  const [progress, setProgress] = useState('')

  if (!open) return null

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return
    setStatus('submitting')
    setError('')
    try {
      const res = await importFiles(files, {
        courseId: defaultCourseId,
        onProgress: (p) => setProgress(`(${p.index}/${p.total}) ${p.name}`),
      })
      if (res.blocked.length > 0) {
        setError(
          `当前平台（Android）暂不支持 PPT 导入：${res.blocked.join('、')}。\n` +
            `请在 Windows 桌面端导入并阅读 PPT。`
        )
        // 只有全部被拦截时才算失败；部分成功仍继续
        if (res.imported === 0) {
          setStatus('error')
          return
        }
      }
      setStatus('success')
      onImported?.(res.lastId)
      setTimeout(() => {
        setStatus('idle')
        onClose()
      }, 600)
    } catch (e) {
      setStatus('error')
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="relative w-[480px] rounded-lg border border-border-1 bg-popover p-6 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          className="absolute right-3 top-3 rounded-md p-1 text-text-3 hover:bg-surface-2 hover:text-text-1"
        >
          <X className="h-4 w-4" />
        </button>
        <h2 className="mb-1 text-lg font-semibold text-text-1">导入资料</h2>
        <p className="mb-4 text-xs text-text-3">
          支持 EPUB、PDF、DOCX、{!isAndroidPlatform() && 'PPTX、'}MOBI、AZW3、CBZ、TXT
          {isAndroidPlatform() && (
            <>
              <br />
              <span className="text-warning">
                Android 暂不支持 PPT 导入（依赖桌面 PowerPoint）
              </span>
            </>
          )}
        </p>

        <label
          htmlFor="import-file-input"
          onDragOver={(e) => {
            e.preventDefault()
            e.currentTarget.classList.add('ring-2', 'ring-accent')
          }}
          onDragLeave={(e) => e.currentTarget.classList.remove('ring-2', 'ring-accent')}
          onDrop={(e) => {
            e.preventDefault()
            e.currentTarget.classList.remove('ring-2', 'ring-accent')
            handleFiles(e.dataTransfer.files)
          }}
          className={cn(
            'flex cursor-pointer flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border-2 bg-surface-2 p-8 text-center text-sm text-text-2 transition-colors hover:bg-surface-3',
            status === 'submitting' && 'pointer-events-none opacity-60'
          )}
        >
          {status === 'submitting' ? (
            <Loader2 className="h-6 w-6 animate-spin text-accent" />
          ) : (
            <Upload className="h-6 w-6 text-text-3" />
          )}
          <div className="text-xs">
            {status === 'submitting' ? `导入中… ${progress}` : '点击或拖拽文件到此处'}
          </div>
        </label>
        <input
          ref={inputRef}
          id="import-file-input"
          type="file"
          multiple
          accept={
            isAndroidPlatform()
              ? '.pdf,.epub,.mobi,.azw3,.cbz,.docx,.txt,.html,.htm,.fb2'
              : '.pdf,.epub,.mobi,.azw3,.cbz,.docx,.pptx,.txt,.html,.htm,.fb2'
          }
          className="hidden"
          onChange={(e) => handleFiles(e.target.files)}
        />

        {status === 'error' && (
          <p className="mt-3 text-xs text-error">导入失败：{error}</p>
        )}
        {status === 'success' && (
          <p className="mt-3 text-xs text-success">导入完成 ✓</p>
        )}
      </div>
    </div>
  )
}

