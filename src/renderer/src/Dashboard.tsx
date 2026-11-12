import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Bar, BarChart, CartesianGrid, Cell, LabelList, Tooltip, XAxis, YAxis } from 'recharts'
import type { Stats } from '../../shared/types'
import { formatCost, formatCount, formatDuration } from '../../shared/format'

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
// Chart props are built once per theme. Recharts compares props by reference, so passing
// new objects on every render makes it recompute (and re-render) the whole chart each time.
function chartTheme(mode: 'light' | 'dark') {
  const n = NEUTRAL[mode]
  return {
    n,
    tick: { fill: n.text, fontSize: 12 },
    axisLine: { stroke: n.grid },
    cursor: { fill: n.grid, opacity: 0.6 },
    tooltip: {
      contentStyle: { background: n.surface, border: `1px solid ${n.grid}`, borderRadius: 8, fontSize: 12 },
      labelStyle: { color: n.text },
      itemStyle: { color: 'inherit', padding: 0 }
    }
  }
}
const THEMES = { light: chartTheme('light'), dark: chartTheme('dark') }
type Theme = (typeof THEMES)['light']

const DAY_MARGIN = { top: 8, right: 8, bottom: 0, left: 0 }
const HBAR_MARGIN = { top: 0, right: 56, bottom: 0, left: 0 }
const HBAR_RADIUS: [number, number, number, number] = [0, 4, 4, 0]
// How often new data may reload the dashboard while Claude Code is busy.
const RELOAD_MS = 5000

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

// Formatters are expensive to create, so make them once.
const WEEKDAY = new Intl.DateTimeFormat(undefined, { weekday: 'short' })
const DAY_MONTH = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' })
const FULL_DAY = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' })

function keyToDate(key: string): Date {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y, m - 1, d)
}
const weekdayLabel = (key: string): string => WEEKDAY.format(keyToDate(key))
const dayMonthLabel = (key: string): string => DAY_MONTH.format(keyToDate(key))
const tooltipDayLabel = (key: unknown): string => FULL_DAY.format(keyToDate(String(key)))
const durationTooltip = (v: unknown, name: unknown): [string, string] => [formatDuration(Number(v)), String(name)]
const timeTooltip = (v: unknown): [string, string] => [formatDuration(Number(v)), 'Time']
const durationLabel = (v: unknown): string => formatDuration(Number(v))
const shortName = (s: string): string => (s.length > 26 ? s.slice(0, 25) + '…' : s)

/** Width of an element, updated on resize. Re-renders only when the whole-pixel width changes. */
function useWidth(): [React.RefObject<HTMLElement | null>, number] {
  const ref = useRef<HTMLElement | null>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = (): void => setWidth(Math.floor(el.getBoundingClientRect().width))
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, width]
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
  const theme = THEMES[mode]
  const n = theme.n
  const [rangeId, setRangeId] = useState<RangeId>('7d')
  const [stats, setStats] = useState<Stats | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  const range = RANGES.find((r) => r.id === rangeId)!
  const [sectionRef, width] = useWidth()

  // Only the newest request may update the page, so a slow reply for the previous
  // range can't overwrite the current one. Identical data doesn't re-render.
  const requestId = useRef(0)
  const lastJson = useRef('')
  const load = useCallback(async () => {
    const id = ++requestId.current
    const now = Date.now()
    const from = startOfDay(now - (range.days - 1) * 86_400_000)
    const next = await window.api.getStats(from, now + 1)
    if (id !== requestId.current) return
    // from/to move every call; compare the numbers only.
    const json = JSON.stringify([next.byDay, next.byTask, next.byProject, next.taskRank, next.tasks])
    if (json === lastJson.current) return
    lastJson.current = json
    setStats(next)
  }, [range.days])

  useEffect(() => {
    lastJson.current = ''
    void load()
    // Claude Code sends data every few seconds; reload at most every RELOAD_MS.
    let timer: ReturnType<typeof setTimeout> | null = null
    const off = window.api.onChange(() => {
      if (timer) return
      timer = setTimeout(() => {
        timer = null
        void load()
      }, RELOAD_MS)
    })
    return () => {
      off()
      if (timer) clearTimeout(timer)
    }
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
    const maxDay = Math.max(0, ...dayTotals)
    const yAxis = axisTicks(maxDay)

    const total = stats.byTask.reduce((s, t) => s + t.seconds, 0)
    const activeDays = dayTotals.filter((s) => s > 0).length
    const byTask = stats.byTask.map((t) => ({
      name: t.taskId === null ? 'Untagged' : (names.get(t.taskId) ?? 'Deleted task'),
      seconds: t.seconds,
      color: colorOf(keyOf(t.taskId))
    }))
    // One table row per task that has time or usage in the range, largest time first.
    const usageOf = new Map(stats.usageByTask.map((u) => [u.taskId, u]))
    const ids = [...new Set([...stats.byTask.map((t) => t.taskId), ...stats.usageByTask.map((u) => u.taskId)])]
    const secondsOf = new Map(stats.byTask.map((t) => [t.taskId, t.seconds]))
    const table = ids
      .map((id) => {
        const u = usageOf.get(id)
        return {
          key: String(id),
          name: id === null ? 'Untagged' : (names.get(id) ?? 'Deleted task'),
          color: colorOf(keyOf(id)),
          seconds: secondsOf.get(id) ?? 0,
          cost: u?.cost ?? 0,
          linesAdded: u?.linesAdded ?? 0,
          linesRemoved: u?.linesRemoved ?? 0,
          commits: u?.commits ?? 0
        }
      })
      .sort((a, b) => b.seconds - a.seconds || b.cost - a.cost)
    const byProject = stats.byProject.map((p) => ({
      name: p.project ?? 'Unknown folder',
      seconds: p.seconds,
      color: SERIES[mode][0]
    }))
    return {
      series,
      rows,
      yTicks: yAxis.ticks,
      yDomain: [0, yAxis.ticks[yAxis.ticks.length - 1]] as [number, number],
      yFormat: yAxis.format,
      total,
      avg: activeDays ? total / activeDays : 0,
      taskCount: stats.byTask.filter((t) => t.taskId !== null).length,
      byTask,
      byProject,
      table,
      usage: stats.usageTotal
    }
  }, [stats, mode, n])

  const xFormat = range.days <= 7 ? weekdayLabel : dayMonthLabel
  const barHeight = (count: number): number => Math.max(80, count * 30 + 24)

  if (!view) return <section ref={sectionRef as React.RefObject<HTMLElement>}>Loading…</section>

  return (
    <section className="dashboard" ref={sectionRef as React.RefObject<HTMLElement>}>
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
        <div className="tile">
          <div className="tile-label">Claude cost</div>
          <div className="tile-value">{formatCost(view.usage.cost)}</div>
        </div>
        <div className="tile">
          <div className="tile-label">Lines changed</div>
          <div className="tile-value lines">
            <span className="added">+{formatCount(view.usage.linesAdded)}</span>{' '}
            <span className="removed">−{formatCount(view.usage.linesRemoved)}</span>
          </div>
          {(view.usage.commits > 0 || view.usage.prs > 0) && (
            <div className="tile-sub">
              {formatCount(view.usage.commits)} commits · {formatCount(view.usage.prs)} PRs
            </div>
          )}
        </div>
      </div>

      {view.total === 0 && view.usage.cost === 0 ? (
        <p className="muted">No Claude Code time in this range yet.</p>
      ) : width === 0 ? null : (
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
              <BarChart width={width} height={200} data={view.rows} margin={DAY_MARGIN}>
                <CartesianGrid vertical={false} stroke={n.grid} />
                <XAxis
                  dataKey="day"
                  tickFormatter={xFormat}
                  tick={theme.tick}
                  tickLine={false}
                  axisLine={theme.axisLine}
                  interval="preserveStartEnd"
                  minTickGap={12}
                />
                <YAxis
                  ticks={view.yTicks}
                  domain={view.yDomain}
                  tickFormatter={view.yFormat}
                  tick={theme.tick}
                  tickLine={false}
                  axisLine={false}
                  width={36}
                />
                <Tooltip
                  {...theme.tooltip}
                  cursor={theme.cursor}
                  labelFormatter={tooltipDayLabel}
                  formatter={durationTooltip}
                  isAnimationActive={false}
                />
                {view.series.map((s) => (
                  // A 2px surface-colored edge is the gap between stacked segments.
                  <Bar
                    key={s.key}
                    dataKey={s.key}
                    name={s.name}
                    stackId="day"
                    fill={s.color}
                    stroke={n.surface}
                    strokeWidth={2}
                    maxBarSize={24}
                    isAnimationActive={false}
                  />
                ))}
              </BarChart>
            </figure>
          )}

          <HBars title="Time per task" data={view.byTask} width={width} height={barHeight(view.byTask.length)} theme={theme} />

          <figure>
            <figcaption>Cost and output per task</figcaption>
            <table className="per-task">
              <thead>
                <tr>
                  <th>Task</th>
                  <th className="num">Time</th>
                  <th className="num">Cost</th>
                  <th className="num">Lines + / −</th>
                  <th className="num">Commits</th>
                </tr>
              </thead>
              <tbody>
                {view.table.map((r) => (
                  <tr key={r.key}>
                    <td>
                      <span className="swatch" style={{ background: r.color }} /> {r.name}
                    </td>
                    <td className="num">{formatDuration(r.seconds)}</td>
                    <td className="num">{formatCost(r.cost)}</td>
                    <td className="num">
                      {r.linesAdded + r.linesRemoved === 0 ? (
                        <span className="muted">—</span>
                      ) : (
                        <>
                          <span className="added">+{formatCount(r.linesAdded)}</span>{' '}
                          <span className="removed">−{formatCount(r.linesRemoved)}</span>
                        </>
                      )}
                    </td>
                    <td className="num">{formatCount(r.commits)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </figure>
          <HBars
            title="Time per project folder"
            data={view.byProject}
            width={width}
            height={barHeight(view.byProject.length)}
            theme={theme}
          />
        </>
      )}
    </section>
  )
}

interface HBarsProps {
  title: string
  data: { name: string; seconds: number; color: string }[]
  width: number
  height: number
  theme: Theme
}

/** Horizontal bars with the value written at the tip, so no color has to be matched to read it. */
const HBars = memo(function HBars({ title, data, width, height, theme }: HBarsProps): React.JSX.Element {
  const domain = useMemo<[number, number]>(() => [0, Math.max(0, ...data.map((d) => d.seconds))], [data])
  return (
    <figure>
      <figcaption>{title}</figcaption>
      <BarChart width={width} height={height} data={data} layout="vertical" margin={HBAR_MARGIN}>
        <XAxis type="number" hide domain={domain} />
        <YAxis
          type="category"
          dataKey="name"
          tick={theme.tick}
          tickLine={false}
          axisLine={theme.axisLine}
          width={170}
          tickFormatter={shortName}
        />
        <Tooltip {...theme.tooltip} cursor={theme.cursor} formatter={timeTooltip} isAnimationActive={false} />
        <Bar dataKey="seconds" radius={HBAR_RADIUS} barSize={16} isAnimationActive={false}>
          {data.map((d) => (
            <Cell key={d.name} fill={d.color} />
          ))}
          <LabelList dataKey="seconds" position="right" formatter={durationLabel} fill={theme.n.text} fontSize={12} />
        </Bar>
      </BarChart>
    </figure>
  )
})
