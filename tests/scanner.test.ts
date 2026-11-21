import test from 'node:test'
import assert from 'node:assert/strict'
import { parseStatLine, buildDirScanCommand, buildFileScanCommand, scanVolume } from '../src/main/core/scanner'
import { MockTransport } from '../src/main/adb/mock-transport'
import type { DeviceCapabilities } from '../src/shared/types'

const capabilities: DeviceCapabilities = {
  bulkStat: true,
  findExecPlus: true,
  md5sum: true,
  androidDataReadable: false,
  diskStats: true,
  trimCaches: true,
  mediaStore: true,
  recycleBinPaths: []
}

test('parseStatLine reads size, mtime and path', () => {
  assert.deepEqual(parseStatLine('1234|1712345678|/sdcard/Download/app.apk'), {
    path: '/sdcard/Download/app.apk',
    size: 1234,
    mtime: 1712345678
  })
})

test('parseStatLine keeps spaces and pipes inside the path', () => {
  const entry = parseStatLine('42|0|/sdcard/My Files/a|b.txt')
  assert.equal(entry?.path, '/sdcard/My Files/a|b.txt')
  assert.equal(entry?.size, 42)
  assert.equal(entry?.mtime, 0)
})

test('parseStatLine rejects lines that cannot be trusted', () => {
  assert.equal(parseStatLine(''), null)
  assert.equal(parseStatLine('not-a-stat-line'), null)
  assert.equal(parseStatLine('123|456'), null)
  assert.equal(parseStatLine('abc|456|/sdcard/a'), null)
  assert.equal(parseStatLine('123|456|relative/path'), null)
})

test('scan strategy prefers the single bulk-stat command', () => {
  const command = buildFileScanCommand('/sdcard', capabilities)
  assert.equal(command.strategy, 'bulk-stat')
  assert.match(command.command, /find -H \/sdcard -type f -print0/)
  assert.match(command.command, /xargs -0 -r -n 500 stat -c '%s\|%Y\|%n'/)
  // `-exec ... {} +` overflows ARG_MAX on real volumes and drops whole batches.
  assert.doesNotMatch(command.command, /-exec/)
  // -xdev would prune /sdcard/Android/data, a separate FUSE mount.
  assert.doesNotMatch(command.command, /-xdev/)
})

test('every scan command follows a symlinked volume root', () => {
  // `/sdcard` is a symlink on MIUI (and many other ROMs). Without -H, find and
  // du describe the link itself and the index ends up with a single 21-byte file.
  const commands = [
    buildFileScanCommand('/sdcard', capabilities).command,
    buildFileScanCommand('/sdcard', { ...capabilities, findExecPlus: false }).command,
    buildFileScanCommand('/sdcard', { ...capabilities, bulkStat: false, findExecPlus: false }).command,
    buildDirScanCommand('/sdcard')
  ]
  for (const command of commands) assert.match(command, /-H/)
  assert.match(buildDirScanCommand('/sdcard'), /^find -H \/sdcard -type d/)
})

test('scan falls back to du when stat is unavailable', () => {
  const command = buildFileScanCommand('/sdcard', { ...capabilities, bulkStat: false, findExecPlus: false })
  assert.equal(command.strategy, 'du-apparent-size')
  assert.match(command.command, /^du -a -b -H \/sdcard/)
})

test('the du fallback indexes the whole fixture volume', async () => {
  const transport = new MockTransport('du-fallback')
  const outcome = await scanVolume({
    transport,
    capabilities: { ...capabilities, bulkStat: false, findExecPlus: false },
    root: '/sdcard',
    signal: new AbortController().signal,
    onProgress: () => {}
  })

  assert.equal(outcome.summary.strategy, 'du-apparent-size')
  assert.ok(outcome.index.fileCount > 1000, `expected a full index, got ${outcome.index.fileCount}`)
  assert.ok(outcome.index.dirCount > 10)
  assert.ok(outcome.index.totalBytes > 0)
  // Directories also appear in du output; they must not be counted as files.
  assert.ok(outcome.index.dirs.has('/sdcard/DCIM'))
  assert.equal(outcome.index.get('/sdcard/DCIM'), undefined)
  assert.ok(outcome.index.files.every((entry) => !entry.isDirectory))
  assert.ok(outcome.summary.warnings.some((warning) => /modification times/i.test(warning)))
})
