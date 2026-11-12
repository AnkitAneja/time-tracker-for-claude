/** 0 → "0m", 20 → "<1m", 2700 → "45m", 3900 → "1h 05m". Seconds are floored to whole minutes. */
export function formatDuration(seconds: number): string {
  if (seconds > 0 && seconds < 60) return '<1m'
  const mins = Math.floor(seconds / 60)
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`
}

/** "just now", "3 min ago", "2 h ago". */
export function formatAgo(ms: number, now: number): string {
  const mins = Math.floor((now - ms) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  return `${Math.floor(mins / 60)} h ago`
}

/** 0 → "$0.00", 0.004 → "<$0.01", 3.456 → "$3.46", 1234.5 → "$1,234.50". */
export function formatCost(usd: number): string {
  if (usd > 0 && usd < 0.01) return '<$0.01'
  return '$' + usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/** Whole counts with thousands separators: 1234 → "1,234". */
export function formatCount(n: number): string {
  return Math.round(n).toLocaleString('en-US')
}
