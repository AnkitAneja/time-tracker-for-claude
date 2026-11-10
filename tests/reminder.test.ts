import { describe, expect, it } from 'vitest'
import { Reminder } from '../src/main/reminder'

describe('untagged time reminder', () => {
  it('notifies past 5 min untagged, then waits 30 min before the next one', () => {
    let now = 0
    let untagged = 200
    let enabled = true
    const sent: number[] = []
    const r = new Reminder({ now: () => now, untaggedSince: () => untagged, enabled: () => enabled, notify: (s) => sent.push(s) })

    expect(r.check()).toBe(false) // 200 s is under the threshold
    untagged = 400
    expect(r.check()).toBe(true)
    now += 10 * 60_000
    expect(r.check()).toBe(false) // cooldown
    now += 25 * 60_000
    enabled = false
    expect(r.check()).toBe(false) // turned off
    enabled = true
    expect(r.check()).toBe(true)
    expect(sent).toEqual([400, 400])
  })
})
