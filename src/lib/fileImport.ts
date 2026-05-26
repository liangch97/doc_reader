/**
 * 文件导入通用逻辑 —— 供 `ImportDialog` 和 `GlobalDropZone` 共用。
 *
 * 历史：原来这些代码内嵌在 `ImportDialog.handleFiles` 里，全局拖拽上传
 * （drop 到窗口任意位置触发导入）也要用同一套流程，所以抽到这里。
 *
 * 平台差异：
 *  - Android Tauri WebView 没有 PowerPoint / PowerShell，`doc_reader_export_ppt_slides`
 *    走不通 → 前端直接拦截 .ppt / .pptx
 *  - MOBI/AZW3 后端无轻量解析库，封面靠前端 foliate-js（`extractMobiCover`）
 */
import { resourcesApi } from './api'
import { extractMobiCover } from './foliate'

export interface ImportProgress {
  /** 当前处理到第几个文件（1-based） */
  index: number
  /** 总文件数 */
  total: number
  /** 当前处理的文件名 */
  name: string
}

export interface ImportResult {
  /** 最后一个成功导入的 resource_id；失败/全部被拦截时为空串 */
  lastId: string
  /** 被 android 规则拦截的文件名 */
  blocked: string[]
  /** 导入成功的文件数（不含被拦截的） */
  imported: number
}

export interface ImportOptions {
  /** 可选：挂到某个课程 */
  courseId?: string
  /** 进度回调：每开始处理一个文件前调用 */
  onProgress?: (p: ImportProgress) => void
}

/** Tauri Android WebView 的 UA 必然含 "Android"；用 UA 检测避免多引入 plugin-os 依赖。 */
export function isAndroidPlatform(): boolean {
  return /Android/i.test(navigator.userAgent)
}

/** File → base64（不带 data:xxx; 前缀） */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result as string
      const idx = result.indexOf(',')
      resolve(idx >= 0 ? result.slice(idx + 1) : result)
    }
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

/** MOBI/AZW3 封面上传（失败静默，不阻塞主流程） */
async function uploadMobiCover(file: File, resourceId: string): Promise<void> {
  const cover = await extractMobiCover(file)
  if (!cover) return
  const mime = cover.type || 'image/jpeg'
  const ext =
    mime.includes('png') ? 'png' :
    mime.includes('webp') ? 'webp' :
    mime.includes('gif') ? 'gif' :
    mime.includes('bmp') ? 'bmp' : 'jpg'
  const buf = new Uint8Array(await cover.arrayBuffer())
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < buf.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, Array.from(buf.subarray(i, i + CHUNK)))
  }
  const b64 = btoa(bin)
  await resourcesApi.saveCover({ resourceId, fileData: b64, ext })
}

/**
 * 批量导入文件。会在 android 平台自动拦截 PPT/PPTX。
 *
 * @throws Error 当所有非拦截文件均导入失败，向上抛错；调用方应 try/catch 展示错误。
 */
export async function importFiles(
  filesInput: FileList | File[],
  opts: ImportOptions = {}
): Promise<ImportResult> {
  const filesArr: File[] = Array.from(filesInput as ArrayLike<File>)
  const blocked: string[] = []
  let processList = filesArr
  if (isAndroidPlatform()) {
    processList = []
    for (const f of filesArr) {
      if (/\.(pptx?|ppt)$/i.test(f.name)) blocked.push(f.name)
      else processList.push(f)
    }
  }
  let lastId = ''
  let imported = 0
  let firstError: unknown = null
  for (let i = 0; i < processList.length; i++) {
    const f = processList[i]
    opts.onProgress?.({ index: i + 1, total: processList.length, name: f.name })
    try {
      const b64 = await fileToBase64(f)
      const res = await resourcesApi.import({
        fileName: f.name,
        fileData: b64,
        courseId: opts.courseId,
      })
      lastId = res.resource_id
      imported++
      if (/\.(mobi|azw3?)$/i.test(f.name)) {
        uploadMobiCover(f, res.resource_id).catch((err) =>
          console.warn('[fileImport] MOBI 封面上传失败（不影响导入）', err)
        )
      }
    } catch (e) {
      firstError ??= e
      console.warn('[fileImport] import failed', f.name, e)
    }
  }
  // 所有文件都失败 & 有文件被尝试导入 → 抛出首个错误
  if (imported === 0 && processList.length > 0 && firstError) {
    throw firstError instanceof Error ? firstError : new Error(String(firstError))
  }
  return { lastId, blocked, imported }
}
