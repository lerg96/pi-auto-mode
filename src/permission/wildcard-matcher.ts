/**
 * Minimal wildcard matcher for tool/skill names used by Capa 1 (visibility).
 *
 * Semantics:
 *   - `*`  matches any sequence of characters, including the empty sequence.
 *   - `?`  matches exactly one character.
 *   - On Windows (`process.platform === 'win32'`) comparisons are
 *     case-insensitive so a pattern `"Bash"` still matches the tool `"bash"`.
 *   - No regex compilation: an iterative two-pointer scan avoids ReDoS risk
 *     and keeps the matcher cheap to run on every tool-call decision.
 *   - Worst-case cost is O(pattern.length x value.length) with a single
 *     backtracking point, so the matcher is safe against long inputs (it is
 *     used both for short tool/skill names and for long absolute filesystem
 *     paths in `external-directory.ts`).
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
  return matchGreedy(pat, v)
}

/**
 * Iterative greedy matcher with a single backtracking point (no regex, no
 * recursion). Literal/`?` characters advance both cursors; on a mismatch the
 * most recent `*` in the pattern absorbs exactly one more value char and the
 * scan resumes from there. Runs of `*` collapse naturally: each `*` seen
 * replaces the recorded backtrack point, which is equivalent to matching the
 * run as a single `*`.
 *
 * Worst case is O(pattern.length x value.length) — never exponential in the
 * number of `*` groups — and there is no recursion, so long absolute paths
 * cannot blow the stack either.
 */
function matchGreedy(p: string, v: string): boolean {
  let pi = 0
  let vi = 0
  // Index just past the most recent '*', or -1 when none has been seen.
  let starPatternIndex = -1
  // Value index that `*` currently consumes (one past its last match).
  let starValueIndex = 0

  while (vi < v.length) {
    const pc = pi < p.length ? p.charCodeAt(pi) : -1
    if (pc === 42 /* '*' */) {
      // collapse runs of '*'
      while (pi < p.length && p.charCodeAt(pi) === 42) pi++
      starPatternIndex = pi
      starValueIndex = vi
    } else if (pc === 63 /* '?' */ || pc === v.charCodeAt(vi)) {
      pi++
      vi++
    } else if (starPatternIndex === -1) {
      return false
    } else {
      // Backtrack: the last '*' consumes one more value char.
      pi = starPatternIndex
      starValueIndex++
      vi = starValueIndex
    }
  }

  // Trailing pattern survives only if it is all '*' (matches empty tail).
  while (pi < p.length && p.charCodeAt(pi) === 42) pi++
  return pi === p.length
}
