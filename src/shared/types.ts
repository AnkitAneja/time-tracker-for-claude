export const DEFAULT_PORT = 47821

export interface Task {
  id: number
  name: string
  project: string | null
  status: 'active' | 'archived'
  /** 'auto' = named by Claude from the conversation. */
  source: 'manual' | 'auto'
  created_at: number
}

export interface TaskTotal {
  taskId: number | null
  seconds: number
}

/** Cost and output for a task or a period. Lines, commits and PRs count what Claude Code changed. */
export interface UsageTotals {
  cost: number
  tokens: number
  linesAdded: number
  linesRemoved: number
  commits: number
  prs: number
}

export interface TaskUsage extends UsageTotals {
  taskId: number | null
}

export interface TrackerState {
  /** Task pinned by hand. null = auto mode: each session uses the task named from its chat. */
  currentTaskId: number | null
  /** Task of the most recently active session (auto mode), or null if none named yet. */
  autoTaskId: number | null
  /** Set when auto naming can't run, e.g. the claude CLI wasn't found. */
  namingProblem: string | null
  todaySeconds: number
  todayByTask: TaskTotal[]
  /** USD spent today across all tasks. */
  todayCost: number
  /** Last time any hook or metric arrived (ms epoch), or null if none yet. */
  lastDataAt: number | null
  /** Short message shown in the tray when something is wrong (port busy, wrong protocol). */
  problem: string | null
}

/** One row per local day and task (null = untagged). `day` is YYYY-MM-DD in local time. */
export interface DayTaskTotal {
  day: string
  taskId: number | null
  seconds: number
}

export interface ProjectTotal {
  /** Folder name of the Claude Code session, or null if unknown. */
  project: string | null
  seconds: number
}

export interface Stats {
  from: number
  to: number
  byDay: DayTaskTotal[]
  byTask: TaskTotal[]
  byProject: ProjectTotal[]
  usageByTask: TaskUsage[]
  usageTotal: UsageTotals
  /** Task ids by all-time total, largest first. Used to give each task a stable color. */
  taskRank: number[]
  tasks: Task[]
}

/** A run of time from one session on one task, with no gap longer than BLOCK_GAP_MS. */
export interface TimeBlock {
  sessionId: string | null
  taskId: number | null
  project: string | null
  /** ms epoch of the first and last record in the block. */
  start: number
  end: number
  seconds: number
}

export const BLOCK_GAP_MS = 15 * 60_000

export type SetupStatus = 'not-installed' | 'installed' | 'partial'

export interface SetupPreview {
  settingsPath: string
  status: SetupStatus
  /** Human-readable list of what Apply will change. */
  changes: string[]
  /** Things the user should know, such as an existing telemetry endpoint being replaced. */
  warnings: string[]
  /** Set when settings.json can't be read or parsed; Apply is disabled. */
  error: string | null
}

export interface SetupResult {
  ok: boolean
  message: string
  backupPath?: string
}

/** API the preload script exposes to the renderer as window.api. */
export interface TrackerApi {
  listTasks(): Promise<Task[]>
  createTask(name: string, project: string | null): Promise<Task>
  archiveTask(id: number): Promise<void>
  setCurrentTask(id: number | null): Promise<void>
  getState(): Promise<TrackerState>
  renameTask(id: number, name: string): Promise<void>
  /** Moves all of one task's time into another and archives the first. */
  mergeTask(fromId: number, intoId: number): Promise<void>
  timeBlocks(from: number, to: number): Promise<TimeBlock[]>
  moveBlock(block: TimeBlock, toTaskId: number | null): Promise<void>
  /** Asks where to save, writes a timesheet CSV for [from, to). Returns the path, or null if cancelled. */
  exportCsv(from: number, to: number, label: string): Promise<string | null>
  /** Totals for [from, to) in ms epoch. */
  getStats(from: number, to: number): Promise<Stats>
  setupPreview(): Promise<SetupPreview>
  setupApply(): Promise<SetupResult>
  setupUndo(): Promise<SetupResult>
  onChange(cb: () => void): () => void
}
