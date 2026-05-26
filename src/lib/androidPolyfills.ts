/**
 * Android WebView 旧版本 polyfills（Chromium < 119）。
 *
 * 必须在所有其它代码之前导入：pdfjs-dist 4.x / foliate-js 在 module top-level
 * 就会调用 `Promise.withResolvers()` / `Object.groupBy()`，晚一拍 patch 已来不及。
 *
 * 触发条件：
 *  - Android WebView < 119 → 缺 `Promise.withResolvers`（ES2024）
 *  - Android WebView < 117 → 缺 `Object.groupBy` / `Map.groupBy`（ES2024）
 *  - Android WebView < 110 → 缺 `Array.prototype.findLast` 等（这里不补，pdfjs 不依赖）
 *
 * 桌面 Tauri (Edge WebView2 / WKWebView 现代版本) 这些 API 都有；polyfill 走
 * `typeof X !== 'function'` 守卫，已存在则跳过，零副作用。
 */

// ─── Promise.withResolvers (ES2024) ─────────────────────────────────────────
if (typeof (Promise as { withResolvers?: unknown }).withResolvers !== 'function') {
  ;(Promise as unknown as {
    withResolvers: <T>() => { promise: Promise<T>; resolve: (v: T | PromiseLike<T>) => void; reject: (reason?: unknown) => void }
  }).withResolvers = function <T>() {
    let resolve!: (v: T | PromiseLike<T>) => void
    let reject!: (reason?: unknown) => void
    const promise = new Promise<T>((res, rej) => {
      resolve = res
      reject = rej
    })
    return { promise, resolve, reject }
  }
}

// ─── Object.groupBy / Map.groupBy (ES2024) ──────────────────────────────────
// pdfjs-dist 4.x 用 Object.groupBy 给 textLayer 分组；foliate-js paginator 也用过。
type GroupKey = PropertyKey
type Groupable<T> = Iterable<T>

if (typeof (Object as { groupBy?: unknown }).groupBy !== 'function') {
  ;(Object as unknown as {
    groupBy: <T, K extends GroupKey>(items: Groupable<T>, callback: (item: T, index: number) => K) => Record<K, T[]>
  }).groupBy = function <T, K extends GroupKey>(items: Groupable<T>, callback: (item: T, index: number) => K) {
    const result = Object.create(null) as Record<K, T[]>
    let i = 0
    for (const item of items) {
      const key = callback(item, i++)
      const bucket = result[key]
      if (bucket) bucket.push(item)
      else result[key] = [item]
    }
    return result
  }
}

if (typeof (Map as { groupBy?: unknown }).groupBy !== 'function') {
  ;(Map as unknown as {
    groupBy: <T, K>(items: Groupable<T>, callback: (item: T, index: number) => K) => Map<K, T[]>
  }).groupBy = function <T, K>(items: Groupable<T>, callback: (item: T, index: number) => K) {
    const result = new Map<K, T[]>()
    let i = 0
    for (const item of items) {
      const key = callback(item, i++)
      const bucket = result.get(key)
      if (bucket) bucket.push(item)
      else result.set(key, [item])
    }
    return result
  }
}

// ─── Array.prototype.findLast / findLastIndex (ES2023) ─────────────────────
// pdfjs 4.x / foliate-js 在搜索/分页里用到；Android WebView 110- 缺失。
if (typeof (Array.prototype as { findLast?: unknown }).findLast !== 'function') {
  Object.defineProperty(Array.prototype, 'findLast', {
    configurable: true,
    writable: true,
    value<T>(this: T[], predicate: (value: T, index: number, array: T[]) => unknown): T | undefined {
      for (let i = this.length - 1; i >= 0; i--) {
        const v = this[i]
        if (predicate(v, i, this)) return v
      }
      return undefined
    },
  })
}

if (typeof (Array.prototype as { findLastIndex?: unknown }).findLastIndex !== 'function') {
  Object.defineProperty(Array.prototype, 'findLastIndex', {
    configurable: true,
    writable: true,
    value<T>(this: T[], predicate: (value: T, index: number, array: T[]) => unknown): number {
      for (let i = this.length - 1; i >= 0; i--) {
        if (predicate(this[i], i, this)) return i
      }
      return -1
    },
  })
}

// ─── structuredClone (Chromium 98+) ─────────────────────────────────────────
// 极旧 Android WebView 缺；用 JSON 走兜底（无法处理循环引用 / Map / Set / Date，
// 但 pdfjs 用它克隆纯 plain 对象，够用）。
if (typeof (globalThis as { structuredClone?: unknown }).structuredClone !== 'function') {
  ;(globalThis as { structuredClone: <T>(v: T) => T }).structuredClone = function <T>(v: T): T {
    return JSON.parse(JSON.stringify(v)) as T
  }
}

export {}
