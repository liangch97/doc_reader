import { useState } from 'react'
import { X } from 'lucide-react'
import { coursesApi } from '@/lib/api'
import { COVER_ICON_PRESETS, COVER_ICON_MAP } from './coverIcon'

const PRESET_COLORS = ['#7C5CFC', '#FF6B6B', '#33CC95', '#FFB13D', '#3DA9FC', '#A35CFF']

interface Props {
  open: boolean
  onClose: () => void
  onCreated?: (courseId: string) => void
}

export function CreateCourseDialog({ open, onClose, onCreated }: Props) {
  const [name, setName] = useState('')
  const [desc, setDesc] = useState('')
  const [color, setColor] = useState(PRESET_COLORS[0])
  const [emoji, setEmoji] = useState(COVER_ICON_PRESETS[0].id)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  if (!open) return null

  async function submit() {
    if (!name.trim()) {
      setError('请填写课程名')
      return
    }
    setSubmitting(true)
    setError('')
    try {
      const id = await coursesApi.create({
        name: name.trim(),
        description: desc.trim() || undefined,
        coverColor: color,
        coverEmoji: emoji,
      })
      onCreated?.(id)
      setName('')
      setDesc('')
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="relative w-[440px] rounded-lg border border-border-1 bg-popover p-6 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          className="absolute right-3 top-3 rounded-md p-1 text-text-3 hover:bg-surface-2 hover:text-text-1"
        >
          <X className="h-4 w-4" />
        </button>
        <h2 className="mb-5 text-lg font-semibold text-text-1">创建课程</h2>

        <div className="flex flex-col gap-4 text-sm">
          <Field label="课程名">
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：计算机网络"
              className="w-full rounded-md border border-border-1 bg-bg px-3 py-2 text-text-1 outline-none focus:border-accent"
            />
          </Field>
          <Field label="简介（可选）">
            <textarea
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              rows={2}
              className="w-full resize-none rounded-md border border-border-1 bg-bg px-3 py-2 text-xs text-text-1 outline-none focus:border-accent"
            />
          </Field>
          <Field label="封面图标">
            <div className="flex flex-wrap gap-2">
              {COVER_ICON_PRESETS.map(({ id, label }) => {
                const Icon = COVER_ICON_MAP[id]
                return (
                  <button
                    key={id}
                    type="button"
                    title={label}
                    onClick={() => setEmoji(id)}
                    className={`flex h-9 w-9 items-center justify-center rounded-md transition-colors ${
                      emoji === id
                        ? 'bg-surface-3 text-text-1'
                        : 'bg-surface-2 text-text-2 hover:bg-surface-3'
                    }`}
                  >
                    <Icon className="h-4 w-4" strokeWidth={1.6} />
                  </button>
                )
              })}
            </div>
          </Field>
          <Field label="主题色">
            <div className="flex flex-wrap gap-2">
              {PRESET_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setColor(c)}
                  className={`h-7 w-7 rounded-full transition-transform ${
                    color === c ? 'scale-110 ring-2 ring-offset-2 ring-offset-surface-1' : ''
                  }`}
                  style={{ background: c, boxShadow: color === c ? `0 0 0 2px ${c}` : undefined }}
                />
              ))}
            </div>
          </Field>
        </div>

        {error && <p className="mt-3 text-xs text-error">{error}</p>}

        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-border-1 px-4 py-1.5 text-sm text-text-2 hover:bg-surface-2"
          >
            取消
          </button>
          <button
            type="button"
            disabled={submitting}
            onClick={submit}
            className="rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-accent-2 disabled:opacity-60"
          >
            {submitting ? '创建中…' : '创建'}
          </button>
        </div>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs text-text-3">{label}</span>
      {children}
    </label>
  )
}
