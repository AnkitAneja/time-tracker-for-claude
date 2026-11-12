import type { DB } from './index'
import type { DayTaskTotal, ProjectTotal, Task, TaskTotal, TaskUsage } from '../../shared/types'

// Pivots usage_records rows into the UsageTotals columns.
const USAGE_SELECT = `SUM(CASE WHEN metric = 'cost' THEN value ELSE 0 END) AS cost,
           SUM(CASE WHEN metric = 'tokens' THEN value ELSE 0 END) AS tokens,
           SUM(CASE WHEN metric = 'lines' AND kind = 'added' THEN value ELSE 0 END) AS linesAdded,
           SUM(CASE WHEN metric = 'lines' AND kind = 'removed' THEN value ELSE 0 END) AS linesRemoved,
           SUM(CASE WHEN metric = 'commits' THEN value ELSE 0 END) AS commits,
           SUM(CASE WHEN metric = 'prs' THEN value ELSE 0 END) AS prs`

/** All SQL lives here so the rest of the app works with plain objects. */
export class Repo {
  constructor(private db: DB) {}

  // --- tasks ---

  createTask(name: string, project: string | null, now: number, source: Task['source'] = 'manual'): Task {
    const info = this.db
      .prepare('INSERT INTO tasks (name, project, source, created_at) VALUES (?, ?, ?, ?)')
      .run(name, project, source, now)
    return this.getTask(Number(info.lastInsertRowid))!
  }

  getTask(id: number): Task | undefined {
    return this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Task | undefined
  }

  listTasks(includeArchived = false): Task[] {
    const sql = includeArchived
      ? 'SELECT * FROM tasks ORDER BY created_at DESC'
      : "SELECT * FROM tasks WHERE status = 'active' ORDER BY created_at DESC"
    return this.db.prepare(sql).all() as Task[]
  }

  /** Active task with this name (case-insensitive) in this project, so auto naming doesn't make duplicates. */
  findActiveTask(name: string, project: string | null): Task | undefined {
    return this.db
      .prepare("SELECT * FROM tasks WHERE status = 'active' AND name = ? COLLATE NOCASE AND project IS ? ORDER BY id LIMIT 1")
      .get(name, project) as Task | undefined
  }

  renameTask(id: number, name: string): void {
    this.db.prepare('UPDATE tasks SET name = ? WHERE id = ?').run(name, id)
  }

  /** Moves everything of task `from` onto task `into`, then archives `from`. */
  mergeTask(from: number, into: number): void {
    this.db.transaction(() => {
      for (const table of ['time_records', 'usage_records', 'events', 'sessions'])
        this.db.prepare(`UPDATE ${table} SET task_id = ? WHERE task_id = ?`).run(into, from)
      this.archiveTask(from)
    })()
  }

  archiveTask(id: number): void {
    this.db.prepare("UPDATE tasks SET status = 'archived' WHERE id = ?").run(id)
  }

  // --- settings (key/value) ---

  getSetting(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined
    return row?.value ?? null
  }

  setSetting(key: string, value: string | null): void {
    if (value === null) this.db.prepare('DELETE FROM settings WHERE key = ?').run(key)
    else
      this.db
        .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run(key, value)
  }

  // --- sessions and events ---

  /** Creates the session on first sight; fills cwd later if it was missing. */
  touchSession(sessionId: string, cwd: string | null, now: number): void {
    this.db
      .prepare(
        `INSERT INTO sessions (session_id, cwd, started_at) VALUES (?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET cwd = COALESCE(sessions.cwd, excluded.cwd)`
      )
      .run(sessionId, cwd, now)
  }

  getSession(
    sessionId: string
  ): { session_id: string; cwd: string | null; task_id: number | null; task_locked: number } | undefined {
    return this.db
      .prepare('SELECT session_id, cwd, task_id, task_locked FROM sessions WHERE session_id = ?')
      .get(sessionId) as { session_id: string; cwd: string | null; task_id: number | null; task_locked: number } | undefined
  }

  /** The user picked this session's task by hand; auto naming stops changing it. */
  lockSessionTask(sessionId: string, taskId: number | null): void {
    this.db.prepare('UPDATE sessions SET task_id = ?, task_locked = 1 WHERE session_id = ?').run(taskId, sessionId)
  }

  /**
   * Points the session at a task from now on, and gives the task any of the session's
   * earlier time and events that had no task yet (the time before it was first named).
   */
  assignSessionTask(sessionId: string, taskId: number): void {
    this.db.transaction(() => {
      this.db.prepare('UPDATE sessions SET task_id = ? WHERE session_id = ?').run(taskId, sessionId)
      this.db.prepare('UPDATE time_records SET task_id = ? WHERE session_id = ? AND task_id IS NULL').run(taskId, sessionId)
      this.db.prepare('UPDATE usage_records SET task_id = ? WHERE session_id = ? AND task_id IS NULL').run(taskId, sessionId)
      this.db.prepare('UPDATE events SET task_id = ? WHERE session_id = ? AND task_id IS NULL').run(taskId, sessionId)
    })()
  }

  reopenSession(sessionId: string): void {
    this.db
      .prepare('UPDATE sessions SET ended_at = NULL, end_reason = NULL WHERE session_id = ?')
      .run(sessionId)
  }

  endSession(sessionId: string, now: number, reason: string | null): void {
    this.db
      .prepare('UPDATE sessions SET ended_at = ?, end_reason = ? WHERE session_id = ?')
      .run(now, reason, sessionId)
  }

  insertEvent(sessionId: string, type: string, detail: string | null, now: number, taskId: number | null): void {
    this.db
      .prepare('INSERT INTO events (session_id, type, detail, timestamp, task_id) VALUES (?, ?, ?, ?, ?)')
      .run(sessionId, type, detail, now, taskId)
  }

  // --- time ---

  insertTimeRecord(
    sessionId: string | null,
    taskId: number | null,
    kind: string,
    seconds: number,
    timestamp: number
  ): void {
    this.db
      .prepare('INSERT INTO time_records (session_id, task_id, kind, seconds, timestamp) VALUES (?, ?, ?, ?, ?)')
      .run(sessionId, taskId, kind, seconds, timestamp)
  }

  insertUsage(
    sessionId: string | null,
    taskId: number | null,
    metric: string,
    kind: string,
    value: number,
    timestamp: number
  ): void {
    this.db
      .prepare('INSERT INTO usage_records (session_id, task_id, metric, kind, value, timestamp) VALUES (?, ?, ?, ?, ?, ?)')
      .run(sessionId, taskId, metric, kind, value, timestamp)
  }

  costSince(since: number): number {
    const r = this.db
      .prepare("SELECT COALESCE(SUM(value), 0) AS c FROM usage_records WHERE metric = 'cost' AND timestamp >= ?")
      .get(since) as { c: number }
    return r.c
  }

  usageByTask(from: number, to: number): TaskUsage[] {
    return this.db
      .prepare(
        `SELECT task_id AS taskId, ${USAGE_SELECT}
         FROM usage_records WHERE timestamp >= ? AND timestamp < ? GROUP BY task_id`
      )
      .all(from, to) as TaskUsage[]
  }

  /** Seconds recorded since `since`, grouped by task (null = no task). */
  totalsSince(since: number): TaskTotal[] {
    const rows = this.db
      .prepare('SELECT task_id AS taskId, SUM(seconds) AS seconds FROM time_records WHERE timestamp >= ? GROUP BY task_id')
      .all(since) as TaskTotal[]
    return rows
  }

  // --- corrections ---

  /** Time records in [from, to) with their session folder, ordered for grouping into blocks. */
  recordsForBlocks(
    from: number,
    to: number
  ): { sessionId: string | null; taskId: number | null; cwd: string | null; seconds: number; timestamp: number }[] {
    return this.db
      .prepare(
        `SELECT r.session_id AS sessionId, r.task_id AS taskId, s.cwd AS cwd, r.seconds AS seconds, r.timestamp AS timestamp
         FROM time_records r LEFT JOIN sessions s ON s.session_id = r.session_id
         WHERE r.timestamp >= ? AND r.timestamp < ?
         ORDER BY r.session_id, r.timestamp`
      )
      .all(from, to) as { sessionId: string | null; taskId: number | null; cwd: string | null; seconds: number; timestamp: number }[]
  }

  /** Re-tags one block's records (and events in the same time span). Returns how many records moved. */
  moveRecords(sessionId: string | null, fromTask: number | null, start: number, end: number, toTask: number | null): number {
    return this.db.transaction(() => {
      const n = this.db
        .prepare('UPDATE time_records SET task_id = ? WHERE session_id IS ? AND task_id IS ? AND timestamp BETWEEN ? AND ?')
        .run(toTask, sessionId, fromTask, start, end).changes
      for (const table of ['usage_records', 'events'])
        this.db
          .prepare(`UPDATE ${table} SET task_id = ? WHERE session_id IS ? AND task_id IS ? AND timestamp BETWEEN ? AND ?`)
          .run(toTask, sessionId, fromTask, start, end)
      return n
    })()
  }

  /** Latest record time for a session, to tell whether a block is the session's most recent one. */
  lastRecordAt(sessionId: string): number | null {
    const r = this.db.prepare('SELECT MAX(timestamp) AS t FROM time_records WHERE session_id = ?').get(sessionId) as { t: number | null }
    return r.t
  }

  untaggedSecondsSince(since: number): number {
    const r = this.db
      .prepare('SELECT COALESCE(SUM(seconds), 0) AS s FROM time_records WHERE task_id IS NULL AND timestamp >= ?')
      .get(since) as { s: number }
    return r.s
  }

  // --- export ---

  exportRows(from: number, to: number): { day: string; task: string | null; cwd: string | null; seconds: number }[] {
    return this.db
      .prepare(
        `SELECT date(r.timestamp / 1000, 'unixepoch', 'localtime') AS day, t.name AS task, s.cwd AS cwd, SUM(r.seconds) AS seconds
         FROM time_records r
         LEFT JOIN tasks t ON t.id = r.task_id
         LEFT JOIN sessions s ON s.session_id = r.session_id
         WHERE r.timestamp >= ? AND r.timestamp < ?
         GROUP BY day, r.task_id, s.cwd
         ORDER BY day, task IS NULL, task, cwd`
      )
      .all(from, to) as { day: string; task: string | null; cwd: string | null; seconds: number }[]
  }

  exportUsageRows(
    from: number,
    to: number
  ): { day: string; task: string | null; cwd: string | null; cost: number; linesAdded: number; linesRemoved: number; commits: number }[] {
    return this.db
      .prepare(
        `SELECT date(u.timestamp / 1000, 'unixepoch', 'localtime') AS day, t.name AS task, s.cwd AS cwd, ${USAGE_SELECT}
         FROM usage_records u
         LEFT JOIN tasks t ON t.id = u.task_id
         LEFT JOIN sessions s ON s.session_id = u.session_id
         WHERE u.timestamp >= ? AND u.timestamp < ?
         GROUP BY day, u.task_id, s.cwd`
      )
      .all(from, to) as { day: string; task: string | null; cwd: string | null; cost: number; linesAdded: number; linesRemoved: number; commits: number }[]
  }

  // --- dashboard ---

  totalsByDay(from: number, to: number): DayTaskTotal[] {
    return this.db
      .prepare(
        `SELECT date(timestamp / 1000, 'unixepoch', 'localtime') AS day, task_id AS taskId, SUM(seconds) AS seconds
         FROM time_records WHERE timestamp >= ? AND timestamp < ?
         GROUP BY day, task_id ORDER BY day`
      )
      .all(from, to) as DayTaskTotal[]
  }

  totalsByTask(from: number, to: number): TaskTotal[] {
    return this.db
      .prepare(
        `SELECT task_id AS taskId, SUM(seconds) AS seconds FROM time_records
         WHERE timestamp >= ? AND timestamp < ? GROUP BY task_id ORDER BY seconds DESC`
      )
      .all(from, to) as TaskTotal[]
  }

  /** Project = the session's folder; a session seen only through metrics has no folder (null). */
  totalsByProjectCwd(from: number, to: number): { cwd: string | null; seconds: number }[] {
    return this.db
      .prepare(
        `SELECT s.cwd AS cwd, SUM(r.seconds) AS seconds
         FROM time_records r LEFT JOIN sessions s ON s.session_id = r.session_id
         WHERE r.timestamp >= ? AND r.timestamp < ? GROUP BY s.cwd ORDER BY seconds DESC`
      )
      .all(from, to) as { cwd: string | null; seconds: number }[]
  }

  taskRank(): number[] {
    return (
      this.db
        .prepare('SELECT task_id AS id FROM time_records WHERE task_id IS NOT NULL GROUP BY task_id ORDER BY SUM(seconds) DESC')
        .all() as { id: number }[]
    ).map((r) => r.id)
  }
}
