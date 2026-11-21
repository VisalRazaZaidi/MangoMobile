import type { AppListResult, InstalledApp } from '@shared/types'
import type { DeviceTransport } from '../adb/transport'
import { shPath } from '../adb/transport'

/** Friendly names for the packages people actually see in a cleaner. */
const KNOWN_LABELS: Record<string, string> = {
  'com.whatsapp': 'WhatsApp',
  'com.whatsapp.w4b': 'WhatsApp Business',
  'com.instagram.android': 'Instagram',
  'com.facebook.katana': 'Facebook',
  'com.zhiliaoapp.musically': 'TikTok',
  'com.android.chrome': 'Chrome',
  'com.brave.browser': 'Brave',
  'org.mozilla.firefox': 'Firefox',
  'com.spotify.music': 'Spotify',
  'com.google.android.youtube': 'YouTube',
  'com.google.android.apps.photos': 'Google Photos',
  'com.google.android.gm': 'Gmail',
  'com.google.android.apps.maps': 'Google Maps',
  'org.telegram.messenger': 'Telegram',
  'org.thoughtcrime.securesms': 'Signal',
  'com.snapchat.android': 'Snapchat',
  'com.twitter.android': 'X',
  'com.discord': 'Discord',
  'com.netflix.mediaclient': 'Netflix',
  'com.amazon.avod.thirdpartyclient': 'Prime Video',
  'com.microsoft.office.outlook': 'Outlook',
  'com.android.vending': 'Google Play Store',
  'com.google.android.gms': 'Google Play services',
  'com.samsung.android.messaging': 'Samsung Messages',
  'com.samsung.android.gallery3d': 'Samsung Gallery',
  'com.miui.gallery': 'Mi Gallery'
}

function labelFor(packageName: string): string {
  if (KNOWN_LABELS[packageName]) return KNOWN_LABELS[packageName]
  const tail = packageName.split('.').filter(Boolean).pop() ?? packageName
  return tail
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase())
}

function parsePackageLine(line: string): { packageName: string; apkPath?: string } | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith('package:')) return null
  const payload = trimmed.slice('package:'.length)
  const equals = payload.lastIndexOf('=')
  if (equals === -1) return { packageName: payload }
  return { packageName: payload.slice(equals + 1), apkPath: payload.slice(0, equals) }
}

/**
 * Installed apps with the sizes the shell user can actually verify.
 *
 * APK size is exact (the code path is world-readable). Per-app data and cache
 * sizes are not readable over ADB on Android 11+, so they are reported as unknown
 * instead of being invented — the Apps screen offers the system cache trim and
 * uninstall instead, which work without those figures.
 */
export async function listApps(transport: DeviceTransport): Promise<AppListResult> {
  const [allResult, systemResult] = await Promise.all([
    transport.exec('pm list packages -f 2>/dev/null', { timeoutMs: 60_000 }),
    transport.exec('pm list packages -s 2>/dev/null', { timeoutMs: 60_000 })
  ])

  if (allResult.code !== 0 || !allResult.stdout.includes('package:')) {
    return {
      apps: [],
      totalCacheBytes: 0,
      totalDataBytes: 0,
      totalApkBytes: 0,
      available: false,
      message: 'The device did not report its package list. Unlock the phone and allow USB debugging, then retry.'
    }
  }

  const systemPackages = new Set(
    systemResult.stdout
      .split(/\r?\n/)
      .map((line) => line.trim().replace(/^package:/, ''))
      .filter(Boolean)
  )

  const parsed = allResult.stdout
    .split(/\r?\n/)
    .map(parsePackageLine)
    .filter((entry): entry is { packageName: string; apkPath?: string } => Boolean(entry))

  const apkPaths = parsed.map((entry) => entry.apkPath).filter((path): path is string => Boolean(path))
  const sizes = new Map<string, number>()
  const SIZE_BATCH = 120
  for (let index = 0; index < apkPaths.length; index += SIZE_BATCH) {
    const batch = apkPaths.slice(index, index + SIZE_BATCH)
    const result = await transport.exec(`stat -c '%s|%n' ${batch.map(shPath).join(' ')} 2>/dev/null`, {
      timeoutMs: 60_000
    })
    for (const line of result.stdout.split(/\r?\n/)) {
      const separator = line.indexOf('|')
      if (separator <= 0) continue
      const size = Number(line.slice(0, separator))
      const path = line.slice(separator + 1).trim()
      if (Number.isFinite(size) && path) sizes.set(path, size)
    }
  }

  const apps: InstalledApp[] = parsed.map((entry) => {
    const apkBytes = entry.apkPath ? sizes.get(entry.apkPath) ?? 0 : 0
    return {
      packageName: entry.packageName,
      label: labelFor(entry.packageName),
      apkBytes,
      dataBytes: 0,
      cacheBytes: 0,
      codeBytes: apkBytes,
      system: systemPackages.has(entry.packageName),
      sized: apkBytes > 0
    }
  })

  apps.sort((a, b) => b.apkBytes - a.apkBytes)

  const totals = await readCacheTotals(transport)

  return {
    apps,
    totalCacheBytes: totals.cacheBytes,
    totalDataBytes: totals.appDataBytes,
    totalApkBytes: apps.reduce((sum, app) => sum + app.apkBytes, 0),
    available: true,
    message: totals.available
      ? undefined
      : 'Per-app cache sizes are not exposed by this Android version. The cache trim below still works.'
  }
}

/** Parses `dumpsys diskstats`, which reports device-wide app/cache totals. */
async function readCacheTotals(transport: DeviceTransport): Promise<{
  cacheBytes: number
  appDataBytes: number
  available: boolean
}> {
  const result = await transport.exec('dumpsys diskstats 2>/dev/null', { timeoutMs: 30_000 })
  const parseK = (pattern: RegExp): number => {
    const match = pattern.exec(result.stdout)
    if (!match) return 0
    const value = Number(match[1])
    return Number.isFinite(value) ? value * 1024 : 0
  }
  const cacheBytes = parseK(/^Cache Size:\s*(\d+)K/m)
  const appDataBytes = parseK(/^App Data:\s*(\d+)K/m)
  return { cacheBytes, appDataBytes, available: /Cache Size:/i.test(result.stdout) }
}

/** Asks the system to trim all app caches. Safe for app state; caches are rebuildable by design. */
export async function trimCaches(transport: DeviceTransport): Promise<{ freedBytes: number; message: string }> {
  const before = await readFreeBytes(transport)
  const result = await transport.exec('pm trim-caches 512G 2>&1', { timeoutMs: 240_000 })
  const after = await readFreeBytes(transport)
  if (result.code !== 0 || /Error|Exception/i.test(result.stdout)) {
    return {
      freedBytes: 0,
      message: result.stdout.trim() || result.stderr.trim() || 'The device rejected the cache trim request.'
    }
  }
  const freed = Math.max(0, after - before)
  return {
    freedBytes: freed,
    message: freed > 0 ? 'Caches trimmed by the system.' : 'Trim requested. Android may free the space in the background.'
  }
}

async function readFreeBytes(transport: DeviceTransport): Promise<number> {
  const result = await transport.exec('df -k /sdcard 2>/dev/null', { timeoutMs: 20_000 })
  for (const line of result.stdout.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 6 || !parts[5].startsWith('/')) continue
    const available = Number(parts[3])
    if (Number.isFinite(available)) return available * 1024
  }
  return 0
}

export async function uninstallApp(
  transport: DeviceTransport,
  packageName: string
): Promise<{ ok: boolean; message: string }> {
  if (!/^[a-zA-Z0-9._]+$/.test(packageName)) {
    return { ok: false, message: 'Refusing to run an uninstall for an unexpected package name.' }
  }
  const result = await transport.exec(`pm uninstall --user 0 ${packageName} 2>&1`, { timeoutMs: 180_000 })
  const ok = /Success/i.test(result.stdout)
  return {
    ok,
    message: ok
      ? `${packageName} was removed for this user.`
      : result.stdout.trim() || result.stderr.trim() || 'Uninstall failed.'
  }
}
