import { describe, expect, it } from 'vitest'
import { openDatabase } from '../src/main/db'
import { Repo } from '../src/main/db/repo'
import type { NameRequest, NameResult } from '../src/main/naming/autotask'
import { formatRequest, parseOutput } from '../src/main/naming/claude-cli'
import type { HookEvent } from '../src/main/server/hooks'
import { Tracker } from '../src/main/tracker'

function setup(answers: (NameResult | Error)[]) {
  const db = openDatabase(':memory:')
  const repo = new Repo(db)
  const calls: NameRequest[] = []
  const namer = async (req: NameRequest): Promise<NameResult> => {
    calls.push(req)
    const a = answers.shift()
    if (!a) throw new Error('no answer queued')
    if (a instanceof Error) throw a
    return a
  }
  const tracker = new Tracker(repo, () => 1_000, { namer, ignoreCwd: '/naming', recheckEvery: 2 })
  const hook = (type: HookEvent['type'], text: string | null = null, sessionId = 's1', cwd = '/dev/shop'): void =>
    tracker.handleHook({ type, sessionId, cwd, detail: null, text })
  const time = (seconds: number, sessionId = 's1'): void =>
    tracker.handleActiveTime([{ sessionId, kind: 'cli', seconds, timestamp: 1 }])
  const rows = () => db.prepare('SELECT task_id, seconds FROM time_records ORDER BY id').all()
  return { db, repo, tracker, calls, hook, time, rows }
}

describe('auto task naming', () => {
  it('names the session after the first reply and moves earlier time onto the task', async () => {
    const { tracker, hook, time, rows, repo, calls } = setup([{ existingTaskId: null, name: 'Fix checkout tax rounding' }])
    hook('UserPromptSubmit', 'Tax is off by a cent on checkout, fix it')
    time(10)
    hook('Stop', 'Found it: rounding happens per line. Fixed in cart.ts.')
    await tracker.namingIdle()
    time(5)

    const task = repo.listTasks()[0]
    expect(task).toMatchObject({ name: 'Fix checkout tax rounding', project: 'shop', source: 'auto' })
    expect(rows()).toEqual([
      { task_id: task.id, seconds: 10 },
      { task_id: task.id, seconds: 5 }
    ])
    expect(calls[0].conversation).toContain('USER: Tax is off by a cent')
    expect(calls[0].conversation).toContain('CLAUDE: Found it')
    expect(calls[0].project).toBe('shop')
    expect(tracker.state().autoTaskId).toBe(task.id)
  })

  it('switches task when the topic changes, keeping earlier time where it was', async () => {
    const { tracker, hook, time, rows, repo, calls } = setup([
      { existingTaskId: null, name: 'Fix checkout bug' },
      { existingTaskId: null, name: 'Add CSV export' }
    ])
    hook('UserPromptSubmit', 'fix the checkout bug')
    hook('Stop', 'done')
    await tracker.namingIdle()
    time(10)
    hook('UserPromptSubmit', 'now add CSV export to reports')
    hook('Stop', 'working on it')
    expect(calls).toHaveLength(1) // not due yet (every 2 replies)
    hook('Stop', 'CSV export added')
    await tracker.namingIdle()
    time(20)

    const [csv, bug] = repo.listTasks().sort((a, b) => b.id - a.id)
    expect(calls[1].currentTask).toEqual({ id: bug.id, name: 'Fix checkout bug' })
    expect(rows()).toEqual([
      { task_id: bug.id, seconds: 10 },
      { task_id: csv.id, seconds: 20 }
    ])
  })

  it('reuses an existing task the model points to, and avoids duplicate names', async () => {
    const { tracker, hook, repo } = setup([
      { existingTaskId: null, name: 'Add CSV export' },
      { existingTaskId: null, name: 'add csv export' }
    ])
    hook('UserPromptSubmit', 'csv export', 'a')
    hook('Stop', 'ok', 'a')
    hook('UserPromptSubmit', 'continue csv export', 'b')
    hook('Stop', 'ok', 'b')
    await tracker.namingIdle()
    expect(repo.listTasks()).toHaveLength(1)
  })

  it('a pinned task wins and skips naming calls', async () => {
    const { tracker, hook, time, rows, calls } = setup([])
    const t = tracker.createTask('Client work', null)
    tracker.setCurrentTask(t.id)
    hook('UserPromptSubmit', 'anything')
    hook('Stop', 'reply')
    await tracker.namingIdle()
    time(7)
    expect(calls).toHaveLength(0)
    expect(rows()).toEqual([{ task_id: t.id, seconds: 7 }])
  })

  it('waits when the model says the chat is too vague', async () => {
    const { tracker, hook, repo, calls } = setup([
      { existingTaskId: null, name: '' },
      { existingTaskId: null, name: 'Write release notes' }
    ])
    hook('UserPromptSubmit', 'hi')
    hook('Stop', 'Hello! What are we working on?')
    await tracker.namingIdle()
    expect(repo.listTasks()).toHaveLength(0)
    hook('UserPromptSubmit', 'write release notes for 1.2')
    hook('Stop', 'Draft below')
    await tracker.namingIdle()
    expect(calls).toHaveLength(2)
    expect(repo.listTasks()[0].name).toBe('Write release notes')
  })

  it('falls back to the folder name when naming fails', async () => {
    const { tracker, hook, repo } = setup([new Error('Claude Code CLI not found')])
    hook('UserPromptSubmit', 'do stuff')
    hook('Stop', 'ok')
    await tracker.namingIdle()
    expect(repo.listTasks()[0]).toMatchObject({ name: 'shop', source: 'auto' })
    expect(tracker.state().namingProblem).toContain('not found')
  })

  it('never saves conversation text and ignores its own naming sessions', async () => {
    const { tracker, hook, db, calls } = setup([{ existingTaskId: null, name: 'Task' }])
    hook('UserPromptSubmit', 'SECRET PROMPT')
    hook('Stop', 'SECRET REPLY')
    hook('UserPromptSubmit', 'naming call', 'n1', '/naming')
    await tracker.namingIdle()
    const dump = ['tasks', 'sessions', 'events', 'time_records', 'settings']
      .map((t) => JSON.stringify(db.prepare(`SELECT * FROM ${t}`).all()))
      .join()
    expect(dump).not.toContain('SECRET')
    expect(db.prepare("SELECT COUNT(*) n FROM sessions WHERE session_id = 'n1'").get()).toEqual({ n: 0 })
    expect(calls).toHaveLength(1)
  })
})

describe('claude CLI namer helpers', () => {
  it('parses structured output and errors', () => {
    expect(parseOutput(JSON.stringify({ is_error: false, structured_output: { existingTaskId: 3, name: ' X ' } }))).toEqual({
      existingTaskId: 3,
      name: 'X'
    })
    expect(parseOutput(JSON.stringify({ result: '{"existingTaskId":null,"name":"Y"}' }))).toEqual({ existingTaskId: null, name: 'Y' })
    expect(() => parseOutput(JSON.stringify({ is_error: true, result: 'Not logged in' }))).toThrow('Not logged in')
  })

  it('formats the request with tasks and conversation', () => {
    const text = formatRequest({
      conversation: 'USER: hi',
      project: 'shop',
      currentTask: { id: 2, name: 'Fix bug' },
      tasks: [{ id: 2, name: 'Fix bug', project: 'shop' }]
    })
    expect(text).toContain('Current task: 2 "Fix bug"')
    expect(text).toContain('2: Fix bug (shop)')
    expect(text).toContain('<conversation>\nUSER: hi\n</conversation>')
  })
})
