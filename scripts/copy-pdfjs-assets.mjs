// 把 pdfjs-dist 的 cmaps / standard_fonts 拷到 public/pdfjs/，让 vite dev/build
// 以 `/pdfjs/cmaps/` 和 `/pdfjs/standard_fonts/` 公开访问。
// 这些资源是 pdfjs-dist 渲染 CJK / 标准字体 PDF 的必备资料（169 个 cmap、16 个字体）。
// 幂等：目录已存在则跳过，不重复拷贝。package.json 的 predev/prebuild 钩子会调用。
//
// 同时生成 public/pdfjs/pdf.worker.patched.mjs —— 在 pdf.worker.min.mjs 前面
// 拼接 Promise.withResolvers / Object.groupBy 等 polyfill，给 Android WebView 旧版本
// 用（主线程的 polyfill 不会传到 Worker 上下文）。每次构建强制重建该文件，避免
// 升级 pdfjs-dist 后 stale。

import { existsSync, cpSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const SRC_DIR = resolve(ROOT, 'node_modules', 'pdfjs-dist')
const DST_DIR = resolve(ROOT, 'public', 'pdfjs')

const targets = [
  { from: 'cmaps', to: 'cmaps' },
  { from: 'standard_fonts', to: 'standard_fonts' },
]

function copy(from, to) {
  const src = resolve(SRC_DIR, from)
  const dst = resolve(DST_DIR, to)
  if (!existsSync(src)) {
    console.warn(`[copy-pdfjs-assets] SKIP: ${src} 不存在（请先 npm i）`)
    return
  }
  // 幂等：目标目录存在且有文件就跳过；需要刷新时删除 public/pdfjs/ 手动触发
  if (existsSync(dst)) return
  mkdirSync(dst, { recursive: true })
  cpSync(src, dst, { recursive: true })
  console.log(`[copy-pdfjs-assets] ${from} -> public/pdfjs/${to}`)
}

// 允许 `node scripts/copy-pdfjs-assets.mjs --force` 强制重拷
if (process.argv.includes('--force') && existsSync(DST_DIR)) {
  rmSync(DST_DIR, { recursive: true, force: true })
  console.log('[copy-pdfjs-assets] --force: 清理 public/pdfjs/')
}

for (const t of targets) copy(t.from, t.to)

// ─── 生成 patched worker（每次都重建，保证与 pdfjs-dist 版本同步） ────────
const WORKER_SRC = resolve(SRC_DIR, 'build', 'pdf.worker.min.mjs')
const WORKER_DST = resolve(DST_DIR, 'pdf.worker.patched.mjs')

const POLYFILL = `// === Android WebView polyfills (auto-prepended by copy-pdfjs-assets.mjs) ===
if (typeof Promise.withResolvers !== 'function') {
  Promise.withResolvers = function () {
    let resolve, reject
    const promise = new Promise((res, rej) => { resolve = res; reject = rej })
    return { promise, resolve, reject }
  }
}
if (typeof Object.groupBy !== 'function') {
  Object.groupBy = function (items, cb) {
    const out = Object.create(null)
    let i = 0
    for (const item of items) {
      const k = cb(item, i++)
      if (out[k]) out[k].push(item); else out[k] = [item]
    }
    return out
  }
}
if (typeof Map.groupBy !== 'function') {
  Map.groupBy = function (items, cb) {
    const out = new Map()
    let i = 0
    for (const item of items) {
      const k = cb(item, i++)
      const b = out.get(k)
      if (b) b.push(item); else out.set(k, [item])
    }
    return out
  }
}
if (typeof Array.prototype.findLast !== 'function') {
  Object.defineProperty(Array.prototype, 'findLast', {
    configurable: true, writable: true,
    value: function (pred) {
      for (let i = this.length - 1; i >= 0; i--) {
        if (pred(this[i], i, this)) return this[i]
      }
    }
  })
}
if (typeof Array.prototype.findLastIndex !== 'function') {
  Object.defineProperty(Array.prototype, 'findLastIndex', {
    configurable: true, writable: true,
    value: function (pred) {
      for (let i = this.length - 1; i >= 0; i--) {
        if (pred(this[i], i, this)) return i
      }
      return -1
    }
  })
}
if (typeof globalThis.structuredClone !== 'function') {
  globalThis.structuredClone = function (v) { return JSON.parse(JSON.stringify(v)) }
}
// === end polyfills ===
`

if (existsSync(WORKER_SRC)) {
  if (!existsSync(DST_DIR)) mkdirSync(DST_DIR, { recursive: true })
  const orig = readFileSync(WORKER_SRC, 'utf8')
  writeFileSync(WORKER_DST, POLYFILL + orig, 'utf8')
  console.log('[copy-pdfjs-assets] patched worker -> public/pdfjs/pdf.worker.patched.mjs')
} else {
  console.warn(`[copy-pdfjs-assets] SKIP worker patch: ${WORKER_SRC} not found`)
}
