import type { ClassifierResult, RiskLevel } from '../classifier/llm-layer.ts'
import type { AccessIntent } from './normalize.ts'
import type { GateDeps } from './gate.ts'

const RISK_RANK: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 }

export function classifyDecision(
  r: ClassifierResult,
  onBlock: 'ask' | 'deny' = 'deny'
): 'allow' | 'ask' | 'deny' {
  if (r.decision === 'block') return onBlock === 'deny' ? 'deny' : 'ask'
  if (r.decision === 'allow') return 'allow'
  return 'ask'
}

export function mostRestrictive(
  a: 'allow' | 'ask' | 'deny',
  b: 'allow' | 'ask' | 'deny'
): 'allow' | 'ask' | 'deny' {
  const rank = { allow: 0, ask: 1, deny: 2 }
  return rank[a] >= rank[b] ? a : b
}

export async function aggregateClassify(
  intents: AccessIntent[],
  toolName: string,
  input: Record<string, unknown>,
  deps: GateDeps
): Promise<{
  action: 'allow' | 'ask' | 'deny'
  risk?: ClassifierResult['risk']
  surface: string
  value: string
}> {
  if (deps.configState.get().classifier.enabled === false) {
    return {
      action: 'allow',
      surface: intents[0]?.surface ?? toolName,
      value: intents[0]?.value ?? '*',
    }
  }
  let action: 'allow' | 'ask' | 'deny' = 'allow'
  const onBlock = deps.configState.get().classifier.onBlock
  let risk: ClassifierResult['risk'] | undefined
  let repSurface = intents[0]?.surface ?? toolName
  let repValue = intents[0]?.value ?? '*'
  let askRepSet = false

  for (const intent of intents) {
    if (!deps.classify)
      return { action: 'deny', surface: repSurface, value: repValue }
    const r = await deps.classify({
      toolName,
      arguments: input,
      surface: intent.surface,
      value: intent.value,
    })
    const a = classifyDecision(r, onBlock)
    if (a === 'ask' && !askRepSet) {
      repSurface = intent.surface
      repValue = intent.value
      askRepSet = true
    }
    if (mostRestrictive(action, a) === a) action = a
    if (r.risk && (!risk || RISK_RANK[r.risk.level] > RISK_RANK[risk.level])) {
      risk = r.risk
    }
  }
  return { action, risk, surface: repSurface, value: repValue }
}
