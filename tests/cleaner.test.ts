import test from 'node:test'
import assert from 'node:assert/strict'
import { MockTransport } from '../src/main/adb/mock-transport'
import { executeCleanup, purgeTrash, restoreFromTrash } from '../src/main/core/cleaner'
import type { VNode } from '../src/main/adb/mock-fs'

const root = '/sdcard'

function filesUnder(transport: MockTransport, prefix: string): VNode[] {
  return [...transport.filesystem.nodes.values()]
    .filter((node) => node.kind === 'file' && node.path.startsWith(prefix))
    .sort((a, b) => a.path.localeCompare(b.path))
}

test('moving to the recycle bin is reversible and records a manifest', async () => {
  const transport = new MockTransport('test-device')
  const [target] = filesUnder(transport, '/sdcard/Download/')
  assert.ok(target, 'fixture should contain a download')

  const result = await executeCleanup(transport, root, {
    files: [{ path: target.path, size: target.size, mtime: target.mtime }],
    dirs: [],
    moveToTrash: true,
    trashDir: '/sdcard/.MangoMobileTrash',
    opId: 'op-test',
    ruleIds: ['test']
  })

  assert.equal(result.failedCount, 0)
  assert.equal(result.deletedCount, 1)
  assert.equal(result.freedBytes, target.size)
  assert.equal(result.verified, true)
  assert.equal(result.trashEntries?.length, 1)
  assert.equal(result.trashEntries?.[0].original, target.path)

  const survivors = await transport.existingPaths([target.path])
  assert.equal(survivors.has(target.path), false)

  const stored = result.trashEntries![0].stored
  assert.match(stored, /^\/sdcard\/\.MangoMobileTrash\/op-test\//)
  assert.equal((await transport.existingPaths([stored])).has(stored), true)

  const manifest = [...transport.filesystem.nodes.values()].find((node) => node.path.endsWith('/manifest.tsv'))
  assert.ok(manifest, 'the device-side manifest should exist')

  const restored = await restoreFromTrash(transport, [{ original: target.path, stored }])
  assert.equal(restored.deletedCount, 1)
  assert.equal((await transport.existingPaths([target.path])).has(target.path), true)
})

test('duplicate paths in a plan are only removed once', async () => {
  const transport = new MockTransport('test-device')
  const target = filesUnder(transport, '/sdcard/DCIM/')[0]
  assert.ok(target)
  const entry = { path: target.path, size: target.size, mtime: target.mtime }

  const result = await executeCleanup(transport, root, {
    files: [entry, { ...entry }, entry],
    dirs: [],
    moveToTrash: true,
    trashDir: '/sdcard/.MangoMobileTrash',
    opId: 'op-duplicate',
    ruleIds: ['overlapping']
  })

  assert.equal(result.deletedCount, 1)
  assert.equal(result.failedCount, 0)
  assert.equal(result.trashEntries?.length, 1)
  assert.equal(result.freedBytes, target.size)
})

test('permanent deletion removes files and verifies they are gone', async () => {
  const transport = new MockTransport('test-device')
  const target = filesUnder(transport, '/sdcard/DCIM/')[0]
  assert.ok(target)

  const result = await executeCleanup(transport, root, {
    files: [{ path: target.path, size: target.size, mtime: target.mtime }],
    dirs: [],
    moveToTrash: false,
    trashDir: '/sdcard/.MangoMobileTrash',
    opId: 'op-delete',
    ruleIds: ['test']
  })

  assert.equal(result.deletedCount, 1)
  assert.equal(result.failedCount, 0)
  assert.equal(result.trashDir, undefined)
  assert.equal((await transport.existingPaths([target.path])).has(target.path), false)
})

test('safety wins over a rule that targets a user folder', async () => {
  const transport = new MockTransport('test-device')
  const result = await executeCleanup(transport, root, {
    files: [{ path: '/sdcard/Movies', size: 0, mtime: 0, isDirectory: true }],
    dirs: ['/sdcard/DCIM/Camera', '/sdcard/Music'],
    moveToTrash: false,
    trashDir: '/sdcard/.MangoMobileTrash',
    opId: 'op-protected',
    ruleIds: ['malicious']
  })

  assert.equal(result.deletedCount, 0)
  assert.ok(result.failedCount >= 2)
  assert.ok(result.failures.some((failure) => /user data folder|not a file/i.test(failure.reason)))
  assert.equal((await transport.existingPaths(['/sdcard/DCIM/Camera'])).has('/sdcard/DCIM/Camera'), true)
})

test('purging the recycle bin removes only its contents', async () => {
  const transport = new MockTransport('test-device')
  const [target] = filesUnder(transport, '/sdcard/Pictures/')
  assert.ok(target)

  const moved = await executeCleanup(transport, root, {
    files: [{ path: target.path, size: target.size, mtime: target.mtime }],
    dirs: [],
    moveToTrash: true,
    trashDir: '/sdcard/.MangoMobileTrash',
    opId: 'op-purge',
    ruleIds: ['test']
  })
  const stored = moved.trashEntries![0].stored

  const purged = await purgeTrash(transport, [stored])
  assert.equal(purged.deletedCount, 1)
  assert.equal((await transport.existingPaths([stored])).has(stored), false)
})
