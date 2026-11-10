import { describe, expect, it } from 'vitest'
import { openDatabase } from '../src/main/db'
import { Repo } from '../src/main/db/repo'
import { csvCell, toCsv } from '../src/main/export'
import { Tracker } from '../src/main/tracker'

describe('CSV export', () => {
  it('escapes quotes and commas, and defuses formulas', () => {
    expect(csvCell('plain')).toBe('plain')
    expect(csvCell('a, "b"')).toBe('"a, ""b"""')
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`)
    expect(csvCell('-1')).toBe("'-1")
  })

  it('writes h:mm and decimal hours', () => {
    expect(toCsv([{ day: '2026-11-10', task: 'Fix bug', project: 'shop', seconds: 5430 }])).toBe(
      'Date,Task,Project folder,Duration (h:mm),Hours\r\n2026-11-10,Fix bug,shop,1:31,1.51\r\n'
    )
  })

  it('groups by day, task and folder name, untagged last', () => {
    const repo = new Repo(openDatabase(':memory:'))
    const at = new Date(2026, 10, 10, 12).getTime()
    const tracker = new Tracker(repo, () => at)
    const a = tracker.createTask('Alpha', null)
    repo.touchSession('s1', '/x/shop', at)
    repo.touchSession('s2', '/y/shop', at)
    repo.insertTimeRecord('s1', a.id, 'cli', 1800, at)
    repo.insertTimeRecord('s2', a.id, 'cli', 1800, at)
    repo.insertTimeRecord('s1', null, 'cli', 600, at)
    repo.insertTimeRecord('s1', a.id, 'cli', 999, at + 2 * 86_400_000) // outside range

    const csv = tracker.exportCsv(at - 86_400_000, at + 86_400_000)
    expect(csv.split('\r\n')).toEqual([
      'Date,Task,Project folder,Duration (h:mm),Hours',
      '2026-11-10,Alpha,shop,1:00,1.00',
      '2026-11-10,Untagged,shop,0:10,0.17',
      ''
    ])
  })
})
