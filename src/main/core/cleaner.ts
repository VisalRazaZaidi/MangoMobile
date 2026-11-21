import type { CleanupResult, FileEntry } from '@shared/types'
import type { DeviceTransport } from '../adb/transport'
import { isRemovableEmptyDir, trashNameFor, validateDeletionPath } from './safety'

export type CleanupRequest = {
  files: FileEntry[]
  /** Directories to remove (empty folder rule) */
  dirs: string[]
  moveToTrash: boolean
  trashDir: string
  opId: string
  ruleIds: string[]
}

export type CleanupHooks = {
  onProgress?: (done: number, total: number) => void
}

/**
 * Executes a cleanup plan.
 *
 * Order of operations matters for safety:
 * 1. Every path is re-validated against the safety invariants (never trust a rule).
 * 2. The plan is applied to the device in a handful of batched commands.
 * 3. The result is verified by asking the device what still exists; the freed
 *    figure counts only files that are confirmed gone.
 */
export async function executeCleanup(
  transport: DeviceTransport,
  root: string,
  request: CleanupRequest,
  hooks: CleanupHooks = {}
): Promise<CleanupResult> {
  const startedAt = Date.now()
  const failures: { path: string; reason: string }[] = []
  const accepted: FileEntry[] = []
  const seenPaths = new Set<string>()

  for (const file of request.files) {
    // Overlapping rules or a stale renderer payload may repeat a path; deleting
    // it twice would fail the second time and understate the recycle bin.
    if (seenPaths.has(file.path)) continue
    seenPaths.add(file.path)
    const verdict = validateDeletionPath(file.path, root)
    if (!verdict.ok) failures.push({ path: file.path, reason: verdict.reason })
    else accepted.push(file)
  }
  const acceptedDirs: string[] = []
  for (const dir of request.dirs) {
    if (seenPaths.has(dir)) continue
    seenPaths.add(dir)
    const verdict = isRemovableEmptyDir(dir, root)
    if (!verdict.ok) failures.push({ path: dir, reason: verdict.reason })
    else acceptedDirs.push(dir)
  }

  const total = accepted.length + acceptedDirs.length
  let processed = 0
  hooks.onProgress?.(0, total)
  const tick = () => {
    processed += 1
    if (processed % 25 === 0 || processed === total) hooks.onProgress?.(processed, total)
  }

  const movedPairs: { from: string; to: string; size: number }[] = []
  let survivors: Set<string>
  let trashOpDir: string | undefined

  if (request.moveToTrash && accepted.length > 0) {
    trashOpDir = `${request.trashDir}/${request.opId}`
    accepted.forEach((file, index) => {
      movedPairs.push({
        from: file.path,
        to: `${trashOpDir}/${trashNameFor(file.path, index + 1)}`,
        size: file.size
      })
    })
    const result = await transport.moveFiles(movedPairs.map(({ from, to }) => ({ from, to })))
    for (const failure of result.failed) failures.push(failure)
    for (const _ of result.done) tick()

    const failedPaths = new Set(result.failed.map((failure) => failure.path))
    // A manifest on the device makes the recycle bin self-describing, even if this app is removed.
    try {
      const manifest = [
        '# MangoMobile recycle bin manifest',
        `# operation\t${request.opId}`,
        '# original\tstored\tsize\tmtime',
        ...movedPairs
          .filter((pair) => !failedPaths.has(pair.from))
          .map((pair) => {
            const file = accepted.find((candidate) => candidate.path === pair.from)
            return `${pair.from}\t${pair.to}\t${file?.size ?? 0}\t${file?.mtime ?? 0}`
          })
      ].join('\n')
      await transport.writeTextFile(`${trashOpDir}/manifest.tsv`, manifest)
    } catch {
      // The manifest is a convenience; the operation itself already succeeded.
    }
    survivors = await transport.existingPaths(accepted.map((file) => file.path))
  } else {
    const result = await transport.deleteFiles(accepted.map((file) => file.path))
    for (const failure of result.failed) failures.push(failure)
    for (const _ of result.done) tick()
    survivors = await transport.existingPaths(accepted.map((file) => file.path))
  }

  let removedDirCount = 0
  if (acceptedDirs.length > 0) {
    const result = await transport.removeEmptyDirs(acceptedDirs)
    for (const failure of result.failed) failures.push(failure)
    for (const _ of result.done) tick()
    const dirSurvivors = await transport.existingPaths(acceptedDirs)
    removedDirCount = acceptedDirs.filter((dir) => !dirSurvivors.has(dir)).length
  }

  const goneFiles = accepted.filter((file) => !survivors.has(file.path))
  const freedBytes = goneFiles.reduce((sum, file) => sum + file.size, 0)
  // Anything that survived the first pass is reported once, with the shell's reason when known.
  for (const file of accepted) {
    if (survivors.has(file.path) && !failures.some((failure) => failure.path === file.path)) {
      failures.push({ path: file.path, reason: 'File is still present after the operation' })
    }
  }

  const failedPaths = new Set(failures.map((failure) => failure.path))
  return {
    opId: request.opId,
    deletedCount: goneFiles.length + removedDirCount,
    failedCount: failures.length,
    freedBytes,
    failures: dedupeFailures(failures),
    verified: failures.length === 0,
    durationMs: Date.now() - startedAt,
    trashDir: trashOpDir,
    trashEntries: trashOpDir
      ? movedPairs
          .filter((pair) => !failedPaths.has(pair.from) && !survivors.has(pair.from))
          .map((pair) => ({ original: pair.from, stored: pair.to, size: pair.size }))
      : undefined
  }
}

function dedupeFailures(failures: { path: string; reason: string }[]): { path: string; reason: string }[] {
  const seen = new Map<string, string>()
  for (const failure of failures) {
    if (!seen.has(failure.path)) seen.set(failure.path, failure.reason)
  }
  return [...seen.entries()].map(([path, reason]) => ({ path, reason }))
}

/** Restores files from the recycle bin back to their original locations. */
export async function restoreFromTrash(
  transport: DeviceTransport,
  entries: { original: string; stored: string }[]
): Promise<CleanupResult> {
  const startedAt = Date.now()
  const pairs = entries.map((entry) => ({ from: entry.stored, to: entry.original }))
  const result = await transport.moveFiles(pairs)
  const survivors = await transport.existingPaths(pairs.map((pair) => pair.from))
  const restored = pairs.filter((pair) => !survivors.has(pair.from))
  return {
    opId: `restore-${startedAt}`,
    deletedCount: restored.length,
    failedCount: result.failed.length,
    freedBytes: 0,
    failures: result.failed,
    verified: result.failed.length === 0,
    durationMs: Date.now() - startedAt
  }
}

/** Permanently removes recycle-bin contents. */
export async function purgeTrash(transport: DeviceTransport, storedPaths: string[]): Promise<CleanupResult> {
  const startedAt = Date.now()
  const result = await transport.deleteFiles(storedPaths)
  const survivors = await transport.existingPaths(storedPaths)
  return {
    opId: `purge-${startedAt}`,
    deletedCount: storedPaths.filter((path) => !survivors.has(path)).length,
    failedCount: result.failed.length,
    freedBytes: 0,
    failures: result.failed,
    verified: survivors.size === 0,
    durationMs: Date.now() - startedAt
  }
}
