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

/**
 * Turns OTLP payloads into active-time increments.
 * Claude Code sends delta temporality by default. If a user forces cumulative,
 * this keeps the last total per session+kind and returns the difference instead.
 */
export class ActiveTimeExtractor {
  private lastCumulative = new Map<string, number>()

  extract(body: unknown, now: number): ActiveTimePoint[] {
    const req = body as OtlpMetricsRequest
    const out: ActiveTimePoint[] = []

    for (const rm of req?.resourceMetrics ?? []) {
      const resourceAttrs = rm.resource?.attributes
      for (const sm of rm.scopeMetrics ?? []) {
        for (const metric of sm.metrics ?? []) {
          if (metric.name !== ACTIVE_TIME_METRIC || !metric.sum) continue
          const cumulative = CUMULATIVE.has(metric.sum.aggregationTemporality ?? 1)

          for (const dp of metric.sum.dataPoints ?? []) {
            const raw = dp.asDouble ?? (dp.asInt !== undefined ? Number(dp.asInt) : NaN)
            if (!Number.isFinite(raw)) continue

            const sessionId = attr(dp.attributes, 'session.id') ?? attr(resourceAttrs, 'session.id')
            const kind = attr(dp.attributes, 'type') ?? 'unknown'
            let seconds = raw

            if (cumulative) {
              const key = `${sessionId ?? ''}|${kind}`
              const prev = this.lastCumulative.get(key)
              this.lastCumulative.set(key, raw)
              // A drop means the counter restarted, so the new value is all new time.
              if (prev !== undefined && raw >= prev) seconds = raw - prev
            }

            if (seconds <= 0) continue
            out.push({ sessionId, kind, seconds, timestamp: nanosToMs(dp.timeUnixNano, now) })
          }
        }
      }
    }
    return out
  }
}
