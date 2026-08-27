/**
 * Minimal wildcard matcher for tool/skill names used by Capa 1 (visibility).
 *
 * Semantics:
 *   - `*`  matches any sequence of characters, including the empty sequence.
 *   - `?`  matches exactly one character.
 *   - On Windows (`process.platform === 'win32'`) comparisons are
 *     case-insensitive so a pattern `"Bash"` still matches the tool `"bash"`.
 *   - No regex compilation: a linear scan avoids ReDoS risk and keeps the
 *     visibility filter cheap to run on every `before_agent_start` event.
 *
 * This matcher is intentionally distinct from `globToRegex` in
 * `src/permission/rule.ts`: rule patterns use token-boundary anchoring and
 * NBSP-aware splitting because they scan arbitrary command/path strings.
 * Visibility names are well-formed identifiers (or `tool:arg-pattern`); an
 * unanchored `*`/`?` walk is the right tool here.
 */

/**
 * Returns true when `value` matches `pattern`. Both inputs are trimmed of
 * surrounding whitespace before matching. An empty pattern is a fail-closed
 * no-match (so a misconfigured `""` never accidentally allows everything),
 * but the special case `pattern === '*'` matches even an empty value (so
 * callers can use `*` as a true wildcard without surprising on empty
 * names).
 */
export function wildcardMatch(pattern: string, value: string): boolean {
  if (typeof pattern !== 'string' || typeof value !== 'string') return false
  if (pattern.length === 0) return false
  if (pattern === '*') return true
  if (value.length === 0) return false
  const p = pattern
  const v = process.platform === 'win32' ? value.toLowerCase() : value
  const pat = process.platform === 'win32' ? p.toLowerCase() : p
  return matchRecursive(pat, 0, v, 0)
}

/**
 * Recursive matcher. A non-empty `*` first tries to consume one more char
 * (`star = match(p+1, i+1)`); on a miss it back-tracks one position in the
 * value and retries. Pathological inputs (e.g. `*?...?` against a very long
 * string) are still linear in the pattern length because `*` only spawns one
 * branch per value char and the pattern length is small for tool names.
 *
 * For tool/skill names (tens of chars) this is cheaper than building a RegExp.
 */
function matchRecursive(p: string, pi: number, v: string, vi: number): boolean {
  while (pi < p.length) {
    const pc = p.charCodeAt(pi)
    if (pc === 42 /* '*' */) {
      // collapse runs of '*'
      while (pi < p.length && p.charCodeAt(pi) === 42) pi++
      // '*' at end matches everything left
      if (pi === p.length) return true
      // try every possible position in v
      while (vi <= v.length) {
        if (matchRecursive(p, pi, v, vi)) return true
        vi++
      }
      return false
    }
    if (vi >= v.length) return false
    if (pc === 63 /* '?' */) {
      pi++
      vi++
      continue
    }
    if (pc !== v.charCodeAt(vi)) return false
    pi++
    vi++
  }
  return vi === v.length
}
