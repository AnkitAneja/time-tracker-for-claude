import { useCallback, useEffect, useState } from 'react'
import type { Task, TimeBlock } from '../../shared/types'
import { formatDuration } from '../../shared/format'

const DAY = 86_400_000

function startOfDay(ms: number): number {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

const time = (ms: number): string => new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })

function dayTitle(ms: number): string {
  const today = startOfDay(Date.now())
  if (ms === today) return 'Today'
  if (ms === today - DAY) return 'Yesterday'
  return new Date(ms).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' })
}

/** One day's time in blocks; each block can be moved to another task. */
export function TimeLog(): React.JSX.Element {
  const [day, setDay] = useState(() => startOfDay(Date.now()))
  const [blocks, setBlocks] = useState<TimeBlock[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    // Next midnight, computed from the date so DST days work.
    const next = new Date(day)
    next.setDate(next.getDate() + 1)
    const [b, t] = await Promise.all([window.api.timeBlocks(day, next.getTime()), window.api.listTasks()])
    setBlocks(b)
    setTasks(t)
  }, [day])

  useEffect(() => {
    void load()
    return window.api.onChange(() => void load())
  }, [load])

  const move = async (block: TimeBlock, value: string): Promise<void> => {
    setError(null)
    try {
      await window.api.moveBlock(block, value === '' ? null : Number(value))
    } catch (err) {
      setError((err as Error).message)
    }
  }

  const shift = (days: number): void => {
    const d = new Date(day)
    d.setDate(d.getDate() + days)
    setDay(d.getTime())
  }
  const isToday = day >= startOfDay(Date.now())
  const total = blocks.reduce((s, b) => s + b.seconds, 0)
  const nameOf = (id: number | null): string | undefined => tasks.find((t) => t.id === id)?.name

  return (
    <section>
      <div className="day-nav">
        <button className="secondary" onClick={() => shift(-1)} aria-label="Previous day">
          ‹
        </button>
        <strong>{dayTitle(day)}</strong>
        <button className="secondary" onClick={() => shift(1)} disabled={isToday} aria-label="Next day">
          ›
        </button>
        <span className="muted">{formatDuration(total)} active</span>
      </div>
      <p className="muted">
        Each row is one Claude Code session on one task. Pick another task to move that time. Moving a session’s latest
        block also sends its later time there.
      </p>
      {error && <p className="error">{error}</p>}

      {blocks.length === 0 ? (
        <p className="muted">No time recorded this day.</p>
      ) : (
        <table className="blocks">
          <thead>
            <tr>
              <th>Time</th>
              <th>Active</th>
              <th>Folder</th>
              <th>Task</th>
            </tr>
          </thead>
          <tbody>
            {blocks.map((b) => (
              <tr key={`${b.sessionId}|${b.taskId}|${b.start}`}>
                <td className="nowrap">
                  {time(b.start)}
                  {b.end - b.start >= 60_000 && ` – ${time(b.end)}`}
                </td>
                <td className="num">{formatDuration(b.seconds)}</td>
                <td className="muted">{b.project ?? '—'}</td>
                <td>
                  <select
                    value={b.taskId ?? ''}
                    onChange={(e) => void move(b, e.target.value)}
                    aria-label={`Task for ${time(b.start)} block`}
                  >
                    <option value="">Untagged</option>
                    {/* Keep an archived task visible as the current value. */}
                    {b.taskId !== null && !tasks.some((t) => t.id === b.taskId) && (
                      <option value={b.taskId}>{nameOf(b.taskId) ?? 'Archived task'}</option>
                    )}
                    {tasks.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                        {t.project ? ` (${t.project})` : ''}
                      </option>
                    ))}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}
