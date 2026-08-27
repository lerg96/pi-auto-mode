import type { Config } from '../types/config.ts'
import type { Rule, Ruleset } from './rule.ts'

/**
 * TEMPORARY STUB — Phase 1 type compatibility.
 *
 * The new cascade-based permission model (Phase 1 schema) replaces the old
 * priority+rules composition. Phase 2 will rewrite the gate to evaluate
 * the cascade directly (see CASCADE ALGORITHM in types/config.ts).
 * For now this returns an empty ruleset so the typecheck passes.
 */
export function composeActiveSets(
  _activeSetNames: string[],
  _config: Config
): Ruleset {
  return []
}
