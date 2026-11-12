// Builds a timesheet CSV: one row per day, task and project folder.

export interface ExportRow {
  day: string
  task: string | null
  project: string | null
  seconds: number
  cost: number
  linesAdded: number
  linesRemoved: number
  commits: number
}

/** Quotes a cell, and stops spreadsheet apps from running text that starts like a formula. */
export function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

function hhmm(seconds: number): string {
  const mins = Math.round(seconds / 60)
  return `${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, '0')}`
}

export function toCsv(rows: ExportRow[]): string {
  const lines = [
    ['Date', 'Task', 'Project folder', 'Duration (h:mm)', 'Hours', 'Cost (USD)', 'Lines added', 'Lines removed', 'Commits'].join(',')
  ]
  for (const r of rows) {
    lines.push(
      [
        r.day,
        csvCell(r.task ?? 'Untagged'),
        csvCell(r.project ?? ''),
        hhmm(r.seconds),
        (r.seconds / 3600).toFixed(2),
        r.cost.toFixed(2),
        String(Math.round(r.linesAdded)),
        String(Math.round(r.linesRemoved)),
        String(Math.round(r.commits))
      ].join(',')
    )
  }
  return lines.join('\r\n') + '\r\n'
}
