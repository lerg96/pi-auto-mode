import type { Rule, PermissionState } from './rule.ts'
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

export class SessionRules {
  add(rule: SessionRule): void {
    registry().rules.push(rule)
  }

  approveForSession(
    surface: string,
    pattern: string,
    action: PermissionState,
    isExact?: boolean
  ): void {
    const reg = registry()
    const incoming: PatternCandidate = { pattern, isExact }
    const alreadyCovered = reg.rules.some(
      (r) =>
        r.surface === surface &&
        r.action === action &&
        patternCovers(r, incoming)
    )
    if (alreadyCovered) {
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
    this.add(rule)
  }

  snapshot(): Rule[] {
    return registry().rules.map((r) => ({ ...r }))
  }

  clear(): void {
    registry().rules = []
  }

  size(): number {
    return registry().rules.length
  }
}
