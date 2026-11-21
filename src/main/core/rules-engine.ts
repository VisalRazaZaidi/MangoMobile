import type { DeviceCapabilities, FileEntry, Rule, RuleScanResult } from '@shared/types'
import rulesJson from './rules/android-rules.json'
import { StorageIndex, baseName, dirOf } from './storage-index'

const DAY = 86_400

/** Compiles a shell-style glob where `*` stays within one path segment. */
export function globToRegExp(pattern: string): RegExp {
  let out = '^'
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i]
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        out += '.*'
        i += 1
      } else {
        out += '[^/]*'
      }
      continue
    }
    if (char === '?') {
      out += '[^/]'
      continue
    }
    out += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`${out}$`)
}

/** Longest literal directory prefix of a glob, used to skip most candidates fast. */
export function literalPrefix(pattern: string): string {
  const wildcard = pattern.search(/[*?]/)
  const head = wildcard === -1 ? pattern : pattern.slice(0, wildcard)
  if (wildcard === -1) return head
  const slash = head.lastIndexOf('/')
  return slash <= 0 ? '/' : head.slice(0, slash)
}

type CompiledRoot = { pattern: string; scope: RegExp; exact: RegExp; prefix: string }

function compileRoots(rule: Rule): CompiledRoot[] {
  return rule.roots.map((pattern) => {
    const exact = globToRegExp(pattern)
    return {
      pattern,
      // A root matches the location itself and everything beneath it.
      scope: new RegExp(`${exact.source.slice(0, -1)}(/.*)?$`),
      exact,
      prefix: literalPrefix(pattern)
    }
  })
}

function matchesAny(globs: string[] | undefined, path: string): boolean {
  if (!globs || globs.length === 0) return false
  const name = baseName(path)
  return globs.some((glob) => {
    const regex = globToRegExp(glob)
    return regex.test(name) || regex.test(path)
  })
}

function passesFilters(rule: Rule, file: FileEntry, now: number): boolean {
  const matcher = rule.matcher
  if (matcher.include && matcher.include.length > 0) {
    if (!matchesAny(matcher.include, file.path) && !matchesAny(matcher.include, baseName(file.path))) return false
  }
  if (matcher.exclude && matchesAny(matcher.exclude, file.path)) return false
  if (matcher.minSizeBytes !== undefined && file.size < matcher.minSizeBytes) return false
  if (matcher.maxSizeBytes !== undefined && file.size > matcher.maxSizeBytes) return false
  if (matcher.olderThanDays !== undefined && matcher.olderThanDays > 0) {
    // Unknown timestamps must not be treated as old: fail closed.
    if (file.mtime <= 0) return false
    if (now - file.mtime < matcher.olderThanDays * DAY) return false
  }
  return true
}

export function loadRules(): Rule[] {
  return rulesJson as Rule[]
}

/** Startup validation: a malformed rule should stop the app, not delete the wrong thing. */
export function validateRules(rules: Rule[]): string[] {
  const problems: string[] = []
  const seen = new Set<string>()
  for (const rule of rules) {
    if (!/^[a-z0-9._-]+$/.test(rule.id)) problems.push(`Invalid rule id: ${rule.id}`)
    if (seen.has(rule.id)) problems.push(`Duplicate rule id: ${rule.id}`)
    seen.add(rule.id)
    if (!rule.roots.length) problems.push(`Rule ${rule.id} has no roots`)
    for (const root of rule.roots) {
      if (!root.startsWith('/')) problems.push(`Rule ${rule.id} has a non-absolute root: ${root}`)
      if (root.includes('..')) problems.push(`Rule ${rule.id} has a traversal root: ${root}`)
    }
    if (rule.defaultSelected && rule.risk !== 'safe') {
      problems.push(`Rule ${rule.id} is default-selected but not marked safe`)
    }
  }
  return problems
}

export type RulePreviewOptions = {
  index: StorageIndex
  capabilities: DeviceCapabilities
  now?: number
}

const CAPABILITY_MESSAGES: Partial<Record<keyof DeviceCapabilities, string>> = {
  androidDataReadable:
    'Android 11 and later hide Android/data from USB debugging, so these caches cannot be read or removed from a computer. Use Apps → Trim system caches, or clean from the phone.'
}

/**
 * Evaluates every rule against the index. Rules never touch the device; this is
 * a pure projection of already-scanned data, which is why previews are instant.
 */
export function previewRules(options: RulePreviewOptions, selectedRules?: Rule[]): RuleScanResult[] {
  const { index, capabilities } = options
  const now = options.now ?? Math.floor(Date.now() / 1000)
  const rules = selectedRules ?? loadRules()
  const results: RuleScanResult[] = []

  for (const rule of rules) {
    if (rule.requiresCapability && !capabilities[rule.requiresCapability]) {
      results.push({
        rule,
        items: [],
        totalBytes: 0,
        skippedReason: CAPABILITY_MESSAGES[rule.requiresCapability] ?? 'This device does not support the required capability.',
        unreadable: ['/sdcard/Android/data']
      })
      continue
    }

    const compiled = compileRoots(rule)
    const items: FileEntry[] = []
    const target = rule.matcher.target ?? 'dirContents'

    if (target === 'dir') {
      for (const dir of index.allDirs()) {
        if (index.bytesIn(dir) !== 0) continue
        if (!compiled.some((root) => root.exact.test(dir))) continue
        if (rule.matcher.exclude && matchesAny(rule.matcher.exclude, dir)) continue
        items.push({ path: dir, size: 0, mtime: 0, isDirectory: true })
      }
      results.push({ rule, items, totalBytes: 0, unreadable: [] })
      continue
    }

    // Narrow the candidate set with the literal prefix before running regexes.
    const prefixes = compiled.map((root) => root.prefix).sort((a, b) => a.length - b.length)
    for (const file of index.files) {
      const inPrefix = prefixes.some((prefix) => file.path.startsWith(prefix))
      if (!inPrefix) continue
      const matched = compiled.some((root) => (target === 'dirContents' ? root.scope : root.scope).test(file.path))
      if (!matched) continue
      if (!passesFilters(rule, file, now)) continue
      items.push(file)
    }

    items.sort((a, b) => b.size - a.size)
    results.push({
      rule,
      items,
      totalBytes: items.reduce((sum, item) => sum + item.size, 0),
      unreadable: []
    })
  }

  return results
}

/**
 * Rules legitimately overlap: an old *.log file matches both "temporary files"
 * and "application logs". A preview is also the delete plan, so each path may
 * only be counted (and removed) once. The first rule in display order keeps it.
 */
export function dedupePreviewResults(results: RuleScanResult[]): RuleScanResult[] {
  const claimed = new Set<string>()
  for (const result of results) {
    if (result.items.length === 0) continue
    const unique = result.items.filter((item) => {
      if (claimed.has(item.path)) return false
      claimed.add(item.path)
      return true
    })
    if (unique.length === result.items.length) continue
    result.items = unique
    result.totalBytes = unique.reduce((sum, item) => sum + item.size, 0)
  }
  return results
}

/** Directories a rule would remove, used by the cleaner for the folder rule. */
export function emptyDirCandidates(index: StorageIndex, rule: Rule): string[] {
  if (rule.matcher.target !== 'dir') return []
  const compiled = compileRoots(rule)
  return index
    .allDirs()
    .filter((dir) => index.bytesIn(dir) === 0 && compiled.some((root) => root.exact.test(dir)))
    .filter((dir) => !rule.matcher.exclude || !matchesAny(rule.matcher.exclude, dir))
    .filter((dir) => dir !== index.root)
}

export { matchesAny, passesFilters, dirOf }
