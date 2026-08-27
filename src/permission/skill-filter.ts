import type { Config } from '../types/config.ts'
import { applyMode, isVisible, type Visibility } from './modes.ts'
import { resolveSkillVisibility } from './visibility.ts'

/**
 * Compute the visibility of a skill after applying the global `mode`.
 * Exposed for tests and the handler hook.
 */
export function computeSkillVisibility(
  cfg: Config,
  skillName: string
): Visibility {
  const raw = resolveSkillVisibility(cfg, skillName)
  return applyMode(raw, cfg.mode)
}

/**
 * Returns the subset of `skillNames` whose visibility is `allow` or `ask`
 * after mode application. Order preserved. Used by the handler to decide
 * which skills to keep in the system prompt and by tests.
 */
export function filterVisibleSkills(
  cfg: Config,
  skillNames: readonly string[]
): string[] {
  const out: string[] = []
  for (const name of skillNames) {
    if (isVisible(computeSkillVisibility(cfg, name))) out.push(name)
  }
  return out
}
