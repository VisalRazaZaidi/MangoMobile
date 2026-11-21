import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import type { AdbStatus, DeviceCandidate } from '@shared/types'
import { type BulkResult, type DeviceTransport, type ExecOptions, type ExecResult, type StreamHandlers, exitCodeOf, shPath } from './transport'

/**
 * Locate the `adb` executable. Order: explicit setting, ADB_PATH env,
 * ANDROID_HOME/SDK_ROOT platform-tools, PATH, then well-known install dirs.
 */
export function locateAdb(explicitPath?: string): AdbStatus {
  const candidates: string[] = []
  const exe = process.platform === 'win32' ? 'adb.exe' : 'adb'
  if (explicitPath) candidates.push(explicitPath)

  for (const envKey of ['ADB_PATH', 'ANDROID_SDK_ROOT', 'ANDROID_HOME']) {
    const value = process.env[envKey]
    if (!value) continue
    candidates.push(existsSync(value) && value.toLowerCase().endsWith(exe) ? value : join(value, 'platform-tools', exe))
    candidates.push(join(value, exe))
  }

  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir) candidates.push(join(dir, exe))
  }

  if (process.platform === 'win32') {
    candidates.push('C:\\platform-tools\\adb.exe')
    candidates.push(join(process.env.LOCALAPPDATA ?? '', 'Android', 'Sdk', 'platform-tools', exe))
  } else {
    candidates.push('/usr/local/bin/adb', '/usr/bin/adb', join(process.env.HOME ?? '', 'Library/Android/sdk/platform-tools/adb'))
  }

  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      return { adbPath: candidate, adbFound: true, serverRunning: true }
    }
  }
  return {
    adbPath: explicitPath || 'adb',
    adbFound: false,
    serverRunning: false,
    error: 'adb was not found. Install Android Platform Tools or set the adb path in Settings.'
  }
}

function spawnAdb(adbPath: string, args: string[], options: ExecOptions = {}) {
  const child = spawn(adbPath, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  if (options.stdin !== undefined) child.stdin?.end(options.stdin)
  else child.stdin?.end()

  const timeoutMs = options.timeoutMs ?? 60_000
  const timer = setTimeout(() => {
    child.kill()
  }, timeoutMs)

  const onAbort = () => child.kill()
  options.signal?.addEventListener('abort', onAbort, { once: true })

  const cleanup = () => {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onAbort)
  }
  return { child, cleanup }
}

/** Runs `adb ...` and buffers the output. Use for short, bounded commands. */
export async function adbExec(
  adbPath: string,
  args: string[],
  options: ExecOptions = {}
): Promise<ExecResult> {
  const startedAt = Date.now()
  const { child, cleanup } = spawnAdb(adbPath, args, options)
  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8')
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8')
  })

  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.on('error', reject)
      child.on('close', resolve)
    })
    return { stdout, stderr, code: exitCodeOf(code), durationMs: Date.now() - startedAt }
  } finally {
    cleanup()
  }
}

export class AdbTransport implements DeviceTransport {
  async copyFile(remotePath: string, localPath: string): Promise<void> {
    const result = await adbExec(this.adbPath, ['-s', this.serial, 'pull', remotePath, localPath], { timeoutMs: 180_000 })
    if (result.code !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || 'Could not read file from phone')
  }
  readonly simulated = false
  constructor(
    readonly serial: string,
    private readonly adbPath: string
  ) {}

  dispose(): void {
    // Per-command processes are short lived; nothing to release.
  }

  async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    return adbExec(this.adbPath, ['-s', this.serial, 'shell', command], options)
  }

  /**
   * Streams a device-shell command line by line. Used for the storage walk so the
   * UI can show progress while a multi-second scan is still in flight.
   */
  async stream(command: string, handlers: StreamHandlers, options: ExecOptions = {}): Promise<ExecResult> {
    const startedAt = Date.now()
    const { child, cleanup } = spawnAdb(this.adbPath, ['-s', this.serial, 'shell', command], options)
    let stderr = ''
    let pending = ''
    let truncated = false

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      if (truncated) return
      pending += chunk
      let index = pending.indexOf('\n')
      while (index !== -1) {
        const line = pending.slice(0, index)
        pending = pending.slice(index + 1)
        try {
          handlers.onLine(line)
        } catch {
          // A malformed line must never abort an otherwise healthy scan.
        }
        index = pending.indexOf('\n')
      }
      // Guard against a pathological single line (binary noise in a filename).
      if (pending.length > 1_000_000) {
        pending = ''
        truncated = true
      }
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      stderr += text
      if (stderr.length > 200_000) stderr = stderr.slice(-100_000)
      handlers.onStderr?.(text)
    })

    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        child.on('error', reject)
        child.on('close', resolve)
      })
      if (pending) {
        try {
          handlers.onLine(pending)
        } catch {
          /* ignore */
        }
      }
      return { stdout: '', stderr, code: exitCodeOf(code), durationMs: Date.now() - startedAt }
    } finally {
      cleanup()
    }
  }

  async getProps(keys: string[]): Promise<Record<string, string>> {
    const result = await this.exec(
      keys.map((key) => `getprop ${key}`).join('; '),
      { timeoutMs: 20_000 }
    )
    const values = result.stdout.split(/\r?\n/).map((line) => line.trim())
    const out: Record<string, string> = {}
    keys.forEach((key, index) => {
      out[key] = values[index] ?? ''
    })
    return out
  }

  /**
   * Deletes in batches. Paths are quoted individually so spaces, quotes and
   * leading dashes in filenames cannot change the meaning of the command.
   * Failures are re-checked individually so the report names the real culprits.
   */
  async deleteFiles(paths: string[], signal?: AbortSignal): Promise<BulkResult> {
    const done: string[] = []
    const failed: { path: string; reason: string }[] = []
    for (const batch of chunk(paths, 150)) {
      if (signal?.aborted) {
        for (const path of batch) failed.push({ path, reason: 'Cancelled' })
        continue
      }
      const command = `rm -f -- ${batch.map(shPath).join(' ')} 2>&1`
      const result = await this.exec(command, { signal, timeoutMs: 120_000 })
      if (result.code === 0) {
        done.push(...batch)
        continue
      }
      // Attribute the failure precisely instead of blaming the whole batch.
      const survivors = await this.existingPaths(batch, signal)
      const reason = result.stderr.trim() || result.stdout.trim() || 'Deletion failed'
      for (const path of batch) {
        if (survivors.has(path)) failed.push({ path, reason })
        else done.push(path)
      }
    }
    return { done, failed }
  }

  async moveFiles(pairs: { from: string; to: string }[], signal?: AbortSignal): Promise<BulkResult> {
    const done: string[] = []
    const failed: { path: string; reason: string }[] = []
    const parents = new Set(pairs.map((pair) => pair.to.slice(0, pair.to.lastIndexOf('/'))))
    if (parents.size) {
      await this.exec(`mkdir -p -- ${[...parents].map(shPath).join(' ')} 2>&1`, { signal, timeoutMs: 60_000 })
    }
    for (const batch of chunk(pairs, 80)) {
      if (signal?.aborted) {
        for (const pair of batch) failed.push({ path: pair.from, reason: 'Cancelled' })
        continue
      }
      const lines = batch.map((pair) => `mv -- ${shPath(pair.from)} ${shPath(pair.to)} 2>/dev/null`).join('; ')
      await this.exec(lines, { signal, timeoutMs: 180_000 })
      const survivors = await this.existingPaths(
        batch.map((pair) => pair.from),
        signal
      )
      for (const pair of batch) {
        if (survivors.has(pair.from)) failed.push({ path: pair.from, reason: 'Move failed or source still present' })
        else done.push(pair.from)
      }
    }
    return { done, failed }
  }

  async existingPaths(paths: string[], signal?: AbortSignal): Promise<Set<string>> {
    const existing = new Set<string>()
    for (const batch of chunk(paths, 200)) {
      const command = `stat -c '%n' ${batch.map(shPath).join(' ')} 2>/dev/null`
      const result = await this.exec(command, { signal, timeoutMs: 60_000 })
      for (const line of result.stdout.split(/\r?\n/)) {
        const value = line.trim()
        if (value) existing.add(value)
      }
    }
    return existing
  }
  async removeEmptyDirs(paths: string[], signal?: AbortSignal): Promise<BulkResult> {
    const done: string[] = []
    const failed: { path: string; reason: string }[] = []
    for (const batch of chunk(paths, 150)) {
      if (signal?.aborted) {
        for (const path of batch) failed.push({ path, reason: 'Cancelled' })
        continue
      }
      const result = await this.exec(`rmdir -- ${batch.map(shPath).join(' ')} 2>&1`, { signal, timeoutMs: 90_000 })
      if (result.code === 0) {
        done.push(...batch)
        continue
      }
      const survivors = await this.existingPaths(batch, signal)
      const reason = result.stderr.trim() || 'Folder is not empty'
      for (const path of batch) {
        if (survivors.has(path)) failed.push({ path, reason })
        else done.push(path)
      }
    }
    return { done, failed }
  }

  async writeTextFile(remotePath: string, content: string): Promise<void> {
    // `adb shell` forwards stdin to the device shell, so this needs no temp file on the host.
    const result = await this.exec(`cat > ${shPath(remotePath)}`, { stdin: content, timeoutMs: 30_000 })
    if (result.code !== 0) throw new Error(result.stderr.trim() || 'Could not write file on device')
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let index = 0; index < items.length; index += size) {
    out.push(items.slice(index, index + size))
  }
  return out
}

/** Parses `adb devices -l` into structured candidates. */
export function parseDevices(output: string): DeviceCandidate[] {
  const devices: DeviceCandidate[] = []
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('List of devices') || line.startsWith('*')) continue
    const [serial, state, ...rest] = line.split(/\s+/)
    if (!serial || !state) continue
    const fields: Record<string, string> = {}
    for (const token of rest) {
      const index = token.indexOf(':')
      if (index > 0) fields[token.slice(0, index)] = token.slice(index + 1)
    }
    devices.push({
      serial,
      state,
      model: fields.model?.replace(/_/g, ' '),
      product: fields.product,
      transportId: fields.transport_id
    })
  }
  return devices
}

export async function listDevices(adbPath: string): Promise<DeviceCandidate[]> {
  const result = await adbExec(adbPath, ['devices', '-l'], { timeoutMs: 20_000 })
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || 'adb devices failed')
  }
  return parseDevices(result.stdout)
}

export async function adbVersion(adbPath: string): Promise<string | undefined> {
  try {
    const result = await adbExec(adbPath, ['version'], { timeoutMs: 15_000 })
    const match = /version\s+([0-9.]+)/i.exec(result.stdout)
    return match?.[1]
  } catch {
    return undefined
  }
}
