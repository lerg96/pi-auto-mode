import type { ClassifierResult, RiskLevel } from '../classifier/llm-layer.ts'
import { redact } from '../telemetry/telemetry.ts'
import { createHash } from 'node:crypto'

export interface DecisionRiskDetail {
  score: number
  level: RiskLevel
  category?: string
  reason?: string
  riskOrigin?: 'rule' | 'llm'
}

export interface DecisionRuleDetail {
  surface: string
  pattern: string
  reason?: string
  // Stable rule identity (sha1 surface|pattern, 12 hex): lets a model
  // group by rule without seeing raw patterns.
  ruleId: string
}

export interface DecisionDetail {
  toolName: string
  matchedSurface: string
  matchedValue: string
  rule?: DecisionRuleDetail
  risk?: DecisionRiskDetail
  latencyMs: number
  // Deny-routing outcome that produced this event, when a deny strategy
  // ran: 'auto-retry' | 'deny-and-continue' | 'ask-user' | 'escalate' |
  // 'deny'. Absent on allow/ask paths that never hit deny routing.
  strategy?: string
}

// Stable rule identity for training grouping. Patterns stay in the payload
// (operators need them); the hash is the join key.
function ruleIdFor(surface: string, pattern: string): string {
  return createHash('sha1')
    .update(`${surface}|${pattern}`)
    .digest('hex')
    .slice(0, 12)
}

function redactedString(value: string): string {
  const redacted = redact(value)
  return typeof redacted === 'string' ? redacted : '[REDACTED]'
}

export function buildDecisionDetail(args: {
  toolName: string
  matchedSurface: string
  matchedValue: string
  rule?: { surface: string; pattern: string; reason?: string }
  risk?: ClassifierResult['risk']
  startedAt: number
  strategy?: string
}): { detail: DecisionDetail } {
  const detail: DecisionDetail = {
    toolName: args.toolName,
    matchedSurface: args.matchedSurface,
    matchedValue: redactedString(args.matchedValue),
    latencyMs: Date.now() - args.startedAt,
  }
  if (args.rule !== undefined) {
    detail.rule = {
      surface: args.rule.surface,
      pattern: redactedString(args.rule.pattern),
      ...(args.rule.reason === undefined
        ? {}
        : { reason: redactedString(args.rule.reason) }),
      ruleId: ruleIdFor(args.rule.surface, args.rule.pattern),
    }
  }
  if (args.risk !== undefined) {
    detail.risk = {
      score: args.risk.score,
      level: args.risk.level,
      ...(args.risk.category === undefined
        ? {}
        : { category: redactedString(args.risk.category) }),
      ...(args.risk.reason === undefined
        ? {}
        : { reason: redactedString(args.risk.reason) }),
      ...(args.risk.riskOrigin === undefined
        ? {}
        : { riskOrigin: args.risk.riskOrigin }),
    }
  }
  if (args.strategy !== undefined) {
    detail.strategy = args.strategy
  }
  return { detail }
}
