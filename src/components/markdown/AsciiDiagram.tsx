/**
 * AsciiDiagram —— 高级 ASCII 流程图 / 框线图渲染组件
 *
 * 目的：把 AI 生成的 ASCII art 流程图（包含 ┌─┐│└┘├┤┬┴┼ 或 →←↑↓ 等字符）
 * 从普通 <pre> 升级为有标签栏 + dot-grid 背景 + 字符着色的"工程图纸"风格。
 *
 * 触发条件由 `isAsciiDiagram()` 决定（在 MarkdownView 里调用）：
 *   1. 显式 language：ascii / diagram / flow / flowchart / box / chart
 *   2. 内容包含 ≥ 3 个 Unicode box-drawing 字符 (U+2500–257F)
 *   3. 内容包含 ≥ 2 个箭头字符 (→ ← ↑ ↓ ⇒ ⇐ ⇑ ⇓ ▶ ◀ ▲ ▼)
 *   4. 内容包含 ≥ 2 个 ASCII flowchart 模式（`+--+` `|` 同列对齐 + `-->`）
 *
 * 字符着色用 SSR-safe 的 React 节点（而非 dangerouslySetInnerHTML），
 * 按 token 类型分类：
 *   - box      : 框线字符 ─│┌┐└┘├┤┬┴┼ + ASCII +-|=/\
 *   - arrow    : 箭头字符 (单 unicode arrow 或 ASCII -->, ==>, <->, etc.)
 *   - label    : 标识符 [A-Za-z0-9_中文]
 *   - num      : 纯数字
 *   - punct    : 标点 ()[]:.,;=
 *   - space    : 空白（不包 span，直接保留）
 *
 * 字体着色样式在 markdown.css 的 `.md-ascii .ascii-*` 中定义。
 */
import { memo, useMemo, useRef, useState } from 'react'
import { Check, Code2, Copy, Workflow } from 'lucide-react'
import { cn } from '@/lib/cn'
import { parseAsciiGraph } from './asciiToSvg'
import { AsciiSvgRenderer } from './AsciiSvgRenderer'

// ─────── 检测正则与字符集 ────────────────────────────────────────────────
// box-drawing：U+2500 至 U+257F
const BOX_DRAWING_RE = /[\u2500-\u257F]/g
// 箭头字符（含粗箭头 / 实心三角箭头）
const ARROW_RE = /[\u2190-\u2193\u21D0-\u21D3\u25B6\u25C0\u25B2\u25BC\u21B3\u21B4]/g
// ASCII 流程图典型模式：`+--+`/`+==+`/`+--`/`--+`，以及 `-->`/`<--`/`==>`/`<==`
const ASCII_BOX_PAT = /\+[-=][-=]+\+|\+[-=]+|[-=]+\+|\|.*\|/g
const ASCII_ARROW_PAT = /-->|<--|==>|<==|->|<-/g

/** 判断一段代码块是否应走"高级 ASCII 渲染"。 */
export function isAsciiDiagram(text: string, language?: string): boolean {
  // 1) 显式语言标识
  if (language) {
    const l = language.toLowerCase()
    if (l === 'ascii' || l === 'diagram' || l === 'flow' || l === 'flowchart' || l === 'box' || l === 'chart') {
      return true
    }
    // 已知语言（有 hljs 高亮的）一律不走 ASCII 渲染
    // 这里只列常见编程语言，避免误判
    if (
      l === 'js' || l === 'javascript' || l === 'ts' || l === 'typescript' ||
      l === 'py' || l === 'python' || l === 'rs' || l === 'rust' ||
      l === 'go' || l === 'java' || l === 'kotlin' || l === 'swift' ||
      l === 'c' || l === 'cpp' || l === 'cs' || l === 'php' || l === 'rb' ||
      l === 'sh' || l === 'bash' || l === 'zsh' || l === 'fish' ||
      l === 'html' || l === 'css' || l === 'scss' || l === 'less' ||
      l === 'json' || l === 'yaml' || l === 'yml' || l === 'toml' || l === 'xml' ||
      l === 'sql' || l === 'graphql' || l === 'md' || l === 'markdown'
    ) {
      return false
    }
  }
  // 2) Unicode box-drawing 字符 ≥ 3
  const boxMatches = text.match(BOX_DRAWING_RE)
  if (boxMatches && boxMatches.length >= 3) return true
  // 3) 箭头字符 ≥ 2
  const arrowMatches = text.match(ARROW_RE)
  if (arrowMatches && arrowMatches.length >= 2) return true
  // 4) ASCII flowchart 模式：典型框线 ≥ 2 个 + 至少 1 个 ASCII 箭头
  const asciiBoxes = text.match(ASCII_BOX_PAT)?.length ?? 0
  const asciiArrows = text.match(ASCII_ARROW_PAT)?.length ?? 0
  if (asciiBoxes >= 2 && asciiArrows >= 1) return true
  return false
}

// ─────── 字符 token 化（每行独立处理，保持等宽对齐） ─────────────────────
// 单字符分类。返回一个 className（如 'ascii-box'），或 '' 表示不需要 span 包裹。
function classifyChar(ch: string): '' | 'ascii-box' | 'ascii-arrow' | 'ascii-label' | 'ascii-num' | 'ascii-punct' {
  if (ch === ' ' || ch === '\t') return ''
  const code = ch.charCodeAt(0)
  // box-drawing block
  if (code >= 0x2500 && code <= 0x257f) return 'ascii-box'
  // arrows
  if (
    (code >= 0x2190 && code <= 0x2193) ||
    (code >= 0x21d0 && code <= 0x21d3) ||
    code === 0x25b6 || code === 0x25c0 || code === 0x25b2 || code === 0x25bc ||
    code === 0x21b3 || code === 0x21b4
  ) return 'ascii-arrow'
  // ASCII 框线相关字符
  if (ch === '+' || ch === '-' || ch === '|' || ch === '=' || ch === '/' || ch === '\\') return 'ascii-box'
  // 数字
  if (ch >= '0' && ch <= '9') return 'ascii-num'
  // 标点
  if ('()[]{}:.,;'.includes(ch)) return 'ascii-punct'
  // 字母 / 中文 / 下划线 → label
  if (
    (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_' ||
    (code >= 0x4e00 && code <= 0x9fff)
  ) return 'ascii-label'
  return ''
}

/** 把一行字符串切成 token 段：相同 class 的连续字符合并为一段。 */
function tokenizeLine(line: string): Array<{ cls: string; text: string }> {
  if (!line) return [{ cls: '', text: '' }]
  const out: Array<{ cls: string; text: string }> = []
  let curCls = classifyChar(line[0])
  let buf = line[0]
  // 单独处理 ASCII 多字符箭头：先把 -->、<--、==>、<== 替换标记
  // 但 tokenize 是字符级的，多字符箭头会被拆开。为了正确性，我们二次扫描
  // —— 但 css 着色对每段 box-drawing 字符也已经 OK（箭头里的 -- 算 box，> 算 punct）。
  // 这里宁可让 ASCII 箭头被着成 box+punct（视觉上仍能识别为箭头），保持代码简单。
  for (let i = 1; i < line.length; i++) {
    const cls = classifyChar(line[i])
    if (cls === curCls) {
      buf += line[i]
    } else {
      out.push({ cls: curCls, text: buf })
      curCls = cls
      buf = line[i]
    }
  }
  out.push({ cls: curCls, text: buf })
  return out
}

interface Props {
  /** 原始代码文本（包含换行） */
  code: string
  /** fenced code 的 language 标识（用于 lang 徽章显示） */
  language?: string
  /** 标题：默认根据 language 推断 */
  title?: string
  className?: string
}

function AsciiDiagramImpl({ code, language, title, className }: Props) {
  const preRef = useRef<HTMLPreElement>(null)
  const [copied, setCopied] = useState(false)

  // v6 (2026-05) #4: 先尝试 ASCII → SVG 拓扑解析。成功 → 默认走 SVG
  // 可视化区；失败 → 回退到原字符着色渲染（兜底）。
  const graph = useMemo(() => parseAsciiGraph(code), [code])
  // 用户切换：SVG 模式 / 字符模式（即便解析成功也允许手动切回看原始字符）
  const [mode, setMode] = useState<'svg' | 'chars'>(graph ? 'svg' : 'chars')

  // tokenize：按行拆，再按字符 class 合并段。性能开销在 code 文本量 ~ KB 级。
  // 用 useMemo 缓存避免每次主题切换/复制状态变化都重算。
  const lines = useMemo(() => {
    // 移除末尾多余空行
    const cleaned = code.replace(/\s+$/, '')
    return cleaned.split('\n').map(tokenizeLine)
  }, [code])

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      // fallback for non-secure context
      try {
        const ta = document.createElement('textarea')
        ta.value = code
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        document.body.removeChild(ta)
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1500)
      } catch {
        /* ignore */
      }
    }
  }

  // 标题：用户传 title 优先；否则按 language 推断；最后兜底
  const displayTitle =
    title ??
    (language === 'flow' || language === 'flowchart'
      ? 'Flowchart'
      : language === 'diagram'
        ? 'Diagram'
        : language === 'box'
          ? 'Box Diagram'
          : language === 'chart'
            ? 'Chart'
            : 'ASCII Diagram')

  // v6 #4: 整体外观从'代码区'升级为'可视化图示区'：
  //   - 默认 SVG 模式：清爽的工程图风格（不再是 IDE 黑窗 + 三圆点）
  //   - 字符模式：保留原着色渲染作为 fallback / 调试视图
  return (
    <div
      className={cn(
        'md-ascii md-ascii-v2 not-prose',
        mode === 'svg' && 'md-ascii-mode-svg',
        mode === 'chars' && 'md-ascii-mode-chars',
        className,
      )}
      role="figure"
      aria-label={displayTitle}
    >
      {/* 顶部工具条：左侧图标 + 标题，右侧模式切换 + 复制 */}
      <div className="md-ascii-bar">
        <span className="md-ascii-icon" aria-hidden="true">
          <Workflow className="h-3.5 w-3.5" />
        </span>
        <span className="md-ascii-title">{displayTitle}</span>
        {language && <span className="md-ascii-lang">{language}</span>}
        <div className="md-ascii-actions">
          {graph && (
            <div className="md-ascii-modes" role="tablist" aria-label="渲染模式">
              <button
                type="button"
                role="tab"
                aria-selected={mode === 'svg'}
                onClick={() => setMode('svg')}
                className={cn('md-ascii-mode-btn', mode === 'svg' && 'is-active')}
                title="SVG 可视化"
              >
                <Workflow className="h-3 w-3" />
                <span>图形</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={mode === 'chars'}
                onClick={() => setMode('chars')}
                className={cn('md-ascii-mode-btn', mode === 'chars' && 'is-active')}
                title="字符原图"
              >
                <Code2 className="h-3 w-3" />
                <span>字符</span>
              </button>
            </div>
          )}
          <button
            type="button"
            onClick={onCopy}
            aria-label={copied ? '已复制' : '复制 ASCII 图'}
            title={copied ? '已复制' : '复制'}
            className="md-ascii-copy"
          >
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>
      {/* 主体 */}
      <div className="md-ascii-body">
        {mode === 'svg' && graph ? (
          <AsciiSvgRenderer graph={graph} />
        ) : (
          <pre ref={preRef}>
            <code>
              {lines.map((tokens, lineIdx) => (
                <span key={lineIdx} className="ascii-line">
                  {tokens.map((t, i) =>
                    t.cls ? (
                      <span key={i} className={t.cls}>
                        {t.text}
                      </span>
                    ) : (
                      // 空白 / 未分类字符不包 span，避免 DOM 膨胀且对齐稳定
                      t.text
                    ),
                  )}
                  {lineIdx < lines.length - 1 && '\n'}
                </span>
              ))}
            </code>
          </pre>
        )}
      </div>
    </div>
  )
}

export const AsciiDiagram = memo(AsciiDiagramImpl)
