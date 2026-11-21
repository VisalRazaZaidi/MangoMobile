import { contextBridge, ipcRenderer } from 'electron'
import type { MangoApi, ProgressEvent } from '@shared/types'

const api: MangoApi = {
  preview: { load: (path: string) => ipcRenderer.invoke('preview:load', path) },
  app: {
    info: () => ipcRenderer.invoke('app:info'),
    openDataDir: () => ipcRenderer.invoke('app:openDataDir'),
    openExternal: (url: string) => ipcRenderer.invoke('app:openExternal', url)
  },
  adb: {
    status: () => ipcRenderer.invoke('adb:status'),
    locate: () => ipcRenderer.invoke('adb:locate'),
    restartServer: () => ipcRenderer.invoke('adb:restartServer')
  },
  device: {
    candidates: () => ipcRenderer.invoke('device:candidates'),
    connect: (serial?: string) => ipcRenderer.invoke('device:connect', serial),
    current: () => ipcRenderer.invoke('device:current'),
    disconnect: () => ipcRenderer.invoke('device:disconnect'),
    diagnostics: () => ipcRenderer.invoke('device:diagnostics')
  },
  scan: {
    start: () => ipcRenderer.invoke('scan:start'),
    cached: () => ipcRenderer.invoke('scan:cached'),
    cancel: () => ipcRenderer.invoke('scan:cancel'),
    summary: () => ipcRenderer.invoke('scan:summary')
  },
  analysis: {
    tree: (path?: string) => ipcRenderer.invoke('analysis:tree', path),
    largeFiles: (limit: number, minBytes?: number) => ipcRenderer.invoke('analysis:largeFiles', limit, minBytes)
  },
  rules: {
    list: () => ipcRenderer.invoke('rules:list')
  },
  cleanup: {
    preview: (ruleIds: string[], extraPaths?: string[]) => ipcRenderer.invoke('cleanup:preview', ruleIds, extraPaths),
    plan: (items, ruleIds) =>
      Promise.resolve({
        id: `plan-${Date.now()}`,
        createdAt: Date.now(),
        items,
        totalBytes: items.reduce((sum: number, item: { size: number }) => sum + item.size, 0),
        moveToTrash: true,
        rules: ruleIds
      }),
    execute: (items, ruleIds: string[], moveToTrash: boolean) =>
      ipcRenderer.invoke('cleanup:execute', items, ruleIds, moveToTrash)
  },
  duplicates: {
    find: (options) => ipcRenderer.invoke('duplicates:find', options),
    cancel: () => ipcRenderer.invoke('duplicates:cancel')
  },
  media: {
    buckets: () => ipcRenderer.invoke('media:buckets')
  },
  apps: {
    list: () => ipcRenderer.invoke('apps:list'),
    trimCaches: () => ipcRenderer.invoke('apps:trimCaches'),
    uninstall: (packageName: string) => ipcRenderer.invoke('apps:uninstall', packageName)
  },
  trash: {
    summary: () => ipcRenderer.invoke('trash:summary'),
    restore: (storedPaths: string[]) => ipcRenderer.invoke('trash:restore', storedPaths),
    purge: (storedPaths?: string[]) => ipcRenderer.invoke('trash:purge', storedPaths)
  },
  history: {
    list: () => ipcRenderer.invoke('history:list'),
    clear: () => ipcRenderer.invoke('history:clear')
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch) => ipcRenderer.invoke('settings:set', patch)
  },
  onProgress: (cb: (event: ProgressEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: ProgressEvent) => cb(payload)
    ipcRenderer.on('mangomobile:progress', listener)
    return () => ipcRenderer.removeListener('mangomobile:progress', listener)
  }
}

contextBridge.exposeInMainWorld('api', api)
