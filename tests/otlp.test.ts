import { describe, expect, it } from 'vitest'
import fixture from './fixtures/otlp-delta.json'
import { ActiveTimeExtractor } from '../src/main/server/otlp'

function cumulative(value: number, session = 's1', type = 'user'): unknown {
  return {
    resourceMetrics: [
      {
        scopeMetrics: [
          {
            metrics: [
              {
                name: 'claude_code.active_time.total',
                sum: {
                  aggregationTemporality: 'AGGREGATION_TEMPORALITY_CUMULATIVE',
                  dataPoints: [
                    {
                      attributes: [
                        { key: 'session.id', value: { stringValue: session } },
                        { key: 'type', value: { stringValue: type } }
                      ],
                      asInt: String(value)
                    }
                  ]
                }
              }
            ]
          }
        ]
      }
    ]
  }
}

describe('ActiveTimeExtractor', () => {
  it('reads delta active time and ignores other metrics', () => {
    const points = new ActiveTimeExtractor().extract(fixture, 0)
    expect(points).toEqual([
      { sessionId: 'sess-1', kind: 'user', seconds: 4.5, timestamp: 1762768810000 },
      { sessionId: 'sess-1', kind: 'cli', seconds: 5.25, timestamp: 1762768810000 }
    ])
  })

  it('turns cumulative totals into increments per session and kind', () => {
    const x = new ActiveTimeExtractor()
    expect(x.extract(cumulative(10), 5)[0]).toMatchObject({ seconds: 10, timestamp: 5 })
    expect(x.extract(cumulative(25), 5)[0].seconds).toBe(15)
    expect(x.extract(cumulative(25), 5)).toEqual([]) // no change
    expect(x.extract(cumulative(3, 's2'), 5)[0].seconds).toBe(3) // separate session
    expect(x.extract(cumulative(4), 5)[0].seconds).toBe(4) // counter restarted
  })

  it('takes session.id from resource attributes when not on the data point', () => {
    const body = {
      resourceMetrics: [
        {
          resource: { attributes: [{ key: 'session.id', value: { stringValue: 'res-sess' } }] },
          scopeMetrics: [
            { metrics: [{ name: 'claude_code.active_time.total', sum: { dataPoints: [{ asDouble: 2 }] } }] }
          ]
        }
      ]
    }
    expect(new ActiveTimeExtractor().extract(body, 7)).toEqual([
      { sessionId: 'res-sess', kind: 'unknown', seconds: 2, timestamp: 7 }
    ])
  })

  it('survives junk input', () => {
    const x = new ActiveTimeExtractor()
    expect(x.extract(null, 0)).toEqual([])
    expect(x.extract({ resourceMetrics: [{}] }, 0)).toEqual([])
    expect(x.extract('nope', 0)).toEqual([])
  })
})
