import type { Config } from '../types/config.ts'
import { applyMode, isVisible, type Visibility } from './modes.ts'
import { resolveToolVisibility } from './visibility.ts'

/**
 * Returns the visibility for every tool in `allTools`, after applying the
 * global `mode`. Order is preserved from `allTools`. Tools whose visibility
 * after mode application is `deny` or `unknown` are filtered out by
 * `computeActiveTools` below; this function is exposed so handlers and
 * tests can audit the per-tool decision.
 */
export function computeToolVisibilities(
  cfg: Config,
  allTools: readonly unknown[]
): Array<{ name: string; visibility: Visibility }> {
  const out: Array<{ name: string; visibility: Visibility }> = []
  for (const t of allTools) {
    const name = toolNameOf(t)
    if (!name) continue
    const raw = resolveToolVisibility(cfg, name)
    const v = applyMode(raw, cfg.mode)
    out.push({ name, visibility: v })
  }
  return out
}

/**
 * Returns the list of tool names the LLM should see. Tools whose visibility
 * resolves to `deny` (explicit block) or `unknown` (no rule in any active set)
 * are excluded. `unknown` is treated as "not visible" because, in the
 * absence of an explicit allow, the fail-closed posture demands we hide it.
 *
 * Important: this filter does NOT use the rule-based gate. That gate runs in
 * `tool_call` and still applies independently, so callers that want a
 * "narrows what the LLM can ask for" tool still need to wire both layers.
 *
 * `activeTools` never returns an empty list when `allTools` is non-empty:
 * if every active set denies every tool (misconfigured lockdown), the
 * previous active set is kept so the agent is not stranded tool-less. If
 * there is no previous set to fall back to (first turn, no active tools
 * registered yet), all tool names are returned so the agent still has the
 * Pi defaults.
 */
export function computeActiveTools(
  cfg: Config,
  allTools: readonly unknown[],
  previousActive?: readonly string[]
): string[] {
  const visibilities = computeToolVisibilities(cfg, allTools)
  const active = visibilities
    .filter((v) => isVisible(v.visibility))
    .map((v) => v.name)

  if (active.length > 0) return active

  // Fail-closed-but-useful: never disable every tool.
  if (previousActive && previousActive.length > 0) return [...previousActive]
  return visibilities.map((v) => v.name).filter(Boolean)
}

function toolNameOf(t: unknown): string {
  return String((t as { name?: unknown })?.name ?? '')
}
