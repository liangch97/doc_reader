import { useCallback, useEffect, useState } from 'react'
import {
  Plus, Trash2, CheckCircle2, XCircle, Loader2, Pencil, X, Sun, Moon,
  Terminal, Zap, Container, Power, PowerOff, Download, RefreshCw, AlertTriangle,
} from 'lucide-react'
import { invoke, isTauri } from '@/lib/tauri'
import { cn } from '@/lib/cn'
import { useTheme } from '@/lib/useTheme'
import {
  MarkdownView,
  MD_THEMES,
  loadMdTheme,
  saveMdTheme,
  type MdTheme,
} from '@/components/markdown/MarkdownView'

interface ModelConfig {
  name: string
  provider: string
  api_key: string
  api_base: string
  model: string
  enabled: boolean
  use_proxy: boolean
  /** "chat"（默认）或 "embedding"。老配置无此字段时按 chat 处理。 */
  kind?: string
}

interface MaskedModel {
  index: number
  name: string
  provider: string
  api_key_masked: string
  api_base: string
  model: string
  enabled: boolean
  kind?: string
}

const PROVIDERS: Array<{ id: string; label: string; hint: string }> = [
  { id: 'custom', label: 'OpenAI 兼容', hint: '通用,国产/第三方都选这个(火山/DeepSeek/智谱/百炼/Jina/SiliconFlow…)' },
  { id: 'openai', label: 'OpenAI', hint: '走 OpenAI 官方,等价于 OpenAI 兼容' },
  { id: 'anthropic', label: 'Anthropic Claude', hint: '专有协议;不支持 embedding' },
]
const KINDS: Array<{ id: string; label: string; hint: string }> = [
  { id: 'chat', label: '对话 (Chat)', hint: '问答、笔记生成、学习大纲' },
  { id: 'embedding', label: '嵌入 (Embedding)', hint: 'RAG 知识库构建：把整本书切块向量化' },
]

const EMPTY_MODEL: ModelConfig = {
  name: '',
  provider: 'custom',
  api_key: '',
  api_base: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
  enabled: true,
  use_proxy: true,
  kind: 'chat',
}

export default function SettingsPage() {
  const [models, setModels] = useState<ModelConfig[]>([])
  const [masked, setMasked] = useState<MaskedModel[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<number | 'new' | null>(null)
  const [draft, setDraft] = useState<ModelConfig>(EMPTY_MODEL)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null)
  const { theme, toggle: toggleTheme } = useTheme()
  const [mdTheme, setMdTheme] = useState<MdTheme>(() => loadMdTheme())
  const pickMdTheme = (t: MdTheme) => {
    setMdTheme(t)
    saveMdTheme(t)
  }

  const reload = async () => {
    try {
      setLoading(true)
      setError('')
      const [raw, m] = await Promise.all([
        invoke<ModelConfig[]>('get_llm_models_raw'),
        invoke<MaskedModel[]>('get_llm_models'),
      ])
      setModels(raw)
      setMasked(m)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    reload()
  }, [])

  const startEdit = (i: number) => {
    setEditing(i)
    setDraft({ ...models[i] })
    setTestResult(null)
  }
  const startNew = () => {
    setEditing('new')
    setDraft({ ...EMPTY_MODEL })
    setTestResult(null)
  }
  const cancelEdit = () => {
    setEditing(null)
    setTestResult(null)
  }

  const saveAll = async (next: ModelConfig[]) => {
    await invoke('save_llm_models', { models: next })
    await reload()
  }

  const commitDraft = async () => {
    if (!draft.name.trim() || !draft.model.trim()) {
      setError('名称和模型 ID 必填')
      return
    }
    const next = [...models]
    if (editing === 'new') next.push(draft)
    else if (typeof editing === 'number') next[editing] = draft
    try {
      await saveAll(next)
      setEditing(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const removeAt = async (i: number) => {
    if (!confirm(`确认删除模型 “${models[i].name}”？`)) return
    try {
      await invoke('delete_llm_model', { index: i })
      await reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const toggleEnabled = async (i: number) => {
    const next = [...models]
    next[i] = { ...next[i], enabled: !next[i].enabled }
    await saveAll(next)
  }

  const testCurrent = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const res = await invoke<{
        success: boolean
        reply?: string
        error?: string
        kind?: string
        dim?: number
      }>('test_llm_model', { model: draft })
      // embedding 测试时附加维度信息;chat 沿用 reply
      const okMsg =
        res.kind === 'embedding'
          ? `连接成功 · 返回向量维度 ${res.dim ?? '?'}`
          : `连接成功:${res.reply ?? ''}`
      setTestResult({
        ok: res.success,
        msg: res.success ? okMsg : res.error ?? '未知错误',
      })
    } catch (e) {
      setTestResult({ ok: false, msg: e instanceof Error ? e.message : String(e) })
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <header className="px-8 py-6">
        <h1 className="text-2xl font-semibold text-text-1">设置</h1>
        <p className="mt-1 text-xs text-text-3">LLM 模型 · 数据 · 外观</p>
      </header>

      <section className="px-8 pb-2">
        <h2 className="mb-3 text-sm font-semibold text-text-2">外观</h2>
        <button
          type="button"
          onClick={toggleTheme}
          className="flex items-center gap-2 rounded-md border border-border-1 bg-surface-1 px-3 py-2 text-xs text-text-1 hover:bg-surface-2"
        >
          {theme === 'dark' ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
          切换到{theme === 'dark' ? '浅色' : '深色'}主题
        </button>
      </section>

      <section className="px-8 pb-2 pt-6">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-text-2">Markdown 渲染主题</h2>
          <span className="text-[11px] text-text-3">
            当前：{MD_THEMES.find((t) => t.id === mdTheme)?.label}
          </span>
        </div>
        <div
          className="mb-4 grid gap-2"
          style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))' }}
        >
          {MD_THEMES.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => pickMdTheme(t.id)}
              className={cn(
                'flex flex-col items-start gap-0.5 rounded-md border px-3 py-2 text-left text-xs transition-colors',
                t.id === mdTheme
                  ? 'border-accent bg-accent/10 text-text-1'
                  : 'border-border-1 bg-surface-1 text-text-2 hover:bg-surface-2'
              )}
            >
              <span className="font-medium">{t.label}</span>
              <span className="text-[10px] text-text-3">{t.hint}</span>
            </button>
          ))}
        </div>
        <div className="max-h-72 overflow-y-auto rounded-md border border-border-1 bg-surface-1 p-4">
          <MarkdownView content={MD_PREVIEW} theme={mdTheme} />
        </div>
        <p className="mt-2 text-[11px] text-text-3">
          选择后全局生效：AI 笔记、AI 聊天、笔记本详情均使用该主题。
        </p>
      </section>

      <CodeRunnerSection />

      <section className="px-8 pb-8 pt-6">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-text-2">LLM 模型</h2>
          <button
            type="button"
            onClick={startNew}
            className="flex items-center gap-1 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-2"
          >
            <Plus className="h-3.5 w-3.5" /> 添加模型
          </button>
        </div>

        <RagHint models={models} />

        {error && (
          <div className="mb-3 rounded-md border border-error/40 bg-error/10 px-3 py-2 text-xs text-error">
            {error}
          </div>
        )}

        {loading ? (
          <div className="rounded-md border border-border-1 p-6 text-center text-xs text-text-3">
            加载中…
          </div>
        ) : masked.length === 0 ? (
          <div className="rounded-md border border-dashed border-border-1 p-6 text-center text-xs text-text-3">
            还没有配置模型，点击「添加模型」开始。
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {masked.map((m) => (
              <li
                key={m.index}
                className="flex items-center gap-3 rounded-md border border-border-1 bg-surface-1 px-3 py-2.5"
              >
                <button
                  type="button"
                  onClick={() => toggleEnabled(m.index)}
                  className={cn(
                    'flex h-5 w-9 shrink-0 items-center rounded-full transition-colors',
                    m.enabled ? 'bg-accent justify-end' : 'bg-surface-3 justify-start'
                  )}
                >
                  <span className="mx-0.5 h-4 w-4 rounded-full bg-white shadow" />
                </button>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-sm text-text-1">
                    <span className="truncate font-medium">{m.name}</span>
                    <span className="rounded bg-surface-3 px-1.5 py-0.5 text-[10px] text-text-3">
                      {m.provider}
                    </span>
                    {(m.kind ?? 'chat') === 'embedding' && (
                      <span className="rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-medium text-accent">
                        embedding
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 truncate text-xs text-text-3">
                    {m.model} · {m.api_base} · {m.api_key_masked}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => startEdit(m.index)}
                  className="rounded p-1.5 text-text-3 hover:bg-surface-2 hover:text-text-1"
                  title="编辑"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => removeAt(m.index)}
                  className="rounded p-1.5 text-text-3 hover:bg-error/10 hover:text-error"
                  title="删除"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {editing !== null && (
        <ModelEditor
          draft={draft}
          setDraft={setDraft}
          testing={testing}
          testResult={testResult}
          onTest={testCurrent}
          onCancel={cancelEdit}
          onSave={commitDraft}
          isNew={editing === 'new'}
        />
      )}
    </div>
  )
}

function ModelEditor({
  draft,
  setDraft,
  testing,
  testResult,
  onTest,
  onCancel,
  onSave,
  isNew,
}: {
  draft: ModelConfig
  setDraft: (m: ModelConfig) => void
  testing: boolean
  testResult: { ok: boolean; msg: string } | null
  onTest: () => void
  onCancel: () => void
  onSave: () => void
  isNew: boolean
}) {
  const inputCls =
    'w-full rounded-md border border-border-1 bg-bg px-2.5 py-1.5 text-xs text-text-1 outline-none focus:border-accent'
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="flex max-h-[90vh] w-full max-w-md flex-col overflow-hidden rounded-lg border border-border-1 bg-popover shadow-xl">
        <div className="flex shrink-0 items-center justify-between border-b border-border-1 px-4 py-3">
          <h3 className="text-sm font-semibold text-text-1">{isNew ? '添加模型' : '编辑模型'}</h3>
          <button
            type="button"
            onClick={onCancel}
            className="rounded p-1 text-text-3 hover:bg-surface-2 hover:text-text-1"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex-1 space-y-3 overflow-y-auto p-4">
          <Field label="显示名称">
            <input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder="例如：火山 ark-code"
              className={inputCls}
            />
          </Field>
          <Field label="提供商">
            <select
              value={draft.provider}
              onChange={(e) => setDraft({ ...draft, provider: e.target.value })}
              className={inputCls}
            >
              {PROVIDERS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label} — {p.hint}
                </option>
              ))}
            </select>
          </Field>
          <Field label="用途">
            <select
              value={draft.kind ?? 'chat'}
              onChange={(e) => setDraft({ ...draft, kind: e.target.value })}
              className={inputCls}
            >
              {KINDS.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.label} — {k.hint}
                </option>
              ))}
            </select>
          </Field>
          <Field label="API Base">
            <input
              value={draft.api_base}
              onChange={(e) => setDraft({ ...draft, api_base: e.target.value })}
              placeholder="https://api.openai.com/v1"
              className={inputCls}
            />
          </Field>
          <Field label="模型 ID">
            <input
              value={draft.model}
              onChange={(e) => setDraft({ ...draft, model: e.target.value })}
              placeholder="gpt-4o-mini"
              className={inputCls}
            />
          </Field>
          <Field label="API Key">
            <input
              type="password"
              value={draft.api_key}
              onChange={(e) => setDraft({ ...draft, api_key: e.target.value })}
              placeholder="sk-…"
              className={inputCls}
            />
          </Field>
          <div className="flex items-center gap-4 text-xs">
            <Toggle
              checked={draft.enabled}
              onChange={(v) => setDraft({ ...draft, enabled: v })}
              label="启用"
            />
            <Toggle
              checked={draft.use_proxy}
              onChange={(v) => setDraft({ ...draft, use_proxy: v })}
              label="使用系统代理"
            />
          </div>
          {testResult && (
            <div
              className={cn(
                'flex items-start gap-2 rounded-md border px-3 py-2 text-xs',
                testResult.ok
                  ? 'border-success/40 bg-success/10 text-success'
                  : 'border-error/40 bg-error/10 text-error'
              )}
            >
              {testResult.ok ? (
                <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              ) : (
                <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              )}
              <span className="break-all">{testResult.msg}</span>
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border-1 bg-surface-1 px-4 py-3">
          <button
            type="button"
            disabled={testing}
            onClick={onTest}
            title={
              (draft.kind ?? 'chat') === 'embedding'
                ? '调用 /embeddings 端点,验证 key 与模型 ID 配对,并返回向量维度'
                : '调用 /chat/completions,验证 key 与模型 ID 配对'
            }
            className="flex items-center gap-1.5 rounded-md border border-border-1 bg-surface-2 px-3 py-1.5 text-xs text-text-2 hover:bg-surface-3 disabled:opacity-60"
          >
            {testing ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
            测试连接{(draft.kind ?? 'chat') === 'embedding' ? '(嵌入)' : ''}
          </button>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="rounded-md border border-border-1 px-3 py-1.5 text-xs text-text-2 hover:bg-surface-2"
            >
              取消
            </button>
            <button
              type="button"
              onClick={onSave}
              className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-2"
            >
              保存
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-xs">
      <span className="text-text-3">{label}</span>
      {children}
    </label>
  )
}

/**
 * RAG 说明区：展示当前是否配了 embedding 模型 + 简短解释。
 * 不暴露"默认 embedding 模型选择"——目前后端只取第一个启用的 embedding 模型；
 * 多模型选择留作后续扩展（在这里加 select 即可）。
 */
function RagHint({ models }: { models: ModelConfig[] }) {
  const embedModels = models.filter((m) => m.enabled && (m.kind ?? 'chat') === 'embedding')
  const has = embedModels.length > 0
  return (
    <div
      className={cn(
        'mb-3 rounded-md border p-3 text-xs',
        has
          ? 'border-accent/40 bg-accent/5 text-text-2'
          : 'border-warning/40 bg-warning/10 text-text-2'
      )}
    >
      <div className="mb-1 font-medium text-text-1">
        {has ? 'RAG 知识库已就绪' : '未配置 RAG 嵌入模型'}
      </div>
      <p className="text-[11px] leading-5 text-text-3">
        要在阅读器里把整本书当知识库做问答（跨页检索 + 引用来源），需要一个用途为
        <span className="px-1 font-mono text-accent">embedding</span>
        的模型。推荐：火山
        <span className="px-1 font-mono">doubao-embedding-text-240715</span>
        、OpenAI
        <span className="px-1 font-mono">text-embedding-3-small</span>
        、智谱
        <span className="px-1 font-mono">embedding-3</span>
        。添加模型时把「用途」改成「嵌入」即可。
      </p>
      {has && (
        <p className="mt-1.5 text-[11px] text-text-3">
          当前可用：
          {embedModels.map((m, i) => (
            <span key={i} className="mr-2 inline-block rounded bg-accent/15 px-1.5 py-0.5 font-mono text-accent">
              {m.name || m.model}
            </span>
          ))}
        </p>
      )}
    </div>
  )
}

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className="flex items-center gap-2 text-text-2"
    >
      <span
        className={cn(
          'flex h-4 w-7 items-center rounded-full transition-colors',
          checked ? 'bg-accent justify-end' : 'bg-surface-3 justify-start'
        )}
      >
        <span className="mx-0.5 h-3 w-3 rounded-full bg-white" />
      </span>
      {label}
    </button>
  )
}

// ════════════════════════════════════════════════════════════════════════
// v6 (2026-05) #3++ 代码运行 endpoint 配置
// ════════════════════════════════════════════════════════════════════════
//
// emkc.org Piston 公共 API 已于 2026/2/15 起改为白名单 → 401。
// 这里让用户填一个自部署 / 备用社区节点 endpoint，存到 app_prefs。
// 推荐：docker run -d --rm -p 2000:2000 ghcr.io/engineer-man/piston
//       endpoint = http://localhost:2000/api/v2/execute

const ENDPOINT_PRESETS: Array<{ id: string; label: string; url: string; hint: string }> = [
  {
    id: 'localhost',
    label: '本机自部署',
    url: 'http://localhost:2000/api/v2/execute',
    hint: '推荐 · Docker 一行起容器、零成本零限速',
  },
  {
    id: 'lan',
    label: '局域网部署',
    url: 'http://192.168.1.10:2000/api/v2/execute',
    hint: '替换成你的内网机器 IP',
  },
]

// ────────────────────────────────────────────────────────────────────────
// Docker / Piston 一键部署面板
// ────────────────────────────────────────────────────────────────────────
//
// 状态机：
//   1. docker_installed=false      → 提示装 Docker
//   2. docker_running=false        → 提示打开 Docker Desktop
//   3. container_state="not_found" → 「创建并启动」(docker run)
//   4. container_state="exited"    → 「启动容器」(docker start)
//   5. container_state="running"   → 「停止 / 安装语言 / 列出已装」

interface DiagnoseResult {
  docker_installed: boolean
  docker_running: boolean
  docker_version: string | null
  container_state: string  // 'running' | 'exited' | 'not_found' | 'error' | 'n/a'
  container_detail: string
  endpoint: string
  image: string
  container_name: string
  error: string | null
}

/// 常用语言按钮（按用户友好排序：脚本语言 → 主流编译语言 → 系统/低级 → JVM / 其他）。
/// 每个 language 字段是"用户友好名"，会通过后端 `normalize_install_language`
/// 映射成 Piston 实际包名（如 javascript→node, c/c++→gcc）。
const COMMON_RUNTIMES: Array<{ language: string; label: string }> = [
  // 脚本 / 高级
  { language: 'python', label: 'Python' },
  { language: 'javascript', label: 'JavaScript' },
  { language: 'typescript', label: 'TypeScript' },
  { language: 'ruby', label: 'Ruby' },
  { language: 'php', label: 'PHP' },
  { language: 'lua', label: 'Lua' },
  { language: 'perl', label: 'Perl' },
  { language: 'r', label: 'R' },
  // 编译 / 系统
  { language: 'c', label: 'C' },
  { language: 'c++', label: 'C++' },
  { language: 'rust', label: 'Rust' },
  { language: 'go', label: 'Go' },
  { language: 'zig', label: 'Zig' },
  { language: 'nim', label: 'Nim' },
  // JVM
  { language: 'java', label: 'Java' },
  { language: 'kotlin', label: 'Kotlin' },
  { language: 'scala', label: 'Scala' },
  // .NET / Apple
  { language: 'csharp', label: 'C#' },
  { language: 'swift', label: 'Swift' },
  // 函数式 / 学术
  { language: 'haskell', label: 'Haskell' },
  { language: 'ocaml', label: 'OCaml' },
  { language: 'elixir', label: 'Elixir' },
  { language: 'erlang', label: 'Erlang' },
  { language: 'julia', label: 'Julia' },
  { language: 'clojure', label: 'Clojure' },
  // 其他
  { language: 'dart', label: 'Dart' },
  { language: 'crystal', label: 'Crystal' },
  { language: 'bash', label: 'Bash' },
  { language: 'pwsh', label: 'PowerShell' },
]

/// 把 Piston `/runtimes` 返回的语言名规范化成 COMMON_RUNTIMES 里的按钮 key。
/// 用来判断"已装"：例如装了 Piston 包 `gcc` 之后，C 和 C++ 两个按钮都该高亮。
/// 跟后端 `runtime::normalize_install_language` 互为反向。
function pistonLangToButtonKeys(pistonLang: string): string[] {
  const l = pistonLang.toLowerCase()
  if (l === 'gcc') return ['c', 'c++']
  if (l === 'node') return ['javascript']
  if (l === 'mono' || l === 'dotnet') return ['csharp']
  if (l === 'vlang') return ['v']
  if (l === 'rscript') return ['r']
  if (l === 'pwsh') return ['pwsh']
  if (l === 'lisp') return ['lisp']
  return [l]
}

function DockerPistonPanel({ onEndpointSet }: { onEndpointSet: (url: string) => void }) {
  const [diag, setDiag] = useState<DiagnoseResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string>('') // 'start' | 'stop' | 'recreate' | 'pull' | 'install:python' …
  const [log, setLog] = useState<{ ok: boolean; msg: string } | null>(null)
  const [installed, setInstalled] = useState<Array<{ language: string; version: string }>>([])
  const [advOpen, setAdvOpen] = useState(false)
  const [containerLogs, setContainerLogs] = useState<string>('')
  const [containerPorts, setContainerPorts] = useState<string>('')
  const [customLang, setCustomLang] = useState<string>('') // 自定义安装：任意 Piston 包名

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const r = await invoke<DiagnoseResult>('docker_diagnose')
      setDiag(r)
      if (r.container_state === 'running') {
        try {
          const rt = await invoke<Array<{ language: string; version: string }>>(
            'piston_list_runtimes',
          )
          setInstalled(rt)
        } catch {
          setInstalled([])
        }
      } else {
        setInstalled([])
      }
    } catch (e) {
      setLog({ ok: false, msg: e instanceof Error ? e.message : String(e) })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const handleStart = async () => {
    setBusy('start')
    setLog(null)
    try {
      const r = await invoke<{ success: boolean; stdout: string; stderr: string; endpoint: string }>(
        'piston_container_start',
      )
      if (r.success) {
        setLog({
          ok: true,
          msg: `容器已启动 · endpoint 已自动写入：${r.endpoint}`,
        })
        onEndpointSet(r.endpoint)
      } else {
        setLog({ ok: false, msg: r.stderr || r.stdout || '启动失败（无错误信息）' })
      }
      await refresh()
    } catch (e) {
      setLog({ ok: false, msg: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy('')
    }
  }

  const handleStop = async () => {
    setBusy('stop')
    setLog(null)
    try {
      const r = await invoke<{ success: boolean; stderr: string }>('piston_container_stop')
      setLog({ ok: r.success, msg: r.success ? '容器已停止' : r.stderr || '停止失败' })
      await refresh()
    } catch (e) {
      setLog({ ok: false, msg: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy('')
    }
  }

  const handleRecreate = async () => {
    if (
      !confirm(
        '强制重建容器：将先 docker rm -f 删掉旧容器，再 docker pull 重新拉镜像，最后 docker run 创建新容器（含放宽的执行超时：运行 15s / 编译 30s）。\n\n注意：容器内已装的运行时会全部丢失，需要重新点「Python」等按钮安装。\n\n确定继续？',
      )
    )
      return
    setBusy('recreate')
    setLog(null)
    try {
      const r = await invoke<{ success: boolean; stdout: string; stderr: string; endpoint: string }>(
        'piston_container_recreate',
      )
      if (r.success) {
        setLog({
          ok: true,
          msg: `容器已重建并启动 · endpoint: ${r.endpoint}\n请等待几秒让 Piston 服务初始化，再点「测试连接」`,
        })
        onEndpointSet(r.endpoint)
      } else {
        setLog({ ok: false, msg: r.stderr || r.stdout || '重建失败（无错误信息）' })
      }
      await refresh()
    } catch (e) {
      setLog({ ok: false, msg: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy('')
    }
  }

  /// 强制重新拉取镜像（修复本地缓存损坏）。
  /// 典型场景：容器启动报 `chown: cannot access '/piston': No such file or directory`
  /// —— Docker 把镜像下载/解压中断了，本地缓存损坏。pull 一次能修复镜像层。
  /// pull 完之后用户通常需要再点「强制重建容器」让新镜像生效。
  const handlePullImage = async () => {
    if (
      !confirm(
        '重新下载 Piston 镜像：将强制 docker pull ghcr.io/engineer-man/piston:latest（约 1~2 GB）。\n\n用于修复本地镜像缓存损坏（如启动时报 "chown: cannot access /piston"）。\n\n下载不会影响正在运行的容器；下载完成后请点「强制重建容器」让新镜像生效。\n\n确定继续？',
      )
    )
      return
    setBusy('pull')
    setLog(null)
    try {
      const r = await invoke<{ success: boolean; stdout: string; stderr: string; image: string }>(
        'piston_pull_image',
      )
      if (r.success) {
        setLog({
          ok: true,
          msg: `镜像 ${r.image} 已下载到本地 · 接下来请点「强制重建容器」让新镜像生效`,
        })
      } else {
        setLog({ ok: false, msg: r.stderr || r.stdout || '拉镜像失败（无错误信息）' })
      }
      await refresh()
    } catch (e) {
      setLog({ ok: false, msg: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy('')
    }
  }

  const handleInspect = async () => {
    setBusy('inspect')
    try {
      const [logsR, portsR] = await Promise.all([
        invoke<{ stdout: string; stderr: string }>('piston_container_logs', { tail: 30 }),
        invoke<{ stdout: string; stderr: string }>('piston_container_ports'),
      ])
      const logsText = (logsR.stdout || '').trim() + (logsR.stderr ? `\n[stderr]\n${logsR.stderr.trim()}` : '')
      const portsText = (portsR.stdout || '').trim() || '(空 — 容器未绑定任何端口)'
      setContainerLogs(logsText || '(无日志)')
      setContainerPorts(portsText)
      setAdvOpen(true)
    } catch (e) {
      setLog({ ok: false, msg: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy('')
    }
  }

  const handleInstall = async (language: string) => {
    setBusy(`install:${language}`)
    setLog(null)
    try {
      const r = await invoke<{ success: boolean; stdout: string; stderr: string }>(
        'piston_install_runtime',
        { language, version: null },
      )
      setLog({
        ok: r.success,
        msg: r.success
          ? `${language} 运行时安装成功`
          : r.stderr || r.stdout || '安装失败',
      })
      await refresh()
    } catch (e) {
      setLog({ ok: false, msg: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy('')
    }
  }

  if (loading && !diag) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-border-1 bg-surface-2 px-3 py-2 text-[11.5px] text-text-3">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        正在检测 Docker 状态…
      </div>
    )
  }
  if (!diag) return null

  // 状态徽章
  const StatePill = ({ ok, text, warn }: { ok: boolean; text: string; warn?: boolean }) => (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium',
        ok
          ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
          : warn
            ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
            : 'bg-error/15 text-error',
      )}
    >
      {ok ? <CheckCircle2 className="h-3 w-3" /> : warn ? <AlertTriangle className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}
      {text}
    </span>
  )

  // 主操作按钮
  let primaryBtn: React.ReactNode = null
  if (!diag.docker_installed) {
    // Tauri webview 默认拦 `<a target="_blank">`、又没目标窗口可弹，会显得"点了没反应"。
    // 在 Tauri 桌面里走自家命令交给系统默认浏览器；其它环境（vite preview / 移动端 webview）
    // fallback 到 window.open，仍然按预期打开新标签页。
    const dockerInstallUrl = 'https://docs.docker.com/desktop/install/windows-install/'
    const handleOpenDockerInstall = async () => {
      if (isTauri()) {
        try {
          await invoke('open_external_url', { url: dockerInstallUrl })
          return
        } catch (e) {
          console.warn('[open_external_url] 失败，回退 window.open：', e)
        }
      }
      window.open(dockerInstallUrl, '_blank', 'noopener,noreferrer')
    }
    primaryBtn = (
      <button
        type="button"
        onClick={handleOpenDockerInstall}
        className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-2"
      >
        <Download className="h-3.5 w-3.5" /> 下载 Docker Desktop
      </button>
    )
  } else if (!diag.docker_running) {
    primaryBtn = (
      <button
        type="button"
        onClick={refresh}
        className="inline-flex items-center gap-1.5 rounded-md border border-border-1 bg-surface-2 px-3 py-1.5 text-xs text-text-1 hover:bg-surface-3"
      >
        <RefreshCw className="h-3.5 w-3.5" /> 我已打开 Docker · 重新检测
      </button>
    )
  } else if (diag.container_state === 'running') {
    primaryBtn = (
      <button
        type="button"
        onClick={handleStop}
        disabled={busy === 'stop'}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-md border border-border-1 bg-surface-2 px-3 py-1.5 text-xs text-text-1 hover:bg-surface-3',
          busy === 'stop' && 'cursor-not-allowed opacity-60',
        )}
      >
        {busy === 'stop' ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <PowerOff className="h-3.5 w-3.5" />
        )}
        停止容器
      </button>
    )
  } else {
    // not_found / exited
    const isFirstRun = diag.container_state === 'not_found'
    primaryBtn = (
      <button
        type="button"
        onClick={handleStart}
        disabled={busy === 'start'}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-2',
          busy === 'start' && 'cursor-not-allowed opacity-80',
        )}
      >
        {busy === 'start' ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Power className="h-3.5 w-3.5" />
        )}
        {busy === 'start'
          ? isFirstRun
            ? '正在拉镜像 + 启动（首次约 1~2 GB / 数分钟）…'
            : '启动容器…'
          : isFirstRun
            ? '一键创建并启动 Piston 容器'
            : '启动已存在的 Piston 容器'}
      </button>
    )
  }

  return (
    <div className="rounded-md border border-border-1 bg-surface-2/40 p-3">
      <div className="mb-2.5 flex flex-wrap items-center gap-1.5">
        <Container className="h-3.5 w-3.5 text-text-2" />
        <span className="text-[12px] font-medium text-text-1">Docker 一键部署</span>
        <span className="ml-auto" />
        <StatePill ok={diag.docker_installed} text={diag.docker_installed ? 'Docker 已安装' : 'Docker 未安装'} />
        {diag.docker_installed && (
          <StatePill
            ok={diag.docker_running}
            text={diag.docker_running ? 'Daemon 在跑' : 'Daemon 未启动'}
            warn={!diag.docker_running}
          />
        )}
        {diag.docker_running && (
          <StatePill
            ok={diag.container_state === 'running'}
            text={
              diag.container_state === 'running'
                ? '容器运行中'
                : diag.container_state === 'exited'
                  ? '容器已停止'
                  : diag.container_state === 'not_found'
                    ? '容器未创建'
                    : '容器状态未知'
            }
            warn={diag.container_state !== 'running'}
          />
        )}
        <button
          type="button"
          onClick={refresh}
          title="刷新状态"
          className="ml-1 rounded p-0.5 text-text-3 hover:bg-surface-3 hover:text-text-1"
        >
          <RefreshCw className={cn('h-3 w-3', loading && 'animate-spin')} />
        </button>
      </div>

      {diag.error && (
        <div className="mb-2 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-[10.5px] text-amber-700 dark:text-amber-300">
          {diag.error}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {primaryBtn}
        {diag.docker_running && diag.container_state === 'running' && (
          <span className="text-[10.5px] text-text-3">
            容器名 <code className="font-mono">{diag.container_name}</code> · endpoint{' '}
            <code className="font-mono">{diag.endpoint}</code>
          </span>
        )}
      </div>

      {/* 辅助操作：重建 / 重下镜像 / 查诊断 ——
          容器存在（exited/running）时显示"重建+查诊断"；
          首次启动失败（not_found）时也显示，让用户能用"重下镜像"修 chown 类错误。 */}
      {diag.docker_running &&
        (diag.container_state === 'running' ||
          diag.container_state === 'exited' ||
          diag.container_state === 'not_found') && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[10.5px]">
            <span className="text-text-3">疑难排查：</span>
            <button
              type="button"
              onClick={handleRecreate}
              disabled={!!busy}
              title="rm -f 旧容器 + docker pull + docker run 新容器（修复端口映射缺失 / 容器损坏）"
              className={cn(
                'inline-flex items-center gap-1 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-amber-700 dark:text-amber-400',
                busy ? 'cursor-not-allowed opacity-60' : 'hover:bg-amber-500/15',
              )}
            >
              {busy === 'recreate' ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <RefreshCw className="h-3 w-3" />
              )}
              强制重建容器
            </button>
            <button
              type="button"
              onClick={handlePullImage}
              disabled={!!busy}
              title="docker pull 强制重新下载镜像（修复本地缓存损坏，如 chown: cannot access '/piston'）"
              className={cn(
                'inline-flex items-center gap-1 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-amber-700 dark:text-amber-400',
                busy ? 'cursor-not-allowed opacity-60' : 'hover:bg-amber-500/15',
              )}
            >
              {busy === 'pull' ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Download className="h-3 w-3" />
              )}
              {busy === 'pull' ? '正在拉镜像（数分钟）…' : '重新下载镜像'}
            </button>
            {(diag.container_state === 'running' || diag.container_state === 'exited') && (
              <button
                type="button"
                onClick={handleInspect}
                disabled={!!busy}
                className={cn(
                  'inline-flex items-center gap-1 rounded border border-border-1 bg-surface-1 px-2 py-0.5 text-text-2',
                  busy ? 'cursor-not-allowed opacity-60' : 'hover:bg-surface-3',
                )}
              >
                {busy === 'inspect' ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Terminal className="h-3 w-3" />
                )}
                查看容器日志 / 端口
              </button>
            )}
          </div>
        )}

      {/* 高级诊断面板（容器日志 + 端口绑定） */}
      {advOpen && (containerLogs || containerPorts) && (
        <div className="mt-2 rounded-md border border-border-1 bg-surface-1 p-2">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-[11px] font-medium text-text-1">容器诊断信息</span>
            <button
              type="button"
              onClick={() => setAdvOpen(false)}
              className="rounded p-0.5 text-text-3 hover:bg-surface-3"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
          <div className="mb-2">
            <div className="mb-0.5 text-[10px] font-medium text-text-3">
              docker port {diag.container_name}
            </div>
            <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded border border-border-1 bg-surface-2 p-1.5 font-mono text-[10px] text-text-1">
              {containerPorts}
            </pre>
            {!containerPorts.includes('->') && (
              <p className="mt-1 text-[10px] text-amber-600 dark:text-amber-400">
                ⚠ 容器没有端口映射 → 请点上方「强制重建容器」修复
              </p>
            )}
          </div>
          <div>
            <div className="mb-0.5 text-[10px] font-medium text-text-3">
              docker logs --tail 30
            </div>
            <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all rounded border border-border-1 bg-surface-2 p-1.5 font-mono text-[10px] text-text-1">
              {containerLogs}
            </pre>
          </div>
        </div>
      )}

      {/* 已装运行时 + 安装按钮（仅 running 时显示） */}
      {diag.container_state === 'running' && (
        <div className="mt-3 border-t border-border-1 pt-3">
          <div className="mb-1.5 flex items-center justify-between text-[11px]">
            <span className="font-medium text-text-2">已装运行时</span>
            <span className="text-[10px] text-text-3">{installed.length} 个</span>
          </div>
          {installed.length > 0 ? (
            <div className="mb-2 flex flex-wrap gap-1">
              {installed.map((rt, i) => (
                <span
                  key={`${rt.language}-${rt.version}-${i}`}
                  className="inline-flex items-center gap-1 rounded-md bg-emerald-500/12 px-1.5 py-0.5 font-mono text-[10.5px] text-emerald-700 dark:text-emerald-300"
                >
                  <CheckCircle2 className="h-2.5 w-2.5" />
                  {rt.language} {rt.version}
                </span>
              ))}
            </div>
          ) : (
            <p className="mb-2 text-[10.5px] text-text-3">
              容器内还没装任何语言运行时。代码题需要装至少一种（推荐先装 Python）。
            </p>
          )}
          <div className="flex flex-wrap gap-1">
            {COMMON_RUNTIMES.map((rt) => {
              // 判断已装：把 Piston 返回的包名（如 gcc / node）映射成按钮 key 集合,
              // 任何映射结果包含当前按钮 key 即视为已装（C 和 C++ 共用 gcc 包）。
              const has = installed.some((x) =>
                pistonLangToButtonKeys(x.language).includes(rt.language),
              )
              const installing = busy === `install:${rt.language}`
              return (
                <button
                  key={rt.language}
                  type="button"
                  onClick={() => handleInstall(rt.language)}
                  disabled={!!busy || has}
                  title={has ? '已安装' : `装最新版的 ${rt.label}`}
                  className={cn(
                    'inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[10.5px] transition',
                    has
                      ? 'cursor-default border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                      : busy
                        ? 'cursor-not-allowed border-border-1 bg-surface-2 text-text-3'
                        : 'border-border-1 bg-surface-1 text-text-2 hover:bg-surface-3',
                  )}
                >
                  {installing ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : has ? (
                    <CheckCircle2 className="h-3 w-3" />
                  ) : (
                    <Download className="h-3 w-3" />
                  )}
                  {rt.label}
                </button>
              )
            })}
          </div>

          {/* 自定义安装：装任意 Piston 包（Piston 总共支持 50+ 语言，常用的已经在上面按钮里）。
              用户输入包名（如 cobol / fortran / dotnet / racket）+ 可选版本号。 */}
          <div className="mt-2 flex flex-wrap items-center gap-1 text-[10.5px]">
            <span className="text-text-3">其他语言：</span>
            <input
              type="text"
              value={customLang}
              onChange={(e) => setCustomLang(e.target.value)}
              placeholder="包名 (如 cobol, racket, julia, fortran)"
              disabled={!!busy}
              className="min-w-[200px] flex-1 rounded border border-border-1 bg-surface-1 px-1.5 py-0.5 text-[10.5px] text-text-1 placeholder:text-text-3 focus:border-accent focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && customLang.trim() && !busy) {
                  e.preventDefault()
                  handleInstall(customLang.trim())
                }
              }}
            />
            <button
              type="button"
              disabled={!customLang.trim() || !!busy}
              onClick={() => handleInstall(customLang.trim())}
              className={cn(
                'inline-flex items-center gap-1 rounded border border-border-1 bg-surface-2 px-2 py-0.5 text-text-2',
                !customLang.trim() || busy
                  ? 'cursor-not-allowed opacity-60'
                  : 'hover:bg-surface-3',
              )}
              title="装任意 Piston 包；包名必须与 GET /api/v2/packages 返回的 language 字段一致"
            >
              {busy === `install:${customLang.trim()}` ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Download className="h-3 w-3" />
              )}
              安装
            </button>
            <a
              href="https://github.com/engineer-man/piston/tree/master/packages"
              target="_blank"
              rel="noreferrer"
              className="text-text-3 underline hover:text-text-2"
              title="所有可装的 Piston 包列表"
            >
              查看可装语言
            </a>
          </div>
        </div>
      )}

      {/* 操作日志反馈 */}
      {log && (
        <div
          className={cn(
            'mt-2 flex items-start gap-1.5 rounded border px-2 py-1.5 text-[10.5px]',
            log.ok
              ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
              : 'border-error/40 bg-error/10 text-error',
          )}
        >
          {log.ok ? (
            <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0" />
          ) : (
            <XCircle className="mt-0.5 h-3 w-3 shrink-0" />
          )}
          <span className="whitespace-pre-wrap break-all">{log.msg}</span>
        </div>
      )}
    </div>
  )
}

interface TestStep {
  step: string
  label: string
  ok: boolean
  detail: string
}

function CodeRunnerSection() {
  const [endpoint, setEndpoint] = useState('')
  const [originalEndpoint, setOriginalEndpoint] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string; steps?: TestStep[] } | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const v = await invoke<string | null>('app_prefs_get', { key: 'code_runner.endpoint' })
        if (cancelled) return
        const cur = (v ?? '').toString()
        setEndpoint(cur)
        setOriginalEndpoint(cur)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const dirty = endpoint.trim() !== originalEndpoint.trim()

  const save = async () => {
    setSaving(true)
    try {
      await invoke('app_prefs_set', {
        key: 'code_runner.endpoint',
        value: endpoint.trim(),
      })
      setOriginalEndpoint(endpoint.trim())
    } catch (e) {
      setTestResult({ ok: false, msg: e instanceof Error ? e.message : String(e) })
    } finally {
      setSaving(false)
    }
  }

  const test = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const r = await invoke<{
        ok: boolean
        endpoint: string
        message: string
        steps?: TestStep[]
      }>('code_runner_test', { endpointOverride: endpoint.trim() || null })
      setTestResult({ ok: r.ok, msg: r.message, steps: r.steps })
    } catch (e) {
      setTestResult({ ok: false, msg: e instanceof Error ? e.message : String(e) })
    } finally {
      setTesting(false)
    }
  }

  return (
    <section className="px-8 pb-2 pt-6">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-text-2">
          <Terminal className="h-3.5 w-3.5" /> 代码运行（Piston endpoint）
        </h2>
        {originalEndpoint ? (
          <span className="text-[11px] text-emerald-500">已配置</span>
        ) : (
          <span className="text-[11px] text-amber-500">未配置 · 代码题无法运行</span>
        )}
      </div>

      <div className="rounded-md border border-border-1 bg-surface-1 p-4">
        <p className="mb-3 text-[11.5px] leading-relaxed text-text-3">
          <span className="font-medium text-text-2">为什么需要配置？</span>{' '}
          emkc.org 公共 Piston API 已于 2026/2/15 改为白名单访问 → 默认 401。
        </p>

        {/* v6 (2026-05) #3++ Docker 一键部署面板 */}
        <DockerPistonPanel onEndpointSet={(url) => setEndpoint(url)} />

        <div className="my-4 flex items-center gap-2 text-[10.5px] text-text-3">
          <span className="h-px flex-1 bg-border-1" />
          或者自填一个 endpoint URL
          <span className="h-px flex-1 bg-border-1" />
        </div>

        {/* 预设按钮 */}
        <div className="mb-3 flex flex-wrap gap-1.5">
          {ENDPOINT_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => setEndpoint(p.url)}
              title={p.hint}
              className="inline-flex items-center gap-1 rounded-md border border-border-1 bg-surface-2 px-2 py-1 text-[11px] text-text-2 hover:bg-surface-3"
            >
              <Zap className="h-3 w-3 text-amber-500" />
              {p.label}
            </button>
          ))}
        </div>

        {/* endpoint 输入框 */}
        <label className="mb-1 block text-[11px] font-medium text-text-2">Endpoint URL</label>
        <input
          type="text"
          value={endpoint}
          onChange={(e) => setEndpoint(e.target.value)}
          placeholder="http://localhost:2000/api/v2/execute"
          disabled={loading}
          className="w-full rounded-md border border-border-1 bg-surface-2 px-3 py-2 font-mono text-xs text-text-1 placeholder:text-text-3 focus:border-accent focus:outline-none"
        />
        <p className="mt-1 text-[10.5px] text-text-3">
          完整 URL，需要包含 <code className="font-mono">/api/v2/execute</code> 路径。留空即停用真实运行（仅 LLM 模拟评分）。
        </p>

        {/* 操作按钮 */}
        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            onClick={test}
            disabled={testing || !endpoint.trim()}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs transition',
              testing || !endpoint.trim()
                ? 'cursor-not-allowed border-border-1 text-text-3'
                : 'border-border-1 bg-surface-2 text-text-1 hover:bg-surface-3',
            )}
          >
            {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
            测试连接
          </button>
          <button
            type="button"
            onClick={save}
            disabled={saving || !dirty}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition',
              saving || !dirty
                ? 'cursor-not-allowed bg-surface-3 text-text-3'
                : 'bg-accent text-white hover:bg-accent-2',
            )}
          >
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            {dirty ? '保存' : '已保存'}
          </button>
        </div>

        {/* 测试结果 —— 含分步骤诊断（TCP 探测 → HTTP 跑代码） */}
        {testResult && (
          <div className="mt-3 space-y-2">
            {/* 分步骤详情（如果有） */}
            {testResult.steps && testResult.steps.length > 0 && (
              <div className="rounded-md border border-border-1 bg-surface-2 px-3 py-2">
                <div className="mb-1.5 text-[10.5px] font-medium text-text-3">诊断步骤</div>
                <ul className="space-y-1">
                  {testResult.steps.map((s, i) => (
                    <li key={i} className="flex items-start gap-2 text-[11px]">
                      {s.ok ? (
                        <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-emerald-500" />
                      ) : (
                        <XCircle className="mt-0.5 h-3 w-3 shrink-0 text-error" />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="font-medium text-text-1">{s.label}</div>
                        <div className="break-all text-[10.5px] text-text-3">{s.detail}</div>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {/* 总体结果 */}
            <div
              className={cn(
                'flex items-start gap-2 rounded-md border px-3 py-2 text-[11.5px]',
                testResult.ok
                  ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                  : 'border-error/40 bg-error/10 text-error',
              )}
            >
              {testResult.ok ? (
                <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              ) : (
                <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              )}
              <span className="whitespace-pre-wrap break-all">{testResult.msg}</span>
            </div>
          </div>
        )}
      </div>
    </section>
  )
}

const MD_PREVIEW = `# 标题一：Markdown 主题预览

这是一段普通段落。**加粗**、*斜体*、~~删除线~~ 与 [链接](#) 都会按主题表现。

> 引用块：每个主题的引用样式可能完全不同，比如学术体会变成斜体居中、Obsidian 会出现灯泡图标、报纸会变成上下双横线。

## 标题二：列表与代码

- 项目一
- 项目二
  - 嵌套项
- [x] 完成的任务
- [ ] 未完成

\`\`\`python
def fib(n: int) -> int:
    if n < 2:
        return n
    return fib(n - 1) + fib(n - 2)
\`\`\`

## 标题三：表格与公式

| 维度 | 默认 | 学术 | 报纸 |
|------|:----:|:----:|:----:|
| 字体 | 无衬线 | 衬线 | 衬线 |
| 对齐 | 左对齐 | 两端对齐 | 两端对齐 |
| 列数 | 单列 | 单列 | 双列 |

行内公式 $E = mc^2$，块级公式：

$$
\\int_0^\\infty e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}
$$
`
