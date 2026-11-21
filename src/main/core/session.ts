import { randomUUID } from 'node:crypto'
import { PreviewCache, validatePreviewPath } from './preview'
import type {
  AdbStatus,
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
  ProgressEvent,
  Rule,
  RuleScanResult,
  ScanProgress,
  ScanSummary,
  Settings,
  TreeView
} from '@shared/types'
import { AdbTransport, adbVersion, listDevices, locateAdb, parseDevices } from '../adb/real-adb'
import { MockTransport } from '../adb/mock-transport'
import { buildDeviceInfo, probeDevice } from '../adb/probe'
import type { DeviceTransport } from '../adb/transport'
import { executeCleanup, purgeTrash, restoreFromTrash } from './cleaner'
import { findDuplicates } from './duplicates'
import { buildMediaBuckets } from './media'
import { listApps, trimCaches, uninstallApp } from './apps'
import { HistoryStore, IndexCache, SettingsStore } from './persistence'
import { type StorageIndex } from './storage-index'
import { dedupePreviewResults, loadRules, previewRules, validateRules } from './rules-engine'
import { trashDirFor } from './safety'
import { scanVolume } from './scanner'

const DEMO_SERIAL = 'demo-pixel'

export class MangoSession {
  async filePreview(path: string, cache: PreviewCache) {
    const index = this.requireIndex()
    validatePreviewPath(path, index.root)
    const file = index.files.find(file => file.path === path) ??
      (index.dirs.has(path) ? { path, size: 0, mtime: 0, isDirectory: true } : undefined) ??
      this.history.trashOperations().filter(op => op.deviceSerial === this.transport?.serial)
        .flatMap(op => op.trashEntries ?? []).filter(entry => entry.stored === path)
        .map(entry => ({ path, size: entry.size, mtime: 0 }))[0]
    if (!file) throw new Error('File is not in the current scan. Rescan storage and try again.')
    return cache.load(this.requireTransport(), file)
  }
  private transport?: DeviceTransport
  private deviceInfo?: DeviceInfo
  private index?: StorageIndex
  private summary?: ScanSummary
  private scanAbort?: AbortController
  private duplicateAbort?: AbortController
  private lastDuplicateProgress?: DuplicateProgress

  constructor(
    private readonly settings: SettingsStore,
    private readonly history: HistoryStore,
    private readonly cache: IndexCache,
    private readonly emit: (event: ProgressEvent) => void
  ) {
    const problems = validateRules(loadRules())
    if (problems.length) {
      // Fail loudly at startup: a bad rule must never reach a destructive path.
      throw new Error(`Cleanup rules are invalid:\n${problems.join('\n')}`)
    }
  }

  // ---------------------------------------------------------------- adb / device

  async adbStatus(): Promise<AdbStatus> {
    const settings = this.settings.get()
    const status = locateAdb(settings.adbPath || undefined)
    if (!status.adbFound) return status
    const version = await adbVersion(status.adbPath)
    return { ...status, adbVersion: version }
  }

  async candidates(): Promise<DeviceCandidate[]> {
    const status = await this.adbStatus()
    if (!status.adbFound) return []
    try {
      return await listDevices(status.adbPath)
    } catch {
      return []
    }
  }

  current(): DeviceInfo | null {
    return this.deviceInfo ?? null
  }

  async connect(serial?: string): Promise<DeviceInfo> {
    const settings = this.settings.get()
    this.transport?.dispose()
    this.transport = undefined
    this.deviceInfo = undefined
    this.index = undefined
    this.summary = undefined

    const wantsDemo = serial === 'demo' || (!serial && settings.useMockDevice)
    if (serial === 'demo' || wantsDemo) {
      const transport = new MockTransport(DEMO_SERIAL, { androidDataReadable: false })
      return this.establish(transport)
    }

    const status = await this.adbStatus()
    if (!status.adbFound) {
      throw new Error(status.error ?? 'adb was not found')
    }

    const devices = await listDevices(status.adbPath)
    const usable = devices.filter((device) => device.state === 'device')
    const chosen = serial ? devices.find((device) => device.serial === serial) : usable[0] ?? devices[0]

    if (!chosen) {
      throw new Error('No Android device is connected. Connect a phone with USB debugging enabled.')
    }
    if (chosen.state !== 'device') {
      this.deviceInfo = {
        serial: chosen.serial,
        state: chosen.state === 'unauthorized' ? 'unauthorized' : chosen.state === 'offline' ? 'offline' : 'unknown',
        manufacturer: chosen.model ?? '',
        model: chosen.model ?? chosen.serial,
        androidVersion: 'unknown',
        sdk: 0,
        productName: chosen.product ?? '',
        isEmulator: false,
        simulated: false,
        volumes: [],
        capabilities: {
          bulkStat: false,
          findExecPlus: false,
          md5sum: false,
          androidDataReadable: false,
          diskStats: false,
          trimCaches: false,
          mediaStore: false,
          recycleBinPaths: []
        }
      }
      return this.deviceInfo
    }

    return this.establish(new AdbTransport(chosen.serial, status.adbPath))
  }

  private async establish(transport: DeviceTransport): Promise<DeviceInfo> {
    this.emit({ kind: 'log', payload: { level: 'info', message: `Connecting to ${transport.serial}…` } })
    const probe = await probeDevice(transport)
    this.transport = transport
    this.deviceInfo = buildDeviceInfo(transport.serial, probe, transport.simulated)
    for (const warning of probe.warnings) {
      this.emit({ kind: 'log', payload: { level: 'warn', message: warning } })
    }
    const cached = this.cache.load(transport.serial)
    if (cached) {
      this.index = cached.index
      this.summary = {
        serial: transport.serial,
        root: cached.index.root,
        scannedAt: cached.meta.scannedAt,
        durationMs: cached.meta.durationMs,
        fileCount: cached.index.fileCount,
        dirCount: cached.index.dirCount,
        totalBytes: cached.index.totalBytes,
        strategy: cached.meta.strategy,
        fromCache: true,
        warnings: []
      }
    }
    void this.purgeExpiredTrash()
    return this.deviceInfo
  }

  async diagnostics(): Promise<{ ok: boolean; title: string; detail: string; steps: string[] }> {
    const status = await this.adbStatus()
    if (!status.adbFound) {
      return {
        ok: false,
        title: 'adb is missing',
        detail: status.error ?? 'Android Platform Tools were not found on this computer.',
        steps: [
          'Download Android Platform Tools from developer.android.com/tools/releases/platform-tools',
          'Unzip it somewhere permanent, for example C:\\platform-tools',
          'Set that folder in Settings → adb path, or add it to PATH'
        ]
      }
    }
    const devices = await this.candidates()
    if (devices.length === 0) {
      return {
        ok: false,
        title: 'No phone detected',
        detail: 'The computer cannot see an Android device over USB.',
        steps: [
          'Unlock the phone and keep the screen on',
          'Enable Developer options: Settings → About phone → tap Build number 7 times',
          'Enable USB debugging in Settings → System → Developer options',
          'Connect the cable and choose "File transfer (MTP)" or "USB debugging" in the USB notification',
          'Accept the "Allow USB debugging?" prompt on the phone'
        ]
      }
    }
    const unauthorized = devices.find((device) => device.state === 'unauthorized')
    if (unauthorized) {
      return {
        ok: false,
        title: 'Phone is not authorised',
        detail: 'The phone sees the computer but has not granted debugging access.',
        steps: [
          'Unlock the phone and look for the "Allow USB debugging?" dialog',
          'Tick "Always allow from this computer" and tap Allow',
          'If no dialog appears, run "adb kill-server" then reconnect the cable'
        ]
      }
    }
    return { ok: true, title: 'Ready', detail: 'Device connected and authorised.', steps: [] }
  }

  disconnect(): void {
    this.transport?.dispose()
    this.transport = undefined
    this.deviceInfo = undefined
    this.index = undefined
    this.summary = undefined
  }

  // -------------------------------------------------------------------- scanning

  async scan(): Promise<ScanSummary> {
    const transport = this.requireTransport()
    const settings = this.settings.get()
    this.scanAbort?.abort()
    const abort = new AbortController()
    this.scanAbort = abort
    const capabilities = this.deviceInfo?.capabilities
    if (!capabilities) throw new Error('Device capabilities are unknown; reconnect the device.')

    const outcome = await scanVolume({
      transport,
      capabilities,
      root: settings.scanRoot || '/sdcard',
      signal: abort.signal,
      onProgress: (progress: ScanProgress) => this.emit({ kind: 'scan', payload: progress })
    })

    this.index = outcome.index
    this.summary = outcome.summary
    this.cache.save(transport.serial, outcome.index, {
      scannedAt: outcome.summary.scannedAt,
      durationMs: outcome.summary.durationMs,
      strategy: outcome.summary.strategy
    })
    this.history.append({
      id: `scan-${outcome.summary.scannedAt}`,
      kind: 'scan',
      at: outcome.summary.scannedAt,
      deviceSerial: transport.serial,
      deviceModel: this.deviceInfo?.model ?? '',
      itemCount: outcome.summary.fileCount,
      freedBytes: 0,
      failedCount: 0,
      details: `Indexed ${outcome.summary.fileCount.toLocaleString()} files in ${formatSpan(outcome.summary.durationMs)}`
    })
    return outcome.summary
  }

  cachedSummary(): ScanSummary | null {
    return this.summary ?? null
  }

  cancelScan(): void {
    this.scanAbort?.abort()
  }

  summaryOrThrow(): ScanSummary {
    if (!this.summary) throw new Error('Scan the device first.')
    return this.summary
  }

  private requireTransport(): DeviceTransport {
    if (!this.transport) throw new Error('No device connected.')
    return this.transport
  }

  private requireIndex(): StorageIndex {
    if (!this.index) throw new Error('Scan the device first.')
    return this.index
  }

  // ------------------------------------------------------------------- analysis

  tree(path?: string): TreeView {
    const index = this.requireIndex()
    return index.tree(path || index.root)
  }

  largeFiles(limit: number, minBytes?: number): LargeFile[] {
    const index = this.requireIndex()
    const settings = this.settings.get()
    return index.largeFiles(limit, minBytes ?? settings.largeFileMinBytes)
  }

  rules(): Rule[] {
    return loadRules()
  }

  // -------------------------------------------------------------------- cleanup

  preview(ruleIds: string[], extraPaths?: string[]): RuleScanResult[] {
    const index = this.requireIndex()
    const rules = loadRules().filter((rule) => ruleIds.includes(rule.id))
    const results = previewRules({ index, capabilities: this.deviceInfo?.capabilities ?? emptyCapabilities() }, rules)

    if (extraPaths && extraPaths.length) {
      const files: FileEntry[] = []
      for (const path of extraPaths) {
        const entry = index.get(path)
        if (entry) files.push(entry)
      }
      results.push({
        rule: {
          id: 'manual.selection',
          category: 'misc',
          title: 'Manually selected',
          description: 'Files you picked yourself.',
          risk: 'highImpact',
          roots: [],
          matcher: {},
          defaultSelected: false
        },
        items: files,
        totalBytes: files.reduce((sum, file) => sum + file.size, 0),
        unreadable: []
      })
    }
    return dedupePreviewResults(results)
  }

  async execute(items: FileEntry[], ruleIds: string[], moveToTrash: boolean): Promise<CleanupResult> {
    const transport = this.requireTransport()
    const index = this.requireIndex()
    const settings = this.settings.get()
    const root = settings.scanRoot || '/sdcard'
    const opId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 6)}`

    const files = items.filter((item) => !item.isDirectory)
    const dirs = items.filter((item) => item.isDirectory).map((item) => item.path)

    this.emit({ kind: 'cleanup', payload: { done: 0, total: files.length + dirs.length } })
    const result = await executeCleanup(
      transport,
      root,
      { files, dirs, moveToTrash, trashDir: trashDirFor(root), opId, ruleIds },
      { onProgress: (done, total) => this.emit({ kind: 'cleanup', payload: { done, total } }) }
    )

    const trashEntries = result.trashEntries

    this.history.append({
      id: opId,
      kind: 'cleanup',
      at: Date.now(),
      deviceSerial: transport.serial,
      deviceModel: this.deviceInfo?.model ?? '',
      itemCount: result.deletedCount,
      freedBytes: result.freedBytes,
      failedCount: result.failedCount,
      details: moveToTrash ? 'Moved to recycle bin' : 'Permanently deleted',
      trashDir: result.trashDir,
      trashEntries
    })

    // Refresh the in-memory index so every view reflects the new state instantly.
    const removedFiles = new Set(files.filter((file) => !result.failures.some((f) => f.path === file.path)).map((file) => file.path))
    const removedDirs = new Set(dirs.filter((dir) => !result.failures.some((f) => f.path === dir)))
    if (removedFiles.size || removedDirs.size) {
      const next = index.without(removedFiles, removedDirs)
      this.index = next
      if (this.summary) {
        this.summary = { ...this.summary, fileCount: next.fileCount, dirCount: next.dirCount, totalBytes: next.totalBytes }
        this.cache.save(transport.serial, next, {
          scannedAt: this.summary.scannedAt,
          durationMs: this.summary.durationMs,
          strategy: this.summary.strategy
        })
      }
    }

    return result
  }

  // ----------------------------------------------------------------- duplicates

  async duplicates(options: DuplicateScanOptions): Promise<DuplicateGroup[]> {
    const transport = this.requireTransport()
    const index = this.requireIndex()
    this.duplicateAbort?.abort()
    const abort = new AbortController()
    this.duplicateAbort = abort

    const groups = await findDuplicates({
      transport,
      index,
      settings: options,
      signal: abort.signal,
      onProgress: (progress) => {
        this.lastDuplicateProgress = progress
        this.emit({ kind: 'duplicates', payload: progress })
      }
    })
    return groups
  }

  cancelDuplicates(): void {
    this.duplicateAbort?.abort()
  }

  // ----------------------------------------------------------------------- media

  media(): MediaBucket[] {
    return buildMediaBuckets(this.requireIndex())
  }

  // ------------------------------------------------------------------------ apps

  async apps(): Promise<AppListResult> {
    return listApps(this.requireTransport())
  }

  async trimCaches(): Promise<{ freedBytes: number; message: string }> {
    const transport = this.requireTransport()
    const result = await trimCaches(transport)
    this.history.append({
      id: `trim-${Date.now()}`,
      kind: 'trim-caches',
      at: Date.now(),
      deviceSerial: transport.serial,
      deviceModel: this.deviceInfo?.model ?? '',
      itemCount: 0,
      freedBytes: result.freedBytes,
      failedCount: 0,
      details: result.message
    })
    return result
  }

  async uninstall(packageName: string): Promise<{ ok: boolean; message: string }> {
    const transport = this.requireTransport()
    const result = await uninstallApp(transport, packageName)
    if (result.ok) {
      this.history.append({
        id: `uninstall-${Date.now()}`,
        kind: 'uninstall',
        at: Date.now(),
        deviceSerial: transport.serial,
        deviceModel: this.deviceInfo?.model ?? '',
        itemCount: 1,
        freedBytes: 0,
        failedCount: 0,
        details: `Uninstalled ${packageName}`
      })
    }
    return result
  }

  // ----------------------------------------------------------------------- trash

  async trashSummary(): Promise<{ dir: string; entries: { opId: string; at: number; deviceSerial: string; originalPath: string; storedPath: string; size: number; mtime: number }[]; totalBytes: number; oldest?: number }> {
    const transport = this.transport
    const root = this.settings.get().scanRoot || '/sdcard'
    const dir = trashDirFor(root)
    const operations = this.history.trashOperations()
    const entries = operations.flatMap((operation) =>
      (operation.trashEntries ?? []).map((entry) => ({
        opId: operation.id,
        at: operation.at,
        deviceSerial: operation.deviceSerial,
        originalPath: entry.original,
        storedPath: entry.stored,
        size: entry.size,
        mtime: 0
      }))
    )
    if (!transport || entries.length === 0) {
      return { dir, entries: [], totalBytes: 0 }
    }
    // Drop entries the user removed by hand, so the bin never lies.
    const existing = await transport.existingPaths(entries.map((entry) => entry.storedPath))
    const alive = entries.filter((entry) => existing.has(entry.storedPath))
    for (const gone of entries) {
      if (existing.has(gone.storedPath)) continue
      const operation = this.history.list().find((candidate) => candidate.id === gone.opId)
      if (operation?.trashEntries) {
        this.history.updateTrash(
          operation.id,
          operation.trashEntries.filter((entry) => entry.stored !== gone.storedPath)
        )
      }
    }
    return {
      dir,
      entries: alive,
      totalBytes: alive.reduce((sum, entry) => sum + entry.size, 0),
      oldest: alive.length ? Math.min(...alive.map((entry) => entry.at)) : undefined
    }
  }

  async restoreTrash(storedPaths: string[]): Promise<CleanupResult> {
    const transport = this.requireTransport()
    const operations = this.history.trashOperations()
    const pairs: { original: string; stored: string }[] = []
    for (const operation of operations) {
      for (const entry of operation.trashEntries ?? []) {
        if (storedPaths.includes(entry.stored)) pairs.push(entry)
      }
    }
    if (pairs.length === 0) throw new Error('Nothing to restore: those items are no longer in the recycle bin.')

    const result = await restoreFromTrash(transport, pairs)
    const restoredPaths = new Set(pairs.filter((pair) => !result.failures.some((failure) => failure.path === pair.stored)).map((pair) => pair.stored))
    for (const operation of operations) {
      const remaining = (operation.trashEntries ?? []).filter((entry) => !restoredPaths.has(entry.stored))
      this.history.updateTrash(operation.id, remaining)
      if (remaining.length === 0) await this.dropTrashOperation(transport, operation.trashDir)
    }
    this.history.append({
      id: `restore-${Date.now()}`,
      kind: 'trash-restore',
      at: Date.now(),
      deviceSerial: transport.serial,
      deviceModel: this.deviceInfo?.model ?? '',
      itemCount: result.deletedCount,
      freedBytes: 0,
      failedCount: result.failedCount,
      details: `Restored ${result.deletedCount} file${result.deletedCount === 1 ? '' : 's'} from the recycle bin`
    })
    return result
  }

  async purge(storedPaths?: string[]): Promise<CleanupResult> {
    const transport = this.requireTransport()
    const operations = this.history.trashOperations()
    const all = operations.flatMap((operation) => operation.trashEntries ?? [])
    const targets = storedPaths ? all.filter((entry) => storedPaths.includes(entry.stored)) : all
    if (targets.length === 0) throw new Error('The recycle bin is already empty.')

    const result = await purgeTrash(transport, targets.map((entry) => entry.stored))
    const removed = new Set(targets.map((entry) => entry.stored))
    for (const operation of operations) {
      const remaining = (operation.trashEntries ?? []).filter((entry) => !removed.has(entry.stored))
      this.history.updateTrash(operation.id, remaining)
      if (remaining.length === 0) await this.dropTrashOperation(transport, operation.trashDir)
    }
    this.history.append({
      id: `purge-${Date.now()}`,
      kind: 'trash-purge',
      at: Date.now(),
      deviceSerial: transport.serial,
      deviceModel: this.deviceInfo?.model ?? '',
      itemCount: result.deletedCount,
      freedBytes: 0,
      failedCount: result.failedCount,
      details: `Permanently removed ${result.deletedCount} file${result.deletedCount === 1 ? '' : 's'} from the recycle bin`
    })
    return result
  }

  /**
   * Drops the on-device folder of a recycle-bin operation once nothing is left.
   * It only holds the manifest, so this stops empty folders piling up on the
   * phone. Best-effort: history has already been updated by the caller.
   */
  private async dropTrashOperation(transport: DeviceTransport, opDir: string | undefined): Promise<void> {
    if (!opDir) return
    try {
      await transport.deleteFiles([`${opDir}/manifest.tsv`])
      await transport.removeEmptyDirs([opDir])
    } catch {
      // Harmless: an empty folder in the bin is invisible to the app.
    }
  }

  /** Deletes recycle-bin operations older than the retention window. */
  private async purgeExpiredTrash(): Promise<void> {
    const settings = this.settings.get()
    if (settings.trashRetentionDays <= 0) return
    const cutoff = Date.now() - settings.trashRetentionDays * 86_400_000
    const expired = this.history
      .trashOperations()
      .filter((operation) => operation.at < cutoff)
      .flatMap((operation) => operation.trashEntries ?? [])
    if (expired.length === 0) return
    try {
      const transport = this.requireTransport()
      await purgeTrash(transport, expired.map((entry) => entry.stored))
      const expiredSet = new Set(expired.map((entry) => entry.stored))
      for (const operation of this.history.trashOperations()) {
        const remaining = (operation.trashEntries ?? []).filter((entry) => !expiredSet.has(entry.stored))
        this.history.updateTrash(operation.id, remaining)
        if (remaining.length === 0) await this.dropTrashOperation(transport, operation.trashDir)
      }
      this.emit({
        kind: 'log',
        payload: { level: 'info', message: `Recycle bin cleanup removed ${expired.length} expired item(s).` }
      })
    } catch {
      // Retention is best-effort; the next cleanup attempt retries.
    }
  }

  // --------------------------------------------------------------------- history

  listHistory(): HistoryEntry[] {
    return this.history.list()
  }

  clearHistory(): void {
    this.history.clear()
  }

  settingsSnapshot(): Settings {
    return this.settings.get()
  }

  updateSettings(patch: Partial<Settings>): Settings {
    return this.settings.set(patch)
  }
}

/** Compact duration for human-facing history text. */
function formatSpan(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)}s`
}

function emptyCapabilities(): DeviceInfo['capabilities'] {
  return {
    bulkStat: false,
    findExecPlus: false,
    md5sum: false,
    androidDataReadable: false,
    diskStats: false,
    trimCaches: false,
    mediaStore: false,
    recycleBinPaths: []
  }
}

export { parseDevices }
