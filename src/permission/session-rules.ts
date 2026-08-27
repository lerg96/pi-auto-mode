import type { Rule, PermissionState } from './rule.ts'
import { globToRegex } from './rule.ts'

type SessionRule = Rule

/**
 * Check if a pattern glob-matches an existing session rule pattern.
 * H4: glob-aware dedup to avoid fragmenting rules like `/tmp/*` vs `/tmp/secret`.
 */
function patternsDedupe(existing: string, candidate: string): boolean {
  // Exact match is still a dedup
  if (existing === candidate) return true
  // Check if existing pattern glob-matches the candidate
  try {
    const body = globToRegex(existing)
    if (new RegExp(body).test(candidate)) return true
  } catch {
    /* invalid glob, fall through to exact */
  }
  // Check if candidate glob-matches the existing
  try {
    const body = globToRegex(candidate)
    if (new RegExp(body).test(existing)) return true
  } catch {
    /* invalid glob, fall through to exact */
  }
  return false
}

export class SessionRules {
  private rules: SessionRule[] = []

  add(rule: SessionRule): void {
    this.rules.push(rule)
  }

  approveForSession(
    surface: string,
    pattern: string,
    action: PermissionState
  ): void {
    // H4: dedupe by glob-aware matching (not just exact string).
    // The gate re-persists an allow after the permission modal already
    // approved-for-session, so without this guard the same pair would be
    // added twice. Using glob matching prevents fragmentation.
    if (
      this.rules.some(
        (r) => r.surface === surface && patternsDedupe(r.pattern, pattern)
      )
    ) {
      return
    }
    this.add({ surface, pattern, action, origin: 'session' } as SessionRule)
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
