import { describe, expect, it } from 'vitest'
import { openDatabase } from '../src/main/db'
import { Repo } from '../src/main/db/repo'
import type { NameRequest, NameResult } from '../src/main/naming/autotask'
import { Tracker } from '../src/main/tracker'

const MIN = 60_000
const T0 = new Date(2026, 10, 10, 9, 0).getTime()

function setup(answers: NameResult[] = []) {
  const db = openDatabase(':memory:')
  const repo = new Repo(db)
  const calls: NameRequest[] = []
  const namer = async (req: NameRequest): Promise<NameResult> => {
    calls.push(req)
    return answers.shift() ?? { existingTaskId: null, name: '' }
  }
  const tracker = new Tracker(repo, () => T0, { namer, recheckEvery: 1 })
  const rec = (session: string | null, task: number | null, seconds: number, at: number) =>
    repo.insertTimeRecord(session, task, 'cli', seconds, at)
  const tasksOf = () => db.prepare('SELECT task_id, seconds FROM time_records ORDER BY id').all()
  return { db, repo, tracker, rec, tasksOf, calls }
}

describe('time blocks', () => {
  it('groups by session and task, splitting on gaps over 15 min, newest first', () => {
    const { tracker, rec, repo } = setup()
    const a = tracker.createTask('A', null)
    repo.touchSession('s1', '/dev/shop', T0)
    rec('s1', a.id, 10, T0)
    rec('s1', a.id, 10, T0 + 10 * MIN)
    rec('s1', a.id, 10, T0 + 40 * MIN) // gap > 15 min → new block
    rec('s2', null, 5, T0 + 5 * MIN)

    const blocks = tracker.timeBlocks(T0, T0 + 24 * 60 * MIN)
    expect(blocks.map((b) => [b.sessionId, b.taskId, b.seconds, b.project])).toEqual([
      ['s1', a.id, 10, 'shop'],
      ['s2', null, 5, null],
      ['s1', a.id, 20, 'shop']
    ])
    expect(blocks[2]).toMatchObject({ start: T0, end: T0 + 10 * MIN })
  })

  it('moves only the chosen block', () => {
    const { tracker, rec, tasksOf } = setup()
    const a = tracker.createTask('A', null)
    const b = tracker.createTask('B', null)
    rec('s1', a.id, 10, T0)
    rec('s1', a.id, 10, T0 + 40 * MIN)
    rec('s1', a.id, 10, T0 + 41 * MIN)

    const [, older] = tracker.timeBlocks(T0, T0 + 99 * MIN)
    tracker.moveBlock(older, b.id)
    expect(tasksOf()).toEqual([
      { task_id: b.id, seconds: 10 },
      { task_id: a.id, seconds: 10 },
      { task_id: a.id, seconds: 10 }
    ])
  })

  it('moving the latest block locks the session: later time follows and auto naming stops', async () => {
    const { tracker, rec, repo, calls } = setup([{ existingTaskId: null, name: 'Wrong name' }])
    tracker.handleHook({ type: 'UserPromptSubmit', sessionId: 's1', cwd: '/dev/shop', detail: null, text: 'fix tax' })
    tracker.handleHook({ type: 'Stop', sessionId: 's1', cwd: '/dev/shop', detail: null, text: 'done' })
    await tracker.namingIdle()
    const wrong = repo.listTasks()[0]
    tracker.handleActiveTime([{ sessionId: 's1', kind: 'cli', seconds: 30, timestamp: T0 }])

    const right = tracker.createTask('Fix tax rounding', 'shop')
    const [latest] = tracker.timeBlocks(T0 - MIN, T0 + MIN)
    expect(latest.taskId).toBe(wrong.id)
    tracker.moveBlock(latest, right.id)

    tracker.handleActiveTime([{ sessionId: 's1', kind: 'cli', seconds: 5, timestamp: T0 + MIN }])
    tracker.handleHook({ type: 'Stop', sessionId: 's1', cwd: '/dev/shop', detail: null, text: 'more' })
    await tracker.namingIdle()
    expect(calls).toHaveLength(1)
    expect(repo.getSession('s1')).toMatchObject({ task_id: right.id, task_locked: 1 })
    expect(tracker.timeBlocks(T0 - MIN, T0 + 2 * MIN)[0]).toMatchObject({ taskId: right.id, seconds: 35 })
  })

  it('can move a block back to untagged', () => {
    const { tracker, rec, tasksOf } = setup()
    const a = tracker.createTask('A', null)
    rec(null, a.id, 10, T0)
    tracker.moveBlock(tracker.timeBlocks(T0, T0 + MIN)[0], null)
    expect(tasksOf()).toEqual([{ task_id: null, seconds: 10 }])
  })
})

describe('rename and merge', () => {
  it('renames, rejecting empty names', () => {
    const { tracker, repo } = setup()
    const a = tracker.createTask('Old', null)
    tracker.renameTask(a.id, '  New name ')
    expect(repo.getTask(a.id)?.name).toBe('New name')
    expect(() => tracker.renameTask(a.id, ' ')).toThrow()
  })

  it('merges all time, events and sessions, archives the source and moves the pin', () => {
    const { tracker, repo, rec, tasksOf, db } = setup()
    const a = tracker.createTask('CSV export', null)
    const b = tracker.createTask('Add CSV export', null)
    repo.touchSession('s1', null, T0)
    repo.assignSessionTask('s1', a.id)
    rec('s1', a.id, 10, T0)
    rec('s2', b.id, 20, T0)
    tracker.setCurrentTask(a.id)

    tracker.mergeTask(a.id, b.id)
    expect(tasksOf()).toEqual([
      { task_id: b.id, seconds: 10 },
      { task_id: b.id, seconds: 20 }
    ])
    expect(repo.getTask(a.id)?.status).toBe('archived')
    expect(repo.getSession('s1')?.task_id).toBe(b.id)
    expect(tracker.getCurrentTaskId()).toBe(b.id)
    expect(db.prepare('SELECT COUNT(*) n FROM tasks WHERE status = ?').get('active')).toEqual({ n: 1 })
    expect(() => tracker.mergeTask(b.id, b.id)).toThrow()
  })
})
