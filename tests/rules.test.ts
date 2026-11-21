import test from 'node:test'
import assert from 'node:assert/strict'
import { MockTransport } from '../src/main/adb/mock-transport'
import { scanVolume } from '../src/main/core/scanner'
import { dedupePreviewResults, globToRegExp, literalPrefix, loadRules, previewRules, validateRules } from '../src/main/core/rules-engine'
import { findDuplicates } from '../src/main/core/duplicates'
import { buildMediaBuckets } from '../src/main/core/media'

async function scanMock(): Promise<{ transport: MockTransport; index: Awaited<ReturnType<typeof scanVolume>>['index']; capabilities: ReturnType<MockTransport['capabilities']> }> {
  const transport = new MockTransport('integration')
  const capabilities = transport.capabilities()
  const outcome = await scanVolume({
    transport,
    capabilities,
    root: '/sdcard',
    signal: new AbortController().signal,
    onProgress: () => {}
  })
  return { transport, index: outcome.index, capabilities }
}

test('glob matching stays inside one path segment', () => {
  const jpg = globToRegExp('*.jpg')
  assert.equal(jpg.test('photo.jpg'), true)
  assert.equal(jpg.test('nested/photo.jpg'), false)
  const recursive = globToRegExp('**/cache/**')
  assert.equal(recursive.test('/sdcard/app/cache/a/b'), true)
  assert.equal(literalPrefix('/sdcard/Download/*.apk'), '/sdcard/Download')
})

test('the shipped rule set is valid and honours the safe-by-default invariant', () => {
  const rules = loadRules()
  assert.ok(rules.length >= 10)
  assert.deepEqual(validateRules(rules), [])
  for (const rule of rules.filter((candidate) => candidate.defaultSelected)) {
    assert.equal(rule.risk, 'safe', `${rule.id} must be safe to be selected by default`)
  }
})

test('the mock device scans into a usable index', async () => {
  const { index } = await scanMock()
  assert.ok(index.fileCount > 1000, 'fixture should contain a realistic file count')
  assert.ok(index.totalBytes > 5 * 1024 ** 3)
  assert.ok(index.dirCount > 10)
  assert.equal(index.bytesIn('/sdcard/Movies'), index.tree('/sdcard/Movies').totalBytes)
})

test('preview flags rules that the Android version cannot serve', async () => {
  const { index, capabilities } = await scanMock()
  const rules = loadRules()
  const results = previewRules({ index, capabilities, now: Math.floor(Date.now() / 1000) }, rules)
  assert.equal(results.length, rules.length)

  const appCache = results.find((result) => result.rule.id === 'android.app-cache')
  assert.ok(appCache?.skippedReason, 'Android/data should be reported as unavailable')

  const thumbnails = results.find((result) => result.rule.id === 'android.thumbnails')
  assert.ok((thumbnails?.items.length ?? 0) > 0)
  assert.ok((thumbnails?.totalBytes ?? 0) > 0)
})

test('overlapping rules are deduplicated so a path is deleted once', async () => {
  const { index, capabilities } = await scanMock()
  const rules = loadRules().filter((rule) => rule.id === 'android.temp-files' || rule.id === 'android.logs')
  const results = dedupePreviewResults(
    previewRules({ index, capabilities, now: Math.floor(Date.now() / 1000) }, rules)
  )

  const seen = new Set<string>()
  let overlaps = 0
  for (const result of results) {
    for (const item of result.items) {
      if (seen.has(item.path)) overlaps += 1
      else seen.add(item.path)
    }
    assert.equal(
      result.totalBytes,
      result.items.reduce((sum, item) => sum + item.size, 0),
      'per-rule totals must follow the deduplicated list'
    )
  }
  assert.equal(overlaps, 0)
  assert.ok(results.some((result) => result.items.some((item) => item.path.endsWith('.log'))))
})

test('duplicate detection finds exact content groups on the device', async () => {
  const { transport, index } = await scanMock()
  const groups = await findDuplicates({
    transport,
    index,
    settings: { minSizeBytes: 4096, maxGroups: 50, fullHash: true },
    signal: new AbortController().signal,
    onProgress: () => {}
  })

  assert.ok(groups.length > 0, 'the fixture contains duplicate copies')
  for (const group of groups) {
    assert.ok(group.files.length >= 2)
    assert.equal(group.wastedBytes, group.size * (group.files.length - 1))
    assert.equal(group.approximate, false)
  }
})

test('media buckets cover the whole index with consistent totals', async () => {
  const { index } = await scanMock()
  const buckets = buildMediaBuckets(index, 100)
  const counted = buckets.reduce((sum, bucket) => sum + bucket.count, 0)
  assert.equal(counted, index.fileCount)
  const totals = buckets.reduce((sum, bucket) => sum + bucket.totalBytes, 0)
  assert.equal(totals, index.totalBytes)
  assert.ok(buckets.some((bucket) => bucket.kind === 'video'))
  assert.ok(buckets.some((bucket) => bucket.kind === 'screenshot'))
})
