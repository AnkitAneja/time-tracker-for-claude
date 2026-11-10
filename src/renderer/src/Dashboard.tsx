import { useCallback, useEffect, useMemo, useState } from 'react'
import { Bar, BarChart, CartesianGrid, Cell, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { Stats } from '../../shared/types'
import { formatDuration } from '../../shared/format'

// Categorical slots (validated for color-blind separation, light and dark).
// A task's color comes from its all-time rank, so it keeps its color when the range changes.
const SERIES = {
  light: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300'],
  dark: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300']
}
const NEUTRAL = {
  light: { other: '#9a9994', untagged: '#cfcec9', grid: '#ececea', text: '#52514e', surface: '#ffffff' },
  dark: { other: '#7a7974', untagged: '#4a4a47', grid: '#2e2e30', text: '#c3c2b7', surface: '#1c1c1e' }
}
const OTHER = 'other'
const UNTAGGED = 'untagged'

const RANGES = [
  { id: 'today', label: 'Today', days: 1 },
  { id: '7d', label: '7 days', days: 7 },
  { id: '30d', label: '30 days', days: 30 }
] as const
type RangeId = (typeof RANGES)[number]['id']

function useDark(): boolean {
  const q = '(prefers-color-scheme: dark)'
  const [dark, setDark] = useState(() => matchMedia(q).matches)
  useEffect(() => {
    const m = matchMedia(q)
    const on = (): void => setDark(m.matches)
    m.addEventListener('change', on)
    return () => m.removeEventListener('change', on)
  }, [])
  return dark
}

function startOfDay(ms: number): number {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function dayKey(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function dayLabel(key: string, days: number): string {
  const [y, m, d] = key.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  return date.toLocaleDateString(undefined, days <= 7 ? { weekday: 'short' } : { day: 'numeric', month: 'short' })
}

/** Clean y-axis ticks: whole hours, or round minutes for small values. About 4 steps. */
function axisTicks(maxSeconds: number): { ticks: number[]; format: (s: number) => string } {
  const hours = maxSeconds >= 2 * 3600
  const unit = hours ? 3600 : 60
  const nice = hours ? [1, 2, 3, 4, 6, 8, 12] : [1, 2, 5, 10, 15, 20, 30]
  const step = (nice.find((n) => (maxSeconds / unit) / n <= 4) ?? nice[nice.length - 1]) * unit
  const ticks: number[] = []
  for (let t = 0; t < maxSeconds + step; t += step) ticks.push(t)
  return { ticks, format: (s) => (hours ? `${s / 3600}h` : `${s / 60}m`) }
}

interface Series {
  key: string
  name: string
  color: string
}

export function Dashboard(): React.JSX.Element {
  const dark = useDark()
  const mode = dark ? 'dark' : 'light'
  const n = NEUTRAL[mode]
  const [rangeId, setRangeId] = useState<RangeId>('7d')
  const [stats, setStats] = useState<Stats | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  const range = RANGES.find((r) => r.id === rangeId)!

  const load = useCallback(async () => {
    const now = Date.now()
    const from = startOfDay(now - (range.days - 1) * 86_400_000)
    setStats(await window.api.getStats(from, now + 1))
  }, [range.days])

  useEffect(() => {
    void load()
    return window.api.onChange(() => void load())
  }, [load])

  const view = useMemo(() => {
    if (!stats) return null
    const names = new Map(stats.tasks.map((t) => [t.id, t.name]))
    const slotOf = new Map(stats.taskRank.slice(0, SERIES[mode].length).map((id, i) => [id, i]))
    const keyOf = (taskId: number | null): string =>
      taskId === null ? UNTAGGED : slotOf.has(taskId) ? `t${taskId}` : OTHER
    const colorOf = (key: string): string =>
      key === UNTAGGED ? n.untagged : key === OTHER ? n.other : SERIES[mode][slotOf.get(Number(key.slice(1)))!]
    const nameOf = (key: string): string =>
      key === UNTAGGED ? 'Untagged' : key === OTHER ? 'Other tasks' : (names.get(Number(key.slice(1))) ?? 'Deleted task')

    // Series present in this range, in color-slot order, then Other, then Untagged.
    const present = new Set(stats.byDay.map((r) => keyOf(r.taskId)))
    const order = [...stats.taskRank.slice(0, SERIES[mode].length).map((id) => `t${id}`), OTHER, UNTAGGED]
    const series: Series[] = order.filter((k) => present.has(k)).map((k) => ({ key: k, name: nameOf(k), color: colorOf(k) }))

    // One row per day in the range, zero-filled.
    const rows: Record<string, number | string>[] = []
    for (let t = stats.from; t < stats.to; t += 86_400_000) {
      const key = dayKey(t)
      if (!rows.some((r) => r.day === key)) rows.push({ day: key })
    }
    for (const r of stats.byDay) {
      const row = rows.find((x) => x.day === r.day)
      if (!row) continue
      const k = keyOf(r.taskId)
      row[k] = ((row[k] as number) ?? 0) + r.seconds
    }
    const dayTotals = rows.map((r) => series.reduce((s, x) => s + ((r[x.key] as number) ?? 0), 0))

    const total = stats.byTask.reduce((s, t) => s + t.seconds, 0)
    const activeDays = dayTotals.filter((s) => s > 0).length
    const byTask = stats.byTask.map((t) => ({
      name: t.taskId === null ? 'Untagged' : (names.get(t.taskId) ?? 'Deleted task'),
      seconds: t.seconds,
      color: colorOf(keyOf(t.taskId))
    }))
    const byProject = stats.byProject.map((p) => ({ name: p.project ?? 'Unknown folder', seconds: p.seconds }))
    return {
      series,
      rows,
      maxDay: Math.max(0, ...dayTotals),
      total,
      avg: activeDays ? total / activeDays : 0,
      taskCount: stats.byTask.filter((t) => t.taskId !== null).length,
      byTask,
      byProject
    }
  }, [stats, mode, n])

  if (!view) return <section>Loading…</section>

  const yAxis = axisTicks(view.maxDay)
  const tick = { fill: n.text, fontSize: 12 }
  const tooltipStyle = {
    contentStyle: { background: n.surface, border: `1px solid ${n.grid}`, borderRadius: 8, fontSize: 12 },
    labelStyle: { color: n.text },
    itemStyle: { color: 'inherit', padding: 0 }
  }
  const barHeight = (count: number): number => Math.max(80, count * 30 + 24)

  return (
    <section className="dashboard">
      <div className="filters" role="group" aria-label="Date range">
        {RANGES.map((r) => (
          <button key={r.id} className={r.id === rangeId ? 'chip active' : 'chip'} onClick={() => { setRangeId(r.id); setSaved(null) }}>
            {r.label}
          </button>
        ))}
        <span className="spacer" />
        <button
          className="secondary"
          disabled={!stats || view.total === 0}
          onClick={async () => {
            if (!stats) return
            const label = `${dayKey(stats.from)}_to_${dayKey(stats.to - 1)}`
            setSaved(await window.api.exportCsv(stats.from, stats.to, label))
          }}
        >
          Export CSV
        </button>
      </div>
      {saved && (
        <p className="ok">
          Saved <code>{saved}</code>
        </p>
      )}

      <div className="tiles">
        <div className="tile">
          <div className="tile-label">Total</div>
          <div className="tile-value">{formatDuration(view.total)}</div>
        </div>
        {range.days > 1 && (
          <div className="tile">
            <div className="tile-label">Average per active day</div>
            <div className="tile-value">{formatDuration(view.avg)}</div>
          </div>
        )}
        <div className="tile">
          <div className="tile-label">Tasks</div>
          <div className="tile-value">{view.taskCount}</div>
        </div>
      </div>

      {view.total === 0 ? (
        <p className="muted">No Claude Code time in this range yet.</p>
      ) : (
        <>
          {range.days > 1 && (
            <figure>
              <figcaption>Time per day</figcaption>
              <ul className="legend">
                {view.series.map((s) => (
                  <li key={s.key}>
                    <span className="swatch" style={{ background: s.color }} />
                    {s.name}
                  </li>
                ))}
              </ul>
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={view.rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                  <CartesianGrid vertical={false} stroke={n.grid} />
                  <XAxis
                    dataKey="day"
                    tickFormatter={(k: string) => dayLabel(k, range.days)}
                    tick={tick}
                    tickLine={false}
                    axisLine={{ stroke: n.grid }}
                    interval="preserveStartEnd"
                    minTickGap={12}
                  />
                  <YAxis
                    ticks={yAxis.ticks}
                    domain={[0, yAxis.ticks[yAxis.ticks.length - 1]]}
                    tickFormatter={yAxis.format}
                    tick={tick}
                    tickLine={false}
                    axisLine={false}
                    width={36}
                  />
                  <Tooltip
                    {...tooltipStyle}
                    cursor={{ fill: n.grid, opacity: 0.6 }}
                    labelFormatter={(k) => dayLabel(String(k), 1) + ' ' + String(k).slice(5)}
                    formatter={(v, name) => [formatDuration(Number(v)), name]}
                  />
                  {view.series.map((s) => (
                    // A 2px surface-colored edge is the gap between stacked segments.
                    <Bar key={s.key} dataKey={s.key} name={s.name} stackId="day" fill={s.color} stroke={n.surface} strokeWidth={2} maxBarSize={24} isAnimationActive={false} />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            </figure>
          )}

          <HBars title="Time per task" data={view.byTask} height={barHeight(view.byTask.length)} n={n} tick={tick} tooltip={tooltipStyle} />
          <HBars
            title="Time per project folder"
            data={view.byProject.map((p) => ({ ...p, color: SERIES[mode][0] }))}
            height={barHeight(view.byProject.length)}
            n={n}
            tick={tick}
            tooltip={tooltipStyle}
          />
        </>
      )}
    </section>
  )
}

interface HBarsProps {
  title: string
  data: { name: string; seconds: number; color: string }[]
  height: number
  n: (typeof NEUTRAL)['light']
  tick: { fill: string; fontSize: number }
  tooltip: object
}

/** Horizontal bars with the value written at the tip, so no color has to be matched to read it. */
function HBars({ title, data, height, n, tick, tooltip }: HBarsProps): React.JSX.Element {
  const max = Math.max(0, ...data.map((d) => d.seconds))
  return (
    <figure>
      <figcaption>{title}</figcaption>
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={data} layout="vertical" margin={{ top: 0, right: 56, bottom: 0, left: 0 }}>
          <XAxis type="number" hide domain={[0, max]} />
          <YAxis
            type="category"
            dataKey="name"
            tick={tick}
            tickLine={false}
            axisLine={{ stroke: n.grid }}
            width={170}
            tickFormatter={(s: string) => (s.length > 26 ? s.slice(0, 25) + '…' : s)}
          />
          <Tooltip {...tooltip} cursor={{ fill: n.grid, opacity: 0.6 }} formatter={(v) => [formatDuration(Number(v)), 'Time']} />
          <Bar dataKey="seconds" radius={[0, 4, 4, 0]} barSize={16} isAnimationActive={false}>
            {data.map((d) => (
              <Cell key={d.name} fill={d.color} />
            ))}
            <LabelList dataKey="seconds" position="right" formatter={(v: unknown) => formatDuration(Number(v))} fill={n.text} fontSize={12} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </figure>
  )
}
