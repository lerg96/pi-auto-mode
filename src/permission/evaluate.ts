import { type Rule, type Ruleset, ruleMatches } from './rule.ts'
import { stripEnvPrefix } from './command-prefix.ts'
import { wildcardMatch } from './wildcard-matcher.ts'

const isShellSurface = (surface: string): boolean =>
  surface === 'bash' ||
  surface === 'powershell' ||
  surface === 'shell' ||
  surface === 'tools'

function ruleOrWildcardMatches(
  rule: Rule,
  surface: string,
  value: string
): boolean {
  if (ruleMatches(rule, surface, value)) return true
  if (
    (rule.surface === surface || rule.surface === '*' || surface === '*') &&
    wildcardMatch(rule.pattern, value)
  ) {
    return true
  }
  return false
}

export function evaluate(surface: string, value: string, rules: Ruleset): Rule {
  // M7: when the ruleset is empty, default-deny (fail-closed). An empty
  // activeSets + disabled classifier would otherwise allow everything.
  if (rules.length === 0) {
    return { surface, pattern: value, action: 'deny' }
  }

  const isShell =
    isShellSurface(surface) || isShellSurface(rules[0]?.surface ?? '')
  const strippedValue = isShell ? stripEnvPrefix(value) : value
  const hasStripped = isShell && strippedValue !== value

  let lastMatch: Rule | undefined
  let preciseConfigDeny: Rule | undefined
  for (let i = rules.length - 1; i >= 0; i--) {
    const rule = rules[i]
    const matchesRaw = ruleOrWildcardMatches(rule, surface, value)
    const matchesStripped =
      hasStripped && ruleOrWildcardMatches(rule, surface, strippedValue)

    if (!matchesRaw && !matchesStripped) continue

    // last-match-wins: keep the highest-index (most specific/latest) rule.
    if (lastMatch === undefined) lastMatch = rule
    // S1/L2: a precise (literal, non-wildcard) non-session DENY that targets the
    // exact requested value is a hard policy. It must NOT be overridden by a
    // later session ALLOW (e.g. "Allow for session"), which would otherwise win
    // under plain last-match-wins.
    if (
      rule.origin !== 'session' &&
      rule.action === 'deny' &&
      (rule.pattern === value ||
        (hasStripped && rule.pattern === strippedValue))
    ) {
      preciseConfigDeny = rule
    }
  }
  // A session ALLOW may relax a *broad* config deny (wildcard), but never a
  // precise one. When the winning match is a session allow overriding a precise
  // config deny, the config deny wins (fail-closed).
  if (
    preciseConfigDeny &&
    lastMatch &&
    lastMatch.origin === 'session' &&
    lastMatch.action === 'allow'
  ) {
    return preciseConfigDeny
  }
  return lastMatch ?? { surface, pattern: value, action: 'allow' }
}

export { evaluate as evaluateRules, evaluate as evaluatePermission }

export function mostRestrictive(
  a: Rule['action'],
  b: Rule['action']
): Rule['action'] {
  const rank: Record<Rule['action'], number> = { deny: 2, ask: 1, allow: 0 }
  return rank[a] >= rank[b] ? a : b
}
