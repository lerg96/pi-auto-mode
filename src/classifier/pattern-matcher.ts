// Safe matching primitives shared with the permission layer.
//
// HISTORY: this module used to back the rule-based classifier phase
// (`rule-evaluator.ts` plus the ~54 block rules hardcoded in `block-rules.ts`).
// That engine has been retired: pi-auto-mode's allow/deny policy is the
// `permissions` cascade coming from the config JSON, not patterns hardcoded in
// the repository. Keeping a second, disconnected policy source was misleading
// — it looked like a safety net while nothing called it.
//
// Only the two primitives the live path actually uses remain below:
//   - `safeRegexpTest`              → permission/rule.ts
//   - `collapseWhitespaceForMatching` → permission/visibility.ts

import { runInNewContext } from 'node:vm'

/**
 * Wall-clock budget for a single RegExp execution under `safeRegexpTest`.
 *
 * The original M5 value was `5ms`. Under heavy CPU contention (e.g. Jest's
 * default 1-worker-per-CPU schedule, where several suites run concurrently and
 * contend for time slices), a single `vm.runInNewContext('new RegExp(...).test(...)')`
 * call routinely takes 10–20ms — measured on the development Windows host with
 * 32 logical CPUs and on Linux runners. The 5ms budget tripped false-positives
 * under load: `safeRegexpTest` returned `true` (fail-closed), which produced
 * spurious `ask`/`block` verdicts and flaky tests
 * (`permission/rule.test.ts` among them).
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
 * Returns false for structurally catastrophic patterns and true on
 * timeout or compile error (fail-closed).
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

/**
 * Collapses every run of horizontal whitespace (spaces, tabs) and newlines
 * into a single space and trims the result.
 *
 * Used ONLY on the matching path of DENY/ASK rules as a strictly additive
 * second pass (`matches(raw) || matches(collapsed(raw))`), so whitespace-mangled
 * commands like `rm  -rf /` or `git reset\t--hard` cannot slip past literal
 * patterns written with single spaces. The raw command is never mutated:
 * display, audit and telemetry keep it verbatim.
 *
 * It must NEVER widen an `allow` rule — see `ruleMatchesCall` in
 * `permission/visibility.ts`.
 */
export function collapseWhitespaceForMatching(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}
