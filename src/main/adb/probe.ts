import type { DeviceCapabilities, DeviceInfo, StorageVolume } from '@shared/types'
import type { DeviceTransport } from './transport'

export type ProbeResult = {
  props: Record<string, string>
  volumes: StorageVolume[]
  capabilities: DeviceCapabilities
  batteryPercent?: number
  warnings: string[]
}

function parseDf(output: string): StorageVolume[] {
  const volumes: StorageVolume[] = []
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || /^Filesystem/i.test(line)) continue
    const parts = line.split(/\s+/)
    if (parts.length < 6) continue
    // toybox df: Filesystem 1K-blocks Used Available Use% Mounted
    const blocks = Number(parts[1])
    const used = Number(parts[2])
    const available = Number(parts[3])
    const mount = parts[5]
    if (!Number.isFinite(blocks) || !mount.startsWith('/')) continue
    const totalBytes = blocks * 1024
    const freeBytes = (Number.isFinite(available) ? available : blocks - used) * 1024
    volumes.push({
      mount: mount === '/storage/emulated/0' ? '/sdcard' : mount,
      label: mount === '/storage/emulated/0' || mount === '/sdcard' ? 'Internal storage' : mount.split('/').pop() || mount,
      totalBytes,
      usedBytes: Math.max(0, totalBytes - freeBytes),
      freeBytes: Math.max(0, freeBytes)
    })
  }
  return volumes
}

/**
 * One pass over the device to learn what it can actually do.
 *
 * Three parallel round trips instead of a dozen sequential ones: connection setup
 * latency dominates on USB, so the probe is grouped into bundles.
 */
export async function probeDevice(transport: DeviceTransport): Promise<ProbeResult> {
  const warnings: string[] = []
  const propsPromise = transport.getProps([
    'ro.product.manufacturer',
    'ro.product.model',
    'ro.product.name',
    'ro.build.version.release',
    'ro.build.version.sdk',
    'ro.kernel.qemu',
    'ro.boot.qemu'
  ])

  const capabilityBundle = [
    `echo "@@STAT"; find -H /sdcard -maxdepth 2 -type f -print0 2>/dev/null | xargs -0 -r -n 50 stat -c '%s|%Y|%n' 2>/dev/null | head -n 2`,
    `echo "@@MD5"; command -v md5sum || echo MISSING`,
    `echo "@@DATA"; ls -1 /sdcard/Android/data 2>&1 | head -n 1`,
    `echo "@@DISK"; dumpsys diskstats 2>/dev/null | head -n 4`,
    `echo "@@BINS"; for d in /sdcard/.Trash /sdcard/Trash /sdcard/Recycle /sdcard/.recycle /sdcard/RecycleBin; do [ -d "$d" ] && echo "$d"; done; true`,
    `echo "@@ROOT"; readlink -f /sdcard 2>/dev/null; find -H /sdcard -maxdepth 1 2>/dev/null | wc -l`
  ].join('; ')

  const volumeBundle = [
    `echo "@@DF"; df -k /sdcard 2>/dev/null`,
    `echo "@@DFSD"; df -k /storage 2>/dev/null`,
    `echo "@@BATT"; dumpsys battery 2>/dev/null | grep -E '^  level' || true`
  ].join('; ')

  const [props, capabilityResult, volumeResult] = await Promise.all([
    propsPromise,
    transport.exec(capabilityBundle, { timeoutMs: 40_000 }),
    transport.exec(volumeBundle, { timeoutMs: 25_000 })
  ])

  const sections = splitSections(capabilityResult.stdout)
  const statSample = sections.get('@@STAT') ?? ''
  const md5Line = (sections.get('@@MD5') ?? '').trim()
  const dataLine = (sections.get('@@DATA') ?? '').trim()
  const diskSample = sections.get('@@DISK') ?? ''
  const bins = (sections.get('@@BINS') ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('/'))

  // @@ROOT returns the canonical path followed by a count of root entries.
  const rootLines = (sections.get('@@ROOT') ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const resolvedRoot = rootLines.find((line) => line.startsWith('/')) ?? ''
  const rootEntries = Number(rootLines.find((line) => /^\d+$/.test(line)) ?? 0)
  if (rootEntries <= 1) {
    warnings.push(
      `The device shell could not list /sdcard${resolvedRoot ? ` (which resolves to ${resolvedRoot})` : ''}. Check that USB debugging is allowed for this computer and that the phone is unlocked.`
    )
  }

  // A working bulk stat looks like `1234|1712345678|/sdcard/Download/x.apk`.
  const bulkStatWorking = /^\d+\|\d+\|\//.test(statSample.split(/\r?\n/)[0] ?? '')
  if (!bulkStatWorking) {
    warnings.push('Fast metadata reads (find + xargs + stat) did not return data; the scan will use a slower fallback.')
  }

  const dataDenied = /permission denied|not found|no such file/i.test(dataLine) || dataLine === ''

  const volumeSections = splitSections(volumeResult.stdout)
  const volumes = dedupeVolumes([
    ...parseDf(volumeSections.get('@@DF') ?? ''),
    ...parseDf(volumeSections.get('@@DFSD') ?? '')
  ])
  const batteryMatch = /(\d+)/.exec(volumeSections.get('@@BATT') ?? '')

  const capabilities: DeviceCapabilities = {
    bulkStat: bulkStatWorking,
    findExecPlus: bulkStatWorking,
    md5sum: md5Line !== '' && !/MISSING/.test(md5Line),
    androidDataReadable: !dataDenied,
    diskStats: /Data-Free/i.test(diskSample),
    trimCaches: true,
    mediaStore: false,
    recycleBinPaths: bins
  }

  const sdk = Number(props['ro.build.version.sdk'] || 0)
  if (sdk >= 30 && dataDenied) {
    warnings.push(
      'Android 11+ blocks app-internal cache folders from the shell user. App caches are handled by the system cache trim instead of direct deletion.'
    )
  }

  return {
    props,
    volumes,
    capabilities,
    batteryPercent: batteryMatch ? Number(batteryMatch[1]) : undefined,
    warnings
  }
}

function splitSections(output: string): Map<string, string> {
  const sections = new Map<string, string>()
  let current = ''
  let buffer: string[] = []
  const flush = () => {
    if (current) sections.set(current, buffer.join('\n'))
    buffer = []
  }
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith('@@')) {
      flush()
      current = line.trim()
      continue
    }
    buffer.push(line)
  }
  flush()
  return sections
}

function dedupeVolumes(volumes: StorageVolume[]): StorageVolume[] {
  const seen = new Map<string, StorageVolume>()
  for (const volume of volumes) {
    const existing = seen.get(volume.mount)
    if (!existing || volume.totalBytes > existing.totalBytes) seen.set(volume.mount, volume)
  }
  return [...seen.values()].sort((a, b) => b.totalBytes - a.totalBytes)
}

export function buildDeviceInfo(
  serial: string,
  probe: ProbeResult,
  simulated: boolean,
  state: DeviceInfo['state'] = 'device'
): DeviceInfo {
  const model = probe.props['ro.product.model'] || serial
  const manufacturer = probe.props['ro.product.manufacturer'] || ''
  return {
    serial,
    state,
    manufacturer,
    model,
    androidVersion: probe.props['ro.build.version.release'] || 'unknown',
    sdk: Number(probe.props['ro.build.version.sdk'] || 0),
    productName: probe.props['ro.product.name'] || '',
    isEmulator: (probe.props['ro.kernel.qemu'] || probe.props['ro.boot.qemu'] || '0') === '1',
    simulated,
    volumes: probe.volumes,
    capabilities: probe.capabilities,
    batteryPercent: probe.batteryPercent
  }
}
