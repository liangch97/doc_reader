/**
 * SkillsPage — 全局技能字典管理（v4 2026-05 P4.1）
 *
 * 用户决策：技能颗粒度 = 「C 全自由 + 用户手动合并/重命名」。
 *   - 每次 training_generate_pack 后 LLM 可自由命名 skill_id；
 *     后端 ensure 到 user_skills 表；用户在此页统一管理。
 *
 * 三大动作：
 *   1. **重命名 / 改类别**：双击 cell → inline 编辑 → blur 保存
 *   2. **合并**：选两个 skill → "合并到目标"
 *      （UI: 在表格头部加"选两行后启用合并按钮"）
 *   3. **删除**：confirm + 危险红色按钮
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertCircle,
  Check,
  ChevronDown,
  ChevronRight,
  Edit3,
  GitMerge,
  LayoutList,
  ListTree,
  Loader2,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
  Wand2,
  X,
} from 'lucide-react'
import { invoke } from '@/lib/tauri'
import { cn } from '@/lib/cn'

// v6 (2026-05) #3++ 树形视图：LLM 会把 category 字段重组成 「领域 / 子领域 / 细分」
// 路径式字符串，前端按 ` / ` 划分递归建树。
const CATEGORY_SEP = ' / '

interface TreeNode {
  /** 该节点名称（路径最后一段） */
  name: string
  /** 完整路径，用作 key + 折叠 state 索引 */
  path: string
  /** 子节点。拉中间节点时为“子路径”；叶子节点为空。 */
  children: TreeNode[]
  /** 落到该节点路径下的技能（仅“路径末端”节点会填，中间节点留空） */
  skills: UserSkill[]
}

/** 把一串 categoryPath / 叶子 skill 递归插入树。 */
function insertIntoTree(roots: TreeNode[], parts: string[], skill: UserSkill) {
  if (parts.length === 0) return
  const [head, ...rest] = parts
  let node = roots.find((n) => n.name === head)
  if (!node) {
    node = { name: head, path: head, children: [], skills: [] }
    roots.push(node)
  }
  if (rest.length === 0) {
    node.skills.push(skill)
  } else {
    insertIntoTree(node.children, rest, skill)
    // 修复子节点 path 为全路径
    for (const c of node.children) {
      if (!c.path.includes(CATEGORY_SEP)) c.path = `${node.path}${CATEGORY_SEP}${c.name}`
    }
  }
}

/** 从平铺 skill 列表构建多根树（同根可多个，名称重复合并）。 */
function buildTree(skills: UserSkill[]): TreeNode[] {
  const roots: TreeNode[] = []
  for (const s of skills) {
    const raw = s.category.trim() || '未分类'
    const parts = raw
      .split(CATEGORY_SEP)
      .map((x) => x.trim())
      .filter((x) => x.length > 0)
    insertIntoTree(roots, parts.length > 0 ? parts : ['未分类'], s)
  }
  // 递归修复全路径
  const fix = (nodes: TreeNode[], parent: string) => {
    for (const n of nodes) {
      n.path = parent ? `${parent}${CATEGORY_SEP}${n.name}` : n.name
      fix(n.children, n.path)
    }
  }
  fix(roots, '')
  // 按名称排序
  const sortRec = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => a.name.localeCompare(b.name, 'zh'))
    nodes.forEach((n) => sortRec(n.children))
  }
  sortRec(roots)
  return roots
}

interface UserSkill {
  skill_id: string
  name: string
  category: string
  description: string
  avg_mastery: number
  sessions_count: number
  total_attempts: number
}

type EditState =
  | { kind: 'idle' }
  | { kind: 'editing'; skill_id: string; field: 'name' | 'category' | 'description'; draft: string }

export default function SkillsPage() {
  const [skills, setSkills] = useState<UserSkill[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [edit, setEdit] = useState<EditState>({ kind: 'idle' })
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [mergeMode, setMergeMode] = useState(false)
  const [confirmDel, setConfirmDel] = useState<string | null>(null)
  // v6 (2026-05) #3++ 视图 + AI 重组
  const [view, setView] = useState<'flat' | 'tree'>('tree')
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const [reorganizing, setReorganizing] = useState(false)
  const [reorgMsg, setReorgMsg] = useState('')

  const toggleNode = (path: string) => {
    setCollapsed((cur) => {
      const next = new Set(cur)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const reorganizeTree = useCallback(async () => {
    if (skills.length === 0) return
    if (!window.confirm(`让 AI 重新整理全部 ${skills.length} 个技能的分类路径？\n\n只会修改「分类」字段，名称 / 描述 / 掌握度不变。`)) return
    setReorganizing(true)
    setReorgMsg('')
    setError('')
    try {
      const r = await invoke<{ updated: number; tree_size: number }>('skills_reorganize_tree')
      setReorgMsg(`AI 已将 ${r.updated} 个技能重新归类到 ${r.tree_size} 个分支`)
      setTimeout(() => setReorgMsg(''), 4000)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setReorganizing(false)
    }
    void refresh()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skills.length])

  const refresh = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const list = await invoke<UserSkill[]>('skills_list')
      setSkills(list ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // 过滤后的技能列表（同时应用于平铺和树形）
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return skills
    return skills.filter(
      (s) =>
        s.skill_id.toLowerCase().includes(q) ||
        s.name.toLowerCase().includes(q) ||
        s.category.toLowerCase().includes(q),
    )
  }, [skills, query])

  // 平铺视图：按 category 分组
  const grouped = useMemo(() => {
    const map = new Map<string, UserSkill[]>()
    for (const s of filtered) {
      const k = s.category || '未分类'
      if (!map.has(k)) map.set(k, [])
      map.get(k)!.push(s)
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b, 'zh'))
  }, [filtered])

  // 树形视图：完整多根树
  const tree = useMemo(() => buildTree(filtered), [filtered])

  const startEdit = (s: UserSkill, field: 'name' | 'category' | 'description') => {
    const draft = field === 'name' ? s.name : field === 'category' ? s.category : s.description
    setEdit({ kind: 'editing', skill_id: s.skill_id, field, draft })
  }
  const cancelEdit = () => setEdit({ kind: 'idle' })
  const commitEdit = async () => {
    if (edit.kind !== 'editing') return
    const { skill_id, field, draft } = edit
    setEdit({ kind: 'idle' })
    try {
      const args: Record<string, unknown> = { skillId: skill_id }
      if (field === 'name') args.name = draft
      else if (field === 'category') args.category = draft
      else if (field === 'description') args.description = draft
      await invoke('skills_update', args)
      void refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const toggleSelect = (skill_id: string) => {
    setSelected((cur) => {
      const next = new Set(cur)
      if (next.has(skill_id)) next.delete(skill_id)
      else next.add(skill_id)
      return next
    })
  }
  const exitMergeMode = () => {
    setMergeMode(false)
    setSelected(new Set())
  }
  const doMerge = async (targetId: string) => {
    // 把所有 selected (除 target) 合并到 target
    const others = Array.from(selected).filter((s) => s !== targetId)
    if (others.length === 0) return
    try {
      for (const from of others) {
        await invoke('skills_merge', { fromId: from, toId: targetId })
      }
      exitMergeMode()
      void refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const doDelete = async (skill_id: string) => {
    try {
      await invoke('skills_delete', { skillId: skill_id })
      setConfirmDel(null)
      void refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-bg">
      {/* ╔═══ 顶部 hero ═══╗ */}
      <header className="shrink-0 border-b border-border-1 bg-bg-1 px-6 py-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-[18px] font-bold text-text-1">
              <Sparkles className="size-4 text-blue-500" />
              技能树管理
            </h1>
            <p className="mt-0.5 text-[12px] text-text-3">
              所有训练涉及的技能都会出现在这里 — 你可以重命名、合并相似项、删除不再需要的
            </p>
          </div>
          <div className="flex items-center gap-2">
            {/* v6 #3++ 视图切换 */}
            <div className="inline-flex items-center rounded-md border border-border-1 bg-bg-1 p-0.5">
              <button
                type="button"
                onClick={() => setView('tree')}
                className={cn(
                  'inline-flex items-center gap-1 rounded px-2 py-1 text-[11.5px] transition',
                  view === 'tree'
                    ? 'bg-blue-500/10 text-blue-600 dark:text-blue-400'
                    : 'text-text-3 hover:text-text-2',
                )}
                title="树形视图"
              >
                <ListTree className="size-3" /> 树形
              </button>
              <button
                type="button"
                onClick={() => setView('flat')}
                className={cn(
                  'inline-flex items-center gap-1 rounded px-2 py-1 text-[11.5px] transition',
                  view === 'flat'
                    ? 'bg-blue-500/10 text-blue-600 dark:text-blue-400'
                    : 'text-text-3 hover:text-text-2',
                )}
                title="平铺视图（按 category 一级分组）"
              >
                <LayoutList className="size-3" /> 平铺
              </button>
            </div>
            {/* v6 #3++ AI 整理树 */}
            <button
              type="button"
              onClick={() => void reorganizeTree()}
              disabled={reorganizing || skills.length === 0}
              className="inline-flex items-center gap-1 rounded-md border border-indigo-500/40 bg-indigo-500/8 px-2.5 py-1.5 text-[12px] font-medium text-indigo-600 transition hover:bg-indigo-500/15 disabled:opacity-50 dark:text-indigo-400"
              title="让 LLM 把所有技能重新归类到层级树（只改 category 字段）"
            >
              {reorganizing ? <Loader2 className="size-3 animate-spin" /> : <Wand2 className="size-3" />}
              {reorganizing ? '整理中…' : 'AI 整理树'}
            </button>
            <button
              type="button"
              onClick={() => void refresh()}
              disabled={loading}
              className="inline-flex items-center gap-1 rounded-md border border-border-1 bg-bg-1 px-2.5 py-1.5 text-[12px] text-text-2 hover:bg-bg-2/60 disabled:opacity-50"
            >
              {loading ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
              刷新
            </button>
            {mergeMode ? (
              <button
                type="button"
                onClick={exitMergeMode}
                className="inline-flex items-center gap-1 rounded-md border border-border-1 bg-bg-1 px-2.5 py-1.5 text-[12px] text-text-2 hover:bg-bg-2/60"
              >
                <X className="size-3" /> 退出合并
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setMergeMode(true)}
                disabled={skills.length < 2}
                className="inline-flex items-center gap-1 rounded-md bg-purple-500 px-2.5 py-1.5 text-[12px] font-medium text-white shadow-sm shadow-purple-500/30 transition hover:bg-purple-600 disabled:opacity-50"
              >
                <GitMerge className="size-3" /> 进入合并模式
              </button>
            )}
          </div>
        </div>

        {/* 搜索栏 */}
        <div className="mt-3 flex items-center gap-2">
          <div className="relative flex-1 max-w-xs">
            <Search className="absolute left-2 top-1/2 size-3 -translate-y-1/2 text-text-3" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索 skill_id / 名称 / 类别…"
              className="w-full rounded-md border border-border-2 bg-bg-2/40 py-1 pl-7 pr-2 text-[12px] text-text-1 placeholder:text-text-3 focus:border-blue-500/50 focus:outline-none"
            />
          </div>
          <span className="text-[11px] text-text-3">共 {skills.length} 个技能</span>
          {mergeMode && (
            <span className="ml-auto text-[11px] text-purple-600 dark:text-purple-400">
              合并模式：勾选 2+ 个技能，然后点击"合并到该项"
            </span>
          )}
        </div>
      </header>

      {error && (
        <div className="shrink-0 border-b border-border-1 bg-rose-500/10 px-4 py-2 text-[12px] text-rose-600 dark:text-rose-400">
          <AlertCircle className="mr-1 inline size-3" /> {error}
        </div>
      )}
      {reorgMsg && (
        <div className="shrink-0 border-b border-border-1 bg-emerald-500/10 px-4 py-2 text-[12px] text-emerald-600 dark:text-emerald-400">
          <Check className="mr-1 inline size-3" /> {reorgMsg}
        </div>
      )}

      {/* ╔═══ 主体：树形 / 平铺 ═══╗ */}
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        {filtered.length === 0 ? (
          <div className="flex h-full items-center justify-center text-[12px] text-text-3">
            {loading ? '加载中…' : '还没有技能。先去训练板块做几次答题，LLM 会自动归类填充。'}
          </div>
        ) : view === 'tree' ? (
          <TreeView
            nodes={tree}
            collapsed={collapsed}
            onToggle={toggleNode}
            mergeMode={mergeMode}
            selected={selected}
            toggleSelect={toggleSelect}
            doMerge={doMerge}
            confirmDel={confirmDel}
            setConfirmDel={setConfirmDel}
            doDelete={doDelete}
          />
        ) : (
          grouped.map(([category, list]) => (
            <section key={category} className="mb-5">
              <h2 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-text-3">
                {category}
                <span className="font-mono text-[10px] text-text-3">· {list.length}</span>
              </h2>
              <div className="overflow-hidden rounded-lg border border-border-1">
                <table className="w-full text-[12px]">
                  <thead className="bg-bg-2/40 text-[10.5px] uppercase tracking-wider text-text-3">
                    <tr>
                      {mergeMode && <th className="w-8 px-2 py-1.5"></th>}
                      <th className="px-2 py-1.5 text-left">名称</th>
                      <th className="px-2 py-1.5 text-left">Skill ID</th>
                      <th className="px-2 py-1.5 text-left">描述</th>
                      <th className="px-2 py-1.5 text-right">掌握度</th>
                      <th className="px-2 py-1.5 text-right">答题数</th>
                      <th className="w-24 px-2 py-1.5 text-right">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((s) => {
                      const isEditing = (field: string) =>
                        edit.kind === 'editing' && edit.skill_id === s.skill_id && edit.field === field
                      const sel = selected.has(s.skill_id)
                      const masteryPct = Math.round(s.avg_mastery * 100)
                      return (
                        <tr
                          key={s.skill_id}
                          className={cn(
                            'border-t border-border-1 transition hover:bg-bg-2/30',
                            sel && 'bg-purple-500/[0.06]',
                          )}
                        >
                          {mergeMode && (
                            <td className="px-2 py-1.5">
                              <input
                                type="checkbox"
                                checked={sel}
                                onChange={() => toggleSelect(s.skill_id)}
                                className="size-3.5 accent-purple-500"
                              />
                            </td>
                          )}
                          <td className="px-2 py-1.5 font-medium text-text-1">
                            {isEditing('name') ? (
                              <InlineEditor
                                value={(edit as Extract<EditState, { kind: 'editing' }>).draft}
                                onChange={(v) =>
                                  setEdit((cur) => (cur.kind === 'editing' ? { ...cur, draft: v } : cur))
                                }
                                onCommit={commitEdit}
                                onCancel={cancelEdit}
                              />
                            ) : (
                              <button
                                type="button"
                                onClick={() => startEdit(s, 'name')}
                                className="group inline-flex items-center gap-1 hover:text-blue-600"
                                title="点击编辑"
                              >
                                {s.name}
                                <Edit3 className="size-2.5 opacity-0 transition group-hover:opacity-50" />
                              </button>
                            )}
                          </td>
                          <td className="px-2 py-1.5 font-mono text-[10.5px] text-text-3">{s.skill_id}</td>
                          <td className="px-2 py-1.5 text-text-2">
                            {isEditing('description') ? (
                              <InlineEditor
                                value={(edit as Extract<EditState, { kind: 'editing' }>).draft}
                                onChange={(v) =>
                                  setEdit((cur) => (cur.kind === 'editing' ? { ...cur, draft: v } : cur))
                                }
                                onCommit={commitEdit}
                                onCancel={cancelEdit}
                              />
                            ) : (
                              <button
                                type="button"
                                onClick={() => startEdit(s, 'description')}
                                className="line-clamp-1 max-w-md cursor-text text-left hover:text-blue-600"
                                title="点击编辑"
                              >
                                {s.description || <span className="italic text-text-3">点击添加描述…</span>}
                              </button>
                            )}
                          </td>
                          <td className="px-2 py-1.5 text-right">
                            <span
                              className={cn(
                                'inline-block min-w-[3rem] rounded font-mono tabular-nums',
                                masteryPct >= 80
                                  ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                                  : masteryPct >= 50
                                    ? 'bg-blue-500/15 text-blue-600 dark:text-blue-400'
                                    : masteryPct > 0
                                      ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
                                      : 'bg-bg-2/40 text-text-3',
                                'px-1.5 py-0.5 text-[10.5px]',
                              )}
                            >
                              {masteryPct}%
                            </span>
                          </td>
                          <td className="px-2 py-1.5 text-right font-mono tabular-nums text-text-3">
                            {s.total_attempts}
                          </td>
                          <td className="px-2 py-1.5">
                            <div className="flex items-center justify-end gap-1">
                              {mergeMode && sel && selected.size >= 2 && (
                                <button
                                  type="button"
                                  onClick={() => void doMerge(s.skill_id)}
                                  className="rounded bg-purple-500/15 px-1.5 py-0.5 text-[10.5px] text-purple-600 hover:bg-purple-500/25 dark:text-purple-400"
                                  title="把其他选中的技能合并到该项"
                                >
                                  <GitMerge className="mr-0.5 inline size-2.5" />
                                  合并到此
                                </button>
                              )}
                              {confirmDel === s.skill_id ? (
                                <>
                                  <button
                                    type="button"
                                    onClick={() => void doDelete(s.skill_id)}
                                    className="rounded bg-rose-500 px-1.5 py-0.5 text-[10.5px] text-white hover:bg-rose-600"
                                  >
                                    <Check className="mr-0.5 inline size-2.5" />
                                    确认
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => setConfirmDel(null)}
                                    className="rounded bg-bg-2/60 px-1.5 py-0.5 text-[10.5px] text-text-3 hover:bg-bg-2"
                                  >
                                    取消
                                  </button>
                                </>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => setConfirmDel(s.skill_id)}
                                  className="rounded p-1 text-text-3 hover:bg-rose-500/15 hover:text-rose-600"
                                  title="删除该技能"
                                >
                                  <Trash2 className="size-3" />
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          ))
        )}
      </div>
    </div>
  )
}

// v6 (2026-05) #3++ 树形视图：递归渲染层级 category 路径
//   - 中间节点：可折叠的"领域 / 子领域"标题
//   - 叶子节点：该路径下的全部技能（紧凑卡片：名称 + mastery + 操作）
//   - 编辑名称 / 改 category / 合并 仍请去「平铺」视图操作（这里只做浏览 + 删除）
interface TreeViewProps {
  nodes: TreeNode[]
  collapsed: Set<string>
  onToggle: (path: string) => void
  mergeMode: boolean
  selected: Set<string>
  toggleSelect: (skill_id: string) => void
  doMerge: (targetId: string) => void
  confirmDel: string | null
  setConfirmDel: (id: string | null) => void
  doDelete: (skill_id: string) => void
}

function TreeView(props: TreeViewProps) {
  return (
    <ul className="space-y-1">
      {props.nodes.map((n) => (
        <TreeNodeView key={n.path} node={n} depth={0} {...props} />
      ))}
    </ul>
  )
}

type TreeNodeViewProps = Omit<TreeViewProps, 'nodes'> & { node: TreeNode; depth: number }

function TreeNodeView({
  node,
  depth,
  collapsed,
  onToggle,
  mergeMode,
  selected,
  toggleSelect,
  doMerge,
  confirmDel,
  setConfirmDel,
  doDelete,
}: TreeNodeViewProps) {
  const isCollapsed = collapsed.has(node.path)
  const totalSkills = countSkills(node)
  return (
    <li>
      <button
        type="button"
        onClick={() => onToggle(node.path)}
        className={cn(
          'flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[12.5px] transition hover:bg-bg-2/50',
        )}
        style={{ paddingLeft: `${depth * 14 + 6}px` }}
      >
        {isCollapsed ? (
          <ChevronRight className="size-3 shrink-0 text-text-3" />
        ) : (
          <ChevronDown className="size-3 shrink-0 text-text-3" />
        )}
        <span className="font-medium text-text-1">{node.name}</span>
        <span className="ml-1 font-mono text-[10px] text-text-3">· {totalSkills}</span>
      </button>
      {!isCollapsed && (
        <>
          {/* 子节点 */}
          {node.children.length > 0 && (
            <ul className="space-y-1">
              {node.children.map((c) => (
                <TreeNodeView
                  key={c.path}
                  node={c}
                  depth={depth + 1}
                  collapsed={collapsed}
                  onToggle={onToggle}
                  mergeMode={mergeMode}
                  selected={selected}
                  toggleSelect={toggleSelect}
                  doMerge={doMerge}
                  confirmDel={confirmDel}
                  setConfirmDel={setConfirmDel}
                  doDelete={doDelete}
                />
              ))}
            </ul>
          )}
          {/* 该节点的叶子技能 */}
          {node.skills.length > 0 && (
            <ul
              className="my-1 space-y-1"
              style={{ paddingLeft: `${(depth + 1) * 14 + 6}px` }}
            >
              {node.skills.map((s) => {
                const sel = selected.has(s.skill_id)
                const masteryPct = Math.round(s.avg_mastery * 100)
                return (
                  <li
                    key={s.skill_id}
                    className={cn(
                      'flex items-center gap-2 rounded-md border border-border-1 bg-bg-1 px-2.5 py-1.5 text-[12px] transition hover:border-border-2',
                      sel && 'border-purple-500/40 bg-purple-500/[0.06]',
                    )}
                  >
                    {mergeMode && (
                      <input
                        type="checkbox"
                        checked={sel}
                        onChange={() => toggleSelect(s.skill_id)}
                        className="size-3.5 accent-purple-500"
                      />
                    )}
                    <span className="font-medium text-text-1">{s.name}</span>
                    <span className="font-mono text-[10px] text-text-3">{s.skill_id}</span>
                    <span
                      className={cn(
                        'inline-block min-w-[3rem] rounded font-mono tabular-nums px-1.5 py-0.5 text-[10.5px]',
                        masteryPct >= 80
                          ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                          : masteryPct >= 50
                            ? 'bg-blue-500/15 text-blue-600 dark:text-blue-400'
                            : masteryPct > 0
                              ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
                              : 'bg-bg-2/40 text-text-3',
                      )}
                      title={`${s.total_attempts} 次答题`}
                    >
                      {masteryPct}%
                    </span>
                    <span className="ml-auto flex items-center gap-1">
                      {mergeMode && sel && selected.size >= 2 && (
                        <button
                          type="button"
                          onClick={() => doMerge(s.skill_id)}
                          className="rounded bg-purple-500/15 px-1.5 py-0.5 text-[10.5px] text-purple-600 hover:bg-purple-500/25 dark:text-purple-400"
                        >
                          <GitMerge className="mr-0.5 inline size-2.5" />
                          合并到此
                        </button>
                      )}
                      {confirmDel === s.skill_id ? (
                        <>
                          <button
                            type="button"
                            onClick={() => doDelete(s.skill_id)}
                            className="rounded bg-rose-500 px-1.5 py-0.5 text-[10.5px] text-white hover:bg-rose-600"
                          >
                            <Check className="mr-0.5 inline size-2.5" />
                            确认
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmDel(null)}
                            className="rounded bg-bg-2/60 px-1.5 py-0.5 text-[10.5px] text-text-3 hover:bg-bg-2"
                          >
                            取消
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setConfirmDel(s.skill_id)}
                          className="rounded p-1 text-text-3 hover:bg-rose-500/15 hover:text-rose-600"
                          title="删除该技能"
                        >
                          <Trash2 className="size-3" />
                        </button>
                      )}
                    </span>
                  </li>
                )
              })}
            </ul>
          )}
        </>
      )}
    </li>
  )
}

/** 递归计算节点 + 子树技能总数（用于树形视图右侧 ·N 计数） */
function countSkills(node: TreeNode): number {
  return node.skills.length + node.children.reduce((s, c) => s + countSkills(c), 0)
}

function InlineEditor({
  value,
  onChange,
  onCommit,
  onCancel,
}: {
  value: string
  onChange: (v: string) => void
  onCommit: () => void
  onCancel: () => void
}) {
  return (
    <input
      autoFocus
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onCommit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          onCommit()
        } else if (e.key === 'Escape') {
          e.preventDefault()
          onCancel()
        }
      }}
      className="w-full min-w-0 rounded border border-blue-500/40 bg-bg-1 px-1.5 py-0.5 text-[12px] text-text-1 focus:outline-none"
    />
  )
}
