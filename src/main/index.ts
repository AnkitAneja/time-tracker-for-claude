import path from 'node:path'
import { app, BrowserWindow, dialog, Notification, shell } from 'electron'
import { DEFAULT_PORT } from '../shared/types'
import { openDatabase } from './db'
import { Repo } from './db/repo'
import { registerIpc } from './ipc'
import { Reminder } from './reminder'
import { checkForUpdate, type UpdateInfo } from './updates'
import { createServer, listen } from './server'
import { defaultSettingsPath, previewFile } from './setup'
import { claudeCliNamer } from './naming/claude-cli'
import { Tracker } from './tracker'
import { createTray } from './tray'

const PORT = Number(process.env.CTT_PORT) || DEFAULT_PORT

// Keep data in one folder for dev and installed builds. Without this, the installed app
// (named after the product) would use a different folder than dev. The folder name is kept
// from the first version so existing data carries over.
// CTT_DATA_DIR points a test copy at a separate folder so it can run beside the real app.
app.setPath('userData', process.env.CTT_DATA_DIR || path.join(app.getPath('appData'), 'claude-time-tracker'))
app.setName('Time Tracker for Claude Code')

const LOGIN_ARG = '--hidden'
const AUTO_START_KEY = 'auto_start_set'

/** Started by the OS at login: stay in the menu bar, don't open the window. */
function startedAtLogin(): boolean {
  return process.argv.includes(LOGIN_ARG) || (process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin)
}

/** Start at login only makes sense for the installed app; in dev it would register the bare Electron binary. */
function canAutoStart(): boolean {
  return app.isPackaged
}

function setAutoStart(on: boolean): void {
  app.setLoginItemSettings({ openAtLogin: on, args: [LOGIN_ARG] })
}

// The app owns a fixed port, so only one copy may run.
const isFirstCopy = app.requestSingleInstanceLock()
if (!isFirstCopy) {
  console.log('[tracker] Already running, so this copy is quitting. The running copy opens its window. Look for it in the menu bar.')
  app.quit()
}

let win: BrowserWindow | null = null

const REMINDERS_KEY = 'reminders_off'

function openWindow(view: 'tasks' | 'dashboard' | 'log' | 'setup'): void {
  if (win && !win.isDestroyed()) {
    void win.webContents.executeJavaScript(`location.hash = ${JSON.stringify(view)}`)
    win.show()
    win.focus()
    return
  }
  win = new BrowserWindow({
    width: 680,
    height: 760,
    title: 'Time Tracker for Claude Code',
    show: false,
    webPreferences: { preload: path.join(__dirname, '../preload/index.js'), sandbox: true, contextIsolation: true }
  })
  win.once('ready-to-show', () => win?.show())
  const hash = `#${view}`
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL + hash)
  else void win.loadFile(path.join(__dirname, '../renderer/index.html'), { hash: view })
}

app.on('second-instance', () => openWindow('tasks'))
// Clicking the Dock icon opens the window.
app.on('activate', () => openWindow('tasks'))
// Tray app: closing the window must not quit.
app.on('window-all-closed', () => {})

app.whenReady().then(async () => {
  if (!isFirstCopy) return
  // Keep the Dock icon: on Macs with a notch or a full menu bar, the tray icon can be hidden.

  const db = openDatabase(path.join(app.getPath('userData'), 'tracker.db'))
  // Auto naming runs `claude -p` in this empty folder; hooks from it are ignored.
  const namingDir = path.join(app.getPath('userData'), 'naming')
  const repo = new Repo(db)
  const tracker = new Tracker(repo, Date.now, {
    namer: claudeCliNamer({ workDir: namingDir }),
    ignoreCwd: namingDir
  })
  const settingsPath = defaultSettingsPath()

  let setupStatus = previewFile(settingsPath, PORT).status
  const refreshSetup = (): void => {
    setupStatus = previewFile(settingsPath, PORT).status
    tracker.emit('change')
  }

  // Installed app: turn on start at login once, on first run. The user can turn it off in the tray.
  if (canAutoStart() && repo.getSetting(AUTO_START_KEY) === null) {
    setAutoStart(true)
    repo.setSetting(AUTO_START_KEY, '1')
  }

  // Installed app: look for a newer release on GitHub at launch and every 6 hours.
  let update: UpdateInfo | null = null
  if (app.isPackaged) {
    const check = async (): Promise<void> => {
      const found = await checkForUpdate(app.getVersion())
      if (found?.version !== update?.version) {
        update = found
        tracker.emit('change')
      }
    }
    void check()
    setInterval(() => void check(), 6 * 3600_000)
  }

  registerIpc(tracker, settingsPath, PORT, refreshSetup)
  createTray(tracker, {
    update: () => update,
    openUpdate: () => {
      if (update) void shell.openExternal(update.url)
    },
    reminders: () => repo.getSetting(REMINDERS_KEY) === null,
    setReminders: (on) => {
      repo.setSetting(REMINDERS_KEY, on ? null : '1')
      tracker.emit('change')
    },
    autoStart: () => (canAutoStart() ? app.getLoginItemSettings().openAtLogin : null),
    setAutoStart: (on) => {
      setAutoStart(on)
      tracker.emit('change')
    },
    openTasks: () => openWindow('tasks'),
    openDashboard: () => openWindow('dashboard'),
    openSetup: () => openWindow('setup'),
    setupStatus: () => setupStatus
  })

  // Untagged time reminder. Only when no task is pinned (pinned time is never untagged anyway).
  const reminder = new Reminder({
    now: Date.now,
    untaggedSince: (since) => repo.untaggedSecondsSince(since),
    enabled: () => repo.getSetting(REMINDERS_KEY) === null && Notification.isSupported(),
    notify: (seconds) => {
      const n = new Notification({
        title: 'Claude time with no task',
        body: `${Math.round(seconds / 60)} min in the last 30 min has no task. Click to sort it out.`
      })
      n.on('click', () => openWindow('log'))
      n.show()
    }
  })
  setInterval(() => reminder.check(), 60_000)

  const server = createServer(tracker)
  try {
    await listen(server, PORT)
  } catch (err) {
    const msg =
      (err as NodeJS.ErrnoException).code === 'EADDRINUSE'
        ? `Port ${PORT} is in use by another program`
        : `Server failed: ${(err as Error).message}`
    tracker.setProblem(msg)
    dialog.showErrorBox('Time Tracker for Claude Code', `${msg}. Tracking is off until this is fixed.`)
  }

  console.log(`[tracker] Running (Dock icon + menu bar). Server: http://127.0.0.1:${PORT}`)

  // Show the window at launch (setup first if Claude Code isn't connected yet),
  // except when the OS started the app at login.
  if (setupStatus !== 'installed') openWindow('setup')
  else if (!startedAtLogin()) openWindow('tasks')

  app.on('before-quit', () => {
    server.close()
    db.close()
  })
})
