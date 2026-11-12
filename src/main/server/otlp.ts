// Parses OTLP/HTTP JSON metric exports and pulls out claude_code.active_time.total.
// Format reference: opentelemetry-proto ExportMetricsServiceRequest, JSON encoding.

export const ACTIVE_TIME_METRIC = 'claude_code.active_time.total'

export interface ActiveTimePoint {
  sessionId: string | null
  /** "user" (typing/reading) or "cli" (tools, model responses), as sent by Claude Code. */
  kind: string
  /** Seconds of active time in this export window. */
  seconds: number
  /** End of the export window, ms epoch. */
  timestamp: number
}

interface KeyValue {
  key: string
  value?: { stringValue?: string; intValue?: string | number; doubleValue?: number; boolValue?: boolean }
}

interface NumberDataPoint {
  attributes?: KeyValue[]
  timeUnixNano?: string | number
  asDouble?: number
  asInt?: string | number
}

interface Sum {
  dataPoints?: NumberDataPoint[]
  aggregationTemporality?: number | string
}

interface OtlpMetricsRequest {
  resourceMetrics?: {
    resource?: { attributes?: KeyValue[] }
    scopeMetrics?: { metrics?: { name?: string; sum?: Sum }[] }[]
  }[]
}

const CUMULATIVE = new Set<number | string>([2, 'AGGREGATION_TEMPORALITY_CUMULATIVE'])

function attr(list: KeyValue[] | undefined, key: string): string | null {
  const v = list?.find((a) => a.key === key)?.value
  if (!v) return null
  if (v.stringValue !== undefined) return v.stringValue
  if (v.intValue !== undefined) return String(v.intValue)
  if (v.doubleValue !== undefined) return String(v.doubleValue)
  if (v.boolValue !== undefined) return String(v.boolValue)
  return null
}

function nanosToMs(n: string | number | undefined, fallback: number): number {
  if (n === undefined) return fallback
  const ms = Number(BigInt(n) / 1_000_000n)
  return ms > 0 ? ms : fallback
}

/** Usage metrics kept per task. Values are increments (delta), already de-cumulated. */
export type UsageMetric = 'cost' | 'tokens' | 'lines' | 'commits' | 'prs'

export interface UsagePoint {
  sessionId: string | null
  metric: UsageMetric
  /** Token type (input/output/cacheRead/cacheCreation), lines type (added/removed), or '' for the rest. */
  kind: string
  /** USD for cost, a count for everything else. */
  value: number
  timestamp: number
}

// OTLP metric name → what we store. Only the `type` attribute is kept; everything else
// (model, user.email, account ids, …) is ignored so it never reaches the database.
const USAGE_METRICS: Record<string, UsageMetric> = {
  'claude_code.cost.usage': 'cost',
  'claude_code.token.usage': 'tokens',
  'claude_code.lines_of_code.count': 'lines',
  'claude_code.commit.count': 'commits',
  'claude_code.pull_request.count': 'prs'
}

export interface ExtractedMetrics {
  activeTime: ActiveTimePoint[]
  usage: UsagePoint[]
}

function attrKey(list: KeyValue[] | undefined): string {
  return (list ?? [])
    .map((a) => `${a.key}=${JSON.stringify(a.value ?? null)}`)
    .sort()
    .join('&')
}

/**
 * Turns OTLP payloads into increments: active time, plus cost, tokens, lines of code,
 * commits and pull requests. Claude Code sends delta temporality by default. If a user
 * forces cumulative, this keeps the last total per series (metric + all attributes) and
 * returns the difference instead.
 */
export class MetricsExtractor {
  private lastCumulative = new Map<string, number>()

  extract(body: unknown, now: number): ExtractedMetrics {
    const req = body as OtlpMetricsRequest
    const out: ExtractedMetrics = { activeTime: [], usage: [] }

    for (const rm of req?.resourceMetrics ?? []) {
      const resourceAttrs = rm.resource?.attributes
      for (const sm of rm.scopeMetrics ?? []) {
        for (const metric of sm.metrics ?? []) {
          const name = metric.name ?? ''
          const usage = USAGE_METRICS[name]
          if ((name !== ACTIVE_TIME_METRIC && !usage) || !metric.sum) continue
          const cumulative = CUMULATIVE.has(metric.sum.aggregationTemporality ?? 1)

          for (const dp of metric.sum.dataPoints ?? []) {
            const raw = dp.asDouble ?? (dp.asInt !== undefined ? Number(dp.asInt) : NaN)
            if (!Number.isFinite(raw)) continue

            const sessionId = attr(dp.attributes, 'session.id') ?? attr(resourceAttrs, 'session.id')
            let value = raw
            if (cumulative) {
              const key = `${name}|${attrKey(resourceAttrs)}|${attrKey(dp.attributes)}`
              const prev = this.lastCumulative.get(key)
              this.lastCumulative.set(key, raw)
              // A drop means the counter restarted, so the new value is all new.
              if (prev !== undefined && raw >= prev) value = raw - prev
            }
            if (value <= 0) continue

            const timestamp = nanosToMs(dp.timeUnixNano, now)
            if (name === ACTIVE_TIME_METRIC) {
              out.activeTime.push({ sessionId, kind: attr(dp.attributes, 'type') ?? 'unknown', seconds: value, timestamp })
            } else {
              const kind = usage === 'tokens' || usage === 'lines' ? (attr(dp.attributes, 'type') ?? 'unknown') : ''
              out.usage.push({ sessionId, metric: usage, kind, value, timestamp })
            }
          }
        }
      }
    }
    return out
  }
}

/** Active time only. Kept for callers and tests that need just that. */
export class ActiveTimeExtractor {
  private inner = new MetricsExtractor()
  extract(body: unknown, now: number): ActiveTimePoint[] {
    return this.inner.extract(body, now).activeTime
  }
}
