/**
 * Shared contract between the Electron main process (device + filesystem authority)
 * and the renderer (presentation only).
 *
 * The renderer never touches the phone directly: every operation is a typed IPC call.
 * Sizes are bytes, times are Unix seconds unless the field says otherwise.
 */

export type RiskLevel = 'safe' | 'recoverable' | 'highImpact'

export type StorageVolume = {
  /** Mount path on the device, e.g. `/sdcard` */
  mount: string
  label: string
  totalBytes: number
  usedBytes: number
  freeBytes: number
}

export type DeviceCapabilities = {
  /** `stat -c` with multiple operands supported (fast bulk metadata reads) */
  bulkStat: boolean
  /** `find -exec ... {} +` supported */
  findExecPlus: boolean
  md5sum: boolean
  /** Shell user can list `/sdcard/Android/data` (Android 10 and OEM exceptions) */
  androidDataReadable: boolean
  /** `dumpsys diskstats` gives per-app size/cache figures */
  diskStats: boolean
  /** `pm trim-caches` available */
  trimCaches: boolean
  /** MediaStore reachable through `content query` */
  mediaStore: boolean
  /** On-device recycle bin directories discovered (`/sdcard/.Trash`, OEM bins) */
  recycleBinPaths: string[]
}

export type DeviceInfo = {
  serial: string
  state: 'device' | 'unauthorized' | 'offline' | 'no-permissions' | 'unknown'
  manufacturer: string
  model: string
  androidVersion: string
  sdk: number
  productName: string
  isEmulator: boolean
  /** Virtual device backed by the built-in fixture filesystem, not real hardware */
  simulated: boolean
  volumes: StorageVolume[]
  capabilities: DeviceCapabilities
  batteryPercent?: number
}

export type AdbStatus = {
  adbPath: string
  adbFound: boolean
  adbVersion?: string
  serverRunning: boolean
  error?: string
}

export type DeviceCandidate = {
  serial: string
  state: string
  model?: string
  product?: string
  transportId?: string
}

export type FileEntry = {
  path: string
  size: number
  /** Modification time in Unix seconds; 0 when the device could not report it */
  mtime: number
  /** Set for folder entries produced by the empty-folder rule */
  isDirectory?: boolean
}

export type ScanProgress = {
  phase: 'connecting' | 'directories' | 'files' | 'aggregating' | 'done' | 'cancelled' | 'error'
  /** Files parsed so far */
  entries: number
  /** Bytes represented by those files */
  bytes: number
  /** Directories seen so far */
  directories: number
  elapsedMs: number
  /** Command strategy actually used, for transparency in the UI */
  strategy: string
  message?: string
}

export type ScanSummary = {
  serial: string
  root: string
  scannedAt: number
  durationMs: number
  fileCount: number
  dirCount: number
  totalBytes: number
  strategy: string
  /** True when this summary came from the on-disk cache instead of a fresh walk */
  fromCache: boolean
  warnings: string[]
}

export type TreeChild = {
  name: string
  path: string
  kind: 'dir' | 'file'
  size: number
  /** Recursive file count for directories */
  fileCount: number
  /** Share of the parent's size, 0..1 */
  share: number
  /** Number of immediate children, for directories */
  childCount?: number
}

export type TreeView = {
  path: string
  totalBytes: number
  fileCount: number
  children: TreeChild[]
  /** Aggregated buckets for the chart: direct files plus child directories */
  otherBytes: number
}

export type LargeFile = FileEntry & {
  /** Extension without the dot, lowercase; empty when there is none */
  ext: string
  /** Directory that contains the file */
  dir: string
  /** Human-friendly grouping derived from the path, e.g. Camera, Download */
  group: string
}

export type RuleMatcher = {
  /** Only files whose name matches one of these globs (omit for everything) */
  include?: string[]
  /** Skip files or directories matching these globs */
  exclude?: string[]
  /** Only match files older than this many days (0 = no age limit) */
  olderThanDays?: number
  /** Only match files at least this large */
  minSizeBytes?: number
  /** Only match files at most this large */
  maxSizeBytes?: number
  /** Match directories themselves instead of their contents */
  target?: 'file' | 'dir' | 'dirContents'
}

export type Rule = {
  id: string
  category: 'system' | 'apps' | 'media' | 'downloads' | 'social' | 'misc'
  title: string
  description: string
  risk: RiskLevel
  /** Shell-style patterns; `*` matches within one path segment. Absolute paths only. */
  roots: string[]
  matcher: RuleMatcher
  defaultSelected: boolean
  /** Shown when the rule is impossible on the connected device */
  requiresCapability?: keyof DeviceCapabilities
}

export type RuleScanResult = {
  rule: Rule
  items: FileEntry[]
  totalBytes: number
  skippedReason?: string
  /** Paths that exist on the device but are unreadable to the shell user */
  unreadable: string[]
}

export type CleanupPlan = {
  id: string
  createdAt: number
  items: FileEntry[]
  totalBytes: number
  /** Move to the on-device recycle bin instead of deleting outright */
  moveToTrash: boolean
  rules: string[]
}

export type CleanupResult = {
  opId: string
  deletedCount: number
  failedCount: number
  freedBytes: number
  failures: { path: string; reason: string }[]
  verified: boolean
  durationMs: number
  trashDir?: string
  /** Mapping recorded when items were moved to the recycle bin */
  trashEntries?: { original: string; stored: string; size: number }[]
}

export type DuplicateGroup = {
  /** Stable key for UI selection */
  id: string
  /** Content hash (md5) or size-only marker when hashing was skipped */
  hash: string
  size: number
  /** Bytes wasted = size * (copies - 1) */
  wastedBytes: number
  files: FileEntry[]
  /** True when only the fast size+head-hash prefilter ran, not the full hash */
  approximate: boolean
}

export type DuplicateScanOptions = {
  minSizeBytes: number
  maxGroups: number
  /** Compare full file contents instead of stopping at the head hash */
  fullHash: boolean
}

export type DuplicateProgress = {
  phase: 'grouping' | 'prefilter' | 'hashing' | 'done' | 'cancelled'
  candidates: number
  hashed: number
  groups: number
  message?: string
}

export type MediaItem = FileEntry & {
  kind: 'image' | 'video' | 'audio' | 'screenshot' | 'document' | 'archive' | 'apk' | 'other'
  /** Path-derived bucket, e.g. Camera, Screenshots, Download */
  group: string
  ext: string
}

export type MediaBucket = {
  kind: MediaItem['kind']
  label: string
  count: number
  totalBytes: number
  items: MediaItem[]
}

export type InstalledApp = {
  packageName: string
  label: string
  apkBytes: number
  dataBytes: number
  cacheBytes: number
  codeBytes: number
  system: boolean
  /** False for apps where size figures were unavailable */
  sized: boolean
}

export type AppListResult = {
  apps: InstalledApp[]
  totalCacheBytes: number
  totalDataBytes: number
  totalApkBytes: number
  available: boolean
  message?: string
}

export type HistoryEntry = {
  id: string
  kind: 'cleanup' | 'trash-restore' | 'trash-purge' | 'uninstall' | 'trim-caches' | 'scan'
  at: number
  deviceSerial: string
  deviceModel: string
  itemCount: number
  freedBytes: number
  failedCount: number
  details: string
  trashDir?: string
  /** Paths relative to the trash dir, for restore */
  trashEntries?: { original: string; stored: string; size: number }[]
}

export type TrashEntry = {
  opId: string
  at: number
  deviceSerial: string
  originalPath: string
  storedPath: string
  size: number
  mtime: number
}

export type TrashSummary = {
  dir: string
  entries: TrashEntry[]
  totalBytes: number
  oldest?: number
}

export type Settings = {
  adbPath: string
  useMockDevice: boolean
  moveToTrash: boolean
  trashRetentionDays: number
  scanRoot: string
  theme: 'light' | 'dark' | 'system'
  largeFileMinBytes: number
  duplicateMinBytes: number
  /** Exclude /sdcard/Android/data from scans (it is unreadable on modern Android) */
  skipAppData: boolean
}

export type AppInfo = {
  version: string
  electron: string
  platform: string
  userDataDir: string
  /** Start on the built-in simulated device (development / screenshots) */
  demoDefault?: boolean
  /** Open this view on launch (development / screenshots) */
  startView?: string
}

export type ProgressEvent =
  | { kind: 'scan'; payload: ScanProgress }
  | { kind: 'duplicates'; payload: DuplicateProgress }
  | { kind: 'cleanup'; payload: { done: number; total: number } }
  | { kind: 'log'; payload: { level: 'info' | 'warn' | 'error'; message: string } }

/** The API surface exposed on `window.api` by the preload bridge. */
export type FilePreview = FileEntry & {
  kind: 'image' | 'video' | 'audio' | 'text' | 'details'
  url?: string
  text?: string
  message?: string
}

export type MangoApi = {
  preview: { load(path: string): Promise<FilePreview> }
  app: {
    info(): Promise<AppInfo>
    openDataDir(): Promise<void>
    openExternal(url: string): Promise<void>
  }
  adb: {
    status(): Promise<AdbStatus>
    locate(): Promise<AdbStatus>
    restartServer(): Promise<AdbStatus>
  }
  device: {
    candidates(): Promise<DeviceCandidate[]>
    connect(serial?: string): Promise<DeviceInfo>
    current(): Promise<DeviceInfo | null>
    disconnect(): Promise<void>
    /** Explain, in user terms, why the current device is not usable yet */
    diagnostics(): Promise<{ ok: boolean; title: string; detail: string; steps: string[] }>
  }
  scan: {
    start(): Promise<ScanSummary>
    cached(): Promise<ScanSummary | null>
    cancel(): Promise<void>
    summary(): Promise<ScanSummary | null>
  }
  analysis: {
    tree(path?: string): Promise<TreeView>
    largeFiles(limit: number, minBytes?: number): Promise<LargeFile[]>
  }
  rules: {
    list(): Promise<Rule[]>
  }
  cleanup: {
    preview(ruleIds: string[], extraPaths?: string[]): Promise<RuleScanResult[]>
    plan(items: FileEntry[], ruleIds: string[]): Promise<CleanupPlan>
    execute(items: FileEntry[], ruleIds: string[], moveToTrash: boolean): Promise<CleanupResult>
  }
  duplicates: {
    find(options: DuplicateScanOptions): Promise<DuplicateGroup[]>
    cancel(): Promise<void>
  }
  media: {
    buckets(): Promise<MediaBucket[]>
  }
  apps: {
    list(): Promise<AppListResult>
    trimCaches(): Promise<{ freedBytes: number; message: string }>
    uninstall(packageName: string): Promise<{ ok: boolean; message: string }>
  }
  trash: {
    summary(): Promise<TrashSummary>
    restore(storedPaths: string[]): Promise<CleanupResult>
    purge(storedPaths?: string[]): Promise<CleanupResult>
  }
  history: {
    list(): Promise<HistoryEntry[]>
    clear(): Promise<void>
  }
  settings: {
    get(): Promise<Settings>
    set(patch: Partial<Settings>): Promise<Settings>
  }
  onProgress(cb: (event: ProgressEvent) => void): () => void
}
