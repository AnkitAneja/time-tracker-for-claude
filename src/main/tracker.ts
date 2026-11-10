import { EventEmitter } from 'node:events'
import path from 'node:path'
import type { Repo } from './db/repo'
import { type ExportRow, toCsv } from './export'
import { AutoTasker, type NameResult, type Namer } from './naming/autotask'
import type { HookEvent } from './server/hooks'
import type { ActiveTimePoint } from './server/otlp'
import { BLOCK_GAP_MS, type ProjectTotal, type Stats, type Task, type TimeBlock, type TrackerState } from '../shared/types'

const CURRENT_TASK_KEY = 'current_task_id'

export function startOfLocalDay(ms: number): number {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

export interface TrackerOptions {
  /** Names each session's task from its conversation. Without it, sessions stay unnamed. */
  namer?: Namer
  /** Hooks from this folder are ignored (the naming calls run there). */
  ignoreCwd?: string
  recheckEvery?: number
}

const MAX_TASKS_FOR_NAMER = 25

/**
 * Decides which task each record belongs to and saves it.
 * Rule: a task pinned by hand wins. Otherwise (auto mode) a record gets its session's
 * task, which is named from the conversation. Time from before the first name is moved
 * onto that task once it's named. With a 10 s export interval, a task switch can
 * misattribute at most about 10 s.
 *
 * Emits 'change' whenever the tray or window should refresh.
 */
export class Tracker extends EventEmitter {
  private currentTaskId: number | null
  private lastDataAt: number | null = null
  private problem: string | null = null
  private namingProblem: string | null = null
  private lastSessionId: string | null = null
  private auto: AutoTasker | null = null
  private ignoreCwd: string | null

  constructor(
    private repo: Repo,
    private now: () => number = Date.now,
    opts: TrackerOptions = {}
  ) {
    super()
    this.ignoreCwd = opts.ignoreCwd ?? null
    if (opts.namer) {
      this.auto = new AutoTasker(
        opts.namer,
        (id) => this.namingContext(id),
        (id, r) => this.applyName(id, r),
        (id, err) => this.namingFailed(id, err),
        { recheckEvery: opts.recheckEvery }
      )
    }
    const saved = repo.getSetting(CURRENT_TASK_KEY)
    const id = saved === null ? null : Number(saved)
    // Drop a saved task that was archived or deleted since.
    this.currentTaskId = id !== null && repo.getTask(id)?.status === 'active' ? id : null
  }

  // --- tasks ---

  listTasks(): Task[] {
    return this.repo.listTasks()
  }

  createTask(name: string, project: string | null): Task {
    const clean = name.trim()
    if (!clean) throw new Error('Task name is required')
    const task = this.repo.createTask(clean, project?.trim() || null, this.now())
    this.emit('change')
    return task
  }

  archiveTask(id: number): void {
    this.repo.archiveTask(id)
    if (this.currentTaskId === id) this.setCurrentTask(null)
    else this.emit('change')
  }

  renameTask(id: number, name: string): void {
    const clean = name.trim()
    if (!clean) throw new Error('Task name is required')
    if (!this.repo.getTask(id)) throw new Error(`No task ${id}`)
    this.repo.renameTask(id, clean)
    this.emit('change')
  }

  mergeTask(fromId: number, intoId: number): void {
    if (fromId === intoId) throw new Error('Pick a different task to merge into')
    if (this.repo.getTask(intoId)?.status !== 'active') throw new Error(`No active task ${intoId}`)
    this.repo.mergeTask(fromId, intoId)
    if (this.currentTaskId === fromId) this.setCurrentTask(intoId)
    else this.emit('change')
  }

  /** Timesheet CSV for [from, to). Folders with the same name are merged, like the dashboard. */
  exportCsv(from: number, to: number): string {
    const merged = new Map<string, ExportRow>()
    for (const r of this.repo.exportRows(from, to)) {
      const project = r.cwd ? path.basename(r.cwd) : null
      const key = JSON.stringify([r.day, r.task, project])
      const row = merged.get(key) ?? { day: r.day, task: r.task, project, seconds: 0 }
      row.seconds += r.seconds
      merged.set(key, row)
    }
    return toCsv([...merged.values()])
  }

  // --- corrections ---

  /** Groups time into blocks: same session and task, gaps under 15 min. Newest first. */
  timeBlocks(from: number, to: number): TimeBlock[] {
    const blocks: TimeBlock[] = []
    let cur: TimeBlock | null = null
    for (const r of this.repo.recordsForBlocks(from, to)) {
      if (cur && cur.sessionId === r.sessionId && cur.taskId === r.taskId && r.timestamp - cur.end <= BLOCK_GAP_MS) {
        cur.end = r.timestamp
        cur.seconds += r.seconds
        continue
      }
      cur = {
        sessionId: r.sessionId,
        taskId: r.taskId,
        project: r.cwd ? path.basename(r.cwd) : null,
        start: r.timestamp,
        end: r.timestamp,
        seconds: r.seconds
      }
      blocks.push(cur)
    }
    return blocks.sort((a, b) => b.start - a.start)
  }

  /**
   * Moves a block to another task. If it is the session's latest block, the session's
   * later time goes to that task too, and auto naming stops changing it.
   */
  moveBlock(block: TimeBlock, toTaskId: number | null): void {
    if (toTaskId !== null && this.repo.getTask(toTaskId)?.status !== 'active') throw new Error(`No active task ${toTaskId}`)
    this.repo.moveRecords(block.sessionId, block.taskId, block.start, block.end, toTaskId)
    if (block.sessionId && this.repo.lastRecordAt(block.sessionId) === block.end) {
      this.repo.lockSessionTask(block.sessionId, toTaskId)
    }
    this.emit('change')
  }

  getCurrentTaskId(): number | null {
    return this.currentTaskId
  }

  setCurrentTask(id: number | null): void {
    if (id !== null && this.repo.getTask(id)?.status !== 'active') throw new Error(`No active task ${id}`)
    this.currentTaskId = id
    this.repo.setSetting(CURRENT_TASK_KEY, id === null ? null : String(id))
    this.emit('change')
  }

  // --- incoming data ---

  /** Pinned task if any, else the session's own task. */
  private taskFor(sessionId: string | null): number | null {
    if (this.currentTaskId !== null) return this.currentTaskId
    const id = sessionId ? (this.repo.getSession(sessionId)?.task_id ?? null) : null
    // An archived task stops collecting time; the next naming check picks a new one.
    return id !== null && this.repo.getTask(id)?.status === 'active' ? id : null
  }

  handleHook(evt: HookEvent): void {
    if (this.ignoreCwd && evt.cwd && path.resolve(evt.cwd) === path.resolve(this.ignoreCwd)) return
    const now = this.now()
    this.repo.touchSession(evt.sessionId, evt.cwd, now)
    if (evt.type === 'SessionStart' || evt.type === 'UserPromptSubmit') this.repo.reopenSession(evt.sessionId)
    if (evt.type === 'SessionEnd') this.repo.endSession(evt.sessionId, now, evt.detail)
    this.repo.insertEvent(evt.sessionId, evt.type, evt.detail, now, this.taskFor(evt.sessionId))
    this.lastSessionId = evt.sessionId

    // Conversation text goes to auto naming (memory only) and nowhere else.
    if (this.auto) {
      if (evt.type === 'UserPromptSubmit' && evt.text) this.auto.prompt(evt.sessionId, evt.text)
      if (evt.type === 'Stop') {
        const locked = this.repo.getSession(evt.sessionId)?.task_locked === 1
        this.auto.reply(evt.sessionId, evt.text, this.currentTaskId === null && !locked)
      }
      if (evt.type === 'SessionEnd') this.auto.end(evt.sessionId)
    }
    this.markData(now)
  }

  handleActiveTime(points: ActiveTimePoint[]): void {
    const now = this.now()
    for (const p of points) {
      if (p.sessionId) {
        this.repo.touchSession(p.sessionId, null, now)
        this.lastSessionId = p.sessionId
      }
      this.repo.insertTimeRecord(p.sessionId, this.taskFor(p.sessionId), p.kind, p.seconds, p.timestamp)
    }
    this.markData(now)
  }

  // --- auto naming ---

  private projectOf(sessionId: string): string | null {
    const cwd = this.repo.getSession(sessionId)?.cwd
    return cwd ? path.basename(cwd) : null
  }

  private namingContext(sessionId: string) {
    const project = this.projectOf(sessionId)
    const taskId = this.repo.getSession(sessionId)?.task_id ?? null
    const current = taskId !== null ? this.repo.getTask(taskId) : undefined
    // Same-project tasks first, so the model sees the likeliest matches.
    const tasks = this.repo
      .listTasks()
      .sort((a, b) => Number(b.project === project) - Number(a.project === project))
      .slice(0, MAX_TASKS_FOR_NAMER)
      .map((t) => ({ id: t.id, name: t.name, project: t.project }))
    return { project, currentTask: current ? { id: current.id, name: current.name } : null, tasks }
  }

  private applyName(sessionId: string, r: NameResult): void {
    if (this.currentTaskId !== null) return // pinned while the call ran
    if (this.repo.getSession(sessionId)?.task_locked === 1) return // corrected by hand while the call ran
    const project = this.projectOf(sessionId)
    let task = r.existingTaskId !== null ? this.repo.getTask(r.existingTaskId) : undefined
    if (task?.status !== 'active') task = undefined
    if (!task) {
      const name = r.name.trim()
      if (!name) return
      task = this.repo.findActiveTask(name, project) ?? this.repo.createTask(name, project, this.now(), 'auto')
    }
    this.repo.assignSessionTask(sessionId, task.id)
    this.namingProblem = null
    this.emit('change')
  }

  /** Naming failed: keep the session trackable under its folder name until a later try works. */
  private namingFailed(sessionId: string, err: Error): void {
    console.error('[naming]', err.message)
    this.namingProblem = err.message
    const session = this.repo.getSession(sessionId)
    const project = this.projectOf(sessionId)
    if (session && session.task_id === null && project && this.currentTaskId === null) {
      const task = this.repo.findActiveTask(project, project) ?? this.repo.createTask(project, project, this.now(), 'auto')
      this.repo.assignSessionTask(sessionId, task.id)
    }
    this.emit('change')
  }

  /** Resolves when pending naming calls finish (tests). */
  namingIdle(): Promise<void> {
    return this.auto?.idle() ?? Promise.resolve()
  }

  /** Called on every valid request, even ones with no active time, so the tray knows data flows. */
  markData(now = this.now()): void {
    this.lastDataAt = now
    this.problem = null
    this.emit('change')
  }

  setProblem(message: string | null): void {
    this.problem = message
    this.emit('change')
  }

  // --- read side ---

  stats(from: number, to: number): Stats {
    // Different folders with the same name (e.g. two "app" folders) are merged by name.
    const merged = new Map<string | null, number>()
    for (const r of this.repo.totalsByProjectCwd(from, to)) {
      const name = r.cwd ? path.basename(r.cwd) : null
      merged.set(name, (merged.get(name) ?? 0) + r.seconds)
    }
    const byProject: ProjectTotal[] = [...merged]
      .map(([project, seconds]) => ({ project, seconds }))
      .sort((a, b) => b.seconds - a.seconds)
    return {
      from,
      to,
      byDay: this.repo.totalsByDay(from, to),
      byTask: this.repo.totalsByTask(from, to),
      byProject,
      taskRank: this.repo.taskRank(),
      tasks: this.repo.listTasks(true)
    }
  }

  state(): TrackerState {
    const todayByTask = this.repo.totalsSince(startOfLocalDay(this.now()))
    const autoTaskId = this.lastSessionId ? (this.repo.getSession(this.lastSessionId)?.task_id ?? null) : null
    return {
      currentTaskId: this.currentTaskId,
      autoTaskId,
      namingProblem: this.auto ? this.namingProblem : null,
      todaySeconds: todayByTask.reduce((sum, t) => sum + t.seconds, 0),
      todayByTask,
      lastDataAt: this.lastDataAt,
      problem: this.problem
    }
  }
}
