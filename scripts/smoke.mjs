/**
 * End-to-end smoke test against the built app and the simulated device.
 *
 *   npm run build && npm run smoke
 *
 * Launches the real Electron binary with a throwaway profile, drives the same
 * preload API the renderer uses (deep-clean preview -> recycle bin -> restore),
 * checks the rendered recycle bin, and asserts on-device state at every step.
 * Exits non-zero on failure.
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const electronPath = require('electron')
const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Ask the OS for an unused local port so parallel or interrupted runs cannot collide. */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => (port ? resolve(port) : reject(new Error('could not reserve a port'))))
    })
  })
}

const PORT = await freePort()
const userData = mkdtempSync(join(tmpdir(), 'mangomobile-smoke-'))
const binShot = join(root, 'shot-smoke-trash.png')
const finalShot = join(root, 'shot-smoke.png')

let child
let ws
let nextId = 1
const pending = new Map()
const checks = []

function check(name, ok, detail = '') {
  checks.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

async function waitForTarget(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const targets = await res.json()
      const page = targets.find((t) => t.type === 'page' && /index\.html/.test(t.url))
      if (page?.webSocketDebuggerUrl) return page
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error('Timed out waiting for the Electron page to expose CDP')
}

function connect(url) {
  return new Promise((resolve, reject) => {
    ws = new WebSocket(url)
    ws.addEventListener('open', () => resolve())
    ws.addEventListener('error', (event) => reject(new Error(`CDP socket error: ${event.message ?? 'unknown'}`)))
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.id && pending.has(message.id)) {
        const { resolve: res, reject: rej } = pending.get(message.id)
        pending.delete(message.id)
        if (message.error) rej(new Error(message.error.message))
        else res(message.result)
      }
    })
  })
}

function send(method, params = {}) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
    setTimeout(() => {
      if (!pending.has(id)) return
      pending.delete(id)
      reject(new Error(`CDP timeout: ${method}`))
    }, 180_000)
  })
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  })
  if (result.exceptionDetails) {
    const details = result.exceptionDetails
    throw new Error(details.exception?.description ?? details.text ?? 'evaluation failed')
  }
  return result.result.value
}

async function screenshot(path) {
  // Toasts from the boot scan would cover the content being documented.
  await evaluate(`(() => {
    const host = document.querySelector('.toast-host')
    if (!host) return 0
    const buttons = [...host.querySelectorAll('button')]
    buttons.forEach((button) => button.click())
    return buttons.length
  })()`)
  await new Promise((r) => setTimeout(r, 500))
  await send('Page.enable')
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(path, Buffer.from(shot.data, 'base64'))
  console.log(`[smoke] screenshot written to ${path}`)
}

const openTrash = `(async () => {
  const target = [...document.querySelectorAll('.nav-item')].find((b) => /recycle bin/i.test(b.textContent || ''))
  if (!target) return false
  target.click()
  await new Promise((r) => setTimeout(r, 1500))
  const text = document.body.innerText
  const putBack = [...document.querySelectorAll('button')].filter((b) => /put back/i.test(b.textContent || '')).length
  return { opened: true, title: /recycle bin/i.test(text), putBack }
})()`

const SHOT_FLOW = `(async () => {
  const api = window.api
  if (!api) throw new Error('preload API missing')

  const info = await api.app.info()
  const device = await api.device.connect('demo')
  const scan1 = await api.scan.start()

  const rules = await api.rules.list()
  const defaults = rules.filter((rule) => rule.defaultSelected)
  const results = await api.cleanup.preview(defaults.map((rule) => rule.id))
  const ruleIds = results.map((result) => result.rule.id)
  const items = results.flatMap((result) => result.items)
  const files = items.filter((item) => !item.isDirectory)
  const before = {
    rules: defaults.length,
    groups: results.filter((result) => result.items.length > 0).length,
    items: items.length,
    files: files.length,
    bytes: items.reduce((sum, item) => sum + item.size, 0)
  }
  if (items.length === 0) throw new Error('demo preview returned no items')

  const exec = await api.cleanup.execute(items, ruleIds, true)
  const trash = await api.trash.summary()

  return {
    info,
    device: { model: device.model, serial: device.serial, android: device.androidVersion },
    scan: { files: scan1.fileCount, dirs: scan1.dirCount, bytes: scan1.totalBytes, durationMs: scan1.durationMs },
    before,
    exec: {
      opId: exec.opId,
      deleted: exec.deletedCount,
      failed: exec.failedCount,
      failures: exec.failures.slice(0, 5),
      verified: exec.verified,
      freedBytes: exec.freedBytes,
      trashEntries: (exec.trashEntries || []).length
    },
    trash: {
      entries: trash.entries.length,
      bytes: trash.totalBytes,
      dir: trash.dir,
      storedPaths: trash.entries.map((entry) => entry.storedPath)
    }
  }
})()`

function restoreFlow(storedPaths) {
  return `(async () => {
    const api = window.api
    const restore = await api.trash.restore(${JSON.stringify(storedPaths)})
    const trashAfter = await api.trash.summary()

    const scan = await api.scan.start()
    const rules = await api.rules.list()
    const defaults = rules.filter((rule) => rule.defaultSelected)
    const back = await api.cleanup.preview(defaults.map((rule) => rule.id))

    return {
      restore: { deleted: restore.deletedCount, failed: restore.failedCount, failures: restore.failures.slice(0, 5) },
      trashAfter: trashAfter.entries.length,
      previewFiles: back.reduce(
        (sum, result) => sum + result.items.filter((item) => !item.isDirectory).length,
        0
      ),
      scanFiles: scan.fileCount,
      history: (await api.history.list()).map((entry) => entry.kind)
    }
  })()`
}

async function cleanup() {
  try {
    ws?.close()
  } catch {}
  if (child && !child.killed) {
    child.__expectedExit = true
    child.kill()
    // Renderer processes can outlive a killed main process on Windows.
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  }
  await new Promise((r) => setTimeout(r, 1200))
  try {
    rmSync(userData, { recursive: true, force: true })
  } catch {}
}

const watchdog = setTimeout(() => {
  console.error('[smoke] watchdog timeout: the app did not finish the flow in 4 minutes')
  void cleanup().finally(() => process.exit(1))
}, 240_000)

try {
  console.log('[smoke] launching Electron with a throwaway profile...')
  child = spawn(electronPath, ['.', `--remote-debugging-port=${PORT}`], {
    cwd: root,
    env: { ...process.env, MANGO_USERDATA: userData, MANGO_DEMO: '1', MANGO_CAPTURE: '' },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stdout.on('data', (chunk) => process.stdout.write(chunk))
  child.stderr.on('data', (chunk) => process.stderr.write(chunk))
  child.on('exit', (code) => {
    if (code !== 0 && !child.__expectedExit) console.error(`[smoke] Electron exited early with code ${code}`)
  })

  const target = await waitForTarget()
  await connect(target.webSocketDebuggerUrl)
  await send('Runtime.enable')

  // Wait for the renderer to mount and the demo boot scan to settle.
  for (let i = 0; i < 60; i++) {
    const ready = await evaluate('document.readyState')
    if (ready === 'complete') break
    await new Promise((r) => setTimeout(r, 250))
  }
  for (let i = 0; i < 80; i++) {
    const summary = await evaluate('window.api ? window.api.scan.summary() : null')
    if (summary) break
    await new Promise((r) => setTimeout(r, 250))
  }

  if (process.env.MANGO_UI_REVIEW === '1') {
    const { mkdirSync } = await import('node:fs')
    const directory = join(root, 'docs', 'ui-review')
    mkdirSync(directory, { recursive: true })
    for (const label of ['Overview', 'Deep Clean', 'Large Files', 'Space Analysis', 'Duplicates', 'Media', 'Apps', 'Recycle Bin', 'History', 'Settings']) {
      await evaluate(`(async () => {
        [...document.querySelectorAll('.nav-item')].find(b => b.textContent.includes(${JSON.stringify(label)})).click()
        await new Promise(r => setTimeout(r, 600))
      })()`)
      await screenshot(join(directory, `${label.toLowerCase().replaceAll(' ', '-')}.png`))
    }
    await send('Emulation.setDeviceMetricsOverride', { width: 1080, height: 760, deviceScaleFactor: 1, mobile: false })
    await evaluate(`(async () => {
      document.documentElement.dataset.theme = 'light';
      [...document.querySelectorAll('.nav-item')].find(b => b.textContent.includes('Overview')).click()
      await new Promise(r => setTimeout(r, 600))
    })()`)
    await screenshot(join(directory, 'overview-light-1080.png'))
    const metrics = await evaluate(`({ width: innerWidth, page: document.documentElement.scrollWidth, chart: document.querySelector('.treemap')?.clientWidth })`)
    check('minimum-window light layout has no page overflow', metrics.page <= metrics.width, JSON.stringify(metrics))
    await evaluate(`document.documentElement.dataset.theme = 'dark'`)
    await send('Emulation.clearDeviceMetricsOverride')
  }
  const data = await evaluate(SHOT_FLOW)

  check('app boots and reports a version', Boolean(data.info.version), `v${data.info.version}`)
  check('demo device connects', data.device.serial === 'demo-pixel', `${data.device.model}, Android ${data.device.android}`)
  check(
    'deep clean preview finds files',
    data.before.items > 0,
    `${data.before.items} items (${data.before.files} files) across ${data.before.groups} rules`
  )
  check(
    'cleanup moves every item to the recycle bin',
    data.exec.failed === 0 && data.exec.deleted === data.before.items && data.exec.trashEntries === data.before.files,
    `${data.exec.deleted} deleted, ${data.exec.failed} failed, ${data.exec.trashEntries} trash entries`
  )
  check(
    'recycle bin records the moved files',
    data.trash.entries === data.before.files && Math.round(data.trash.bytes) >= Math.round(data.before.bytes),
    `${data.trash.entries} entries, ${(data.trash.bytes / 1024 / 1024).toFixed(1)} MB`
  )

  const binView = await evaluate(openTrash)
  check('recycle bin view lists the moved files', Boolean(binView?.opened) && binView.putBack > 0, `${binView?.putBack ?? 0} "Put back" buttons`)
  await screenshot(binShot)

  const back = await evaluate(restoreFlow(data.trash.storedPaths))

  check('restore puts files back', back.restore.failed === 0, `${back.restore.deleted} restored, ${back.restore.failed} failed`)
  check('recycle bin is empty after restore', back.trashAfter === 0)
  check(
    'device file count returns to the pre-clean value',
    back.scanFiles === data.scan.files,
    `${back.scanFiles}/${data.scan.files} files`
  )
  check(
    'restored files reappear in the deep-clean preview',
    back.previewFiles === data.before.files,
    `${back.previewFiles}/${data.before.files} files back`
  )
  check(
    'history records cleanup and restore',
    back.history.includes('cleanup') && back.history.includes('trash-restore'),
    back.history.join(', ')
  )

  if (data.exec.failures?.length) console.log('[smoke] cleanup failures:', data.exec.failures)
  if (back.restore.failures?.length) console.log('[smoke] restore failures:', back.restore.failures)

  const finalView = await evaluate(openTrash)
  check('recycle bin view reflects the restore', Boolean(finalView?.opened) && finalView.putBack === 0)
  await screenshot(finalShot)

  const cleanView = await evaluate(`(async () => {
    const nav = [...document.querySelectorAll('.nav-item')].find((b) => /deep clean/i.test(b.textContent || ''))
    if (!nav) return { opened: false }
    nav.click()
    await new Promise((r) => setTimeout(r, 1800))
    const selectAll = [...document.querySelectorAll('button')].find((b) => /select all found/i.test(b.textContent || ''))
    if (selectAll) selectAll.click()
    await new Promise((r) => setTimeout(r, 800))
    const cards = [...document.querySelectorAll('.card')]
    const preview = cards.find((card) => /Preview/.test(card.textContent || ''))
    const primary = [...document.querySelectorAll('button.btn-primary')].find((b) => {
      const text = (b.textContent || '').trim()
      return text.startsWith('Move ') || text.startsWith('Delete ')
    })
    return {
      opened: true,
      rules: document.querySelectorAll('.rule-card').length,
      rows: document.querySelectorAll('.table tbody tr').length,
      preview: preview ? preview.textContent.split(' ').filter(Boolean).join(' ').slice(0, 110) : '',
      primary: primary ? primary.textContent.split(' ').filter(Boolean).join(' ') : '',
      disabled: primary ? primary.disabled : true
    }
  })()`)
  check(
    'deep clean view renders the preview through the store',
    Boolean(cleanView?.opened) && cleanView.rules >= 14 && cleanView.rows > 0,
    `${cleanView?.rules} rule cards, ${cleanView?.rows} rows`
  )
  check(
    'select-all enables a priced cleanup action',
    !cleanView?.disabled && /Move \d+ item/.test(cleanView?.primary ?? ''),
    `${cleanView?.preview} · ${cleanView?.primary}`
  )
  await screenshot(join(root, 'shot-smoke-clean.png'))
  const imagePreview = await evaluate(`(async () => {
    const link = [...document.querySelectorAll('.file-link')].find(b => /\\.(jpg|png)/i.test(b.textContent))
    const selected = document.querySelectorAll('.table input:checked').length
    link.click()
    await new Promise(r => setTimeout(r, 700))
    const img = document.querySelector('.file-preview img')
    return { loaded: img?.naturalWidth > 0, selected, after: document.querySelectorAll('.table input:checked').length, text: document.querySelector('.file-preview')?.innerText }
  })()`)
  check('filename click renders image without changing cleanup selection', imagePreview.loaded && imagePreview.selected === imagePreview.after, JSON.stringify(imagePreview))
  await screenshot(join(root, 'shot-smoke-preview.png'))
  await evaluate(`document.querySelector('[aria-label="Close preview"]').click()`)
  const mediaPreview = await evaluate(`(async () => {
    const buckets = await window.api.media.buckets()
    const video = buckets.find(b => b.kind === 'video').items.find(f => f.size < 512 * 1024 * 1024)
    const result = await window.api.preview.load(video.path)
    const player = document.createElement('video')
    player.src = result.url
    document.body.append(player)
    const loaded = await new Promise(resolve => {
      player.onloadedmetadata = () => resolve(player.duration > 0)
      player.onerror = () => resolve(false)
      setTimeout(() => resolve(false), 3000)
    })
    player.remove()
    const large = buckets.flatMap(b => b.items).find(f => f.size > 512 * 1024 * 1024)
    const details = await window.api.preview.load(large.path)
    let blocked = false
    try { await window.api.preview.load('/sdcard/../data/private') } catch { blocked = true }
    return { loaded, details: details.kind, blocked }
  })()`)
  check('video loads through preview protocol and oversized files show details', mediaPreview.loaded && mediaPreview.details === 'details' && mediaPreview.blocked, JSON.stringify(mediaPreview))
  const scroll = await evaluate(`(() => {
    const content = document.querySelector('.content')
    content.scrollTop = 300
    return { top: content.scrollTop, bottom: content.getBoundingClientRect().bottom, height: innerHeight }
  })()`)
  check('main content scrolls within the window', scroll.top > 0 && scroll.bottom <= scroll.height + 1, JSON.stringify(scroll))
  const uiCleanup = await evaluate(`(async () => {
    const before = (await window.api.trash.summary()).entries.length
    const action = [...document.querySelectorAll('button.btn-primary')].find(b => b.textContent.trim().startsWith('Move '))
    action.click()
    await new Promise(r => setTimeout(r, 300))
    document.querySelector('.modal-foot .btn-primary').click()
    await new Promise(r => setTimeout(r, 2500))
    return { before, after: (await window.api.trash.summary()).entries.length, errors: document.querySelector('.toast-host')?.innerText }
  })()`)
  check('confirmed UI cleanup moves selected files', uiCleanup.after > uiCleanup.before, JSON.stringify(uiCleanup))
  const permanent = await evaluate(`(async () => {
    const nav = [...document.querySelectorAll('.nav-item')].find(b => /large files/i.test(b.textContent))
    nav.click()
    await new Promise(r => setTimeout(r, 600))
    document.querySelector('.table tbody input[type=checkbox]').click()
    await new Promise(r => setTimeout(r, 100))
    document.querySelector('button.btn-danger').click()
    await new Promise(r => setTimeout(r, 200))
    const dialog = document.querySelector('.modal')
    dialog.querySelector('label input[type=checkbox]').click()
    await new Promise(r => setTimeout(r, 100))
    const before = (await window.api.scan.summary()).fileCount
    dialog.querySelector('.modal-foot .btn-danger').click()
    await new Promise(r => setTimeout(r, 1000))
    return { before, after: (await window.api.scan.summary()).fileCount, errors: document.querySelector('.toast-host')?.innerText }
  })()`)
  check('confirmed large-file UI deletion removes the file permanently', permanent.after === permanent.before - 1, JSON.stringify(permanent))
} catch (error) {
  console.error(`[smoke] ERROR ${error.message}`)
  checks.push({ name: 'smoke flow completed', ok: false, detail: error.message })
} finally {
  clearTimeout(watchdog)
  await cleanup()
}

const failed = checks.filter((c) => !c.ok)
console.log(`\n[smoke] ${checks.length - failed.length}/${checks.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
