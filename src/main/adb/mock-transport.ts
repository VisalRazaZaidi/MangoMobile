import type { DeviceCapabilities } from '@shared/types'
import { writeFileSync } from 'node:fs'
import { DEMO_VIDEO, DEMO_AUDIO } from './preview-fixtures'
import { type BulkResult, type DeviceTransport, type ExecOptions, type ExecResult, type StreamHandlers } from './transport'
import { buildVirtualFs, canonicalPath, contentDigest, normalizePath, type VirtualFs, type VNode } from './mock-fs'

const GB = 1024 * 1024 * 1024
const MB = 1024 * 1024

type MockOptions = {
  androidDataReadable?: boolean
  /** Reports itself as a real, connected handset */
  model?: string
  androidVersion?: string
  sdk?: number
}

function ok(stdout: string, code = 0): ExecResult {
  return { stdout, stderr: '', code, durationMs: 1 }
}

/**
 * Executes the production command surface against a virtual Android filesystem.
 *
 * This is not a stub: it implements the same `find`/`stat`/`md5sum`/`df`/`pm`
 * shapes the real scanner emits, so a parsing regression fails here first.
 */
export class MockTransport implements DeviceTransport {
  async copyFile(remotePath: string, localPath: string): Promise<void> {
    const node = this.fs.nodes.get(canonicalPath(remotePath)) ?? this.fs.nodes.get(remotePath)
    if (!node || node.kind !== 'file') throw new Error('File no longer exists')
    if (/\.(jpg|jpeg|png|gif|webp|bmp)$/i.test(remotePath)) {
      writeFileSync(localPath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'))
    } else if (/\.(mp4|webm|mov|m4v|mkv|3gp)$/i.test(remotePath)) {
      writeFileSync(localPath, Buffer.from(DEMO_VIDEO, 'base64'))
    } else if (/\.(mp3|m4a|aac|ogg|opus|wav|flac)$/i.test(remotePath)) {
      writeFileSync(localPath, Buffer.from(DEMO_AUDIO, 'base64'))
    } else writeFileSync(localPath, `Demo file preview\n${remotePath}\nThis is simulated content.`)
  }
  readonly simulated = true
  private readonly fs: VirtualFs
  private readonly options: MockOptions
  private readonly deleted = new Set<string>()

  constructor(
    readonly serial: string,
    options: MockOptions = {}
  ) {
    this.options = options
    this.fs = buildVirtualFs({ androidDataReadable: options.androidDataReadable ?? false })
  }

  dispose(): void {}

  /** Exposed for tests and for the "simulate cleanup" round trip. */
  get filesystem(): VirtualFs {
    return this.fs
  }

  async getProps(keys: string[]): Promise<Record<string, string>> {
    const props: Record<string, string> = {
      'ro.product.manufacturer': 'Samsung',
      'ro.product.model': this.options.model ?? 'SM-S918B',
      'ro.product.name': 'dm3qxxx',
      'ro.build.version.release': this.options.androidVersion ?? '15',
      'ro.build.version.sdk': String(this.options.sdk ?? 35),
      'ro.kernel.qemu': '0',
      'ro.boot.qemu': '0'
    }
    const out: Record<string, string> = {}
    for (const key of keys) out[key] = props[key] ?? ''
    return out
  }

  async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    if (options.signal?.aborted) return { stdout: '', stderr: '', code: 130, durationMs: 0 }
    return this.run(command.trim())
  }

  async stream(command: string, handlers: StreamHandlers, options: ExecOptions = {}): Promise<ExecResult> {
    const result = await this.exec(command, options)
    // Emit in slices so the renderer still sees incremental progress.
    const lines = result.stdout.split('\n')
    for (const line of lines) {
      if (options.signal?.aborted) break
      if (line.length) handlers.onLine(line)
    }
    if (result.stderr) handlers.onStderr?.(result.stderr)
    return { ...result, stdout: '' }
  }

  async deleteFiles(paths: string[]): Promise<BulkResult> {
    const done: string[] = []
    const failed: { path: string; reason: string }[] = []
    for (const path of paths) {
      const node = this.fs.nodes.get(canonicalPath(path))
      if (!node) {
        failed.push({ path, reason: 'No such file or directory' })
        continue
      }
      if (node.kind === 'dir') {
        failed.push({ path, reason: 'Is a directory' })
        continue
      }
      if (node.readable === false) {
        failed.push({ path, reason: 'Permission denied' })
        continue
      }
      this.fs.nodes.delete(node.path)
      this.deleted.add(node.path)
      done.push(path)
    }
    return { done, failed }
  }

  async moveFiles(pairs: { from: string; to: string }[]): Promise<BulkResult> {
    const done: string[] = []
    const failed: { path: string; reason: string }[] = []
    for (const pair of pairs) {
      const source = this.fs.nodes.get(canonicalPath(pair.from))
      if (!source) {
        failed.push({ path: pair.from, reason: 'No such file or directory' })
        continue
      }
      if (source.readable === false) {
        failed.push({ path: pair.from, reason: 'Permission denied' })
        continue
      }
      const dest = canonicalPath(pair.to)
      const parent = dest.slice(0, dest.lastIndexOf('/'))
      this.ensureVirtualDir(parent)
      this.fs.nodes.set(dest, { ...source, path: dest })
      this.fs.nodes.delete(source.path)
      done.push(pair.from)
    }
    return { done, failed }
  }

  async existingPaths(paths: string[]): Promise<Set<string>> {
    const existing = new Set<string>()
    for (const path of paths) {
      const node = this.fs.nodes.get(canonicalPath(path))
      if (node) existing.add(path)
    }
    return existing
  }

  async removeEmptyDirs(paths: string[]): Promise<BulkResult> {
    const done: string[] = []
    const failed: { path: string; reason: string }[] = []
    for (const path of paths) {
      const node = this.fs.nodes.get(canonicalPath(path))
      if (!node) {
        failed.push({ path, reason: 'No such file or directory' })
        continue
      }
      if (node.kind !== 'dir') {
        failed.push({ path, reason: 'Not a directory' })
        continue
      }
      const prefix = `${node.path}/`
      const hasChild = [...this.fs.nodes.keys()].some((key) => key.startsWith(prefix))
      if (hasChild) {
        failed.push({ path, reason: 'Directory not empty' })
        continue
      }
      this.fs.nodes.delete(node.path)
      done.push(path)
    }
    return { done, failed }
  }

  async writeTextFile(remotePath: string, content: string): Promise<void> {
    const dest = canonicalPath(remotePath)
    const parent = dest.slice(0, dest.lastIndexOf('/'))
    this.ensureVirtualDir(parent)
    this.fs.nodes.set(dest, {
      path: dest,
      kind: 'file',
      size: content.length,
      mtime: Math.floor(Date.now() / 1000),
      contentKey: `manifest:${dest}:${content.length}`
    })
  }

  private ensureVirtualDir(path: string): void {
    const parts = path.split('/').filter(Boolean)
    let current = ''
    for (const part of parts) {
      current += `/${part}`
      if (!this.fs.nodes.has(current)) {
        this.fs.nodes.set(current, { path: current, kind: 'dir', size: 4096, mtime: Math.floor(Date.now() / 1000) })
      }
    }
  }

  private node(path: string): VNode | undefined {
    return this.fs.nodes.get(canonicalPath(path))
  }

  private walk(root: string): { dirs: string[]; files: VNode[] } {
    const start = canonicalPath(root)
    const dirs: string[] = []
    const files: VNode[] = []
    const stack = [start]
    let guard = 0
    while (stack.length) {
      const current = stack.pop() as string
      guard += 1
      if (guard > 200_000) break
      const node = this.fs.nodes.get(current)
      if (!node) continue
      if (node.readable === false) continue
      dirs.push(current)
      for (const child of this.fs.nodes.values()) {
        if (child.path.startsWith(`${current}/`) && child.path.indexOf('/', current.length + 1) === -1) {
          if (child.kind === 'dir') stack.push(child.path)
          else files.push(child)
        }
      }
    }
    return { dirs, files }
  }

  /** Direct children only, honouring permission flags. */
  private children(dir: string): VNode[] {
    const base = canonicalPath(dir)
    const out: VNode[] = []
    for (const node of this.fs.nodes.values()) {
      if (!node.path.startsWith(`${base}/`)) continue
      if (node.path.indexOf('/', base.length + 1) !== -1) continue
      if (node.readable === false) continue
      out.push(node)
    }
    return out.sort((a, b) => a.path.localeCompare(b.path))
  }

  private run(rawCommand: string): ExecResult {
    const command = rawCommand.replace(/\s+/g, ' ').trim()

    // Redirections are irrelevant for the simulator.
    const withoutRedirect = command.replace(/\s*2>\s*\/dev\/null/g, '').replace(/\s*>\s*\/dev\/null/g, '')

    if (withoutRedirect.includes(';') && !withoutRedirect.startsWith('find')) {
      const parts = withoutRedirect.split(';').map((part) => part.trim()).filter(Boolean)
      const outputs: string[] = []
      let lastCode = 0
      for (const part of parts) {
        const result = this.run(part)
        outputs.push(result.stdout.replace(/\n$/, ''))
        lastCode = result.code
      }
      return ok(outputs.filter(Boolean).join('\n'), lastCode)
    }

    const [name, ...args] = tokenize(withoutRedirect)
    switch (name) {
      case 'getprop': {
        const props = {
          'ro.product.manufacturer': 'Samsung',
          'ro.product.model': this.options.model ?? 'SM-S918B',
          'ro.product.name': 'dm3qxxx',
          'ro.build.version.release': this.options.androidVersion ?? '15',
          'ro.build.version.sdk': String(this.options.sdk ?? 35),
          'ro.kernel.qemu': '0'
        } as Record<string, string>
        return ok(args.length ? (props[args[0]] ?? '') : Object.entries(props).map(([k, v]) => `[${k}]: [${v}]`).join('\n'))
      }
      case 'id':
        return ok('uid=2000(shell) gid=2000(shell) groups=2000(shell),1078(ext_data_rw),1028(sdcard_rw)')
      case 'df':
        return this.df(args)
      case 'stat':
        return this.stat(args)
      case 'find':
        return this.find(args)
      case 'du':
        return this.du(args)
      case 'ls':
        return this.ls(args)
      case 'md5sum':
        return this.md5(args)
      case 'head':
        return this.head(args)
      case 'dumpsys':
        return this.dumpsys(args)
      case 'pm':
        return this.pm(args)
      case 'command':
        return ok('/system/bin/md5sum')
      case 'echo':
        return ok(args.join(' '))
      default:
        return { stdout: '', stderr: `mock: unsupported command: ${name}`, code: 127, durationMs: 1 }
    }
  }

  private df(args: string[]): ExecResult {
    const { totalBytes, usedBytes } = this.fs.volume
    const totalK = Math.round(totalBytes / 1024)
    const usedK = Math.round(usedBytes / 1024)
    const freeK = totalK - usedK
    const usePercent = Math.round((usedK / totalK) * 100)
    const mount = args[args.length - 1] && args[args.length - 1].startsWith('/') ? this.fs.volume.mount : '/storage/emulated/0'
    const header = 'Filesystem     1K-blocks      Used Available Use% Mounted on'
    const row = `/dev/fuse     ${totalK} ${usedK} ${freeK} ${usePercent}% ${mount}`
    return ok(`${header}\n${row}`)
  }

  private stat(args: string[]): ExecResult {
    let format = '%s|%Y|%n'
    const operands: string[] = []
    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i]
      if (arg === '-c' || arg === '--format') {
        format = args[i + 1] ?? format
        i += 1
        continue
      }
      if (arg.startsWith('--format=')) {
        format = arg.slice('--format='.length)
        continue
      }
      if (arg.startsWith('-')) continue
      operands.push(arg)
    }

    const lines: string[] = []
    const missing: string[] = []
    for (const operand of operands) {
      if (operand.startsWith('/data/app/') || operand.startsWith('/data/')) {
        // Package payloads live outside /sdcard; sizes come from the app fixture.
        const app = this.fs.apps.find((candidate) => operand.includes(candidate.packageName))
        if (app) {
          lines.push(format.replace('%s', String(app.codeBytes)).replace('%Y', String(Math.floor(Date.now() / 1000))).replace('%n', operand).replace('%F', 'regular file'))
        } else {
          missing.push(operand)
        }
        continue
      }
      const node = this.node(operand)
      if (!node) {
        missing.push(operand)
        continue
      }
      if (node.readable === false) {
        missing.push(operand)
        continue
      }
      const rendered = format
        .replace('%s', node.kind === 'dir' ? '4096' : String(node.size))
        .replace('%Y', String(node.mtime))
        .replace('%n', node.path)
        .replace('%F', node.kind === 'dir' ? 'directory' : 'regular file')
      lines.push(rendered)
    }
    const stderr = missing.map((path) => `stat: ${path}: No such file or directory`).join('\n')
    return { stdout: lines.join('\n') + (lines.length ? '\n' : ''), stderr, code: missing.length ? 1 : 0, durationMs: 1 }
  }

  private find(args: string[]): ExecResult {
    // `find -H /sdcard ...` follows a symlinked root; other link modes do not
    // change the simulator's view of the fixture.
    while (args.length && /^-[HLP]$/.test(args[0])) args.shift()
    const root = args.shift() ?? '/sdcard'
    let type: 'f' | 'd' | 'l' | null = null
    let maxDepth = Number.POSITIVE_INFINITY
    let execFormat: string | null = null

    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i]
      if (arg === '-type') {
        type = (args[i + 1] as 'f' | 'd' | 'l') ?? null
        i += 1
      } else if (arg === '-maxdepth') {
        maxDepth = Number(args[i + 1] ?? '999')
        i += 1
      } else if (arg === '-exec') {
        const collector: string[] = []
        i += 1
        while (i < args.length && args[i] !== ';' && args[i] !== '+') {
          collector.push(args[i])
          i += 1
        }
        const formatIndex = collector.findIndex((token) => token === '-c')
        if (formatIndex >= 0) execFormat = collector[formatIndex + 1] ?? null
      }
    }

    // `find ... -print0 | xargs -0 stat -c FMT` is the real scanner's pipeline;
    // the simulator ignores pipes everywhere else, so mirror the stat output here.
    const statIndex = args.indexOf('stat')
    if (statIndex >= 0) {
      const formatIndex = args.indexOf('-c', statIndex)
      if (formatIndex >= 0) execFormat = args[formatIndex + 1] ?? execFormat
    }

    const { dirs, files } = this.walk(root)
    const base = canonicalPath(root)
    const depthOf = (path: string) => path.split('/').filter(Boolean).length - base.split('/').filter(Boolean).length

    const selected: VNode[] = []
    if (type === 'd') {
      for (const dir of dirs) {
        if (depthOf(dir) > maxDepth) continue
        if (dir === base && maxDepth !== Number.POSITIVE_INFINITY && maxDepth < 1) continue
        selected.push({ path: dir, kind: 'dir', size: 4096, mtime: this.fs.nodes.get(dir)?.mtime ?? 0 })
      }
    } else {
      for (const file of files) {
        if (depthOf(file.path) > maxDepth) continue
        selected.push(file)
      }
    }

    if (execFormat) {
      const lines = selected.map((node) =>
        execFormat
          .replace('%s', String(node.kind === 'dir' ? 4096 : node.size))
          .replace('%Y', String(node.mtime))
          .replace('%n', node.path)
          .replace('%F', node.kind === 'dir' ? 'directory' : 'regular file')
      )
      return ok(lines.join('\n') + (lines.length ? '\n' : ''))
    }
    return ok(selected.map((node) => node.path).join('\n') + (selected.length ? '\n' : ''))
  }

  /**
   * `du -a -b -H <root>`: apparent size and path for every file and folder,
   * deepest first. Emitted for the scanner's last-resort strategy, so the
   * fallback is exercised by the same fixtures as the stat strategies.
   */
  private du(args: string[]): ExecResult {
    while (args.length && /^-[HLP]$/.test(args[0])) args.shift()
    let all = false
    let maximumDepth = Number.POSITIVE_INFINITY
    const operands: string[] = []
    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i]
      if (arg === '--apparent-size' || arg === '-b') continue
      if (arg === '-a' || arg === '--all') {
        all = true
        continue
      }
      if (arg === '-d' || arg === '--max-depth') {
        maximumDepth = Number(args[i + 1] ?? '0')
        i += 1
        continue
      }
      if (arg.startsWith('--max-depth=')) {
        maximumDepth = Number(arg.slice('--max-depth='.length))
        continue
      }
      if (arg.startsWith('-')) continue
      operands.push(arg)
    }

    const roots = operands.length ? operands : ['/sdcard']
    const lines: string[] = []
    for (const root of roots) {
      const node = this.node(root)
      if (!node) {
        return { stdout: '', stderr: `du: ${root}: No such file or directory`, code: 1, durationMs: 1 }
      }
      const { dirs, files } = this.walk(root)
      const totals = new Map<string, number>()
      for (const file of files) {
        let parent = file.path
        while (parent.length > 1) {
          parent = parent.slice(0, parent.lastIndexOf('/')) || '/'
          totals.set(parent, (totals.get(parent) ?? 0) + file.size)
        }
      }
      const base = canonicalPath(root)
      const baseDepth = base.split('/').filter(Boolean).length
      const depthOf = (path: string) => path.split('/').filter(Boolean).length - baseDepth
      const ordered = [...dirs].sort((a, b) => b.split('/').length - a.split('/').length || a.localeCompare(b))
      for (const dir of ordered) {
        if (depthOf(dir) > maximumDepth) continue
        if (!all && dir !== base) continue
        lines.push(`${4096 + (totals.get(dir) ?? 0)}\t${dir}`)
      }
      if (all || maximumDepth >= 1) {
        for (const file of files) {
          if (depthOf(file.path) > maximumDepth) continue
          lines.push(`${file.size}\t${file.path}`)
        }
      }
    }
    return ok(lines.join('\n') + (lines.length ? '\n' : ''))
  }

  private ls(args: string[]): ExecResult {
    const operands = args.filter((arg) => !arg.startsWith('-'))
    const target = operands[0] ?? '/sdcard'
    const node = this.node(target)
    if (!node) {
      return { stdout: '', stderr: `ls: ${target}: No such file or directory`, code: 1, durationMs: 1 }
    }
    if (node.readable === false) {
      return { stdout: '', stderr: `ls: ${target}: Permission denied`, code: 1, durationMs: 1 }
    }
    if (node.kind === 'file') return ok(node.path)
    return ok(this.children(target).map((child) => child.path.split('/').pop()).join('\n'))
  }

  private md5(args: string[]): ExecResult {
    const paths = args.filter((arg) => !arg.startsWith('-'))
    const lines: string[] = []
    const errors: string[] = []
    for (const path of paths) {
      if (path === '-') continue
      const node = this.node(path)
      if (!node || node.kind !== 'file') {
        errors.push(`md5sum: ${path}: No such file or directory`)
        continue
      }
      if (node.readable === false) {
        errors.push(`md5sum: ${path}: Permission denied`)
        continue
      }
      lines.push(`${contentDigest(node.contentKey ?? node.path)}  ${node.path}`)
    }
    return { stdout: lines.join('\n') + (lines.length ? '\n' : ''), stderr: errors.join('\n'), code: errors.length ? 1 : 0, durationMs: 1 }
  }

  private head(args: string[]): ExecResult {
    const operands = args.filter((arg) => !arg.startsWith('-') && !/^\d+$/.test(arg))
    const node = this.node(operands[0] ?? '')
    if (!node) return { stdout: '', stderr: 'head: No such file', code: 1, durationMs: 1 }
    return ok(`${contentDigest(node.contentKey ?? node.path, true)}\n`)
  }

  private dumpsys(args: string[]): ExecResult {
    const service = args[0]
    if (service !== 'diskstats') {
      return { stdout: '', stderr: `mock: unsupported dumpsys service ${service}`, code: 0, durationMs: 1 }
    }
    const { totalBytes, usedBytes } = this.fs.volume
    const appBytes = this.fs.apps.reduce((sum, app) => sum + app.codeBytes + app.dataBytes, 0)
    const cacheBytes = this.fs.apps.reduce((sum, app) => sum + app.cacheBytes, 0)
    const toK = (value: number) => `${Math.round(value / 1024)}K`
    return ok(
      [
        'Latency: 0ms [512B Data Write]',
        `Data-Free: ${toK(totalBytes - usedBytes)} / ${toK(totalBytes)} total = ${Math.round(((totalBytes - usedBytes) / totalBytes) * 100)}% free`,
        `Cache-Free: ${toK(cacheBytes)}`,
        `System-Free: ${toK(6 * GB)}`,
        `App Size: ${toK(appBytes)}`,
        `App Data: ${toK(this.fs.apps.reduce((sum, app) => sum + app.dataBytes, 0))}`,
        `Cache Size: ${toK(cacheBytes)}`
      ].join('\n')
    )
  }

  private pm(args: string[]): ExecResult {
    const sub = args[0]
    if (sub === 'list') {
      const withPath = args.includes('-f')
      const thirdParty = args.includes('-3')
      const systemOnly = args.includes('-s')
      const apps = this.fs.apps.filter((app) => (thirdParty ? !app.system : true) && (systemOnly ? app.system : true))
      const lines = apps.map((app, index) => {
        if (!withPath) return `package:${app.packageName}`
        const hash = Buffer.from(app.packageName).toString('base64url').slice(0, 12)
        return `package:/data/app/~~${hash}==/${app.packageName}-${index}/base.apk=${app.packageName}`
      })
      return ok(lines.join('\n') + (lines.length ? '\n' : ''))
    }
    if (sub === 'trim-caches') {
      const before = this.fs.volume.usedBytes
      this.fs.volume.usedBytes = Math.max(0, before - 512 * MB)
      return ok('Success')
    }
    if (sub === 'uninstall') {
      const pkg = args[args.length - 1]
      const index = this.fs.apps.findIndex((app) => app.packageName === pkg)
      if (index === -1) return { stdout: '', stderr: 'Failure [not installed]', code: 1, durationMs: 1 }
      this.fs.apps.splice(index, 1)
      return ok('Success')
    }
    return { stdout: '', stderr: 'mock: unsupported pm subcommand', code: 1, durationMs: 1 }
  }

  capabilities(): DeviceCapabilities {
    return {
      bulkStat: true,
      findExecPlus: true,
      md5sum: true,
      androidDataReadable: this.options.androidDataReadable ?? false,
      diskStats: true,
      trimCaches: true,
      mediaStore: false,
      recycleBinPaths: ['/sdcard/.Trash']
    }
  }
}

/**
 * Minimal POSIX-ish tokenizer: handles single quotes, double quotes and
 * backslash escapes. Filenames with spaces are the common case in practice.
 */
export function tokenize(input: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let hasToken = false
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i]
    if (quote) {
      if (char === quote) quote = null
      else if (char === '\\' && quote === '"' && i + 1 < input.length) {
        current += input[++i]
      } else current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      hasToken = true
      continue
    }
    if (char === '\\' && i + 1 < input.length) {
      current += input[++i]
      hasToken = true
      continue
    }
    if (/\s/.test(char)) {
      if (hasToken || current) {
        tokens.push(current)
        current = ''
        hasToken = false
      }
      continue
    }
    current += char
    hasToken = true
  }
  if (hasToken || current) tokens.push(current)
  return tokens
}

export { normalizePath }
