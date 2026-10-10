import { safeRegexpTest } from '../classifier/pattern-matcher.ts'

export type PermissionState = 'allow' | 'deny' | 'ask'

export interface Rule {
  surface: string
  pattern: string
  action: PermissionState
  reason?: string
  origin?: string
  priority?: number
  isExact?: boolean
}

export type Ruleset = Rule[]

export function globToRegex(pattern: string): string {
  // Do NOT escape `?`: it is a single-char wildcard (consistent with
  // ruleSpecificity counting `?` as a wildcard). Convert `?`->`.`, `*`->`.*`.
  // JS `\s` does NOT include NBSP (U+00A0), so replace literal space-runs
  // with `[,\t\u00a0]+` (matches tab, NBSP, space — excludes \n\r\f\v)
  // and use `(?:^|[\s\u00a0\\/])` for the token-boundary anchor.
  //
  // L3 fix: `/` and `\` (path separators) are now valid boundaries, so an
  // fs `deny` for a path segment matches on both POSIX (`/home/x/secrets`)
  // and Windows (`C:\Users\x\secrets`) paths.
  //
  // M4 fix: include zero-width chars (U+200B, U+FEFF) and other Unicode
  // whitespace in the token-boundary anchor so patterns with zero-width
  // character injection are still caught.
  //
  // The returned string body is fed to `safeRegexpTest` (ReDoS-guarded, with
  // a wall-clock deadline + structural detection) instead of a raw
  // `RegExp(...).test(...)` (M1 fix — prevents catastrophic backtracking).
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  const inner = escaped
    .replaceAll('*', '.*')
    .replaceAll('?', '.')
    .replace(/[ \t]+/g, '[\\t\\u00a0 ]+')
  // M4: add zero-width chars and Unicode whitespace to boundary anchor
  return `(?:^|[\\s\\u00a0\\\\/\u200b\ufeff])${inner}`
}

export function ruleMatches(
  rule: Rule,
  surface: string,
  value: string
): boolean {
  if (rule.surface !== surface && rule.surface !== '*') return false
  if (rule.surface === '*' && rule.pattern !== '*') return false
  const body = globToRegex(rule.pattern)
  // M1 fix: route through the ReDoS-guarded `safeRegexpTest` (structural
  // detection + hard wall-clock deadline) instead of a direct `RegExp.test`.
  return safeRegexpTest(body, value)
}
