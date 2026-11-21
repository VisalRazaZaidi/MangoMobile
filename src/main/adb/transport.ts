import type { DeviceCapabilities } from '@shared/types'

export type ExecResult = {
  stdout: string
  stderr: string
  code: number
  /** Wall-clock duration of the round trip, useful for the performance panel */
  durationMs: number
}

export type StreamHandlers = {
  onLine(line: string): void
  onStderr?(chunk: string): void
}

export type BulkResult = {
  done: string[]
  failed: { path: string; reason: string }[]
}

export type ExecOptions = {
  timeoutMs?: number
  signal?: AbortSignal
  stdin?: string
}

/**
 * A transport runs shell commands on an Android device.
 *
 * Two implementations exist: `AdbTransport` talks to a real phone through the
 * `adb` binary, and `MockTransport` interprets the same commands against an
 * in-memory fixture filesystem. Keeping the command surface identical means the
 * simulator exercises the real command builders and parsers.
 */
export interface DeviceTransport {
  copyFile(remotePath: string, localPath: string): Promise<void>
  readonly serial: string
  readonly simulated: boolean
  exec(command: string, options?: ExecOptions): Promise<ExecResult>
  stream(command: string, handlers: StreamHandlers, options?: ExecOptions): Promise<ExecResult>
  /** Raw properties used for the device banner; cheap, single round trip. */
  getProps(keys: string[]): Promise<Record<string, string>>
  /**
   * Permanent removal, batched into a handful of round trips.
   * Implementations must attribute failures per path rather than per batch.
   */
  deleteFiles(paths: string[], signal?: AbortSignal): Promise<BulkResult>
  /** Move (not copy) files to their new absolute paths, creating parents as needed. */
  moveFiles(pairs: { from: string; to: string }[], signal?: AbortSignal): Promise<BulkResult>
  /** Which of these paths still exist. One round trip per chunk, used for post-operation verification. */
  existingPaths(paths: string[], signal?: AbortSignal): Promise<Set<string>>
  /** Removes directories that are already empty. */
  removeEmptyDirs(paths: string[], signal?: AbortSignal): Promise<BulkResult>
  /** Writes a small text file on the device (used for trash manifests). */
  writeTextFile(remotePath: string, content: string): Promise<void>
  dispose(): void
}

/** POSIX single-quote escaping, safe for `sh -c '...'`. */
export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** Quote a path for use as a shell operand, tolerating spaces and `$`. */
export function shPath(path: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(path)) return path
  return shQuote(path)
}

export function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    ((error as { name?: string }).name === 'AbortError' ||
      (error as { code?: string }).code === 'ABORT_ERR')
  )
}

/** Best-effort numeric parse of the shell's exit status. */
export function exitCodeOf(code: number | null): number {
  return typeof code === 'number' ? code : -1
}

export const EMPTY_CAPABILITIES: DeviceCapabilities = {
  bulkStat: false,
  findExecPlus: false,
  md5sum: false,
  androidDataReadable: false,
  diskStats: false,
  trimCaches: false,
  mediaStore: false,
  recycleBinPaths: []
}
