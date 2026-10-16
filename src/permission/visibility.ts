import type {
  Config,
  SimpleAction,
  PatternRule,
  ToolPermission,
  PermissionsBlock,
} from '../types/config.ts'
import { wildcardMatch } from './wildcard-matcher.ts'
import { collapseWhitespaceForMatching } from '../classifier/pattern-matcher.ts'
import { stripEnvPrefix } from './command-prefix.ts'

// ─── Legacy compat exports (tests only) ────────────────────────────────
// These are the OLD API (tool:arg keys, wildcards). Kept so existing tests
// don't need full rewrite. NOT used by the new cascade logic.
export type VisibilityAction = 'allow' | 'ask' | 'deny'
export type Visibility = VisibilityAction | 'unknown'

export function splitToolKey(
  key: string
): { tool: string; arg: string | null } | null {
  if (typeof key !== 'string' || key.length === 0) return null
  const idx = key.indexOf(':')
  if (idx === -1) return { tool: key, arg: null }
  return { tool: key.slice(0, idx), arg: key.slice(idx + 1) }
}

export function keyMatchesTool(
  key: string,
  toolName: string,
  toolArgs: string | undefined
): boolean {
  const parsed = splitToolKey(key)
  if (!parsed) return false
  if (!wildcardMatch(parsed.tool, toolName)) return false
  if (parsed.arg === null) return true
  if (!toolArgs) return false
  return wildcardMatch(parsed.arg, toolArgs)
}

/**
 * Checks if a ToolPermission is a SimpleAction (string) vs PatternRule[].
 */
function isSimpleAction(perm: ToolPermission): perm is SimpleAction {
  return typeof perm === 'string'
}

/**
 * Checks if a ToolPermission is a PatternRule array.
 */
function isPatternRuleArray(perm: ToolPermission): perm is PatternRule[] {
  return Array.isArray(perm)
}

/**
 * Does `rule` match the call value?
 *
 * Whitespace-mangled commands (`rm  -rf`, tabs instead of spaces) must not
 * slip past a rule the user wrote with literal single spaces, so `deny`/`ask`
 * rules also match the whitespace-collapsed value. `allow` rules stay strict:
 * normalizing them would silently grant a call whose text the user never
 * wrote, turning a prompt into a pass. Normalization may only ever harden.
 */
function ruleMatchesCall(rule: PatternRule, value: string): boolean {
  if (wildcardMatch(rule.pattern, value)) return true

  const stripped = stripEnvPrefix(value)
  if (stripped !== value) {
    if (wildcardMatch(rule.pattern, stripped)) return true
    if (rule.action !== 'allow') {
      const collapsedStripped = collapseWhitespaceForMatching(stripped)
      if (
        collapsedStripped !== stripped &&
        wildcardMatch(rule.pattern, collapsedStripped)
      ) {
        return true
      }
    }
  }

  if (rule.action === 'allow') return false
  const collapsed = collapseWhitespaceForMatching(value)
  if (collapsed === value) return false
  return wildcardMatch(rule.pattern, collapsed)
}

/**
 * Finds the first matching PatternRule for a given value (the full tool call string).
 * Returns the matching rule or undefined if no match.
 */
function firstPatternMatch(
  rules: PatternRule[],
  value: string | undefined
): PatternRule | undefined {
  if (!value) return undefined
  for (const rule of rules) {
    if (ruleMatchesCall(rule, value)) {
      return rule
    }
  }
  return undefined
}

/**
 * Evaluates a single PermissionsBlock for a given toolName and callValue.
 * Returns the resolved SimpleAction if found, or undefined if no opinion.
 * Key is exact toolName (no wildcards, no "tool:arg" syntax).
 * If value is SimpleAction → returns it.
 * If value is PatternRule[] → returns first match's action (or undefined if no match).
 */
function evaluatePermissionsBlock(
  block: PermissionsBlock | undefined,
  namespace: 'tools' | 'skills' | 'mcps',
  name: string,
  callValue: string | undefined
): SimpleAction | undefined {
  if (!block) return undefined
  const map = block[namespace]
  if (!map) return undefined

  // Exact name first; `"*"` is the catch-all for names with NO entry
  // (unknown tools included). An existing entry whose patterns miss the
  // call stays silent (no star fallthrough): allow-final is preserved.
  const perm = map[name] ?? map['*']
  if (perm === undefined) return undefined

  if (isSimpleAction(perm)) return perm
  if (isPatternRuleArray(perm)) {
    const match = firstPatternMatch(perm, callValue)
    if (match) return match.action
    return undefined
  }
  return undefined
}

/**
 * Result of evaluating a permission cascade with matched rule info.
 */
export interface PermissionEvaluation {
  action: Visibility
  matchedRule?: { pattern: string; reason?: string }
}

/**
 * Evaluates a single PermissionsBlock and returns the matched rule info.
 */
function evaluatePermissionsBlockWithRule(
  block: PermissionsBlock | undefined,
  namespace: 'tools' | 'skills' | 'mcps',
  name: string,
  callValue: string | undefined
):
  | { action: SimpleAction; matchedRule?: { pattern: string; reason?: string } }
  | undefined {
  if (!block) return undefined
  const map = block[namespace]
  if (!map) return undefined

  // Same `"*"` catch-all as evaluatePermissionsBlock (see above).
  const perm = map[name] ?? map['*']
  if (perm === undefined) return undefined

  if (isSimpleAction(perm)) return { action: perm, matchedRule: undefined }
  if (isPatternRuleArray(perm)) {
    const match = firstPatternMatch(perm, callValue)
    if (match)
      return {
        action: match.action,
        matchedRule: { pattern: match.pattern, reason: match.reason },
      }
    return undefined
  }
  return undefined
}

/**
 * Core cascade algorithm with matched rule tracking.
 */
function resolveCascadeWithRule(
  cfg: Config,
  namespace: 'tools' | 'skills' | 'mcps',
  name: string,
  callValue: string | undefined,
  forVisibility: boolean
): PermissionEvaluation | undefined {
  const sources: PermissionsBlock[] = [cfg.permissions]
  for (const setId of cfg.activePermissionSets ?? []) {
    const set = cfg.permissionSets[setId]
    if (set?.permissions) sources.push(set.permissions)
  }

  let decision: SimpleAction | undefined
  let matchedRule: { pattern: string; reason?: string } | undefined

  for (const source of sources) {
    const result = evaluatePermissionsBlockWithRule(
      source,
      namespace,
      name,
      callValue
    )
    if (result === undefined) continue

    if (forVisibility) {
      if (isSimpleAction(result.action)) {
        decision = result.action
        matchedRule = undefined // SimpleAction has no pattern/reason
      }
    } else {
      decision = result.action
      matchedRule = result.matchedRule
    }
  }

  if (decision !== undefined) {
    return { action: decision, matchedRule }
  }
  return undefined
}

/**
 * Core cascade algorithm for resolving permissions/visibility.
 * Sources: global permissions block first, then each activePermissionSet in order.
 *
 * For LLM visibility (forVisibility=true): ONLY SimpleAction entries count;
 * PatternRule arrays are ignored. Last SimpleAction wins: "deny" -> hidden, other -> visible.
 *
 * For gate evaluation (forVisibility=false): both SimpleAction and PatternRule matches count.
 * Last match wins (cascades overwrite).
 */
function resolveCascade(
  cfg: Config,
  namespace: 'tools' | 'skills' | 'mcps',
  name: string,
  callValue: string | undefined,
  forVisibility: boolean
): SimpleAction | undefined {
  const sources: PermissionsBlock[] = [cfg.permissions]
  for (const setId of cfg.activePermissionSets ?? []) {
    const set = cfg.permissionSets[setId]
    if (set?.permissions) sources.push(set.permissions)
  }

  let decision: SimpleAction | undefined

  for (const source of sources) {
    const perm = evaluatePermissionsBlock(source, namespace, name, callValue)
    if (perm === undefined) continue

    if (forVisibility) {
      if (isSimpleAction(perm)) decision = perm
    } else {
      decision = perm
    }
  }

  return decision
}

/**
 * Resolves the visibility of a tool for the LLM (before_agent_start).
 * Returns 'allow' | 'ask' | 'deny' | 'unknown'.
 * Only explicit SimpleAction strings in the cascade count.
 * If cascade yields nothing → 'unknown' (caller applies mode fallback if needed).
 */
export function resolveToolVisibility(
  cfg: Config,
  toolName: string,
  callValue?: string
): Visibility {
  return resolveCascade(cfg, 'tools', toolName, callValue, true) ?? 'unknown'
}

/**
 * Resolves the visibility of a skill for the LLM.
 */
export function resolveSkillVisibility(
  cfg: Config,
  skillName: string
): Visibility {
  return resolveCascade(cfg, 'skills', skillName, undefined, true) ?? 'unknown'
}

/**
 * Evaluates a tool/skill/mcp permission for the gate (tool_call).
 * Considers BOTH SimpleAction and PatternRule matches.
 * Returns the action (allow/ask/deny) or 'unknown' if no opinion.
 */
export function evaluatePermission(
  cfg: Config,
  namespace: 'tools' | 'skills' | 'mcps',
  toolName: string,
  callValue: string | undefined
): PermissionEvaluation {
  return (
    resolveCascadeWithRule(cfg, namespace, toolName, callValue, false) ?? {
      action: 'unknown',
      matchedRule: undefined,
    }
  )
}
