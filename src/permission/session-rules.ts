import type { Rule, PermissionState } from './rule.ts'
import { sessionPatternMatches } from './wildcard-matcher.ts'

type SessionRule = Rule

interface PatternCandidate {
  pattern: string
  isExact?: boolean
}

function patternCovers(
  broad: PatternCandidate,
  narrow: PatternCandidate
): boolean {
  if (broad.isExact) {
    if (!narrow.isExact) return false
    return process.platform === 'win32'
      ? broad.pattern.toLowerCase() === narrow.pattern.toLowerCase()
      : broad.pattern === narrow.pattern
  }
  if (
    process.platform === 'win32'
      ? broad.pattern.toLowerCase() === narrow.pattern.toLowerCase()
      : broad.pattern === narrow.pattern
  ) {
    return true
  }
  return sessionPatternMatches(broad.pattern, narrow.pattern)
}

export class SessionRules {
  private rules: SessionRule[] = []

  add(rule: SessionRule): void {
    this.rules.push(rule)
  }

  approveForSession(
    surface: string,
    pattern: string,
    action: PermissionState,
    isExact?: boolean
  ): void {
    const incoming: PatternCandidate = { pattern, isExact }
    const alreadyCovered = this.rules.some(
      (r) =>
        r.surface === surface &&
        r.action === action &&
        patternCovers(r, incoming)
    )
    if (alreadyCovered) {
      return
    }

    this.rules = this.rules.filter(
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
    return this.rules.map((r) => ({ ...r }))
  }

  clear(): void {
    this.rules = []
  }

  size(): number {
    return this.rules.length
  }
}
