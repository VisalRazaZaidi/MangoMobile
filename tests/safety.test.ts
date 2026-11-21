import test from 'node:test'
import assert from 'node:assert/strict'
import {
  isRemovableEmptyDir,
  trashDirFor,
  trashNameFor,
  TRASH_DIR_NAME,
  validateDeletionPath
} from '../src/main/core/safety'

const root = '/sdcard'

test('accepts ordinary files inside the scanned volume', () => {
  assert.equal(validateDeletionPath('/sdcard/Download/old.zip', root).ok, true)
  assert.equal(validateDeletionPath('/sdcard/DCIM/Camera/IMG_1.jpg', root).ok, true)
  assert.equal(validateDeletionPath('/sdcard/Download/nested/deep/file.tmp', root).ok, true)
})

test('rejects the volume root and anything outside it', () => {
  assert.equal(validateDeletionPath('/sdcard', root).ok, false)
  assert.equal(validateDeletionPath('/data/local/tmp/x', root).ok, false)
  assert.equal(validateDeletionPath('/storage/emulated/0/x', root).ok, false)
  assert.equal(validateDeletionPath('sdcard/x', root).ok, false)
})

test('rejects traversal, null bytes and line breaks', () => {
  assert.equal(validateDeletionPath('/sdcard/../data/x', root).ok, false)
  assert.equal(validateDeletionPath('/sdcard/./x', root).ok, false)
  assert.equal(validateDeletionPath('/sdcard/a\0b', root).ok, false)
  assert.equal(validateDeletionPath('/sdcard/a\nb', root).ok, false)
})

test('protects system trees and the recycle bin', () => {
  assert.equal(validateDeletionPath('/system/build.prop', root).ok, false)
  assert.equal(validateDeletionPath(`/sdcard/${TRASH_DIR_NAME}/op/file`, root).ok, false)
})

test('protects user media folders themselves but not their files', () => {
  assert.equal(validateDeletionPath('/sdcard/Movies', root).ok, false)
  assert.equal(validateDeletionPath('/sdcard/DCIM/Camera', root).ok, false)
  assert.equal(validateDeletionPath('/sdcard/Movies/movie.mkv', root).ok, true)
})

test('only cache subfolders of app data are removable', () => {
  assert.equal(validateDeletionPath('/sdcard/Android/data/com.foo/cache/a.bin', root).ok, true)
  assert.equal(validateDeletionPath('/sdcard/Android/data/com.foo/code_cache/x', root).ok, true)
  assert.equal(validateDeletionPath('/sdcard/Android/data/com.foo/files/state.db', root).ok, false)
  assert.equal(validateDeletionPath('/sdcard/Android/media/com.foo/a.jpg', root).ok, true)
  assert.equal(isRemovableEmptyDir('/sdcard/Android/media/com.foo/empty', root).ok, false)
})

test('empty directories are only removable in disposable locations', () => {
  assert.equal(isRemovableEmptyDir('/sdcard/Download/old-folder', root).ok, true)
  assert.equal(isRemovableEmptyDir('/sdcard/DCIM/Camera', root).ok, false)
  assert.equal(isRemovableEmptyDir('/sdcard/Music', root).ok, false)
})

test('recycle bin layout is deterministic and path-safe', () => {
  assert.equal(trashDirFor('/sdcard'), '/sdcard/.MangoMobileTrash')
  assert.equal(trashDirFor('/sdcard/'), '/sdcard/.MangoMobileTrash')
  assert.equal(trashNameFor('/sdcard/a/b c.txt', 7), '00007_b c.txt')
  assert.equal(trashNameFor('/sdcard/a/x\r\ny', 1), '00001_x__y')
})
