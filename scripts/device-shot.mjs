/**
 * Drives the built app against a real, connected phone and captures the
 * Overview screen. Read-only: it connects, clicks Scan, and renders the result.
 *
 *   npm run build
 *   node scripts/device-shot.mjs
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

function arg(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

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
const userData = mkdtempSync(join(tmpdir(), 'mangomobile-device-'))
const shotPath = join(root, arg('--out') ?? 'shot-real-device.png')

let child
let ws
let nextId = 1
const pending = new Map()

function send(method, params = {}) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
    setTimeout(() => {
      if (!pending.has(id)) return
      pending.delete(id)
      reject(new Error(`CDP timeout: ${method}`))
    }, 600_000)
  })
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) {
    const details = result.exceptionDetails
    throw new Error(details.exception?.description ?? details.text ?? 'evaluation failed')
  }
  return result.result.value
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

async function main() {
  child = spawn(electronPath, ['.', `--remote-debugging-port=${PORT}`], {
    cwd: root,
    env: { ...process.env, MANGO_USERDATA: userData, MANGO_DEMO: '', MANGO_CAPTURE: '' },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let logs = ''
  child.stdout.on('data', (chunk) => (logs += chunk))
  child.stderr.on('data', (chunk) => (logs += chunk))

  const target = await waitForTarget()
  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve)
    ws.addEventListener('error', () => reject(new Error('CDP socket error')))
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
  await send('Runtime.enable')

  for (let i = 0; i < 60; i++) {
    if ((await evaluate('document.readyState')) === 'complete') break
    await new Promise((r) => setTimeout(r, 250))
  }

  // Drive the real UI path: the Scan button updates the store, the store renders.
  // Vue mounts after `readyState === 'complete'`, so retry until the header exists.
  let clicked = false
  const clickDeadline = Date.now() + 60_000
  while (!clicked && Date.now() < clickDeadline) {
    clicked = await evaluate(`(() => {
      const buttons = [...document.querySelectorAll('button')]
      const scan = buttons.find((b) => /scan storage|rescan/i.test(b.textContent || ''))
      if (!scan) return false
      scan.click()
      return true
    })()`)
    if (!clicked) await new Promise((r) => setTimeout(r, 500))
  }
  if (!clicked) throw new Error('could not find the Scan storage button')

  let scan = null
  const deadline = Date.now() + 240_000
  while (Date.now() < deadline) {
    scan = await evaluate('window.api.scan.summary()')
    if (scan) break
    await new Promise((r) => setTimeout(r, 1000))
  }
  if (!scan) throw new Error('the scan did not finish in time')
  // Let the store paint the tree after the summary arrives.
  await new Promise((r) => setTimeout(r, 3000))

  const data = await evaluate(`(async () => {
    const api = window.api
    const device = await api.device.current()
    const summary = await api.scan.summary()
    const overview = await api.analysis.tree('/sdcard')

    return {
      device: { serial: device.serial, model: device.model, android: device.androidVersion },
      scan: {
        files: summary.fileCount,
        dirs: summary.dirCount,
        bytes: summary.totalBytes,
        strategy: summary.strategy,
        durationMs: summary.durationMs,
        warnings: summary.warnings ?? []
      },
      rendered: {
        empty: /Nothing indexed yet/i.test(document.body.innerText),
        rows: document.querySelectorAll('tbody tr').length
      },
      topFolders: overview.children.slice(0, 6).map((child) => ({
        name: child.name,
        bytes: child.size
      }))
    }
  })()`)

  console.log(`[device-shot] ${data.device.model} (${data.device.serial}, Android ${data.device.android})`)
  console.log(
    `[device-shot] ${data.scan.files.toLocaleString()} files · ${data.scan.dirs.toLocaleString()} folders · ` +
      `${(data.scan.bytes / 1024 / 1024 / 1024).toFixed(2)} GB in ${(data.scan.durationMs / 1000).toFixed(1)}s ` +
      `(${data.scan.strategy})`
  )
  for (const warning of data.scan.warnings) console.log(`[device-shot] warning: ${warning}`)
  for (const folder of data.topFolders) {
    console.log(`[device-shot]   ${folder.name.padEnd(24)} ${(folder.bytes / 1024 / 1024 / 1024).toFixed(2)} GB`)
  }
  console.log(`[device-shot] overview rendered: ${data.rendered.empty ? 'EMPTY' : `${data.rendered.rows} rows`}`)

  // Open the Overview view through the store so the screenshot shows real data.
  await evaluate(`(async () => {
    const nav = [...document.querySelectorAll('.nav-item')].find((b) => /overview/i.test(b.textContent || ''))
    if (nav) nav.click()
    await new Promise((r) => setTimeout(r, 2500))
    const host = document.querySelector('.toast-host')
    if (host) [...host.querySelectorAll('button')].forEach((button) => button.click())
    return true
  })()`)

  const shot = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(shotPath, Buffer.from(shot.data, 'base64'))
  console.log(`[device-shot] screenshot written to ${shotPath}`)

  const ok = data.scan.files > 1000 && data.scan.strategy === 'bulk-stat' && !data.rendered.empty
  console.log(`[device-shot] ${ok ? 'PASS' : 'FAIL'} real-device scan shows storage data in the UI`)
  return ok ? 0 : 1
}

try {
  const code = await main()
  process.exitCode = code
} catch (error) {
  console.error(`[device-shot] ERROR ${error.message}`)
  process.exitCode = 1
} finally {
  try {
    ws?.close()
  } catch {}
  if (child && !child.killed) {
    child.kill()
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  }
  await new Promise((r) => setTimeout(r, 1500))
  try {
    rmSync(userData, { recursive: true, force: true })
  } catch {}
}
