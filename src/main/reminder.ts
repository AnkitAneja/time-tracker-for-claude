// Nudges the user when Claude Code time is piling up with no task.

export const REMINDER_WINDOW_MS = 30 * 60_000
export const REMINDER_THRESHOLD_S = 5 * 60
export const REMINDER_COOLDOWN_MS = 30 * 60_000

export interface ReminderDeps {
  now: () => number
  /** Seconds of untagged time recorded since `since`. */
  untaggedSince: (since: number) => number
  enabled: () => boolean
  notify: (untaggedSeconds: number) => void
}

/** Call check() every minute or so. Notifies at most once per cooldown. */
export class Reminder {
  private lastNotified = -Infinity

  constructor(private deps: ReminderDeps) {}

  check(): boolean {
    const now = this.deps.now()
    if (!this.deps.enabled() || now - this.lastNotified < REMINDER_COOLDOWN_MS) return false
    const untagged = this.deps.untaggedSince(now - REMINDER_WINDOW_MS)
    if (untagged < REMINDER_THRESHOLD_S) return false
    this.lastNotified = now
    this.deps.notify(untagged)
    return true
  }
}
