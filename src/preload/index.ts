import { contextBridge, ipcRenderer } from 'electron'
import type { TrackerApi } from '../shared/types'

const api: TrackerApi = {
  listTasks: () => ipcRenderer.invoke('tasks:list'),
  createTask: (name, project) => ipcRenderer.invoke('tasks:create', name, project),
  archiveTask: (id) => ipcRenderer.invoke('tasks:archive', id),
  setCurrentTask: (id) => ipcRenderer.invoke('tasks:setCurrent', id),
  getState: () => ipcRenderer.invoke('state:get'),
  exportCsv: (from, to, label) => ipcRenderer.invoke('export:csv', from, to, label),
  renameTask: (id, name) => ipcRenderer.invoke('tasks:rename', id, name),
  mergeTask: (from, into) => ipcRenderer.invoke('tasks:merge', from, into),
  timeBlocks: (from, to) => ipcRenderer.invoke('blocks:list', from, to),
  moveBlock: (block, to) => ipcRenderer.invoke('blocks:move', block, to),
  getStats: (from, to) => ipcRenderer.invoke('stats:get', from, to),
  setupPreview: () => ipcRenderer.invoke('setup:preview'),
  setupApply: () => ipcRenderer.invoke('setup:apply'),
  setupUndo: () => ipcRenderer.invoke('setup:undo'),
  onChange: (cb) => {
    const listener = (): void => cb()
    ipcRenderer.on('state:changed', listener)
    return () => ipcRenderer.removeListener('state:changed', listener)
  }
}

contextBridge.exposeInMainWorld('api', api)
