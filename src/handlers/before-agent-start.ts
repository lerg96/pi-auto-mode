import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { filterVisibleSkills } from '../permission/skill-filter.ts'
import { resolveToolVisibility } from '../permission/visibility.ts'
import { applyMode } from '../permission/modes.ts'
import { surfaceForTool } from '../gate/normalize.ts'
import type { Config } from '../types/config.ts'
import { scrubAvailableTools } from './system-prompt-sanitizer.ts'
import {
  parseAvailableSkillsSections,
  scrubAvailableSkills,
} from './skill-prompt-sanitizer.ts'

export interface BeforeAgentStartDeps {
  cfg: Config
  allTools: readonly unknown[]
  previousActiveTools?: readonly string[]
}

export interface BeforeAgentStartResult {
  systemPrompt: string
  visibleTools: string[]
  visibleSkills: string[]
  unchanged: boolean
}

/**
 * Compute the tool list the LLM should see.
 * Uses the new cascade-based permission model:
 * - For each tool, resolve its visibility via the cascade (global permissions
 *   + activePermissionSets in order).
 * - Only an explicit `deny` hides a tool from the LLM; `allow`, `ask`,
 *   and `unknown` all keep it visible.
 * - Global `mode` applies: `strict` -> `ask` becomes `deny`; `yolo` -> `ask`
 *   becomes `allow`; `default` keeps `ask`.
 */
export function computeVisibleToolList(deps: BeforeAgentStartDeps): string[] {
  const { cfg, allTools, previousActiveTools } = deps

  const visible = allTools.filter((t) => {
    const name = toolNameOf(t)
    if (!name) return false
    // Evaluate permission cascade for this tool's surface.
    const surface = surfaceForTool(name)
    const v = resolveToolVisibility(cfg, name, '*')
    const modeApplied = applyMode(v, cfg.mode)
    return modeApplied !== 'deny'
  })

  const names = visible.map(toolNameOf).filter((n): n is string => Boolean(n))

  if (names.length > 0) return names

  if (previousActiveTools && previousActiveTools.length > 0) {
    return [...previousActiveTools]
  }
  return allTools.map(toolNameOf).filter((n): n is string => Boolean(n))
}

/**
 * Apply visibility to the system prompt, returning sanitized prompt + audit.
 */
export function applyVisibilityToPrompt(
  deps: BeforeAgentStartDeps,
  systemPrompt: string
): BeforeAgentStartResult {
  const visibleTools = computeVisibleToolList(deps)
  const allowedNames = new Set(visibleTools)

  const sections = parseAvailableSkillsSections(systemPrompt)
  const skillNames: string[] = []
  for (const s of sections) {
    for (const e of s.entries) skillNames.push(e.name)
  }
  const visibleSkills = filterVisibleSkills(deps.cfg, skillNames)
  const allowedSkillNames = new Set(visibleSkills)

  let nextPrompt = systemPrompt
  nextPrompt = scrubAvailableTools(nextPrompt, allowedNames)
  nextPrompt = scrubAvailableSkills(nextPrompt, allowedSkillNames)

  return {
    systemPrompt: nextPrompt,
    visibleTools,
    visibleSkills,
    unchanged: nextPrompt === systemPrompt,
  }
}

/**
 * Hook handler for `before_agent_start`.
 */
export function createBeforeAgentStartHandler(deps: {
  cfg: () => Config
  pi: ExtensionAPI
}): (
  event: { systemPrompt?: string },
  ctx: unknown
) => Promise<{ systemPrompt: string } | undefined> {
  return async (event) => {
    const cfg = deps.cfg()
    const allTools = deps.pi.getAllTools()
    const previousActive = deps.pi.getActiveTools?.() ?? []

    const visibleTools = computeVisibleToolList({
      cfg,
      allTools,
      previousActiveTools: previousActive,
    })
    deps.pi.setActiveTools(visibleTools)

    if (typeof event.systemPrompt !== 'string') return undefined
    const result = applyVisibilityToPrompt(
      {
        cfg,
        allTools,
        previousActiveTools: previousActive,
      },
      event.systemPrompt
    )
    if (result.unchanged) return undefined
    return { systemPrompt: result.systemPrompt }
  }
}

function toolNameOf(t: unknown): string {
  return String((t as { name?: unknown })?.name ?? '')
}

// Re-export for tests / other handlers.
export { resolveToolVisibility, applyMode }
export type { Visibility } from '../permission/modes.ts'
