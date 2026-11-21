import type { DeviceCapabilities, FileEntry, ScanProgress, ScanSummary } from '@shared/types'
import type { DeviceTransport } from '../adb/transport'
import { StorageIndex } from './storage-index'
import { trashDirFor } from './safety'

const MAX_ENTRIES = 800_000

export type ScanOptions = {
  transport: DeviceTransport
  capabilities: DeviceCapabilities
  root: string
  signal: AbortSignal
  onProgress: (progress: ScanProgress) => void
}

export type ScanOutcome = {
  index: StorageIndex
  summary: ScanSummary
}

/**
 * The one command that turns a whole volume into a compact, streamable index.
 *
 * Two device quirks drive the shape of this command:
 *
 * - `-H` follows a symlinked root. On MIUI (and many other ROMs) `/sdcard` is a
 *   link to /storage/emulated/0, and plain `find` describes the link itself,
 *   which used to make the scan index a single 21-byte entry.
 * - `-exec stat {} +` is not used. On a real 62k-file volume toybox reported
 *   "Argument list too long" and silently dropped whole batches (17k of 37k
 *   files indexed). `xargs -n` keeps every batch under the limit.
 *
 * `-xdev` is deliberately absent: it prunes `/sdcard/Android/data`, which is a
 * separate FUSE mount on Android 11+, and that is exactly where app caches live
 * on the devices that expose them.
 */
export function buildFileScanCommand(root: string, capabilities: DeviceCapabilities): { command: string; strategy: string } {
  if (capabilities.findExecPlus) {
    return {
      command: `find -H ${root} -type f -print0 2>/dev/null | xargs -0 -r -n 500 stat -c '%s|%Y|%n' 2>/dev/null`,
      strategy: 'bulk-stat'
    }
  }
  if (capabilities.bulkStat) {
    return {
      command: `find -H ${root} -type f -exec stat -c '%s|%Y|%n' {} \\; 2>/dev/null`,
      strategy: 'per-file-stat'
    }
  }
  // Last resort: `du -a -b` reports apparent sizes for files and directories.
  return {
    command: `du -a -b -H ${root} 2>/dev/null`,
    strategy: 'du-apparent-size'
  }
}

export function buildDirScanCommand(root: string): string {
  return `find -H ${root} -type d 2>/dev/null`
}

export function parseStatLine(line: string): FileEntry | null {
  const first = line.indexOf('|')
  if (first <= 0) return null
  const second = line.indexOf('|', first + 1)
  if (second === -1) return null
  const size = Number(line.slice(0, first))
  const mtime = Number(line.slice(first + 1, second))
  const path = line.slice(second + 1).trim()
  if (!Number.isFinite(size) || !path.startsWith('/')) return null
  return { path, size, mtime: Number.isFinite(mtime) ? mtime : 0 }
}

/**
 * Walks the device once and builds a cached index.
 *
 * Design notes:
 * - Directories and files are two streamed commands, not per-directory listings.
 * - Parsing happens on the chunk boundary, so a 200k-file volume never has to be
 *   held as one giant string.
 * - `du` output (fallback strategy) also contains directories; those are dropped
 *   by checking the known directory set.
 */
export async function scanVolume(options: ScanOptions): Promise<ScanOutcome> {
  const { transport, capabilities, root, signal, onProgress } = options
  const startedAt = Date.now()
  const warnings: string[] = []
  const dirs: string[] = []
  const files: FileEntry[] = []
  let bytes = 0

  // Our own recycle bin is bookkeeping, not user content: counting it would make
  // trashed files show up in analysis, duplicates and media after a cleanup.
  const ownTrash = trashDirFor(root)
  const ownTrashPrefix = `${ownTrash}/`
  const isOwnTrash = (path: string) => path === ownTrash || path.startsWith(ownTrashPrefix)

  const emit = (phase: ScanProgress['phase'], message?: string) => {
    onProgress({
      phase,
      entries: files.length,
      bytes,
      directories: dirs.length,
      elapsedMs: Date.now() - startedAt,
      strategy: buildFileScanCommand(root, capabilities).strategy,
      message
    })
  }

  emit('directories', 'Listing folders')
  const dirResult = await transport.stream(
    buildDirScanCommand(root),
    {
      onLine: (line) => {
        const value = line.trim()
        if (value.startsWith('/') && !isOwnTrash(value)) dirs.push(value)
      }
    },
    { signal, timeoutMs: 600_000 }
  )
  if (dirResult.code !== 0 && dirResult.stderr) {
    warnings.push(`Directory listing finished with code ${dirResult.code}. Some folders may be missing.`)
  }

  const { command, strategy } = buildFileScanCommand(root, capabilities)
  emit('files', 'Reading file metadata')

  let lastEmit = Date.now()
  let unknownDirs = 0
  const dirSet = new Set(dirs)

  await transport.stream(
    command,
    {
      onLine: (line) => {
        if (files.length >= MAX_ENTRIES) return
        if (strategy === 'du-apparent-size') {
          // `du` lines are `<bytes>\t<path>` and include directories.
          const tab = line.indexOf('\t')
          if (tab <= 0) return
          const size = Number(line.slice(0, tab))
          const path = line.slice(tab + 1).trim()
          if (!Number.isFinite(size) || !path.startsWith('/')) return
          if (dirSet.has(path) || isOwnTrash(path)) return
          files.push({ path, size, mtime: 0 })
          bytes += size
        } else {
          const entry = parseStatLine(line)
          if (!entry || isOwnTrash(entry.path)) return
          files.push(entry)
          bytes += entry.size
        }

        const now = Date.now()
        if (now - lastEmit > 180) {
          lastEmit = now
          emit('files', 'Reading file metadata')
        }
      },
      onStderr: (chunk) => {
        if (/permission denied/i.test(chunk)) unknownDirs += 1
      }
    },
    { signal, timeoutMs: 1_800_000 }
  )

  if (signal.aborted) {
    emit('cancelled', 'Scan cancelled')
    throw new Error('Scan cancelled')
  }

  if (files.length >= MAX_ENTRIES) {
    warnings.push(`Stopped after ${MAX_ENTRIES.toLocaleString()} files to protect memory. Large-file and duplicate results cover this subset.`)
  }
  if (files.length === 0) {
    warnings.push('The scan found no files. If the phone is unlocked and USB debugging is allowed, tap Rescan storage; some MIUI builds require the "USB debugging (Security settings)" toggle as well.')
  }
  if (unknownDirs > 0) {
    warnings.push(`${unknownDirs} folder${unknownDirs === 1 ? '' : 's'} could not be read by the device shell user (usually Android/data).`)
  }
  if (strategy === 'du-apparent-size') {
    warnings.push('File modification times are unavailable on this device; age-based rules were skipped.')
  }

  emit('aggregating', 'Building index')
  const index = new StorageIndex(root, files, dirs)
  const summary: ScanSummary = {
    serial: transport.serial,
    root,
    scannedAt: Date.now(),
    durationMs: Date.now() - startedAt,
    fileCount: index.fileCount,
    dirCount: index.dirCount,
    totalBytes: index.totalBytes,
    strategy,
    fromCache: false,
    warnings
  }
  emit('done', 'Scan complete')
  return { index, summary }
}
