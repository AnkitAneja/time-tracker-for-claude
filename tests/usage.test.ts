import { describe, expect, it } from 'vitest'
import { openDatabase } from '../src/main/db'
import { Repo } from '../src/main/db/repo'
import { MetricsExtractor } from '../src/main/server/otlp'
import { Tracker } from '../src/main/tracker'
import { formatCost, formatCount } from '../src/shared/format'

const T0 = new Date(2026, 10, 12, 10, 0).getTime()
const nanos = (ms: number) => String(BigInt(ms) * 1_000_000n)

type Attrs = Record<string, string>
const kv = (a: Attrs) => Object.entries(a).map(([key, v]) => ({ key, value: { stringValue: v } }))
function otlp(metrics: { name: string; points: { attrs: Attrs; value: number }[]; temporality?: number }[], at = T0) {
  return {
    resourceMetrics: [
      {
        resource: { attributes: kv({ 'service.name': 'claude-code' }) },
        scopeMetrics: [
          {
            metrics: metrics.map((m) => ({
              name: m.name,
              sum: {
                aggregationTemporality: m.temporality ?? 1,
                dataPoints: m.points.map((p) => ({ attributes: kv(p.attrs), asDouble: p.value, timeUnixNano: nanos(at) }))
              }
            }))
          }
        ]
      }
    ]
  }
}

const S = { 'session.id': 's1', 'user.email': 'dev@example.com', 'user.account_uuid': 'acct-123' }

describe('usage metrics', () => {
  it('extracts cost, tokens, lines, commits and PRs, keeping only the type attribute', () => {
    const m = new MetricsExtractor().extract(
      otlp([
        { name: 'claude_code.cost.usage', points: [{ attrs: { ...S, model: 'claude-x' }, value: 0.12 }] },
        { name: 'claude_code.token.usage', points: [{ attrs: { ...S, type: 'input' }, value: 900 }, { attrs: { ...S, type: 'output' }, value: 100 }] },
        { name: 'claude_code.lines_of_code.count', points: [{ attrs: { ...S, type: 'added' }, value: 40 }, { attrs: { ...S, type: 'removed' }, value: 5 }] },
        { name: 'claude_code.commit.count', points: [{ attrs: S, value: 1 }] },
        { name: 'claude_code.pull_request.count', points: [{ attrs: S, value: 1 }] },
        { name: 'claude_code.session.count', points: [{ attrs: S, value: 1 }] }, // not tracked
        { name: 'claude_code.active_time.total', points: [{ attrs: { ...S, type: 'cli' }, value: 30 }] }
      ]),
      0
    )
    expect(m.activeTime).toEqual([{ sessionId: 's1', kind: 'cli', seconds: 30, timestamp: T0 }])
    expect(m.usage.map((u) => [u.metric, u.kind, u.value])).toEqual([
      ['cost', '', 0.12],
      ['tokens', 'input', 900],
      ['tokens', 'output', 100],
      ['lines', 'added', 40],
      ['lines', 'removed', 5],
      ['commits', '', 1],
      ['prs', '', 1]
    ])
    expect(JSON.stringify(m)).not.toContain('example.com')
  })

  it('de-cumulates each series separately', () => {
    const x = new MetricsExtractor()
    const cost = (a: number, b: number) =>
      otlp([{ name: 'claude_code.cost.usage', temporality: 2, points: [{ attrs: { ...S, model: 'a' }, value: a }, { attrs: { ...S, model: 'b' }, value: b }] }])
    expect(x.extract(cost(1, 2), 0).usage.map((u) => u.value)).toEqual([1, 2])
    expect(x.extract(cost(1.5, 2), 0).usage.map((u) => u.value)).toEqual([0.5])
  })

  it('tags usage with the session task, backfills on naming, and follows moves and merges', () => {
    const db = openDatabase(':memory:')
    const repo = new Repo(db)
    const tracker = new Tracker(repo, () => T0)
    const usage = (value: number, at = T0) => tracker.handleUsage([{ sessionId: 's1', metric: 'cost', kind: '', value, timestamp: at }])
    const rows = () => db.prepare('SELECT task_id, value FROM usage_records ORDER BY id').all()

    usage(0.1) // before the session has a task
    const a = tracker.createTask('A', null)
    repo.assignSessionTask('s1', a.id) // what auto naming does
    usage(0.2)
    tracker.handleActiveTime([{ sessionId: 's1', kind: 'cli', seconds: 10, timestamp: T0 }])
    expect(rows()).toEqual([
      { task_id: a.id, value: 0.1 },
      { task_id: a.id, value: 0.2 }
    ])

    const b = tracker.createTask('B', null)
    tracker.moveBlock(tracker.timeBlocks(T0 - 1, T0 + 1)[0], b.id)
    expect(rows()).toEqual([
      { task_id: b.id, value: 0.1 },
      { task_id: b.id, value: 0.2 }
    ])
    const c = tracker.createTask('C', null)
    tracker.mergeTask(b.id, c.id)
    expect(rows().every((r) => (r as { task_id: number }).task_id === c.id)).toBe(true)

    // A pinned task wins, as for time.
    tracker.setCurrentTask(a.id)
    usage(1)
    expect((rows().at(-1) as { task_id: number }).task_id).toBe(a.id)
  })

  it('reports per-task usage, range totals and today’s cost', () => {
    const repo = new Repo(openDatabase(':memory:'))
    const tracker = new Tracker(repo, () => T0)
    const a = tracker.createTask('A', null)
    repo.insertUsage('s1', a.id, 'cost', '', 1.25, T0)
    repo.insertUsage('s1', a.id, 'tokens', 'input', 1000, T0)
    repo.insertUsage('s1', a.id, 'lines', 'added', 30, T0)
    repo.insertUsage('s1', a.id, 'lines', 'removed', 4, T0)
    repo.insertUsage('s1', a.id, 'commits', '', 2, T0)
    repo.insertUsage('s2', null, 'cost', '', 0.5, T0)
    repo.insertUsage('s1', a.id, 'cost', '', 99, T0 - 3 * 86_400_000) // earlier day

    const s = tracker.stats(T0 - 3600_000, T0 + 3600_000)
    expect(s.usageByTask.find((u) => u.taskId === a.id)).toEqual({
      taskId: a.id, cost: 1.25, tokens: 1000, linesAdded: 30, linesRemoved: 4, commits: 2, prs: 0
    })
    expect(s.usageTotal).toMatchObject({ cost: 1.75, linesAdded: 30, commits: 2 })
    expect(tracker.state().todayCost).toBe(1.75)
  })

  it('formats cost and counts', () => {
    expect(formatCost(0)).toBe('$0.00')
    expect(formatCost(0.004)).toBe('<$0.01')
    expect(formatCost(1234.5)).toBe('$1,234.50')
    expect(formatCount(12345.4)).toBe('12,345')
  })
})
