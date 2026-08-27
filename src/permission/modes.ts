import type { Config } from '../types/config.ts'

export type Visibility = 'allow' | 'ask' | 'deny' | 'unknown'

/**
 * Global visibility mode (Capa 1). `default` honours the permission-set
 * `tools`/`skills` maps verbatim; `strict` collapses `ask` to `deny` so no
 * interactive prompt reaches the LLM during before_agent_start (the per-call
 * gate may still prompt); `yolo` collapses `ask` to `allow` while keeping
 * every explicit `deny` (so users can still block `rm -rf`). `unknown` is
 * always preserved — it represents "no entry in any active set" and is
 * handled by the visibility layer as "not visible".
 */
export function applyMode(
  visibility: Visibility,
  mode: Config['mode']
): Visibility {
  if (visibility === 'unknown') return 'unknown'
  if (visibility === 'allow') return 'allow'
  if (visibility === 'deny') return 'deny'
  // visibility === 'ask'
  if (mode === 'strict') return 'deny'
  if (mode === 'yolo') return 'allow'
  return 'ask'
}

/**
 * Returns the visible-or-not decision for a tool already mapped through
 * `applyMode`. Only an explicit `deny` hides a tool from the LLM; `unknown`
 * (no rule in any active set) keeps the tool visible so users who have not
 * configured per-tool entries get the same behavior as before Capa 1.
 */
export function isVisible(v: Visibility): boolean {
  // Unknown (no entry in any active set's `tools`/`skills` map) keeps the
  // tool/skill visible — only an explicit `deny` hides it. This matches
  // the user-facing intent: "everything is visible unless explicitly denied".
  // Built-in tool detection (e.g. surface === 'denied' sentinel for tools
  // unknown to the extension) is handled separately at the layer-1
  // surface filter; this function only sees values produced by
  // `resolveToolVisibility` / `resolveSkillVisibility`, both of which never
  // return the sentinel.
  return v !== 'deny'
}
