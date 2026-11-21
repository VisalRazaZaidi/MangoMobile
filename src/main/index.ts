import { app, BrowserWindow, ipcMain, shell, protocol, net } from 'electron'
import { pathToFileURL } from 'node:url'
import { PreviewCache } from './core/preview'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { HistoryStore, IndexCache, SettingsStore } from './core/persistence'
import { MangoSession } from './core/session'
import type { ProgressEvent } from '@shared/types'

let window: BrowserWindow | null = null
let session: MangoSession | null = null
let previewCache: PreviewCache
protocol.registerSchemesAsPrivileged([{ scheme: 'mango-preview', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } }])

// Automated runs (scripts/smoke.mjs) point the app at a throwaway profile so the
// developer's real history, settings and recycle-bin index are never touched.
if (process.env.MANGO_USERDATA) app.setPath('userData', process.env.MANGO_USERDATA)

function broadcast(event: ProgressEvent): void {
  if (window && !window.isDestroyed()) window.webContents.send('mangomobile:progress', event)
}

function createWindow(): void {
  window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1080,
    minHeight: 680,
    show: false,
    backgroundColor: '#0b0e14',
    autoHideMenuBar: true,
    title: 'MangoMobile',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  window.on('ready-to-show', () => window?.show())

  const capturePath = process.env.MANGO_CAPTURE
  if (capturePath) {
    window.webContents.once('did-finish-load', () => {
      const delay = Number(process.env.MANGO_CAPTURE_DELAY ?? 4500)
      setTimeout(async () => {
        try {
          const image = await window?.webContents.capturePage()
          if (image) writeFileSync(capturePath, image.toPNG())
        } catch (error) {
          console.error('capture failed', error)
        } finally {
          app.quit()
        }
      }, Number.isFinite(delay) ? delay : 4500)
    })
  }
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function registerIpc(): void {
  ipcMain.handle('preview:load', (_event, path: string) => {
    if (!session) throw new Error('Session is not ready')
    return session.filePreview(path, previewCache)
  })
  const getSession = (): MangoSession => {
    if (!session) throw new Error('Session is not ready yet')
    return session
  }

  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    platform: `${process.platform} ${process.arch}`,
    userDataDir: app.getPath('userData'),
    demoDefault: process.env.MANGO_DEMO === '1',
    startView: process.env.MANGO_VIEW
  }))
  ipcMain.handle('app:openDataDir', () => shell.openPath(app.getPath('userData')))
  ipcMain.handle('app:openExternal', (_event, url: string) => shell.openExternal(url))

  ipcMain.handle('adb:status', () => getSession().adbStatus())
  ipcMain.handle('adb:locate', () => getSession().adbStatus())
  ipcMain.handle('adb:restartServer', async () => {
    const status = await getSession().adbStatus()
    if (!status.adbFound) return status
    const { adbExec } = await import('./adb/real-adb')
    await adbExec(status.adbPath, ['kill-server'], { timeoutMs: 20_000 })
    await adbExec(status.adbPath, ['start-server'], { timeoutMs: 30_000 })
    return getSession().adbStatus()
  })

  ipcMain.handle('device:candidates', () => getSession().candidates())
  ipcMain.handle('device:connect', (_event, serial?: string) => getSession().connect(serial))
  ipcMain.handle('device:current', () => getSession().current())
  ipcMain.handle('device:disconnect', () => getSession().disconnect())
  ipcMain.handle('device:diagnostics', () => getSession().diagnostics())

  ipcMain.handle('scan:start', () => getSession().scan())
  ipcMain.handle('scan:cached', () => getSession().cachedSummary())
  ipcMain.handle('scan:cancel', () => getSession().cancelScan())
  ipcMain.handle('scan:summary', () => getSession().cachedSummary())

  ipcMain.handle('analysis:tree', (_event, path?: string) => getSession().tree(path))
  ipcMain.handle('analysis:largeFiles', (_event, limit: number, minBytes?: number) =>
    getSession().largeFiles(limit, minBytes)
  )

  ipcMain.handle('rules:list', () => getSession().rules())
  ipcMain.handle('cleanup:preview', (_event, ruleIds: string[], extraPaths?: string[]) =>
    getSession().preview(ruleIds, extraPaths)
  )
  ipcMain.handle('cleanup:execute', (_event, items, ruleIds: string[], moveToTrash: boolean) =>
    getSession().execute(items, ruleIds, moveToTrash)
  )

  ipcMain.handle('duplicates:find', (_event, options) => getSession().duplicates(options))
  ipcMain.handle('duplicates:cancel', () => getSession().cancelDuplicates())

  ipcMain.handle('media:buckets', () => getSession().media())

  ipcMain.handle('apps:list', () => getSession().apps())
  ipcMain.handle('apps:trimCaches', () => getSession().trimCaches())
  ipcMain.handle('apps:uninstall', (_event, packageName: string) => getSession().uninstall(packageName))

  ipcMain.handle('trash:summary', () => getSession().trashSummary())
  ipcMain.handle('trash:restore', (_event, storedPaths: string[]) => getSession().restoreTrash(storedPaths))
  ipcMain.handle('trash:purge', (_event, storedPaths?: string[]) => getSession().purge(storedPaths))

  ipcMain.handle('history:list', () => getSession().listHistory())
  ipcMain.handle('history:clear', () => getSession().clearHistory())

  ipcMain.handle('settings:get', () => getSession().settingsSnapshot())
  ipcMain.handle('settings:set', (_event, patch) => getSession().updateSettings(patch))
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (window) {
      if (window.isMinimized()) window.restore()
      window.focus()
    }
  })

  void app.whenReady().then(() => {
    previewCache = new PreviewCache()
    protocol.handle('mango-preview', request => {
      const url = new URL(request.url)
      const file = url.hostname === 'cache' ? previewCache.resolve(url.pathname.slice(1)) : undefined
      if (!file) return new Response('Preview expired', { status: 404 })
      return net.fetch(pathToFileURL(file).toString(), { headers: request.headers })
    })
    app.on('will-quit', () => previewCache.dispose())
    const userData = app.getPath('userData')
    const settings = new SettingsStore(join(userData, 'settings.json'))
    const history = new HistoryStore(join(userData, 'history.ndjson'))
    const cache = new IndexCache(join(userData, 'scan-cache'))
    session = new MangoSession(settings, history, cache, broadcast)
    registerIpc()
    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
