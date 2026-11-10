import fs from 'node:fs'
import path from 'node:path'
import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import type { TimeBlock } from '../shared/types'
import type { Tracker } from './tracker'
import { applyFile, previewFile, undoFile } from './setup'

/** Wires window.api calls (see src/preload) to the tracker and setup code. */
export function registerIpc(tracker: Tracker, settingsPath: string, port: number, onSetupChanged: () => void): void {
  ipcMain.handle('tasks:list', () => tracker.listTasks())
  ipcMain.handle('tasks:create', (_e, name: string, project: string | null) => tracker.createTask(name, project))
  ipcMain.handle('tasks:archive', (_e, id: number) => tracker.archiveTask(id))
  ipcMain.handle('tasks:setCurrent', (_e, id: number | null) => tracker.setCurrentTask(id))
  ipcMain.handle('tasks:rename', (_e, id: number, name: string) => tracker.renameTask(id, name))
  ipcMain.handle('tasks:merge', (_e, from: number, into: number) => tracker.mergeTask(from, into))
  ipcMain.handle('blocks:list', (_e, from: number, to: number) => tracker.timeBlocks(Number(from), Number(to)))
  ipcMain.handle('blocks:move', (_e, block: TimeBlock, to: number | null) => tracker.moveBlock(block, to))
  ipcMain.handle('export:csv', async (e, from: number, to: number, label: string) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const opts = {
      title: 'Export timesheet',
      defaultPath: path.join(app.getPath('downloads'), `claude-time-${String(label).replace(/[^\w.-]+/g, '_')}.csv`),
      filters: [{ name: 'CSV', extensions: ['csv'] }]
    }
    const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
    if (r.canceled || !r.filePath) return null
    fs.writeFileSync(r.filePath, tracker.exportCsv(Number(from), Number(to)))
    return r.filePath
  })
  ipcMain.handle('state:get', () => tracker.state())
  ipcMain.handle('stats:get', (_e, from: number, to: number) => tracker.stats(Number(from), Number(to)))

  ipcMain.handle('setup:preview', () => previewFile(settingsPath, port))
  ipcMain.handle('setup:apply', () => {
    const r = applyFile(settingsPath, port)
    onSetupChanged()
    return r
  })
  ipcMain.handle('setup:undo', () => {
    const r = undoFile(settingsPath, port)
    onSetupChanged()
    return r
  })

  tracker.on('change', () => {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('state:changed')
  })
}
