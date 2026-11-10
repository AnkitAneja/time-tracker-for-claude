import { describe, expect, it } from 'vitest'
import { openDatabase } from '../src/main/db'
import { Repo } from '../src/main/db/repo'
import { Tracker } from '../src/main/tracker'

describe('dashboard stats', () => {
  it('groups time by local day, task and project folder', () => {
    const db = openDatabase(':memory:')
    const repo = new Repo(db)
    const day1 = new Date(2026, 10, 9, 10, 0).getTime()
    const day2 = new Date(2026, 10, 10, 23, 30).getTime()
    const tracker = new Tracker(repo, () => day2)
    const a = tracker.createTask('A', null)
    const b = tracker.createTask('B', null)

    tracker.handleHook({ type: 'UserPromptSubmit', sessionId: 's1', cwd: '/x/shop', detail: null, text: null })
    tracker.handleHook({ type: 'UserPromptSubmit', sessionId: 's2', cwd: '/y/shop', detail: null, text: null })
    tracker.handleHook({ type: 'UserPromptSubmit', sessionId: 's3', cwd: '/z/blog', detail: null, text: null })
    repo.insertTimeRecord('s1', a.id, 'cli', 100, day1)
    repo.insertTimeRecord('s1', a.id, 'user', 50, day2)
    repo.insertTimeRecord('s2', b.id, 'cli', 300, day2)
    repo.insertTimeRecord('s3', null, 'cli', 20, day2)
    repo.insertTimeRecord('s1', a.id, 'cli', 999, day1 - 7 * 86_400_000) // outside range

    const s = tracker.stats(new Date(2026, 10, 9).getTime(), new Date(2026, 10, 11).getTime())
    expect(s.byDay).toEqual([
      { day: '2026-11-09', taskId: a.id, seconds: 100 },
      { day: '2026-11-10', taskId: null, seconds: 20 },
      { day: '2026-11-10', taskId: a.id, seconds: 50 },
      { day: '2026-11-10', taskId: b.id, seconds: 300 }
    ])
    expect(s.byTask).toEqual([
      { taskId: b.id, seconds: 300 },
      { taskId: a.id, seconds: 150 },
      { taskId: null, seconds: 20 }
    ])
    // Two folders named "shop" are merged by name.
    expect(s.byProject).toEqual([
      { project: 'shop', seconds: 450 },
      { project: 'blog', seconds: 20 }
    ])
    // All-time rank includes time outside the range: A has 1149 s.
    expect(s.taskRank).toEqual([a.id, b.id])
  })
})
