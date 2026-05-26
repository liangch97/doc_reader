/**
 * v2 typed Tauri commands — courses / resources / progress / annotations / bookmarks
 * 命令名必须与 src-tauri/src/library_cmd.rs 中 #[tauri::command] 函数名一致。
 */
import { invoke } from './tauri'
import type { Course, CourseResourceCategory, CourseResourceLink } from '@/types/course'
import type { Resource, ResourceKind } from '@/types/resource'
import type { Annotation, AnnotationKind, Bookmark, ReadingProgress } from '@/types/annotation'

// ─── courses ────────────────────────────────────────────────────────────

export const coursesApi = {
  create(args: { name: string; description?: string; coverColor?: string; coverEmoji?: string }) {
    return invoke<string>('course_create', {
      name: args.name,
      description: args.description,
      coverColor: args.coverColor,
      coverEmoji: args.coverEmoji,
    })
  },
  list(includeArchived = false) {
    return invoke<Course[]>('course_list', { includeArchived })
  },
  get(courseId: string) {
    return invoke<Course | null>('course_get', { courseId })
  },
  update(courseId: string, patch: Partial<Omit<Course, 'course_id' | 'created_at' | 'updated_at'>>) {
    return invoke<void>('course_update', {
      courseId,
      name: patch.name,
      description: patch.description,
      coverColor: patch.cover_color,
      coverEmoji: patch.cover_emoji,
      notebookId: patch.notebook_id,
      outlineId: patch.outline_id,
      sortOrder: patch.sort_order,
      archived: patch.archived,
    })
  },
  remove(courseId: string) {
    return invoke<void>('course_delete', { courseId })
  },
  attachResource(args: {
    courseId: string
    resourceId: string
    category?: CourseResourceCategory
    sortOrder?: number
  }) {
    return invoke<void>('course_attach_resource', {
      courseId: args.courseId,
      resourceId: args.resourceId,
      category: args.category,
      sortOrder: args.sortOrder,
    })
  },
  detachResource(courseId: string, resourceId: string) {
    return invoke<void>('course_detach_resource', { courseId, resourceId })
  },
  listResources(courseId: string) {
    return invoke<CourseResourceLink[]>('course_list_resources', { courseId })
  },
  setResourceCategory(args: {
    courseId: string
    resourceId: string
    category: CourseResourceCategory
    sortOrder?: number
  }) {
    return invoke<void>('course_set_resource_category', {
      courseId: args.courseId,
      resourceId: args.resourceId,
      category: args.category,
      sortOrder: args.sortOrder,
    })
  },
}

// ─── resources ──────────────────────────────────────────────────────────

export const resourcesApi = {
  create(args: {
    kind: ResourceKind
    title: string
    author?: string
    filename: string
    filePath: string
    fileSize?: number
    pageCount?: number
    hasText?: boolean
    docSessionId?: string
  }) {
    return invoke<string>('resource_create', {
      kind: args.kind,
      title: args.title,
      author: args.author,
      filename: args.filename,
      filePath: args.filePath,
      fileSize: args.fileSize,
      pageCount: args.pageCount,
      hasText: args.hasText,
      docSessionId: args.docSessionId,
    })
  },
  list(args?: { kind?: ResourceKind; limit?: number }) {
    return invoke<Resource[]>('resource_list', { kind: args?.kind, limit: args?.limit })
  },
  get(resourceId: string) {
    return invoke<Resource | null>('resource_get', { resourceId })
  },
  updateMeta(args: { resourceId: string; title?: string; author?: string; coverPath?: string }) {
    return invoke<void>('resource_update_meta', {
      resourceId: args.resourceId,
      title: args.title,
      author: args.author,
      coverPath: args.coverPath,
    })
  },
  remove(resourceId: string) {
    return invoke<void>('resource_delete', { resourceId })
  },
  guessKind(filename: string) {
    return invoke<ResourceKind>('resource_guess_kind', { filename })
  },
  /** 读取 resource.file_path 指向的文件，返回 base64 */
  readFile(resourceId: string) {
    return invoke<{ file_data: string; file_name: string; file_size: number }>(
      'resource_read_file',
      { resourceId }
    )
  },
  /**
   * 保存封面图（前端从 foliate book.getCover() 提取的 Blob）。
   * 后端写到 `uploads/covers/<resource_id>.<ext>` 并 update resources.cover_path。
   * MOBI/AZW3 走这条路径；EPUB 走后端 epub_cover Rust 实现。
   */
  saveCover(args: { resourceId: string; fileData: string; ext: string }) {
    return invoke<string>('resource_save_cover', {
      resourceId: args.resourceId,
      fileData: args.fileData,
      ext: args.ext,
    })
  },
  /** 一次性导入：保存文件 + 注册 resource + 可选挂课程 */
  import(args: {
    fileName: string
    fileData: string // base64
    courseId?: string
    category?: CourseResourceCategory
  }) {
    return invoke<{
      resource_id: string
      kind: ResourceKind
      file_name: string
      file_path: string
      file_size: number
      page_count: number | null
      has_text: boolean
      doc_session_id: string | null
    }>('resource_import', {
      fileName: args.fileName,
      fileData: args.fileData,
      courseId: args.courseId,
      category: args.category,
    })
  },
}

// ─── notebooks ──────────────────────────────────────────────────────────

import type { Notebook, NotebookDetail } from '@/types/notebook'

export const notebooksApi = {
  list() {
    return invoke<{ notebooks: Notebook[] }>('notebook_list').then((r) => r.notebooks || [])
  },
  get(notebookId: string) {
    return invoke<NotebookDetail>('notebook_get', { notebookId })
  },
  create(args: { name: string; description?: string; color?: string; teacher?: string }) {
    return invoke<{ notebook_id: string; name: string }>('notebook_create', {
      name: args.name,
      description: args.description,
      color: args.color,
      teacher: args.teacher,
    })
  },
  update(args: {
    notebookId: string
    name: string
    description?: string
    color?: string
    teacher?: string
  }) {
    return invoke<void>('notebook_update', {
      notebookId: args.notebookId,
      name: args.name,
      description: args.description,
      color: args.color,
      teacher: args.teacher,
    })
  },
  addEntry(args: {
    notebookId: string
    title: string
    content: string
    entryType?: string
    sourceInfo?: string
  }) {
    return invoke<{ entry_id: string }>('notebook_add_entry', {
      notebookId: args.notebookId,
      title: args.title,
      content: args.content,
      entryType: args.entryType,
      sourceInfo: args.sourceInfo,
    })
  },
  updateEntry(args: { entryId: string; title: string; content: string }) {
    return invoke<void>('notebook_update_entry', {
      entryId: args.entryId,
      title: args.title,
      content: args.content,
    })
  },
  deleteEntry(args: { entryId: string }) {
    return invoke<void>('notebook_delete_entry', { entryId: args.entryId })
  },
  /**
   * 启动一键排版（异步事件驱动）。立刻 resolve；真正完成/失败由 Tauri 事件通知：
   *   - `note-format-done`  payload: `{ entry_id, content, char_count }`
   *   - `note-format-error` payload: `{ entry_id, error }`
   * 调用方应在调用前订阅事件并按 `entry_id` 过滤。
   */
  entryAutoFormat(args: { entryId: string }) {
    return invoke<{ entry_id: string; started: boolean }>(
      'notebook_entry_auto_format',
      { entryId: args.entryId }
    )
  },
  buildLearningOutline(args: { notebookId: string }) {
    return invoke<unknown>('notebook_build_learning_outline', {
      notebookId: args.notebookId,
    })
  },
}

// ─── reading_progress ───────────────────────────────────────────────────

export const progressApi = {
  upsert(args: {
    resourceId: string
    cfi?: string
    pageIndex?: number
    percent?: number
    addSeconds?: number
  }) {
    return invoke<void>('progress_upsert', {
      resourceId: args.resourceId,
      cfi: args.cfi,
      pageIndex: args.pageIndex,
      percent: args.percent,
      addSeconds: args.addSeconds,
    })
  },
  get(resourceId: string) {
    return invoke<ReadingProgress | null>('progress_get', { resourceId })
  },
}

// ─── annotations ────────────────────────────────────────────────────────

export const annotationsApi = {
  create(args: {
    resourceId: string
    kind: AnnotationKind
    color?: string
    cfiStart?: string
    cfiEnd?: string
    pageIndex?: number
    textOffsetStart?: number
    textOffsetEnd?: number
    selectedText: string
    noteContent?: string
    /** PDF 专用：`PdfNormRect[]` 的 JSON 字符串。cfi_* 为空，用这个定位。 */
    pdfRects?: string
  }) {
    return invoke<string>('annotation_create', {
      resourceId: args.resourceId,
      kind: args.kind,
      color: args.color,
      cfiStart: args.cfiStart,
      cfiEnd: args.cfiEnd,
      pageIndex: args.pageIndex,
      textOffsetStart: args.textOffsetStart,
      textOffsetEnd: args.textOffsetEnd,
      selectedText: args.selectedText,
      noteContent: args.noteContent,
      pdfRects: args.pdfRects,
    })
  },
  update(args: { annotationId: string; color?: string; noteContent?: string }) {
    return invoke<void>('annotation_update', {
      annotationId: args.annotationId,
      color: args.color,
      noteContent: args.noteContent,
    })
  },
  remove(annotationId: string) {
    return invoke<void>('annotation_delete', { annotationId })
  },
  list(resourceId: string) {
    return invoke<Annotation[]>('annotation_list', { resourceId })
  },
}

// ─── bookmarks ──────────────────────────────────────────────────────────

export const bookmarksApi = {
  create(args: { resourceId: string; cfi?: string; pageIndex?: number; label?: string }) {
    return invoke<string>('bookmark_create', {
      resourceId: args.resourceId,
      cfi: args.cfi,
      pageIndex: args.pageIndex,
      label: args.label,
    })
  },
  remove(bookmarkId: string) {
    return invoke<void>('bookmark_delete', { bookmarkId })
  },
  list(resourceId: string) {
    return invoke<Bookmark[]>('bookmark_list', { resourceId })
  },
}
