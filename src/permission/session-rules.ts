import type { Rule, PermissionState } from './rule.ts'
import type { ScriptFingerprint } from './script-fingerprint.ts'
import { sessionPatternMatches } from './wildcard-matcher.ts'
import { stripEnvPrefix } from './command-prefix.ts'

type SessionRule = Rule

interface PatternCandidate {
  pattern: string
  isExact?: boolean
}

const REGISTRY_KEY = Symbol.for('pi-auto-mode:session-rules')

interface SessionRulesRegistry {
  rules: SessionRule[]
}

function registry(): SessionRulesRegistry {
  const slot = globalThis as unknown as Record<
    symbol,
    SessionRulesRegistry | undefined
  >
  let reg = slot[REGISTRY_KEY]
  if (!reg) {
    reg = { rules: [] }
    slot[REGISTRY_KEY] = reg
  }
  return reg
}

/** Test seam: forget the registry so tests start clean. */
export function resetSessionRulesRegistry(): void {
  const slot = globalThis as unknown as Record<
    symbol,
    SessionRulesRegistry | undefined
  >
  delete slot[REGISTRY_KEY]
}

function normalizePattern(p: string): string {
  const collapsed = p.replace(/["']/g, '').replace(/\s+/g, ' ').trim()
  return process.platform === 'win32' ? collapsed.toLowerCase() : collapsed
}

function patternCovers(
  broad: PatternCandidate,
  narrow: PatternCandidate
): boolean {
  const isWin = process.platform === 'win32'
  const broadExact = isWin ? broad.pattern.toLowerCase() : broad.pattern
  const narrowExact = isWin ? narrow.pattern.toLowerCase() : narrow.pattern
  const exactEq = broadExact === narrowExact
  const normEq =
    normalizePattern(broad.pattern) === normalizePattern(narrow.pattern)

  if (broad.isExact) {
    if (!narrow.isExact) return false
    return exactEq || normEq
  }
  if (exactEq || normEq) {
    return true
  }
  if (
    sessionPatternMatches(broad.pattern, narrow.pattern) ||
    sessionPatternMatches(
      normalizePattern(broad.pattern),
      normalizePattern(narrow.pattern)
    )
  ) {
    return true
  }

  const strippedNarrow = stripEnvPrefix(narrow.pattern)
  if (strippedNarrow !== narrow.pattern) {
    return (
      sessionPatternMatches(broad.pattern, strippedNarrow) ||
      sessionPatternMatches(
        normalizePattern(broad.pattern),
        normalizePattern(strippedNarrow)
      ) ||
      normalizePattern(broad.pattern) === normalizePattern(strippedNarrow)
    )
  }

  return false
}

export function sessionPatternCovers(pattern: string, value: string): boolean {
  return patternCovers({ pattern }, { pattern: value })
}

function mergeFingerprints(
  existing: ScriptFingerprint[] | undefined,
  incoming: ScriptFingerprint[]
): ScriptFingerprint[] {
  if (!existing || existing.length === 0) return incoming
  const map = new Map<string, ScriptFingerprint>()
  const isWin = process.platform === 'win32'
  for (const fp of existing) {
    map.set(isWin ? fp.path.toLowerCase() : fp.path, fp)
  }
  for (const fp of incoming) {
    map.set(isWin ? fp.path.toLowerCase() : fp.path, fp)
  }
  return Array.from(map.values())
}

export class SessionRules {
  add(rule: SessionRule): void {
    const reg = registry()
    const existing = reg.rules.find(
      (r) =>
        r.surface === rule.surface &&
        r.pattern === rule.pattern &&
        r.action === rule.action &&
        Boolean(r.isExact) === Boolean(rule.isExact)
    )
    if (existing) {
      if (rule.scriptFingerprints && rule.scriptFingerprints.length > 0) {
        existing.scriptFingerprints = mergeFingerprints(
          existing.scriptFingerprints,
          rule.scriptFingerprints
        )
      }
      return
    }
    reg.rules.push(rule)
  }

  remove(surface: string, pattern: string, action?: PermissionState): boolean {
    const reg = registry()
    const before = reg.rules.length
    reg.rules = reg.rules.filter(
      (r) =>
        !(
          r.surface === surface &&
          r.pattern === pattern &&
          (action === undefined || r.action === action)
        )
    )
    return reg.rules.length < before
  }

  approveForSession(
    surface: string,
    pattern: string,
    action: PermissionState,
    isExact?: boolean,
    scriptFingerprints?: ScriptFingerprint[]
  ): void {
    const reg = registry()
    const incoming: PatternCandidate = { pattern, isExact }
    const coveringRule = reg.rules.find(
      (r) =>
        r.surface === surface &&
        r.action === action &&
        patternCovers(r, incoming)
    )
    if (coveringRule) {
      if (scriptFingerprints && scriptFingerprints.length > 0) {
        coveringRule.scriptFingerprints = mergeFingerprints(
          coveringRule.scriptFingerprints,
          scriptFingerprints
        )
      }
      return
    }

    reg.rules = reg.rules.filter(
      (r) =>
        !(
          r.surface === surface &&
          r.action === action &&
          r.origin === 'session' &&
          patternCovers(incoming, r)
        )
    )

    const rule: SessionRule = { surface, pattern, action, origin: 'session' }
    if (isExact !== undefined) {
      rule.isExact = isExact
    }
    if (scriptFingerprints && scriptFingerprints.length > 0) {
      rule.scriptFingerprints = scriptFingerprints
    }
    this.add(rule)
  }

  snapshot(): Rule[] {
    return registry().rules.map((r) => ({
      ...r,
      ...(r.scriptFingerprints
        ? { scriptFingerprints: r.scriptFingerprints.map((fp) => ({ ...fp })) }
        : {}),
    }))
  }

  clear(): void {
    registry().rules = []
  }

  size(): number {
    return registry().rules.length
  }
}
