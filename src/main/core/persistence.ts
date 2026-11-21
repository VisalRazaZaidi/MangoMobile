import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import type { HistoryEntry, Settings } from '@shared/types'
import { StorageIndex } from './storage-index'

export const DEFAULT_SETTINGS: Settings = {
  adbPath: '',
  useMockDevice: false,
  moveToTrash: true,
  trashRetentionDays: 7,
  scanRoot: '/sdcard',
  theme: 'system',
  largeFileMinBytes: 50 * 1024 * 1024,
  duplicateMinBytes: 4096,
  skipAppData: false
}

/** Atomic JSON write: never leave a half-written settings file behind. */
function writeJsonAtomic(path: string, value: unknown): void {
  const temp = `${path}.tmp`
  writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8')
  renameSync(temp, path)
}

export class SettingsStore {
  private current: Settings
  constructor(private readonly filePath: string) {
    this.current = { ...DEFAULT_SETTINGS }
    try {
      if (existsSync(filePath)) {
        const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<Settings>
        this.current = { ...DEFAULT_SETTINGS, ...parsed }
      }
    } catch {
      this.current = { ...DEFAULT_SETTINGS }
    }
  }

  get(): Settings {
    return { ...this.current }
  }

  set(patch: Partial<Settings>): Settings {
    this.current = { ...this.current, ...patch }
    writeJsonAtomic(this.filePath, this.current)
    return this.get()
  }
}

/**
 * Operation history, stored as newline-delimited JSON for crash safety: a partial
 * final line is discarded instead of corrupting the whole log.
 */
export class HistoryStore {
  private entries: HistoryEntry[] = []

  constructor(private readonly filePath: string) {
    this.load()
  }

  private load(): void {
    if (!existsSync(this.filePath)) return
    try {
      const text = readFileSync(this.filePath, 'utf8')
      const parsed: HistoryEntry[] = []
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue
        try {
          parsed.push(JSON.parse(line) as HistoryEntry)
        } catch {
          // Skip a truncated line (crash during write) and keep the rest.
        }
      }
      this.entries = parsed
    } catch {
      this.entries = []
    }
  }

  list(): HistoryEntry[] {
    return [...this.entries].sort((a, b) => b.at - a.at)
  }

  append(entry: HistoryEntry): void {
    this.entries.push(entry)
    try {
      const stream = createWriteStream(this.filePath, { flags: 'a' })
      stream.write(`${JSON.stringify(entry)}\n`)
      stream.end()
    } catch {
      // History is diagnostic; a write failure must not break the operation.
    }
  }

  clear(): void {
    this.entries = []
    writeFileSync(this.filePath, '', 'utf8')
  }

  /** Cleanup entries that still own files inside the recycle bin. */
  trashOperations(): HistoryEntry[] {
    return this.entries
      .filter((entry) => entry.kind === 'cleanup' && entry.trashDir && entry.trashEntries?.length)
      .sort((a, b) => b.at - a.at)
  }

  updateTrash(opId: string, remaining: { original: string; stored: string; size: number }[]): void {
    const entry = this.entries.find((candidate) => candidate.id === opId)
    if (!entry) return
    entry.trashEntries = remaining
    writeFileSync(this.filePath, this.entries.map((value) => JSON.stringify(value)).join('\n') + '\n', 'utf8')
  }

  removeTrashOperation(opId: string): void {
    this.updateTrash(opId, [])
  }
}

/** Scan cache: one gzipped file per device, so reopening the app is instant. */
export class IndexCache {
  constructor(private readonly dir: string) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  }

  private pathFor(serial: string): string {
    return join(this.dir, `${serial.replace(/[^a-zA-Z0-9._-]/g, '_')}.index.json.gz`)
  }

  save(serial: string, index: StorageIndex, summary: { scannedAt: number; durationMs: number; strategy: string }): void {
    const payload = {
      version: 1,
      scannedAt: summary.scannedAt,
      durationMs: summary.durationMs,
      strategy: summary.strategy,
      index: index.toJSON()
    }
    writeFileSync(this.pathFor(serial), gzipSync(Buffer.from(JSON.stringify(payload))))
  }

  load(serial: string): { index: StorageIndex; meta: { scannedAt: number; durationMs: number; strategy: string } } | null {
    const path = this.pathFor(serial)
    if (!existsSync(path)) return null
    try {
      const payload = JSON.parse(gunzipSync(readFileSync(path)).toString('utf8'))
      if (payload.version !== 1) return null
      return {
        index: StorageIndex.fromJSON(payload.index),
        meta: { scannedAt: payload.scannedAt, durationMs: payload.durationMs, strategy: payload.strategy }
      }
    } catch {
      return null
    }
  }

  ageMs(serial: string): number | null {
    const path = this.pathFor(serial)
    if (!existsSync(path)) return null
    return Date.now() - statSync(path).mtimeMs
  }
}
