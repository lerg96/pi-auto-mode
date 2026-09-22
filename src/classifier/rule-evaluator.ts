// Rule-based classifier layer (Milestone M4-T2).
// Mirrors opencode-auto-mode RuleEvaluator precedence:
//   1. Trust boundary (hard block)
//   2. Allow exceptions (only if EVERY segment is covered)
//   3. Block rules (critical -> block, soft -> uncertain, high|medium|low -> ask)
//   4. No match -> uncertain (defer to LLM)

import {
  type BlockRule,
  type Severity,
  DEFAULT_BLOCK_RULES,
} from './block-rules.ts'
export { DEFAULT_BLOCK_RULES }
import { PatternMatcher, StrictPatternMatcher } from './pattern-matcher.ts'
import { segmentCommand, stripQuotedLiterals } from '../gate/normalize.ts'

export type RuleEvalResult = 'allowed' | 'blocked' | 'uncertain' | 'ask'

export interface RuleEvalOutput {
  evaluation: RuleEvalResult
  matchedRule?: string
  matchedException?: string
  severity?: Severity
}

export interface ClassifierToolCall {
  toolName: string
  arguments: { command?: string; path?: string; value?: string }
}

export interface TrustBoundary {
  protectedPaths: string[]
  protectedCommands: string[]
}

/** True if the whole command OR any shell segment matches the pattern. */
function segmentMatches(
  matcher: PatternMatcher,
  pattern: string,
  command: string,
  segments: string[]
): boolean {
  return (
    matcher.match(pattern, command) ||
    segments.some((s) => matcher.match(pattern, s))
  )
}

/** True if the command (or any segment) references one of the protected paths. */
function referencesPath(
  matcher: PatternMatcher,
  command: string,
  segments: string[],
  paths: string[]
): boolean {
  return paths.some((p) => segmentMatches(matcher, p, command, segments))
}

/**
 * Execution wrappers whose (remaining) argument is run as a command:
 *  - "-c" interpreters: `bash -c "cmd"`, `python3 -c "cmd"`, ...
 *  - bare evaluators: `eval "cmd"`, `source file`, `. file`
 *  - pass-through launchers: `sudo cmd`, `env cmd`, `timeout N cmd`, ...
 * Wrappers may be chained (`sudo bash -c "..."`), so extraction recurses.
 */
const WRAPPER_EXEC_RE =
  /^(?:sh|bash|zsh|ksh|fish|python|python3|powershell|pwsh)\s+-[a-zA-Z]*c[a-zA-Z]*\s+(\S.*)$/
const WRAPPER_BARE_RE = /^(?:eval|source|\.)\s+(\S.*)$/
const WRAPPER_PASSTHROUGH_RE =
  /^(?:sudo|env|time|nice|nohup|timeout|setsid|stdbuf|watch|ionice|xargs)\b(.*)$/

/** True if `value` matches a known execution wrapper; returns its inner argument. */
function matchWrapper(value: string): string | null {
  const exec = WRAPPER_EXEC_RE.exec(value)
  if (exec) return exec[1]
  const bare = WRAPPER_BARE_RE.exec(value)
  if (bare) return bare[1]
  const pass = WRAPPER_PASSTHROUGH_RE.exec(value)
  if (pass) return pass[1].trim()
  return null
}

/**
 * Recursively unwraps an execution-wrapper command, returning every command
 * string that should be scanned: each wrapper *level* (so trust-boundary /
 * block rules still see the wrapper keyword, e.g. `sudo`) and the final *leaf*
 * command the shell will actually execute.
 *
 * FIX (A): now also recognizes pass-through launchers (`sudo`, `env`, `time`,
 * `nice`, `nohup`, `timeout`, `setsid`, `xargs`, ...) that were previously
 * discarded, collapsing the whole command into a dropped quoted segment.
 */
function extractWrapperPayloads(value: string): string[] {
  const out: string[] = []
  const visited = new Set<string>()
  let current = value.trim()
  let inside = false
  let depth = 0
  while (depth < 16) {
    const trimmed = current.trim()
    if (trimmed.length === 0 || visited.has(trimmed)) break
    visited.add(trimmed)
    const inner = matchWrapper(trimmed)
    if (inner === null) {
      if (inside) out.push(trimmed)
      break
    }
    out.push(trimmed)
    inside = true
    current = inner.trim()
    depth++
  }
  return out
}

/** True if `value` (unquoted) is an execution-wrapper command like `sh -c`. */
const WRAPPER_CMD_RE =
  /^(?:sh|bash|zsh|ksh|fish|python|python3|powershell|pwsh)\s+-[a-zA-Z]*c[a-zA-Z]*$/

function isWrapperCommand(value: string): boolean {
  return WRAPPER_CMD_RE.test(value) || /^(?:eval|source|\.)$/.test(value)
}

// Shell interpolation that prevents literal matching of a wrapper payload:
// `$VAR`, `${VAR}`, `$(...)`, backtick substitution.
const INTERP_RE = /[$`](?:\(|\{|\w|\$)/
function hasInterpolation(value: string): boolean {
  return INTERP_RE.test(value)
}

/**
 * Quote-aware split of a raw command into simple statements on shell
 * separators (`;`, `|`, `&&`, `||`, `&`, newline). Substitutions (`$(...)`,
 * backticks) and quoted regions are opaque so the split stays stable; quoting
 * is preserved so wrapper arguments can be inspected verbatim.
 */
function splitRawStatements(command: string): string[] {
  const out: string[] = []
  let buf = ''
  let quote: "'" | '"' | null = null
  let i = 0
  const flush = () => {
    const v = buf.trim()
    if (v.length > 0) out.push(v)
    buf = ''
  }
  while (i < command.length) {
    const c = command[i]
    if (quote) {
      buf += c
      if (c === quote) quote = null
      i++
      continue
    }
    if (c === "'" || c === '"') {
      quote = c
      buf += c
      i++
      continue
    }
    if (c === '$' && command[i + 1] === '(') {
      let depth = 1
      buf += c
      i++
      buf += command[i] // '('
      i++
      while (i < command.length && depth > 0) {
        const sc = command[i]
        if (sc === '(') depth++
        else if (sc === ')') depth--
        buf += sc
        i++
      }
      continue
    }
    if (c === '`') {
      buf += c
      i++
      while (i < command.length && command[i] !== '`') {
        buf += command[i]
        i++
      }
      if (i < command.length) {
        buf += command[i]
        i++
      }
      continue
    }
    if (c === ';' || c === '\n') {
      flush()
      i++
      continue
    }
    if (c === '|') {
      while (i < command.length && command[i] === '|') i++
      if (i < command.length && command[i] === '&') i++ // |&
      flush()
      continue
    }
    if (c === '&') {
      if (command[i + 1] === '&') {
        flush()
        i += 2
        continue
      }
      flush()
      i++
      continue
    }
    buf += c
    i++
  }
  flush()
  return out
}

/**
 * Scan raw wrapper invocations for executed command payloads. Unlike the
 * segment-based scan this preserves the *verbatim* quoted argument, so it can
 * detect shell interpolation inside a wrapper payload (FIX B). Only wrapper
 * levels and wrapper-derived leaves are returned — arbitrary quoted data is
 * left to the segment-based scan, so `echo "rm -rf"` stays non-executable.
 */
function analyzeWrapperPayloads(command: string): { interpolated: boolean } {
  let interpolated = false
  for (const stmt of splitRawStatements(command)) {
    const visited = new Set<string>()
    let current = stmt.trim()
    let depth = 0
    while (depth < 16) {
      const trimmed = current.trim()
      if (trimmed.length === 0 || visited.has(trimmed)) break
      visited.add(trimmed)
      const inner = matchWrapper(trimmed)
      if (inner === null) break
      if (hasInterpolation(inner)) {
        interpolated = true
        break
      }
      current = inner.trim()
      depth++
    }
    if (interpolated) break
  }
  return { interpolated }
}

/** True if any enabled critical block rule matches this command. */
function findAllowException(
  matcher: PatternMatcher,
  command: string,
  segments: string[],
  exceptions: BlockRule[]
): string | undefined {
  const active = exceptions.filter((e) => e.enabled !== false)
  if (active.length === 0) return undefined
  const covered = segments.every((s) =>
    active.some((e) => matcher.match(e.pattern, s))
  )
  if (!covered) return undefined
  const hit = active.find((e) =>
    segmentMatches(matcher, e.pattern, command, segments)
  )
  return hit?.id
}

/** Hardcoded trust-boundary patterns that must never be whitelisted by an exception. */
const NEVER_WHITELIST_PATHS = ['~/.ssh/', '/etc/', '~/.env']
const NEVER_WHITELIST_COMMANDS = ['sudo', 'rm -rf']

/** True if the command hits a hardcoded trust-boundary pattern. */
function isTrustBoundaryHit(
  matcher: PatternMatcher,
  command: string,
  segments: string[]
): boolean {
  const cmdHit = NEVER_WHITELIST_COMMANDS.some((c) =>
    segments.some((s) => matcher.match(c, s))
  )
  const pathHit = NEVER_WHITELIST_PATHS.some((p) =>
    segmentMatches(matcher, p, command, segments)
  )
  return cmdHit || pathHit
}

/** True if any enabled critical block rule matches this command. */
function hasCriticalRuleMatch(
  matcher: PatternMatcher,
  command: string,
  segments: string[],
  rules: BlockRule[]
): boolean {
  return rules
    .filter((r) => r.enabled !== false && r.severity === 'critical')
    .some((r) => segmentMatches(matcher, r.pattern, command, segments))
}

export function evaluateRules(
  toolCall: ClassifierToolCall,
  rules: BlockRule[],
  exceptions: BlockRule[],
  trustBoundary: TrustBoundary
): RuleEvalOutput {
  const pm = new PatternMatcher()
  // Allow-exception matching stays whitespace-strict: normalization may only
  // harden deny patterns, never widen a user's explicit allow list.
  const strictPm = new StrictPatternMatcher()
  const command = toolCall.arguments.command ?? ''
  const cmdSegments = segmentCommand(command)
  // Build the set of command content to scan:
  //  - every unquoted segment (data-quoted segments are skipped to avoid
  //    false positives, e.g. `echo "rm -rf"`),
  //  - command substitutions already extracted as unquoted segments (e.g.
  //    `echo "$(rm -rf /)"`),
  //  - the quoted argument of an execution wrapper (`sh -c "..."`, `eval "..."`),
  //    since the shell executes it as a command.
  const scannable: string[] = []
  for (let idx = 0; idx < cmdSegments.length; idx++) {
    const seg = cmdSegments[idx]

    // Quoted segment: unwrap any execution-wrapper payload (recurses through
    // pass-through launchers like `sudo bash -c "..."`).
    if (seg.quoted) {
      const payloads = extractWrapperPayloads(seg.value)
      if (payloads.length > 0) {
        scannable.push(...payloads)
        continue
      }
    }

    // Always add unquoted segments (including bare wrapper commands).
    // If a wrapper command (e.g. sh -c) appears unquoted, its value
    // itself may contain the payload (e.g. "sh -c rm -rf /tmp").
    if (!seg.quoted) {
      scannable.push(seg.value)
      continue
    }

    // Quoted segment whose value wasn't a wrapper — check if the
    // previous segment was a wrapper command and push this quoted
    // value as the payload.
    const prev = cmdSegments[idx - 1]
    if (prev && !prev.quoted && isWrapperCommand(prev.value)) {
      // Previous segment was a bare wrapper command (e.g. `sh -c`); its quoted
      // argument is the executed payload.
      scannable.push(...extractWrapperPayloads(seg.value))
    }
  }
  // FIX (B): scan raw wrapper invocations verbatim to detect shell
  // interpolation (`$(...)`, `${VAR}`, backticks) inside an executed payload.
  // Only the `interpolated` flag is consumed here: the recursive command
  // unwrapping for non-interpolated wrappers is already handled by the
  // segment-based `extractWrapperPayloads` above, so we must NOT re-add those
  // payloads to `scannable` (that would change allow-exception coverage and
  // trust-boundary semantics — e.g. weaken `sudo apt update`).
  const { interpolated } = analyzeWrapperPayloads(command)
  const unquotedCommand = stripQuotedLiterals(command)

  // 1. Trust boundary — hard block.
  //    Checks the full unquoted command (for path patterns in quoted args) AND
  //    scannable segments (for protected commands in unquoted context).
  const cmdHit = scannable.some((s) =>
    trustBoundary.protectedCommands.some((c) => pm.match(c, s))
  )
  let result: RuleEvalOutput
  if (
    cmdHit ||
    referencesPath(pm, unquotedCommand, scannable, trustBoundary.protectedPaths)
  ) {
    result = { evaluation: 'blocked', matchedRule: 'TB', severity: 'critical' }
  } else {
    // 2. Allow exceptions — only if every segment is covered AND the command
    // is not a critical rule match or a hardcoded trust-boundary hit.
    const exId = findAllowException(
      strictPm,
      unquotedCommand,
      scannable,
      exceptions
    )
    if (exId) {
      const isCritical = hasCriticalRuleMatch(
        pm,
        unquotedCommand,
        scannable,
        rules
      )
      const isTB = isTrustBoundaryHit(pm, unquotedCommand, scannable)
      if (!isCritical && !isTB) {
        result = { evaluation: 'allowed', matchedException: exId }
      } else if (isTB) {
        result = {
          evaluation: 'blocked',
          matchedRule: 'TB',
          severity: 'critical',
        }
      } else {
        // isCritical — fall through to step 3 which returns blocked with id.
        result = evaluateBlockRules(pm, scannable, rules)
      }
    } else {
      result = evaluateBlockRules(pm, scannable, rules)
    }
  }

  // FIX (B): a wrapper payload with shell interpolation (`$(...)`, `${VAR}`,
  // backticks) cannot be matched literally. Fail closed: escalate to `ask`
  // (keep `blocked` if a stricter rule already fired).
  if (interpolated && result.evaluation !== 'blocked') {
    return {
      evaluation: 'ask',
      matchedRule: 'WRAPPER-INTERP',
      severity: 'high',
    }
  }
  return result
}

/**
 * Step 3 of the rule evaluation: first matching enabled block rule wins.
 * Only checks `scannable` (excludes quoted data segments) to preserve the
 * existing behaviour where `echo "rm -rf"` is treated as data.
 */
function evaluateBlockRules(
  matcher: PatternMatcher,
  segments: string[],
  rules: BlockRule[]
): RuleEvalOutput {
  for (const rule of rules.filter((r) => r.enabled !== false)) {
    const hitsScannable = segments.some((s) => matcher.match(rule.pattern, s))
    if (!hitsScannable) continue
    if (rule.severity === 'critical') {
      return {
        evaluation: 'blocked',
        matchedRule: rule.id,
        severity: 'critical',
      }
    }
    if (rule.severity === 'soft') {
      return {
        evaluation: 'uncertain',
        matchedRule: rule.id,
        severity: 'soft',
      }
    }
    return { evaluation: 'ask', matchedRule: rule.id, severity: rule.severity }
  }
  // 4. No match — defer to LLM.
  return { evaluation: 'uncertain' }
}
