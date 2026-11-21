/**
 * Read-only health check against a real phone.
 *
 *   npm run check:device                 # first connected device
 *   npm run check:device -- --serial 8d3c07c6
 *
 * Probes the device, runs the same scan the app runs, and previews the
 * default (safe) rules. It never deletes, moves or uninstalls anything: the
 * only mutating command in the whole pipeline is unreachable from here.
 */
import { locateAdb, listDevices, AdbTransport } from '../src/main/adb/real-adb'
import { probeDevice } from '../src/main/adb/probe'
import { scanVolume } from '../src/main/core/scanner'
import { loadRules, previewRules } from '../src/main/core/rules-engine'

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

async function main(): Promise<number> {
  const adb = locateAdb(arg('--adb'))
  if (!adb.adbFound) {
    console.error(adb.error ?? 'adb not found')
    return 2
  }

  const devices = await listDevices(adb.adbPath)
  const serial = arg('--serial') ?? devices.find((device) => device.state === 'device')?.serial
  if (!serial) {
    console.error(`No usable device. adb reports: ${devices.map((d) => `${d.serial}=${d.state}`).join(', ') || 'nothing'}`)
    return 2
  }

  const transport = new AdbTransport(serial, adb.adbPath)
  console.log(`[device] ${serial} via ${adb.adbPath}`)

  const probe = await probeDevice(transport)
  console.log(`[probe] ${probe.props['ro.product.model'] ?? '?'} · Android ${probe.props['ro.build.version.release'] ?? '?'}`)
  console.log(
    `[probe] capabilities: ${Object.entries(probe.capabilities)
      .filter(([, value]) => typeof value === 'boolean')
      .map(([key, value]) => `${key}=${value}`)
      .join(' ')}`
  )
  for (const warning of probe.warnings) console.log(`[probe] warning: ${warning}`)

  const started = Date.now()
  let lastReport = 0
  const outcome = await scanVolume({
    transport,
    capabilities: probe.capabilities,
    root: '/sdcard',
    signal: new AbortController().signal,
    onProgress: (progress) => {
      const now = Date.now()
      if (now - lastReport < 500 && progress.phase !== 'done') return
      lastReport = now
      console.log(
        `[scan] ${progress.phase}: ${progress.entries.toLocaleString()} files, ` +
          `${progress.directories.toLocaleString()} folders, ${(progress.bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
      )
    }
  })

  const summary = outcome.summary
  console.log(
    `[scan] done in ${((Date.now() - started) / 1000).toFixed(1)}s: ${summary.fileCount.toLocaleString()} files, ` +
      `${summary.dirCount.toLocaleString()} folders, ${(summary.totalBytes / 1024 / 1024 / 1024).toFixed(2)} GB ` +
      `(strategy: ${summary.strategy})`
  )
  for (const warning of summary.warnings) console.log(`[scan] warning: ${warning}`)

  const defaults = loadRules().filter((rule) => rule.defaultSelected)
  const preview = previewRules({ index: outcome.index, capabilities: probe.capabilities }, defaults)
  let items = 0
  for (const result of preview) {
    const skipped = result.skippedReason ? ` (skipped: ${result.skippedReason.slice(0, 60)}…)` : ''
    console.log(
      `[preview] ${result.rule.title.padEnd(26)} ${String(result.items.length).padStart(6)} items · ` +
        `${(result.totalBytes / 1024 / 1024).toFixed(1)} MB${skipped}`
    )
    items += result.items.length
  }

  const ok = summary.fileCount > 1000 && summary.strategy !== 'du-apparent-size'
  console.log(`\n[device] ${ok ? 'PASS' : 'FAIL'} read-only scan: ${items} previewable items`)
  transport.dispose()
  return ok ? 0 : 1
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error)
    process.exit(1)
  }
)
