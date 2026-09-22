import type { ClassifierResult } from '../classifier/llm-layer.ts'
import { redactSecretsForModel } from '../classifier/secret-guard.ts'

interface DenyMessageParams {
  kind:
    | 'deny-and-continue'
    | 'escalate'
    | 'classifier_block'
    | 'unknown_tool'
    | 'permission_deny'
  toolName: string
  command: string
  surface: string
  risk?: ClassifierResult['risk']
  rulePattern?: string
  ruleSurface?: string
  ruleReason?: string
}

/**
 * Self-explanatory deny message for the LLM.
 */
export function formatDenyMessage(p: DenyMessageParams): string {
  if (p.kind === 'unknown_tool') return formatUnknownToolMessage(p)
  if (p.kind === 'classifier_block') return formatClassifierBlockMessage(p)
  // permission_deny, deny-and-continue, escalate
  return formatRuleDenyMessage(p)
}

function formatUnknownToolMessage(p: DenyMessageParams): string {
  const name = p.toolName && p.toolName.length > 0 ? p.toolName : 'unknown'
  return [
    `Tool call denied: tool name was unrecognized by the gate.`,
    `  Tool: '${name}'`,
    `  Reformulation: only the registered tools can be used. Available tools`,
    `  are listed in the system prompt (if visibility filtering is active,`,
    `  only the tools the permission set allows are visible). Pick a known`,
    `  tool, or ask the user to enable a new one via the permission set.`,
  ].join('\n')
}

function formatClassifierBlockMessage(p: DenyMessageParams): string {
  const r = p.risk
  const score = r ? r.score : '?'
  const level = r ? r.level : '?'
  const category = r?.category ?? 'unknown'
  // Never leak secrets to the model: redact user-controlled strings.
  const reason = redactSecretsForModel(r?.reason ?? 'classifier verdict')
  const command = redactSecretsForModel(p.command)
  const lines: string[] = [
    `Tool call denied by classifier: command '${command}' was classified`,
    `as high risk.`,
  ]
  if (r?.riskOrigin === 'llm' && reason && reason !== 'classifier verdict') {
    lines.push(`  LLM explanation: ${reason}  (source: LLM classifier)`)
  }
  lines.push(
    `  Risk: score ${score}/10, level ${level}, category ${category},`,
    `  reason ${reason}`,
    `  Reformulation: the classifier is enforcing the same policy as the`,
    `  underlying rules — pick a non-destructive alternative (e.g. remove`,
    `  a single file instead of a recursive force, or scope the operation`,
    `  to a project-local path), or ask the user to run the original`,
    `  command manually outside the agent.`
  )
  return lines.join('\n')
}

function formatRuleDenyMessage(p: DenyMessageParams): string {
  // Never leak secrets to the model (config reasons get pasted around,
  // so they are redacted defensively; ids like surface/toolName are not).
  const rulePattern = p.rulePattern ? redactSecretsForModel(p.rulePattern) : '*'
  const ruleSurface = p.ruleSurface ?? p.surface
  const ruleReason = p.ruleReason
    ? redactSecretsForModel(p.ruleReason)
    : undefined
  const reasonPart = ruleReason
    ? `  Rule: ${ruleSurface} / ${rulePattern}  (reason: ${ruleReason})\n`
    : `  Rule: ${ruleSurface} / ${rulePattern}\n`
  const command = redactSecretsForModel(p.command)
  return [
    `Tool call denied: command '${command}' was blocked by a deny rule.`,
    reasonPart.trimEnd(),
    `  Reformulation: avoid destructive / policy-violating operations. Use a`,
    `  narrower, non-destructive alternative (e.g. remove a single file`,
    `  instead of a recursive force, or scope the operation to a`,
    `  project-local path). If the user explicitly requested this exact`,
    `  action, ask them to run it manually outside the agent.`,
  ].join('\n')
}
