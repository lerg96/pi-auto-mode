// Pattern matcher for block rules (Milestone M4-T1).
// Supports plain substrings, `regex:`-prefixed patterns, and glob patterns,
// with a robust ReDoS guard that rejects unsafe patterns and enforces a
// wall-clock deadline on regex execution.

import { runInNewContext } from 'node:vm'
import { splitShellSegments } from '../gate/normalize.ts'

const REGEX_PREFIX = 'regex:'
const GLOB_METACHARS = /[*?[{}]/

/**
 * Wall-clock budget for a single RegExp execution under `safeRegexpTest`.
 *
 * The original M5 value was `5ms`. Under heavy CPU contention (e.g. Jest's
 * default 1-worker-per-CPU schedule, where `pattern-matcher.test.ts` and
 * `rule-evaluator.test.ts` run concurrently across workers and contend for
 * time slices), a single `vm.runInNewContext('new RegExp(...).test(...)')`
 * call routinely takes 10–20ms — measured on the development Windows host
 * with 32 logical CPUs and on Linux runners. The 5ms budget tripped
 * false-positives under load: `safeRegexpTest` returned `true` (fail-closed),
 * which made `PatternMatcher.match()` report a glob match that the regex
 * itself does not produce. The downstream effect was flaky tests
 * (`pattern-matcher.test.ts`, `rule-evaluator.test.ts`,
 * `permission/rule.test.ts`) plus spurious `ask`/`block` verdicts in the
 * LLM classifier under load.
 *
 * Catastrophic patterns (the only legitimate reason for this timeout) are
 * already caught by `looksReDoSy` before `runInNewContext` runs — that
 * structural check covers `(a+)+`, `(a*)*`, `(?:a|b)+`, `([a-z]+)+`, etc.
 * The wall-clock timeout is a backstop for patterns that LOOK benign but
 * backtrack exponentially in pathological inputs. 50ms is a generous margin
 * for legitimate patterns under contention while still aborting genuinely
 * catastrophic ones well below the 200ms ceiling asserted by
 * `test/permission/rule.test.ts`.
 */
const REGEXP_TIMEOUT_MS = 50

/** Case-insensitive substring match of a clean (prefix-free) pattern. */
function submatch(needle: string, text: string): boolean {
  return text.toLowerCase().includes(needle.toLowerCase())
}

// Structural ReDoS pattern detectors — covers all major catastrophic backtracking shapes.
const UNSAFE_RE_PATTERNS: RegExp[] = [
  // Group with inner quantifier followed by outer quantifier: (a+)+, (a*)*, (a{2,})+
  /\([^()]*[+*{][^()]*\)\s*[+*?{]/,
  // Nested groups with quantifier: ((x)+)+
  /\(\([^()]*\)\s*[+*?{]\)/,
  // Quantified alternation: (?:a|b)+, (a|b)*
  /\(\?:[^()]*\|[^()]*\)\s*[+*?{]/,
  /\([^()|]+\|[^()|]*\)\s*[+*?{]/,
  // Character class with quantifier inside group, then outer quantifier: ([a-z]+)+
  /\(\[[^\]]*\]\s*[+*?{][^)]*\)\s*[+*?{]/,
  // Optional inside group followed by quantifier: (a?)+
  /\([^()]*\?\)\s*[+*]/,
  // Adjacent quantifiers: ** or ++ or *+ or ?*
  /[*+?]\s*[*+?{]/,
  // Quantifier range {n,m} followed by another quantifier
  /\{[^}]*\}\s*[*+?]/,
  // Back-reference inside group with outer quantifier
  /\\\d[^)]*\)\s*[+*?{]/,
]

/** Returns true if `body` contains structural patterns known to cause catastrophic backtracking. */
function looksReDoSy(body: string): boolean {
  return UNSAFE_RE_PATTERNS.some((p) => p.test(body))
}

/**
 * Execute a RegExp test with a hard wall-clock deadline.
 * Uses `vm.runInNewContext` with a timeout so truly exponential
 * patterns are **aborted** rather than blocking the event loop.
 * Falls back to substring match on timeout or compile error.
 */
export function safeRegexpTest(
  body: string,
  text: string,
  timeoutMs: number = REGEXP_TIMEOUT_MS
): boolean {
  if (looksReDoSy(body)) return false
  try {
    const code =
      `new RegExp(${JSON.stringify(body)}, 'i')` +
      `.test(${JSON.stringify(text)})`
    return runInNewContext(code, {}, { timeout: timeoutMs }) as boolean
  } catch {
    // M5: timeout or syntax error → block (fail-closed), not miss.
    // A timeout means the pattern took too long — block rather than
    // risk letting a malicious pattern through. Syntax errors on user
    // patterns should also block rather than silently allow.
    return true
  }
}

function globToRegex(glob: string): string {
  let out = ''
  for (const c of glob) {
    if (c === '*') out += '.*'
    else if (c === '?') out += '.'
    else if ('.+^$()|\\'.includes(c)) out += '\\' + c
    else if (c === '[' || c === ']' || c === '{' || c === '}') out += '\\' + c
    else out += c
  }
  return out
}

/**
 * Collapses every run of horizontal whitespace (spaces, tabs) and newlines
 * into a single space and trims the result. Used ONLY on the matching path of
 * `PatternMatcher.match` as a strictly additive second pass
 * (`matches(raw) || matches(collapsed(raw))`), so whitespace-mangled commands
 * like `rm  -rf /` or `git reset\t--hard` cannot slip past literal patterns.
 * The raw command is never mutated: display, audit and telemetry keep it
 * verbatim.
 */
export function collapseWhitespaceForMatching(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

export class PatternMatcher {
  /**
   * Returns true if `text` matches `pattern` (case-insensitive). Safe, never throws.
   *
   * Additive by construction: a match requires the pattern to hit the raw
   * text OR the whitespace-collapsed text, so results can only go from
   * false to true, never the other way.
   */
  match(pattern: string, text: string): boolean {
    if (this.matchVerbatim(pattern, text)) return true
    const normalized = collapseWhitespaceForMatching(text)
    if (normalized === text) return false
    return this.matchVerbatim(pattern, normalized)
  }

  /** Original single-pass matching against one exact text. */
  protected matchVerbatim(pattern: string, text: string): boolean {
    if (pattern.startsWith(REGEX_PREFIX)) {
      const body = pattern.slice(REGEX_PREFIX.length)
      return safeRegexpTest(body, text) || submatch(body, text)
    }

    if (GLOB_METACHARS.test(pattern)) {
      const body = '^' + globToRegex(pattern) + '$'
      return safeRegexpTest(body, text) || submatch(pattern, text)
    }

    return submatch(pattern, text)
  }

  /**
   * Splits a compound shell command into trimmed, non-empty segments using the
   * SAME quote-aware logic as `segmentCommand` in `gate/normalize.ts`. This
   * keeps the classifier and the permission gate in agreement on segment
   * boundaries (H6) — including `&&`, `||`, `|`, quoted separators, backticks
   * and `$(...)` command substitution.
   */
  splitSegments(command: string): string[] {
    return splitShellSegments(command)
  }
}

/**
 * Matcher for ALLOW paths (block-rule exceptions).
 *
 * Whitespace normalization makes DENY patterns robust, but applied to an
 * allow exception it does the opposite: a command the user never excepted
 * verbatim (`git  reset  --hard`) would be silently allowed by an exception
 * written for `git reset --hard`, turning a human prompt into a silent pass.
 * Allow rules must be earned with the exact text they were written with, so
 * this matcher stays raw-only. Deny/block paths keep `PatternMatcher`.
 */
export class StrictPatternMatcher extends PatternMatcher {
  override match(pattern: string, text: string): boolean {
    return this.matchVerbatim(pattern, text)
  }
}
