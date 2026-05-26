import { useEffect, useMemo, useRef, useState } from 'react'
import { Search, Plus, Filter } from 'lucide-react'
import { resourcesApi, progressApi } from '@/lib/api'
import type { Resource, ResourceKind } from '@/types/resource'
import { ResourceGrid } from '@/features/library/ResourceGrid'
import { ImportDialog } from '@/features/library/ImportDialog'
import { importFiles, isAndroidPlatform } from '@/lib/fileImport'
import { cn } from '@/lib/cn'

type Status = 'loading' | 'success' | 'error' | 'empty'

const KIND_FILTERS: Array<{ label: string; value: ResourceKind | 'all' }> = [
  { label: '全部', value: 'all' },
  { label: 'EPUB', value: 'epub' },
  { label: 'PDF', value: 'pdf' },
  { label: 'PPTX', value: 'pptx' },
  { label: 'DOCX', value: 'docx' },
  { label: 'MOBI', value: 'mobi' },
  { label: 'CBZ', value: 'cbz' },
]

export default function LibraryPage() {
  const [status, setStatus] = useState<Status>('loading')
  const [error, setError] = useState('')
  const [resources, setResources] = useState<Resource[]>([])
  const [progressMap, setProgressMap] = useState<Record<string, number>>({})
  const [search, setSearch] = useState('')
  const [kindFilter, setKindFilter] = useState<ResourceKind | 'all'>('all')
  const [importOpen, setImportOpen] = useState(false)
  /**
   * Android 差异化：用户要求"安卓版导入不要弹拖入框"。
   * Android 平台直接触发隐藏的 <input type="file"> 调起系统文件选择器，
   * 桌面端继续走 ImportDialog（提供拖拽 + 多文件 + 进度反馈）。
   */
  const isAndroid = isAndroidPlatform()
  const androidInputRef = useRef<HTMLInputElement>(null)
  const [androidImporting, setAndroidImporting] = useState(false)

  const onClickImport = () => {
    if (isAndroid) {
      androidInputRef.current?.click()
    } else {
      setImportOpen(true)
    }
  }

  const onAndroidFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return
    setAndroidImporting(true)
    try {
      const res = await importFiles(files)
      if (res.imported > 0) {
        window.dispatchEvent(new CustomEvent('doc-reader:resources-changed'))
      }
    } catch {
      /* 用 toast 通报 —— 静默落到本地 catch 避免破坏 UI */
    } finally {
      setAndroidImporting(false)
      // 重置 input 让同一文件能二次选择
      if (androidInputRef.current) androidInputRef.current.value = ''
    }
  }

  const reload = async () => {
    try {
      setStatus('loading')
      const list = await resourcesApi.list()
      setResources(list)
      setStatus(list.length === 0 ? 'empty' : 'success')

      const entries = await Promise.all(
        list.map(async (r) => {
          try {
            const p = await progressApi.get(r.resource_id)
            return [r.resource_id, p?.percent ?? 0] as const
          } catch {
            return [r.resource_id, 0] as const
          }
        })
      )
      setProgressMap(Object.fromEntries(entries))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setStatus('error')
    }
  }

  useEffect(() => {
    reload()
    // 全局拖拽导入 / 其它页面操作完成后派发此事件，通知所有资源列表刷新
    const onChanged = () => reload()
    window.addEventListener('doc-reader:resources-changed', onChanged)
    return () => window.removeEventListener('doc-reader:resources-changed', onChanged)
  }, [])

  const filtered = useMemo(() => {
    return resources.filter((r) => {
      if (kindFilter !== 'all' && r.kind !== kindFilter) return false
      if (search.trim() && !r.title.toLowerCase().includes(search.toLowerCase())) return false
      return true
    })
  }, [resources, kindFilter, search])

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border-1 px-6">
        <h1 className="text-lg font-semibold text-text-1">图书馆</h1>

        <div className="ml-4 flex items-center gap-1 rounded-md border border-border-1 bg-surface-1 p-0.5 text-xs">
          {KIND_FILTERS.map((f) => (
            <button
              key={f.value}
              onClick={() => setKindFilter(f.value)}
              className={cn(
                'rounded px-2.5 py-1 text-text-3 transition-colors hover:text-text-1',
                kindFilter === f.value && 'bg-surface-3 text-text-1'
              )}
            >
              {f.label}
            </button>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-2">
          <div className="flex items-center gap-2 rounded-md border border-border-1 bg-surface-1 px-2.5 py-1">
            <Search className="h-3.5 w-3.5 text-text-3" />
            <input
              type="text"
              placeholder="搜索资料标题…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-48 bg-transparent text-xs text-text-1 outline-none placeholder:text-text-4"
            />
          </div>
          <button
            type="button"
            onClick={onClickImport}
            disabled={androidImporting}
            className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-accent-2 disabled:opacity-60"
          >
            <Plus className="h-3.5 w-3.5" /> {androidImporting ? '导入中…' : '导入'}
          </button>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto p-8">
        {status === 'loading' && <CenterMsg>加载中…</CenterMsg>}
        {status === 'error' && (
          <CenterMsg variant="error">
            出错了：{error}
            <button
              onClick={reload}
              className="ml-2 rounded-md border border-border-1 px-2 py-0.5 text-xs hover:bg-surface-2"
            >
              重试
            </button>
          </CenterMsg>
        )}
        {status === 'empty' && (
          <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
            <div className="flex h-20 w-20 items-center justify-center rounded-full bg-surface-2">
              <Filter className="h-8 w-8 text-text-3" />
            </div>
            <div>
              <p className="text-sm text-text-2">还没有任何资料</p>
              <p className="mt-1 text-xs text-text-3">导入 PDF / EPUB / PPTX 开始你的学习</p>
            </div>
            <button
              type="button"
              onClick={onClickImport}
              className="flex items-center gap-1.5 rounded-md bg-accent px-4 py-2 text-sm font-medium text-white"
            >
              <Plus className="h-4 w-4" /> 导入资料
            </button>
          </div>
        )}
        {status === 'success' && filtered.length === 0 && (
          <CenterMsg>无匹配项 · 试着改变筛选或搜索词</CenterMsg>
        )}
        {status === 'success' && filtered.length > 0 && (
          <ResourceGrid resources={filtered} progressMap={progressMap} onChanged={reload} />
        )}
      </main>

      <ImportDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={() => reload()}
      />
      {/* Android 差异化：隐藏的原生 file input，导入按钮直接触发系统文件选择器 */}
      <input
        ref={androidInputRef}
        type="file"
        multiple
        accept=".pdf,.epub,.mobi,.azw3,.cbz,.docx,.txt,.html,.htm,.fb2"
        className="hidden"
        onChange={(e) => onAndroidFiles(e.target.files)}
      />
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
        'flex h-full items-center justify-center text-sm',
        variant === 'error' ? 'text-error' : 'text-text-3'
      )}
    >
      {children}
    </div>
  )
}
