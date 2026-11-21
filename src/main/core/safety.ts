/**
 * Safety invariants for destructive operations.
 *
 * Rules decide *what* is disposable; this module decides what is categorically
 * untouchable no matter what a rule says. It runs on every deletion, before the
 * device is asked to do anything.
 */

export type SafetyVerdict = { ok: true } | { ok: false; reason: string }

const HARD_PROTECTED_PREFIXES = [
  '/system',
  '/vendor',
  '/product',
  '/proc',
  '/sys',
  '/dev',
  '/data',
  '/apex',
  '/metadata',
  '/efs',
  '/persist',
  '/firmware',
  '/storage/emulated/Android'
]

const USER_CRITICAL_DIRS = [
  '/sdcard/Android/obb',
  '/sdcard/Android/media',
  '/sdcard/DCIM/Camera',
  '/sdcard/Pictures',
  '/sdcard/Documents',
  '/sdcard/Music',
  '/sdcard/Movies',
  '/sdcard/Download',
  '/sdcard/Android'
]

/** Sub-paths inside Android/data that are caches, not app state. */
const APP_DATA_DELETABLE = /\/Android\/data\/[^/]+\/(cache|code_cache|files\/cache|files\/\.cache)(\/|$)/

export const TRASH_DIR_NAME = '.MangoMobileTrash'

export function trashDirFor(root: string): string {
  return `${root.replace(/\/$/, '')}/${TRASH_DIR_NAME}`
}

/**
 * A path is deletable only when it is an absolute, normalized path inside the
 * scanned volume, outside protected trees, and not one of the user's irreplaceable
 * media roots (individual files inside those roots are still fine — the rule's
 * own matcher decided that).
 */
export function validateDeletionPath(path: string, root: string): SafetyVerdict {
  if (!path.startsWith('/')) return { ok: false, reason: 'Path is not absolute' }
  if (path.includes('\0')) return { ok: false, reason: 'Path contains a null byte' }
  const segments = path.split('/')
  if (segments.some((segment) => segment === '..' || segment === '.')) {
    return { ok: false, reason: 'Path contains traversal segments' }
  }
  if (/[\r\n]/.test(path)) return { ok: false, reason: 'Path contains a line break and cannot be handled safely' }

  const normalizedRoot = root.replace(/\/$/, '')
  if (path === normalizedRoot) return { ok: false, reason: 'Refusing to remove the volume root' }
  if (!path.startsWith(`${normalizedRoot}/`)) {
    return { ok: false, reason: `Path is outside ${normalizedRoot}` }
  }

  for (const prefix of HARD_PROTECTED_PREFIXES) {
    if (path === prefix || path.startsWith(`${prefix}/`)) {
      return { ok: false, reason: `${prefix} is a protected system location` }
    }
  }

  // Trash contents are only removed by the trash purger, which passes its own flag.
  if (path.includes(`/${TRASH_DIR_NAME}/`)) {
    return { ok: false, reason: 'Recycle bin contents are managed by Trash' }
  }

  for (const dir of USER_CRITICAL_DIRS) {
    if (path === dir) return { ok: false, reason: `${dir} is a user data folder, not a file` }
  }

  if (path.includes('/Android/data/') && !APP_DATA_DELETABLE.test(path)) {
    return { ok: false, reason: 'Only cache subfolders of apps can be removed' }
  }

  return { ok: true }
}

/** Empty-directory removal is restricted to clearly disposable locations. */
export function isRemovableEmptyDir(path: string, root: string): SafetyVerdict {
  const base = validateDeletionPath(path, root)
  if (!base.ok) return base
  for (const dir of USER_CRITICAL_DIRS) {
    if (path === dir || path.startsWith(`${dir}/`)) {
      if (path.includes('/Download/') || path.includes('/Android/data/')) continue
      return { ok: false, reason: `${dir} is a user data folder` }
    }
  }
  return { ok: true }
}

/**
 * Trash names are derived from the original basename so a human can make sense of
 * the folder, prefixed with a sequence number to keep them unique.
 */
export function trashNameFor(originalPath: string, sequence: number): string {
  const base = originalPath.slice(originalPath.lastIndexOf('/') + 1)
  const safe = base.replace(/[\0\r\n]/g, '_').slice(0, 120)
  return `${String(sequence).padStart(5, '0')}_${safe}`
}
