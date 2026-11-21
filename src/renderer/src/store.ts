import { computed, reactive } from 'vue'
import { formatDuration } from '@/lib/format'
import type {
  AdbStatus,
  AppInfo,
  AppListResult,
  CleanupResult,
  DeviceCandidate,
  DeviceInfo,
  DuplicateGroup,
  DuplicateProgress,
  DuplicateScanOptions,
  FileEntry,
  HistoryEntry,
  LargeFile,
  MediaBucket,
  Rule,
  RuleScanResult,
  ScanProgress,
  ScanSummary,
  Settings,
  TreeView,
  TrashSummary
} from '@shared/types'

export type ViewKey =
  | 'overview'
  | 'clean'
  | 'large'
  | 'analysis'
  | 'duplicates'
  | 'media'
  | 'apps'
  | 'trash'
  | 'history'
  | 'settings'

type Toast = { id: number; type: 'info' | 'ok' | 'warn' | 'error'; title: string; message: string }

type State = {
  booted: boolean
  booting: boolean
  view: ViewKey
  info: AppInfo | null
  settings: Settings | null
  adb: AdbStatus | null
  candidates: DeviceCandidate[]
  device: DeviceInfo | null
  diagnostics: { ok: boolean; title: string; detail: string; steps: string[] } | null
  connecting: boolean
  scanning: boolean
  scanProgress: ScanProgress | null
  summary: ScanSummary | null
  tree: TreeView | null
  treePath: string
  treeLoading: boolean
  largeFiles: LargeFile[]
  largeLoading: boolean
  rules: Rule[]
  selectedRules: string[]
  preview: RuleScanResult[]
  previewLoading: boolean
  selection: string[]
  duplicates: DuplicateGroup[]
  duplicateProgress: DuplicateProgress | null
  duplicateRunning: boolean
  duplicateOptions: DuplicateScanOptions
  mediaBuckets: MediaBucket[]
  mediaLoading: boolean
  apps: AppListResult | null
  appsLoading: boolean
  trash: TrashSummary | null
  trashLoading: boolean
  history: HistoryEntry[]
  toasts: Toast[]
  operation: { running: boolean; title: string; done: number; total: number } | null
  lastResult: CleanupResult | null
}

export const state = reactive<State>({
  booted: false,
  booting: false,
  view: 'overview',
  info: null,
  settings: null,
  adb: null,
  candidates: [],
  device: null,
  diagnostics: null,
  connecting: false,
  scanning: false,
  scanProgress: null,
  summary: null,
  tree: null,
  treePath: '',
  treeLoading: false,
  largeFiles: [],
  largeLoading: false,
  rules: [],
  selectedRules: [],
  preview: [],
  previewLoading: false,
  selection: [],
  duplicates: [],
  duplicateProgress: null,
  duplicateRunning: false,
  duplicateOptions: { minSizeBytes: 4096, maxGroups: 200, fullHash: true },
  mediaBuckets: [],
  mediaLoading: false,
  apps: null,
  appsLoading: false,
  trash: null,
  trashLoading: false,
  history: [],
  toasts: [],
  operation: null,
  lastResult: null
})

let toastId = 0

export function toast(type: Toast['type'], title: string, message = '', timeout = 6500): void {
  // Reconnecting probes the device again and used to stack identical toasts.
  const duplicate = state.toasts.find((entry) => entry.title === title && entry.message === message)
  if (duplicate) return
  const id = ++toastId
  state.toasts.push({ id, type, title, message })
  if (timeout > 0) {
    setTimeout(() => {
      const index = state.toasts.findIndex((entry) => entry.id === id)
      if (index >= 0) state.toasts.splice(index, 1)
    }, timeout)
  }
}

export function dismissToast(id: number): void {
  const index = state.toasts.findIndex((entry) => entry.id === id)
  if (index >= 0) state.toasts.splice(index, 1)
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return 'Something went wrong.'
}

export const isDemo = computed(() => state.device?.simulated ?? false)

export const selectedRuleSet = computed(() => new Set(state.selectedRules))

export const previewTotals = computed(() => ({
  bytes: state.preview.reduce((sum, result) => sum + result.totalBytes, 0),
  items: state.preview.reduce((sum, result) => sum + result.items.length, 0),
  selectedBytes: state.preview
    .flatMap((result) => result.items)
    .filter((item) => state.selection.includes(item.path))
    .reduce((sum, item) => sum + item.size, 0),
  selectedCount: state.selection.length
}))

export const allPreviewItems = computed(() => {
  const map = new Map<string, FileEntry>()
  for (const result of state.preview) for (const item of result.items) map.set(item.path, item)
  return map
})

export const volume = computed(() => state.device?.volumes[0] ?? null)

export const freePercent = computed(() => {
  const current = volume.value
  if (!current || !current.totalBytes) return 0
  return (current.freeBytes / current.totalBytes) * 100
})

// ------------------------------------------------------------------- lifecycle

export async function boot(): Promise<void> {
  if (state.booted || state.booting) return
  state.booting = true
  try {
    state.info = await window.api.app.info()
    state.settings = await window.api.settings.get()
    applyTheme()
    state.adb = await window.api.adb.status()
    state.candidates = await window.api.device.candidates()
    state.rules = await window.api.rules.list()
    state.selectedRules = state.rules.filter((rule) => rule.defaultSelected).map((rule) => rule.id)
    state.diagnostics = await window.api.device.diagnostics()

    const demoDefault = state.info?.demoDefault ?? false
    const usable = state.candidates.find((candidate) => candidate.state === 'device')
    if (demoDefault) {
      await connect('demo')
      if (state.device?.state === 'device' && !state.summary) await scan()
    } else if (usable) {
      await connect(usable.serial)
    }
    if (state.info?.startView) await go(state.info.startView as ViewKey)
    await refreshHistory()
  } catch (error) {
    toast('error', 'Startup problem', messageOf(error))
  } finally {
    state.booting = false
    state.booted = true
  }
}

export function applyTheme(): void {
  const theme = state.settings?.theme ?? 'system'
  const dark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
}

// ---------------------------------------------------------------------- device

export async function connect(serial?: string): Promise<void> {
  state.connecting = true
  try {
    const device = await window.api.device.connect(serial)
    state.device = device
    state.diagnostics = await window.api.device.diagnostics()
    if (device.state !== 'device') {
      toast('warn', 'Device not ready', state.diagnostics?.detail ?? 'Allow USB debugging on the phone.')
      return
    }
    const cached = await window.api.scan.cached()
    state.summary = cached
    if (cached) await loadAfterScan(cached)
  } catch (error) {
    state.device = null
    toast('error', 'Could not connect', messageOf(error))
  } finally {
    state.connecting = false
  }
}

export async function disconnect(): Promise<void> {
  await window.api.device.disconnect()
  state.device = null
  state.summary = null
  state.tree = null
  state.largeFiles = []
  state.preview = []
  state.duplicates = []
  state.mediaBuckets = []
  state.apps = null
  state.trash = null
}

export async function refreshDiagnostics(): Promise<void> {
  state.candidates = await window.api.device.candidates()
  state.diagnostics = await window.api.device.diagnostics()
}

export async function restartAdb(): Promise<void> {
  try {
    state.adb = await window.api.adb.restartServer()
    await refreshDiagnostics()
    toast('ok', 'adb restarted', 'Reconnect the phone if it was showing an authorisation prompt.')
  } catch (error) {
    toast('error', 'adb restart failed', messageOf(error))
  }
}

// ---------------------------------------------------------------------- scanning

export async function scan(): Promise<void> {
  if (state.scanning) return
  state.scanning = true
  state.scanProgress = null
  try {
    const summary = await window.api.scan.start()
    state.summary = summary
    await loadAfterScan(summary)
    toast('ok', 'Storage indexed', `${summary.fileCount.toLocaleString()} files in ${formatDuration(summary.durationMs)} using ${summary.strategy}.`)
  } catch (error) {
    toast('error', 'Scan failed', messageOf(error))
  } finally {
    state.scanning = false
    state.scanProgress = null
  }
}

export async function cancelScan(): Promise<void> {
  await window.api.scan.cancel()
}

async function loadAfterScan(summary: ScanSummary): Promise<void> {
  state.summary = summary
  if (summary.warnings.length) {
    toast('warn', 'Scan finished with notes', summary.warnings[0], 9000)
  }
  await Promise.all([loadTree(summary.root), loadLargeFiles(), loadMedia()])
  if (state.view === 'clean') await loadPreview()
}

// ---------------------------------------------------------------------- analysis

export async function loadTree(path?: string): Promise<void> {
  if (!state.summary) return
  state.treeLoading = true
  try {
    state.tree = await window.api.analysis.tree(path)
    state.treePath = state.tree.path
  } catch (error) {
    toast('error', 'Could not open folder', messageOf(error))
  } finally {
    state.treeLoading = false
  }
}

export async function loadLargeFiles(): Promise<void> {
  if (!state.summary) return
  state.largeLoading = true
  try {
    state.largeFiles = await window.api.analysis.largeFiles(300)
  } catch (error) {
    toast('error', 'Could not list large files', messageOf(error))
  } finally {
    state.largeLoading = false
  }
}

// ------------------------------------------------------------------------ rules

export async function loadPreview(): Promise<void> {
  if (!state.summary) return
  state.previewLoading = true
  try {
    state.preview = await window.api.cleanup.preview([...state.selectedRules])
    const available = new Set(state.preview.flatMap((result) => result.items.map((item) => item.path)))
    state.selection = state.selection.filter((path) => available.has(path))
  } catch (error) {
    toast('error', 'Preview failed', messageOf(error))
  } finally {
    state.previewLoading = false
  }
}

export function toggleRule(id: string): void {
  const index = state.selectedRules.indexOf(id)
  if (index >= 0) state.selectedRules.splice(index, 1)
  else state.selectedRules.push(id)
  void loadPreview()
}

export function selectAllRules(): void {
  state.selectedRules = state.rules.map((rule) => rule.id)
  void loadPreview()
}

export function clearRules(): void {
  state.selectedRules = []
  state.preview = []
  state.selection = []
}

export function toggleItem(path: string): void {
  const index = state.selection.indexOf(path)
  if (index >= 0) state.selection.splice(index, 1)
  else state.selection.push(path)
}

export function selectAllItems(): void {
  state.selection = state.preview.flatMap((result) => result.items.map((item) => item.path))
}

export function clearSelection(): void {
  state.selection = []
}

// ---------------------------------------------------------------------- cleanup

export async function executeCleanup(moveToTrash: boolean): Promise<CleanupResult | null> {
  const items = state.selection
    .map((path) => allPreviewItems.value.get(path))
    .filter((item): item is FileEntry => Boolean(item))
    .map((item) => ({ path: item.path, size: item.size, mtime: item.mtime, isDirectory: item.isDirectory }))
  if (items.length === 0) {
    toast('warn', 'Nothing selected', 'Choose at least one item to clean.')
    return null
  }
  state.operation = { running: true, title: moveToTrash ? 'Moving to recycle bin' : 'Deleting files', done: 0, total: items.length }
  try {
    const result = await window.api.cleanup.execute(items, [...state.selectedRules], moveToTrash)
    state.lastResult = result
    await Promise.all([loadPreview(), loadTree(state.treePath), loadLargeFiles(), loadMedia(), refreshHistory(), refreshTrash()])
    if (state.summary) {
      const fresh = await window.api.scan.cached()
      if (fresh) state.summary = fresh
    }
    if (result.failedCount === 0) {
      toast('ok', moveToTrash ? 'Moved to recycle bin' : 'Freed space', `${formatFreed(result.freedBytes)} reclaimed from ${result.deletedCount} item(s).`)
    } else {
      toast(
        'warn',
        'Cleanup finished with issues',
        `${formatFreed(result.freedBytes)} reclaimed. ${result.failedCount} item(s) could not be removed.`
      )
    }
    state.selection = []
    return result
  } catch (error) {
    toast('error', 'Cleanup failed', messageOf(error))
    return null
  } finally {
    state.operation = null
  }
}

function formatFreed(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  if (!bytes) return '0 B'
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`
}

// ------------------------------------------------------------------- duplicates

export async function findDuplicates(): Promise<void> {
  if (!state.summary || state.duplicateRunning) return
  state.duplicateRunning = true
  state.duplicates = []
  state.duplicateProgress = null
  try {
    state.duplicates = await window.api.duplicates.find({ ...state.duplicateOptions })
    const wasted = state.duplicates.reduce((sum, group) => sum + group.wastedBytes, 0)
    toast('ok', 'Duplicate scan complete', `${state.duplicates.length} group(s) holding ${formatFreed(wasted)}.`)
  } catch (error) {
    toast('error', 'Duplicate scan failed', messageOf(error))
  } finally {
    state.duplicateRunning = false
    state.duplicateProgress = null
  }
}

export async function cancelDuplicates(): Promise<void> {
  await window.api.duplicates.cancel()
}

/** Keeps the newest copy in every group and marks the rest for removal. */
export function duplicateRemovalCandidates(group: DuplicateGroup): FileEntry[] {
  return group.files.slice(1)
}

// ------------------------------------------------------------------------ media

export async function loadMedia(): Promise<void> {
  if (!state.summary) return
  state.mediaLoading = true
  try {
    state.mediaBuckets = await window.api.media.buckets()
  } catch (error) {
    toast('error', 'Could not read media', messageOf(error))
  } finally {
    state.mediaLoading = false
  }
}

// ------------------------------------------------------------------------- apps

export async function loadApps(): Promise<void> {
  if (!state.device) return
  state.appsLoading = true
  try {
    state.apps = await window.api.apps.list()
  } catch (error) {
    toast('error', 'Could not list apps', messageOf(error))
  } finally {
    state.appsLoading = false
  }
}

export async function trimCaches(): Promise<void> {
  state.operation = { running: true, title: 'Trimming app caches', done: 0, total: 0 }
  try {
    const result = await window.api.apps.trimCaches()
    if (result.freedBytes > 0) toast('ok', 'Caches trimmed', `${formatFreed(result.freedBytes)} reclaimed. ${result.message}`)
    else toast('info', 'Cache trim', result.message)
    await loadApps()
    await refreshHistory()
  } catch (error) {
    toast('error', 'Cache trim failed', messageOf(error))
  } finally {
    state.operation = null
  }
}

export async function uninstallApp(packageName: string): Promise<void> {
  state.operation = { running: true, title: `Uninstalling ${packageName}`, done: 0, total: 0 }
  try {
    const result = await window.api.apps.uninstall(packageName)
    toast(result.ok ? 'ok' : 'error', result.ok ? 'App removed' : 'Uninstall failed', result.message)
    await loadApps()
    await refreshHistory()
  } catch (error) {
    toast('error', 'Uninstall failed', messageOf(error))
  } finally {
    state.operation = null
  }
}

// ------------------------------------------------------------------------ trash

export async function refreshTrash(): Promise<void> {
  if (!state.device) return
  state.trashLoading = true
  try {
    state.trash = await window.api.trash.summary()
  } catch (error) {
    toast('error', 'Could not read the recycle bin', messageOf(error))
  } finally {
    state.trashLoading = false
  }
}

export async function restoreTrash(storedPaths: string[]): Promise<void> {
  try {
    const result = await window.api.trash.restore(storedPaths)
    toast('ok', 'Restored', `${result.deletedCount} file(s) returned to their original folders.`)
    await Promise.all([refreshTrash(), refreshHistory(), loadTree(state.treePath)])
  } catch (error) {
    toast('error', 'Restore failed', messageOf(error))
  }
}

export async function purgeTrash(storedPaths?: string[]): Promise<void> {
  try {
    const result = await window.api.trash.purge(storedPaths)
    toast('ok', 'Recycle bin emptied', `${result.deletedCount} file(s) permanently removed.`)
    await Promise.all([refreshTrash(), refreshHistory()])
  } catch (error) {
    toast('error', 'Could not empty the recycle bin', messageOf(error))
  }
}

// ---------------------------------------------------------------------- history

export async function refreshHistory(): Promise<void> {
  try {
    state.history = await window.api.history.list()
  } catch {
    state.history = []
  }
}

export async function clearHistory(): Promise<void> {
  await window.api.history.clear()
  await refreshHistory()
  toast('info', 'History cleared', 'Operation records were removed from this computer.')
}

// --------------------------------------------------------------------- settings

export async function saveSettings(patch: Partial<Settings>): Promise<void> {
  state.settings = await window.api.settings.set(patch)
  applyTheme()
}

// ------------------------------------------------------------------- navigation

export async function go(view: ViewKey): Promise<void> {
  state.view = view
  if (!state.summary) return
  if (view === 'overview' || view === 'analysis') await loadTree(state.treePath || undefined)
  if (view === 'large') await loadLargeFiles()
  if (view === 'clean') await loadPreview()
  if (view === 'media') await loadMedia()
  if (view === 'apps') await loadApps()
  if (view === 'trash') await refreshTrash()
  if (view === 'history') await refreshHistory()
}

export function onProgress(event: Parameters<Parameters<typeof window.api.onProgress>[0]>[0]): void {
  if (event.kind === 'scan') state.scanProgress = event.payload
  if (event.kind === 'duplicates') state.duplicateProgress = event.payload
  if (event.kind === 'cleanup' && state.operation) {
    state.operation.done = event.payload.done
    state.operation.total = event.payload.total
  }
  if (event.kind === 'log') {
    if (event.payload.level === 'error') toast('error', 'Device message', event.payload.message)
    else if (event.payload.level === 'warn') toast('warn', 'Device message', event.payload.message)
  }
}
