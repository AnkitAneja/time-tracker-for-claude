import { useCallback, useEffect, useState } from 'react'
import type { SetupPreview, SetupResult, Task, TrackerState } from '../../shared/types'
import { formatDuration } from '../../shared/format'
import { Dashboard } from './Dashboard'
import { TimeLog } from './TimeLog'

const VIEWS = ['tasks', 'dashboard', 'log', 'setup'] as const
type View = (typeof VIEWS)[number]

function currentView(): View {
  const h = location.hash.slice(1)
  return (VIEWS as readonly string[]).includes(h) ? (h as View) : 'tasks'
}

export function App(): React.JSX.Element {
  const [view, setView] = useState<View>(currentView)

  useEffect(() => {
    const onHash = (): void => setView(currentView())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  return (
    <main>
      <nav>
        <a className={view === 'tasks' ? 'active' : ''} href="#tasks">
          Tasks
        </a>
        <a className={view === 'dashboard' ? 'active' : ''} href="#dashboard">
          Dashboard
        </a>
        <a className={view === 'log' ? 'active' : ''} href="#log">
          Time log
        </a>
        <a className={view === 'setup' ? 'active' : ''} href="#setup">
          Claude Code setup
        </a>
      </nav>
      {view === 'tasks' && <Tasks />}
      {view === 'dashboard' && <Dashboard />}
      {view === 'log' && <TimeLog />}
      {view === 'setup' && <Setup />}
    </main>
  )
}

function Tasks(): React.JSX.Element {
  const [tasks, setTasks] = useState<Task[]>([])
  const [state, setState] = useState<TrackerState | null>(null)
  const [name, setName] = useState('')
  const [project, setProject] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<number | null>(null)

  const load = useCallback(async () => {
    const [t, s] = await Promise.all([window.api.listTasks(), window.api.getState()])
    setTasks(t)
    setState(s)
  }, [])

  useEffect(() => {
    void load()
    return window.api.onChange(() => void load())
  }, [load])

  const secondsFor = (id: number | null): number => state?.todayByTask.find((t) => t.taskId === id)?.seconds ?? 0

  const add = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    setError(null)
    try {
      const task = await window.api.createTask(name, project || null)
      await window.api.setCurrentTask(task.id)
      setName('')
      setProject('')
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <section>
      <p className="summary">
        Today: <strong>{formatDuration(state?.todaySeconds ?? 0)}</strong>
        {secondsFor(null) > 0 && <span className="muted"> · {formatDuration(secondsFor(null))} untagged</span>}
      </p>
      <p className="muted">
        In <strong>Auto</strong> mode each Claude Code session gets a task named from its conversation. Pin a task to
        put all time on it instead.
      </p>
      {state?.namingProblem && <p className="error">{state.namingProblem}</p>}

      <form onSubmit={add} className="new-task">
        <input placeholder="New task name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        <input placeholder="Project (optional)" value={project} onChange={(e) => setProject(e.target.value)} />
        <button type="submit" disabled={!name.trim()}>
          Add and start
        </button>
      </form>
      {error && <p className="error">{error}</p>}

      <ul className="tasks">
        <li className={state?.currentTaskId === null ? 'current' : ''}>
          <button className="pick" onClick={() => void window.api.setCurrentTask(null)}>
            Auto (name tasks from the chat)
          </button>
          <span className="time">{formatDuration(secondsFor(null))}</span>
        </li>
        {tasks.map((t) =>
          editing === t.id ? (
            <li key={t.id}>
              <EditTask
                task={t}
                others={tasks.filter((o) => o.id !== t.id)}
                onDone={() => setEditing(null)}
                onError={setError}
              />
            </li>
          ) : (
          <li key={t.id} className={state?.currentTaskId === t.id ? 'current' : ''}>
            <button className="pick" onClick={() => void window.api.setCurrentTask(t.id)}>
              {t.name}
              {t.project && <span className="muted"> · {t.project}</span>}
              {t.source === 'auto' && <span className="badge">auto</span>}
              {state?.currentTaskId === null && state.autoTaskId === t.id && <span className="badge live">now</span>}
            </button>
            <span className="time">{formatDuration(secondsFor(t.id))}</span>
            <button className="link" onClick={() => setEditing(t.id)}>
              Edit
            </button>
            <button className="link" onClick={() => void window.api.archiveTask(t.id)}>
              Archive
            </button>
          </li>
          )
        )}
      </ul>
    </section>
  )
}

/** Rename a task, or merge it into another (moves all its time there and archives it). */
function EditTask({
  task,
  others,
  onDone,
  onError
}: {
  task: Task
  others: Task[]
  onDone: () => void
  onError: (msg: string | null) => void
}): React.JSX.Element {
  const [name, setName] = useState(task.name)
  const [into, setInto] = useState('')

  const run = async (fn: () => Promise<void>): Promise<void> => {
    onError(null)
    try {
      await fn()
      onDone()
    } catch (err) {
      onError((err as Error).message)
    }
  }

  return (
    <div className="edit-task">
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault()
          void run(() => window.api.renameTask(task.id, name))
        }}
      >
        <input value={name} onChange={(e) => setName(e.target.value)} autoFocus aria-label="Task name" />
        <button type="submit" disabled={!name.trim() || name.trim() === task.name}>
          Rename
        </button>
        <button type="button" className="secondary" onClick={onDone}>
          Cancel
        </button>
      </form>
      {others.length > 0 && (
        <div className="row">
          <select value={into} onChange={(e) => setInto(e.target.value)} aria-label="Merge into task">
            <option value="">Merge into another task…</option>
            {others.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
                {o.project ? ` (${o.project})` : ''}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="secondary"
            disabled={!into}
            onClick={() => void run(() => window.api.mergeTask(task.id, Number(into)))}
          >
            Merge
          </button>
        </div>
      )}
    </div>
  )
}

function Setup(): React.JSX.Element {
  const [preview, setPreview] = useState<SetupPreview | null>(null)
  const [result, setResult] = useState<SetupResult | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => setPreview(await window.api.setupPreview()), [])
  useEffect(() => {
    void load()
  }, [load])

  const run = async (fn: () => Promise<SetupResult>): Promise<void> => {
    setBusy(true)
    try {
      setResult(await fn())
      await load()
    } finally {
      setBusy(false)
    }
  }

  if (!preview) return <section>Loading…</section>

  const installed = preview.status === 'installed'
  return (
    <section>
      <p>
        Status:{' '}
        <strong>{installed ? 'Connected' : preview.status === 'partial' ? 'Partly set up' : 'Not set up'}</strong>
      </p>
      <p className="muted">
        File: <code>{preview.settingsPath}</code>
      </p>

      {preview.error && <p className="error">{preview.error}</p>}

      {!installed && !preview.error && (
        <>
          <h3>Setup will make these changes</h3>
          <ul className="changes">
            {preview.changes.map((c) => (
              <li key={c}>
                <code>{c}</code>
              </li>
            ))}
          </ul>
          <p className="muted">
            A backup of the current file is saved next to it first. Prompts and replies are only held in memory to name
            tasks; they are never saved.
          </p>
        </>
      )}

      {preview.warnings.length > 0 && (
        <ul className="warnings">
          {preview.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}

      <div className="actions">
        {!installed && (
          <button disabled={busy || !!preview.error} onClick={() => void run(window.api.setupApply)}>
            Apply changes
          </button>
        )}
        {preview.status !== 'not-installed' && (
          <button className="secondary" disabled={busy || !!preview.error} onClick={() => void run(window.api.setupUndo)}>
            Remove tracker settings
          </button>
        )}
      </div>

      {result && (
        <p className={result.ok ? 'ok' : 'error'}>
          {result.message}
          {result.backupPath && (
            <>
              <br />
              <span className="muted">
                Backup: <code>{result.backupPath}</code>
              </span>
            </>
          )}
        </p>
      )}
    </section>
  )
}
