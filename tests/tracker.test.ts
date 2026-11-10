import { describe, expect, it } from 'vitest'
import { openDatabase } from '../src/main/db'
import { Repo } from '../src/main/db/repo'
import { parseHookEvent } from '../src/main/server/hooks'
import { Tracker } from '../src/main/tracker'
import promptFixture from './fixtures/hook-user-prompt-submit.json'
import stopFixture from './fixtures/hook-stop.json'

function setup(start = new Date(2026, 10, 10, 9, 0).getTime()) {
  const db = openDatabase(':memory:')
  const repo = new Repo(db)
  let now = start
  const tracker = new Tracker(repo, () => now)
  return { db, repo, tracker, advance: (ms: number) => (now += ms), now: () => now }
}

describe('parseHookEvent', () => {
  it('keeps only whitelisted fields, with conversation text for naming', () => {
    expect(parseHookEvent(promptFixture)).toEqual({
      type: 'UserPromptSubmit',
      sessionId: 'sess-1',
      cwd: '/Users/dev/projects/shop',
      detail: null,
      text: 'SECRET PROMPT TEXT'
    })
    expect(parseHookEvent(stopFixture)?.text).toBe('SECRET ASSISTANT TEXT')
    expect(Object.keys(parseHookEvent(stopFixture)!)).toEqual(['type', 'sessionId', 'cwd', 'detail', 'text'])
  })

  it('reads SessionStart source and SessionEnd reason', () => {
    expect(parseHookEvent({ hook_event_name: 'SessionStart', session_id: 's', source: 'resume' })?.detail).toBe('resume')
    expect(parseHookEvent({ hook_event_name: 'SessionEnd', session_id: 's', reason: 'clear' })?.detail).toBe('clear')
  })

  it('ignores untracked events and bad payloads', () => {
    expect(parseHookEvent({ hook_event_name: 'PreToolUse', session_id: 's' })).toBeNull()
    expect(parseHookEvent({ hook_event_name: 'Stop' })).toBeNull()
    expect(parseHookEvent(null)).toBeNull()
  })
})

describe('Tracker', () => {
  it('tags time with the task selected when it arrives', () => {
    const { tracker, db } = setup()
    const a = tracker.createTask('Checkout bug', 'shop')
    const b = tracker.createTask('Refactor', null)

    tracker.handleActiveTime([{ sessionId: 's1', kind: 'cli', seconds: 5, timestamp: 1 }])
    tracker.setCurrentTask(a.id)
    tracker.handleActiveTime([{ sessionId: 's1', kind: 'user', seconds: 10, timestamp: 2 }])
    tracker.setCurrentTask(b.id)
    tracker.handleActiveTime([{ sessionId: 's1', kind: 'cli', seconds: 20, timestamp: 3 }])

    const rows = db.prepare('SELECT task_id, seconds FROM time_records ORDER BY id').all()
    expect(rows).toEqual([
      { task_id: null, seconds: 5 },
      { task_id: a.id, seconds: 10 },
      { task_id: b.id, seconds: 20 }
    ])
  })

  it('reports today totals per task and skips earlier days', () => {
    const { tracker, now } = setup()
    const a = tracker.createTask('A', null)
    tracker.setCurrentTask(a.id)
    tracker.handleActiveTime([
      { sessionId: 's1', kind: 'cli', seconds: 30, timestamp: now() },
      { sessionId: 's1', kind: 'cli', seconds: 999, timestamp: now() - 24 * 3600_000 }
    ])
    const s = tracker.state()
    expect(s.todaySeconds).toBe(30)
    expect(s.todayByTask).toEqual([{ taskId: a.id, seconds: 30 }])
  })

  it('records sessions from hooks without storing prompt text', () => {
    const { tracker, db, advance } = setup()
    const t = tracker.createTask('A', null)
    tracker.setCurrentTask(t.id)
    tracker.handleHook(parseHookEvent(promptFixture)!)
    advance(1000)
    tracker.handleHook(parseHookEvent(stopFixture)!)
    advance(1000)
    tracker.handleHook({ type: 'SessionEnd', sessionId: 'sess-1', cwd: null, detail: 'prompt_input_exit', text: null })

    const session = db.prepare('SELECT * FROM sessions').get() as Record<string, unknown>
    expect(session).toMatchObject({ session_id: 'sess-1', cwd: '/Users/dev/projects/shop', task_id: null, end_reason: 'prompt_input_exit' })
    expect(db.prepare('SELECT DISTINCT task_id FROM events').all()).toEqual([{ task_id: t.id }])
    expect(session.ended_at).not.toBeNull()
    const types = db.prepare('SELECT type FROM events ORDER BY id').all().map((r) => (r as { type: string }).type)
    expect(types).toEqual(['UserPromptSubmit', 'Stop', 'SessionEnd'])

    const dump = JSON.stringify(db.prepare('SELECT * FROM events').all()) + JSON.stringify(session)
    expect(dump).not.toContain('SECRET')

    // A resumed session gets reopened.
    tracker.handleHook({ type: 'SessionStart', sessionId: 'sess-1', cwd: null, detail: 'resume', text: null })
    expect((db.prepare('SELECT ended_at FROM sessions').get() as { ended_at: unknown }).ended_at).toBeNull()
  })

  it('creates a session from metrics alone, and fills cwd from a later hook', () => {
    const { tracker, db } = setup()
    tracker.handleActiveTime([{ sessionId: 'm1', kind: 'cli', seconds: 1, timestamp: 1 }])
    tracker.handleHook({ type: 'UserPromptSubmit', sessionId: 'm1', cwd: '/proj', detail: null, text: 'hi' })
    expect(db.prepare('SELECT session_id, cwd FROM sessions').all()).toEqual([{ session_id: 'm1', cwd: '/proj' }])
  })

  it('remembers the current task across restarts and drops it when archived', () => {
    const { tracker, repo } = setup()
    const t = tracker.createTask('A', null)
    tracker.setCurrentTask(t.id)
    expect(new Tracker(repo).getCurrentTaskId()).toBe(t.id)
    tracker.archiveTask(t.id)
    expect(tracker.getCurrentTaskId()).toBeNull()
    expect(new Tracker(repo).getCurrentTaskId()).toBeNull()
    expect(() => tracker.setCurrentTask(t.id)).toThrow()
  })

  it('rejects empty task names', () => {
    expect(() => setup().tracker.createTask('   ', null)).toThrow()
  })
})
