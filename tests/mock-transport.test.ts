import test from 'node:test'
import assert from 'node:assert/strict'
import { MockTransport } from '../src/main/adb/mock-transport'

test('adb pm listing distinguishes package paths and system apps', async () => {
  const transport = new MockTransport('pm-test')

  const all = await transport.exec('pm list packages -f')
  assert.match(all.stdout, /package:\/data\/app\//)
  assert.match(all.stdout, /=com\.android\.chrome/)

  const system = await transport.exec('pm list packages -s')
  assert.match(system.stdout, /^package:com\.android\.vending$/m)
  assert.doesNotMatch(system.stdout, /com\.whatsapp/)

  const thirdParty = await transport.exec('pm list packages -3')
  assert.match(thirdParty.stdout, /^package:com\.whatsapp$/m)
  assert.doesNotMatch(thirdParty.stdout, /com\.google\.android\.gms/)
})

test('adb stat reports the format the scanner expects', async () => {
  const transport = new MockTransport('stat-test')
  const result = await transport.exec("stat -c '%s|%Y|%n' /sdcard/Movies /sdcard/DCIM/Camera")
  for (const line of result.stdout.trim().split('\n')) {
    assert.match(line, /^\d+\|\d+\|\/sdcard\//)
  }
})

test('trim-caches is acknowledged and uninstall removes the package', async () => {
  const transport = new MockTransport('pm-test')
  const trim = await transport.exec('pm trim-caches 512G')
  assert.match(trim.stdout, /Success/)

  const uninstall = await transport.exec('pm uninstall --user 0 com.spotify.music')
  assert.match(uninstall.stdout, /Success/)
  const remaining = await transport.exec('pm list packages -f')
  assert.doesNotMatch(remaining.stdout, /com\.spotify\.music/)
})

test('ls lists a directory and honours the default operand', async () => {
  const transport = new MockTransport('ls-test')

  const listing = await transport.exec('ls /sdcard')
  assert.match(listing.stdout, /^DCIM$/m)
  assert.match(listing.stdout, /^Download$/m)
  assert.equal(listing.code, 0)

  const fallback = await transport.exec('ls')
  assert.match(fallback.stdout, /^DCIM$/m)

  const file = await transport.exec('ls /sdcard/Movies')
  assert.equal(file.code, 0)

  const missing = await transport.exec('ls /sdcard/does-not-exist')
  assert.equal(missing.code, 1)
  assert.match(missing.stderr, /No such file/)
})

test('find accepts a leading -H so a symlinked root is walked', async () => {
  const transport = new MockTransport('find-test')
  const plain = await transport.exec('find /sdcard -maxdepth 1 -type d')
  const followed = await transport.exec('find -H /sdcard -maxdepth 1 -type d')

  assert.equal(plain.stdout.trim().split('\n')[0], '/sdcard')
  assert.equal(followed.stdout.trim(), plain.stdout.trim())
  assert.match(followed.stdout, /^\/sdcard\/DCIM$/m)
})

test('du reports apparent sizes for files and directory totals', async () => {
  const transport = new MockTransport('du-test')
  const result = await transport.exec('du -a -b -H /sdcard')
  assert.equal(result.code, 0)

  const rows = result.stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf('\t')
      assert.ok(tab > 0, `expected <size>\\t<path>, got ${line}`)
      return { size: Number(line.slice(0, tab)), path: line.slice(tab + 1) }
    })

  assert.ok(rows.length > 100)
  assert.ok(rows.every((row) => Number.isFinite(row.size) && row.path.startsWith('/')))

  const downloads = rows.find((row) => row.path === '/sdcard/Download')
  assert.ok(downloads, 'du should include directory totals')
  const inside = rows.filter((row) => row.path.startsWith('/sdcard/Download/'))
  assert.ok(downloads.size >= inside.reduce((sum, row) => sum + row.size, 0))
})
