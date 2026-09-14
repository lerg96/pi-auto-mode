import { homedir } from 'node:os'
import { isAbsolute, normalize, relative, resolve, sep } from 'node:path'
import type { Config, SimpleAction } from '../types/config.ts'
import { wildcardMatch } from './wildcard-matcher.ts'

// Local structural intent — deliberately NOT imported from gate/normalize.ts
// to avoid an import cycle (gate imports this module).
export interface ExternalIntent {
  surface: string
  value: string
}

export interface ExternalVerdict {
  action: SimpleAction
  pattern?: string
  absPath: string
  /** Intent that produced absPath — reporting shows the trigger, not intent[0]. */
  matchedValue?: string
  matchedSurface?: string
}

/**
 * Expands `~` / `$HOME` / `${HOME}` prefixes. Used for candidate paths
 * AND external_directory glob keys, so user-written `~/projects/**`
 * matches resolved absolute paths.
 */
function expandHomePrefix(p: string): string {
  const trimmed = p.trim()
  if (
    trimmed === '~' ||
    trimmed.startsWith('~/') ||
    trimmed.startsWith('~\\')
  ) {
    return homedir() + trimmed.slice(1)
  }
  if (
    trimmed === '$HOME' ||
    trimmed.startsWith('$HOME/') ||
    trimmed.startsWith('$HOME\\')
  ) {
    return homedir() + trimmed.slice(5)
  }
  if (trimmed.startsWith('${HOME}')) {
    return homedir() + trimmed.slice(7)
  }
  return trimmed
}

/**
 * Rewrites MSYS2/Git-Bash drive paths (`/c/Users/...` → `C:/Users/...`).
 * Win32-only: on POSIX `/c/...` is a legitimate absolute path and must
 * NOT be rewritten. A lone `/<letter>` (no trailing slash) means the
 * drive root. Anything else (`/cmd/...`) passes through untouched.
 */
function expandMsysDrive(p: string): string {
  if (process.platform !== 'win32') return p
  const trimmed = p.trim()
  const m = /^\/([a-zA-Z])(?:\/(.*))?$/.exec(trimmed)
  if (!m) return p
  const drive = (m[1] as string).toUpperCase()
  const rest = m[2] ?? ''
  return `${drive}:/${rest}`
}

// Safe sinks with identical meaning on POSIX and MSYS2/Git-Bash shells:
// reads/writes there never touch real files, inside or outside the cwd.
const POSIX_SINKS = new Set([
  '/dev/null',
  '/dev/zero',
  '/dev/stdin',
  '/dev/stdout',
  '/dev/stderr',
  '/dev/tty',
])

// Bare DOS device names. Reserved (uncreatable as files) on Windows, but
// ordinary filenames on POSIX — so only honored on win32.
const DOS_DEVICES = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9',
])

/**
 * True when a raw (pre-resolution) token names a device/sink rather than
 * a real file: `/dev/null`, MSYS `/dev/*` (no real tree on win32), bare
 * DOS devices (`NUL`, `nul.txt`) on win32. Such tokens can never escape
 * the working directory, so the scope ignores them. Case-insensitive.
 */
function isDevicePath(raw: string): boolean {
  const t = raw
    .trim()
    .replace(/[/\\]+$/, '')
    .toLowerCase()
  if (t.length === 0) return false
  if (POSIX_SINKS.has(t)) return true
  if (process.platform !== 'win32') return false
  if (t === '/dev' || t === '\\dev' || t.startsWith('/dev/')) return true
  if (t.startsWith('\\dev\\')) return true
  // Windows also reserves `nul.txt`-style names: compare pre-extension.
  return DOS_DEVICES.has(t.split('.')[0])
}

// Lone string-escape debris (`\n`, `\t`, …) from dequoted inline scripts
// (`node -e "..."`, `sh -c '...'`). Quote stripping exposes these
// fragments as bare `\X` tokens — rooted (thus "absolute") on win32,
// but never a path anyone means. Skipped, never scoped.
const ESCAPE_DEBRIS = new Set([
  '\\n',
  '\\t',
  '\\r',
  '\\0',
  '\\\\',
  "\\'",
  '\\"',
])

function isEscapeDebris(raw: string): boolean {
  return ESCAPE_DEBRIS.has(raw.trim())
}

// Lone `/X` (slash + single letter) on win32 is almost always a cmd-style
// flag (`dir /b`, `cmd /c`) rather than a path. Skipped in shell extraction
// only: structured fs values keep `/X` as a real absolute path, and posix
// keeps it too (flags use `-` there). Bare MSYS drive roots (`/c`) are the
// accepted blind spot (navigation-ish, documented); drives with a real path
// (`/c/...`) still rewrite via expandMsysDrive.
const LONE_SLASH_LETTER = /^\/[A-Za-z]$/

function isWindowsFlagArg(raw: string): boolean {
  if (process.platform !== 'win32') return false
  if (raw.includes("'") || raw.includes('"')) return false
  return LONE_SLASH_LETTER.test(raw.trim())
}

// Fragments starting with `{`/`}` come from shredded quoted expressions
// (`sed 's/a {…/…/'` — quotes are stripped upstream, so spaces split the
// expression and stripToken eats the brace). Real paths never start with
// a brace (beyond exotic brace-expansion, an accepted blind spot).
function isBraceFragment(raw: string): boolean {
  const t = raw.trimStart()
  return t.startsWith('{') || t.startsWith('}')
}

// Bare slash runs (`//`, `\\`) are regex debris (searching URLs/comments:
// `grep "//"`), not paths. Single `/` still counts (root listing asks).
const BARE_SLASH_RUN = /^[/\\]{2,}$/

function isBareSlashRun(cand: string): boolean {
  return BARE_SLASH_RUN.test(cand.trim())
}

// Rooted regex debris (`\.dp` from shredded `rg "\.dp|…"`, `\4`
// backrefs): a real rooted path starts with a letter (`\tmp`,
// `\Windows`). `\*`/`\?` stay (glob-legit, fail-closed) and a lone
// `\` (drive root) still counts.
const ROOTED_REGEX_DEBRIS = /^\\[^A-Za-z*?]/

function isRootedRegexDebris(cand: string): boolean {
  return ROOTED_REGEX_DEBRIS.test(cand)
}

// A bare lowercase drive token (`p:` from `for p in …:`) is loop-variable
// debris, not a path: win32 resolves `p:` drive-relative (usually outside
// the cwd). Uppercase (`C:`, `D:`) still counts — real cross-drive refs.
const BARE_LOWER_DRIVE = /^[a-z]:$/

function isBareLowerDrive(cand: string): boolean {
  return BARE_LOWER_DRIVE.test(cand.trim())
}

// A quoted token that is only separators, spaces and wildcards (`"\*"`,
// `"/*"`) is a dequoted glob/pattern fragment (e.g. a grep regex), not a
// path argument. Unquoted `\*` still counts (fail-closed: `del \*`).
const QUOTED_PURE_GLOB = /^[\\/][\\/ *?]*[*?][\\/ *?]*$/

// NOTE: call with the pre-strip token — stripToken removes the quotes
// this check looks for.
function isQuotedPureGlob(raw: string): boolean {
  if (!raw.includes("'") && !raw.includes('"')) return false
  return QUOTED_PURE_GLOB.test(stripToken(raw))
}

// Code punctuation: paths carrying these come from tokenized source
// (`node -e` bodies, regex bits), not from real file arguments.
const CODE_PUNCT = /[(){},;]/

/**
 * Reason quality for default asks: name the longest clean outside path
 * (usually the actual target) instead of the first soup fragment.
 * Falls back to the first outside path when nothing is clean.
 * Verdict membership is unaffected (fail-closed: every outside path
 * still forces at least ask).
 */
function reasonPathFor(outside: string[]): string {
  const first = outside[0] as string
  let best = ''
  for (const p of outside) {
    if (!CODE_PUNCT.test(p) && p.length > best.length) best = p
  }
  return best === '' ? first : best
}

/**
 * Expands MSYS drive + home prefixes and resolves relatives against cwd.
 * Returns a normalized absolute path.
 */
export function resolveFsPath(p: string, cwd: string): string {
  const expanded = expandHomePrefix(expandMsysDrive(p))
  if (isAbsolute(expanded)) return normalize(expanded)
  return resolve(cwd, expanded)
}

/**
 * True when absPath lies outside cwd. Same dir = inside. Case-insensitive
 * on Windows. A different drive (isAbsolute(relative)) counts as outside.
 */
export function isOutsideCwd(absPath: string, cwd: string): boolean {
  const normCwd = normalize(resolve(cwd))
  const normAbs = normalize(
    isAbsolute(absPath) ? absPath : resolve(cwd, absPath)
  )
  const c = process.platform === 'win32' ? normCwd.toLowerCase() : normCwd
  const a = process.platform === 'win32' ? normAbs.toLowerCase() : normAbs
  if (a === c) return false
  const rel = relative(c, a)
  if (rel.length === 0) return false
  if (rel === '..' || rel.startsWith(`..${sep}`)) return true
  if (isAbsolute(rel)) return true
  return false
}

const SHELL_SPLITTERS = new Set([';', '&', '|', '(', ')', '<', '>', '`'])

function tokenizeShell(segment: string): string[] {
  const tokens: string[] = []
  let buf = ''
  let quote: "'" | '"' | null = null
  const flush = () => {
    if (buf.length > 0) {
      tokens.push(buf)
      buf = ''
    }
  }
  let i = 0
  while (i < segment.length) {
    const c = segment[i] as string
    if (quote) {
      if (c === quote) {
        buf += c // preserve closing quote: quotedness is signal (globs)
        quote = null
        i++
        continue
      }
      buf += c
      i++
      continue
    }
    if (c === "'" || c === '"') {
      buf += c // preserve opening quote: quotedness is signal (globs)
      quote = c
      i++
      continue
    }
    if (c === ' ' || c === '\t' || c === '\n' || SHELL_SPLITTERS.has(c)) {
      flush()
      i++
      continue
    }
    buf += c
    i++
  }
  flush()
  return tokens
}

function stripToken(t: string): string {
  return t.replace(/^['"`[{(]+|['"`\]},;]+$/g, '')
}

function isPathLike(token: string): boolean {
  if (token.includes('/') || token.includes('\\')) return true
  if (token.startsWith('~')) return true
  if (token === '.' || token === '..') return true
  if (
    token.startsWith('./') ||
    token.startsWith('.\\') ||
    token.startsWith('../') ||
    token.startsWith('..\\')
  )
    return true
  if (
    token === '$HOME' ||
    token.startsWith('$HOME/') ||
    token.startsWith('$HOME\\') ||
    token.startsWith('${HOME}')
  )
    return true
  if (/^[A-Za-z]:/.test(token)) return true
  return false
}

/**
 * Extracts path-like tokens from a shell segment, quote-aware. Skips flags
 * (`-*`), URLs (`://`), device sinks (`/dev/null`, `NUL`, …), escape
 * debris (`\n`) and bare operators/words. For `key=value` tokens only
 * the value part is
 * considered.
 */
export function extractBashPaths(segment: string): string[] {
  const out: string[] = []
  const push = (cand: string): void => {
    // A lone `/` right after a sed-substitution head (`s/a/ /` shredded by
    // dequoting) is expression debris, not the root dir. The head needs two
    // slashes (`s/a/…`) so a relative path (`s/a`) + `/` still counts.
    const prev = out[out.length - 1]
    if (cand === '/' && prev !== undefined && /^s\/.*\//.test(prev)) return
    out.push(cand)
  }
  for (const token of tokenizeShell(segment)) {
    const eq = token.lastIndexOf('=')
    const raw = eq >= 0 ? token.slice(eq + 1) : token
    const cand = stripToken(raw)
    if (cand.length === 0) continue
    if (cand.startsWith('-')) continue
    if (cand.includes('://')) continue
    if (!isPathLike(cand)) continue
    if (isDevicePath(cand)) continue
    if (isEscapeDebris(cand)) continue
    if (isWindowsFlagArg(cand)) continue
    if (isQuotedPureGlob(raw)) continue
    if (isBraceFragment(raw)) continue
    if (isBareSlashRun(cand)) continue
    if (isRootedRegexDebris(cand)) continue
    if (isBareLowerDrive(cand)) continue
    push(cand)
  }
  return out
}

/**
 * Evaluates the external_directory scope. Returns undefined (no opinion) when
 * the flag is off, when no intent touches a path outside cwd, or when all
 * values are internal. Otherwise returns the explicit glob match (last match
 * across sources, last matching key within a map) or a default 'ask'.
 * Never throws: any evaluation error resolves to a fail-closed deny.
 */
export function evaluateExternalDirectory(
  cfg: Config,
  intents: ExternalIntent[],
  cwd?: string
): ExternalVerdict | undefined {
  try {
    if (cfg.confineToWorkingDirectory !== true) return undefined
    const base = cwd ?? process.cwd()
    const outside: Array<{ abs: string; value: string; surface: string }> = []
    for (const intent of intents) {
      if (intent.surface === 'fs') {
        if (intent.value === '*') continue
        if (isDevicePath(intent.value)) continue
        if (isEscapeDebris(intent.value)) continue
        if (isQuotedPureGlob(intent.value)) continue
        const abs = resolveFsPath(intent.value, base)
        if (isOutsideCwd(abs, base))
          outside.push({ abs, value: intent.value, surface: intent.surface })
      } else if (intent.surface === 'shell') {
        for (const cand of extractBashPaths(intent.value)) {
          const abs = resolveFsPath(cand, base)
          if (isOutsideCwd(abs, base))
            outside.push({ abs, value: intent.value, surface: intent.surface })
        }
      }
      // Custom surfaces: no opinion.
    }
    if (outside.length === 0) return undefined
    const sources: Array<Record<string, SimpleAction> | undefined> = [
      cfg.permissions.external_directory,
    ]
    for (const setId of cfg.activePermissionSets ?? []) {
      sources.push(cfg.permissionSets[setId]?.permissions.external_directory)
    }
    let action: SimpleAction | undefined
    let pattern: string | undefined
    let matchedAbs: string | undefined
    for (const map of sources) {
      if (!map) continue
      for (const key of Object.keys(map)) {
        const candidate: SimpleAction = map[key] as SimpleAction
        if (
          candidate !== 'allow' &&
          candidate !== 'deny' &&
          candidate !== 'ask'
        )
          continue
        // Expand MSYS-drive + home prefixes (and normalize separators) so
        // globs like `~/projects/**` or `/c/work/**` match resolved paths.
        const expandedKey = normalize(expandHomePrefix(expandMsysDrive(key)))
        const hit = outside.find((o) => wildcardMatch(expandedKey, o.abs))
        if (hit !== undefined) {
          action = candidate
          pattern = key
          matchedAbs = hit.abs
        }
      }
    }
    const first = outside[0] as {
      abs: string
      value: string
      surface: string
    }
    if (action !== undefined) {
      const trigger = outside.find((o) => o.abs === matchedAbs) ?? first
      return {
        action,
        pattern,
        absPath: matchedAbs ?? first.abs,
        matchedValue: trigger.value,
        matchedSurface: trigger.surface,
      }
    }
    const reasonAbs = reasonPathFor(outside.map((o) => o.abs))
    const trigger = outside.find((o) => o.abs === reasonAbs) ?? first
    return {
      action: 'ask',
      pattern: undefined,
      absPath: reasonAbs,
      matchedValue: trigger.value,
      matchedSurface: trigger.surface,
    }
  } catch {
    return { action: 'deny', pattern: '*', absPath: '(evaluation error)' }
  }
}
