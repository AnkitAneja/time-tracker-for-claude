import path from 'node:path'
import { app, Menu, nativeImage, Tray, type MenuItemConstructorOptions } from 'electron'
import type { Tracker } from './tracker'
import type { SetupStatus } from '../shared/types'
import type { UpdateInfo } from './updates'
import { formatAgo, formatCost, formatDuration } from '../shared/format'

export interface TrayActions {
  openTasks(): void
  openDashboard(): void
  openSetup(): void
  setupStatus(): SetupStatus
  update(): UpdateInfo | null
  openUpdate(): void
  reminders(): boolean
  setReminders(on: boolean): void
  /** null when start at login isn't available (dev mode). */
  autoStart(): boolean | null
  setAutoStart(on: boolean): void
}

const MAX_TITLE_TASK = 24
const REFRESH_MS = 30_000

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

/** Tray icon + menu. Rebuilds the menu whenever the tracker changes, and every 30 s for "x min ago". */
export function createTray(tracker: Tracker, actions: TrayActions): Tray {
  const iconPath = path.join(app.getAppPath(), 'resources', 'trayTemplate.png')
  const icon = nativeImage.createFromPath(iconPath)
  icon.setTemplateImage(true)
  const tray = new Tray(icon)

  const render = (): void => {
    const state = tracker.state()
    const tasks = tracker.listTasks()
    const now = Date.now()
    const pinned = tasks.find((t) => t.id === state.currentTaskId)
    const autoTask = tasks.find((t) => t.id === state.autoTaskId)
    const current = pinned ?? autoTask
    const secondsFor = (id: number | null): number => state.todayByTask.find((t) => t.taskId === id)?.seconds ?? 0

    const dataLine = state.problem
      ? `⚠ ${state.problem}`
      : state.lastDataAt
        ? `Last data from Claude Code: ${formatAgo(state.lastDataAt, now)}`
        : 'Waiting for data from Claude Code'

    const headline = pinned
      ? `Pinned: ${pinned.name}`
      : autoTask
        ? `Auto: ${autoTask.name}`
        : 'Auto: waiting for a Claude conversation'

    const setup = actions.setupStatus()
    const items: MenuItemConstructorOptions[] = [
      { label: headline, enabled: false },
      { label: `Today: ${formatDuration(state.todaySeconds)} · ${formatCost(state.todayCost)}`, enabled: false },
      { label: dataLine, enabled: false },
      ...(state.namingProblem ? [{ label: `⚠ ${truncate(state.namingProblem, 60)}`, enabled: false }] : []),
      { type: 'separator' },
      {
        label: 'Auto (name tasks from the chat)',
        type: 'radio',
        checked: state.currentTaskId === null,
        click: () => tracker.setCurrentTask(null)
      },
      ...(secondsFor(null) > 0 ? [{ label: `Untagged today  ·  ${formatDuration(secondsFor(null))}`, enabled: false }] : []),
      { label: 'Or pin a task:', enabled: false },
      ...tasks.map(
        (t): MenuItemConstructorOptions => ({
          label: `${t.name}${t.project ? ` (${t.project})` : ''}  ·  ${formatDuration(secondsFor(t.id))}${t.id === state.autoTaskId && !pinned ? '  ◀' : ''}`,
          type: 'radio',
          checked: t.id === state.currentTaskId,
          click: () => tracker.setCurrentTask(t.id)
        })
      ),
      { type: 'separator' },
      { label: 'Dashboard…', click: actions.openDashboard },
      { label: 'New or manage tasks…', click: actions.openTasks },
      {
        label: setup === 'installed' ? '✓ Claude Code connected' : 'Set up Claude Code…',
        click: actions.openSetup
      },
      {
        label: 'Remind me about untagged time',
        type: 'checkbox',
        checked: actions.reminders(),
        click: () => actions.setReminders(!actions.reminders())
      },
      ...(() => {
        const on = actions.autoStart()
        return on === null
          ? [{ label: 'Start at login (installed app only)', enabled: false }]
          : [{ label: 'Start at login', type: 'checkbox' as const, checked: on, click: () => actions.setAutoStart(!on) }]
      })(),
      ...(() => {
        const u = actions.update()
        return u ? [{ type: 'separator' as const }, { label: `Update available: v${u.version}. Download…`, click: actions.openUpdate }] : []
      })(),
      { type: 'separator' },
      { label: `Quit (v${app.getVersion()})`, role: 'quit' }
    ]

    tray.setContextMenu(Menu.buildFromTemplate(items))
    const label = current ? truncate(current.name, MAX_TITLE_TASK) : 'Auto'
    tray.setToolTip(`Claude time: ${label} · today ${formatDuration(state.todaySeconds)}`)
    // macOS shows this text next to the icon.
    tray.setTitle(` ${label} · ${formatDuration(state.todaySeconds)}`)
  }

  // Many events can arrive at once; coalesce renders.
  let pending = false
  const schedule = (): void => {
    if (pending) return
    pending = true
    setTimeout(() => {
      pending = false
      render()
    }, 250)
  }

  tracker.on('change', schedule)
  setInterval(render, REFRESH_MS)
  render()
  return tray
}
