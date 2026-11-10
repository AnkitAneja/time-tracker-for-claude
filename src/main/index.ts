import path from 'node:path'
import { app, BrowserWindow, dialog } from 'electron'
import { DEFAULT_PORT } from '../shared/types'
import { openDatabase } from './db'
import { Repo } from './db/repo'
import { registerIpc } from './ipc'
import { createServer, listen } from './server'
import { defaultSettingsPath, previewFile } from './setup'
import { claudeCliNamer } from './naming/claude-cli'
import { Tracker } from './tracker'
import { createTray } from './tray'

const PORT = Number(process.env.CTT_PORT) || DEFAULT_PORT

// The app owns a fixed port, so only one copy may run.
const isFirstCopy = app.requestSingleInstanceLock()
if (!isFirstCopy) {
  console.log('[tracker] Already running, so this copy is quitting. The running copy opens its window. Look for it in the menu bar.')
  app.quit()
}

let win: BrowserWindow | null = null

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
    title: 'Claude Time Tracker',
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
  const tracker = new Tracker(new Repo(db), Date.now, {
    namer: claudeCliNamer({ workDir: namingDir }),
    ignoreCwd: namingDir
  })
  const settingsPath = defaultSettingsPath()

  let setupStatus = previewFile(settingsPath, PORT).status
  const refreshSetup = (): void => {
    setupStatus = previewFile(settingsPath, PORT).status
    tracker.emit('change')
  }

  registerIpc(tracker, settingsPath, PORT, refreshSetup)
  createTray(tracker, {
    openTasks: () => openWindow('tasks'),
    openDashboard: () => openWindow('dashboard'),
    openSetup: () => openWindow('setup'),
    setupStatus: () => setupStatus
  })

  const server = createServer(tracker)
  try {
    await listen(server, PORT)
  } catch (err) {
    const msg =
      (err as NodeJS.ErrnoException).code === 'EADDRINUSE'
        ? `Port ${PORT} is in use by another program`
        : `Server failed: ${(err as Error).message}`
    tracker.setProblem(msg)
    dialog.showErrorBox('Claude Time Tracker', `${msg}. Tracking is off until this is fixed.`)
  }

  console.log(`[tracker] Running (Dock icon + menu bar). Server: http://127.0.0.1:${PORT}`)

  // Show the window at launch; setup first if Claude Code isn't connected yet.
  openWindow(setupStatus === 'installed' ? 'tasks' : 'setup')

  app.on('before-quit', () => {
    server.close()
    db.close()
  })
})
