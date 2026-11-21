import test from 'node:test'
import assert from 'node:assert/strict'
import { previewKind, validatePreviewPath } from '../src/main/core/preview'
import { PreviewCache } from '../src/main/core/preview'
import { MockTransport } from '../src/main/adb/mock-transport'
import { existsSync, readFileSync } from 'node:fs'

test('preview only reads normalized paths inside the scan root', () => {
  assert.doesNotThrow(() => validatePreviewPath('/sdcard/Pictures/a.jpg', '/sdcard'))
  for (const path of ['/data/private', '/sdcard/../data/x', '/sdcard/a\n.jpg', '/sdcard-other/x', '/sdcard//x']) {
    assert.throws(() => validatePreviewPath(path, '/sdcard'))
  }
})

test('active documents and unsupported formats use details instead of executable content', () => {
  assert.equal(previewKind('/sdcard/a.jpg'), 'image')
  assert.equal(previewKind('/sdcard/a.mp4'), 'video')
  assert.equal(previewKind('/sdcard/a.mp3'), 'audio')
  assert.equal(previewKind('/sdcard/a.txt'), 'text')
  assert.equal(previewKind('/sdcard/a.html'), 'details')
  assert.equal(previewKind('/sdcard/a.svg'), 'details')
  assert.equal(previewKind('/sdcard/a.apk'), 'details')
})

test('preview cache retains only recent copies and removes them on shutdown', async () => {
  const cache = new PreviewCache()
  const transport = new MockTransport('preview-test')
  const image = [...transport.filesystem.nodes.values()].find(f => f.kind === 'file' && f.path.endsWith('.jpg'))!
  const paths: string[] = []
  const tokens: string[] = []
  try {
    for (let i = 0; i < 4; i++) {
      const result = await cache.load(transport, image)
      const token = new URL(result.url!).pathname.slice(1)
      const local = cache.resolve(token)!
      tokens.push(token)
      paths.push(local)
      assert.equal(readFileSync(local).subarray(1, 4).toString(), 'PNG')
    }
    assert.equal(cache.resolve(tokens[0]), undefined)
    assert.equal(existsSync(paths[0]), false)
    assert.equal(cache.resolve('arbitrary-local-path'), undefined)
    const huge = await cache.load(transport, { ...image, size: 513 * 1024 * 1024 })
    assert.equal(huge.kind, 'details')
    assert.equal(huge.url, undefined)
  } finally { cache.dispose() }
  for (const path of paths) assert.equal(existsSync(path), false)
})
