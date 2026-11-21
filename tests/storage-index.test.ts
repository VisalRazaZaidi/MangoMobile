import test from 'node:test'
import assert from 'node:assert/strict'
import { StorageIndex } from '../src/main/core/storage-index'

function fixture(): StorageIndex {
  return new StorageIndex(
    '/sdcard',
    [
      { path: '/sdcard/DCIM/a.jpg', size: 1000, mtime: 100 },
      { path: '/sdcard/DCIM/b.jpg', size: 500, mtime: 200 },
      { path: '/sdcard/Download/c.zip', size: 2000, mtime: 300 }
    ],
    ['/sdcard', '/sdcard/DCIM', '/sdcard/Download', '/sdcard/Empty']
  )
}

test('aggregates directory sizes during construction', () => {
  const index = fixture()
  assert.equal(index.totalBytes, 3500)
  assert.equal(index.fileCount, 3)
  assert.equal(index.bytesIn('/sdcard/DCIM'), 1500)
  assert.equal(index.countIn('/sdcard/DCIM'), 2)
  assert.equal(index.bytesIn('/sdcard/Empty'), 0)
})

test('tree lists children largest first and keeps totals consistent', () => {
  const index = fixture()
  const tree = index.tree('/sdcard')
  assert.equal(tree.path, '/sdcard')
  assert.equal(tree.totalBytes, 3500)
  assert.deepEqual(
    tree.children.map((child) => child.name),
    ['Download', 'DCIM']
  )
  assert.equal(tree.children[0].kind, 'dir')
  assert.equal(tree.children[0].fileCount, 1)
})

test('tree can open a subfolder without re-walking', () => {
  const tree = fixture().tree('/sdcard/DCIM')
  assert.equal(tree.totalBytes, 1500)
  assert.deepEqual(
    tree.children.map((child) => child.name),
    ['a.jpg', 'b.jpg']
  )
})

test('largeFiles filters, sorts and annotates', () => {
  const files = fixture().largeFiles(10, 600)
  assert.deepEqual(
    files.map((file) => file.path),
    ['/sdcard/Download/c.zip', '/sdcard/DCIM/a.jpg']
  )
  assert.equal(files[0].ext, 'zip')
  assert.equal(files[0].dir, '/sdcard/Download')
})

test('emptyDirs only reports directories without any file', () => {
  assert.deepEqual(fixture().emptyDirs(), ['/sdcard/Empty'])
})

test('without rebuilds aggregates after a cleanup', () => {
  const index = fixture().without(new Set(['/sdcard/DCIM/a.jpg']))
  assert.equal(index.fileCount, 2)
  assert.equal(index.totalBytes, 2500)
  assert.equal(index.bytesIn('/sdcard/DCIM'), 500)
  assert.equal(index.get('/sdcard/DCIM/a.jpg'), undefined)
})

test('serialisation round-trips through the cache format', () => {
  const restored = StorageIndex.fromJSON(fixture().toJSON())
  assert.equal(restored.totalBytes, 3500)
  assert.equal(restored.dirCount, 4)
  assert.equal(restored.bytesIn('/sdcard/Download'), 2000)
})
