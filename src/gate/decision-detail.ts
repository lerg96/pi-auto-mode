import type { ClassifierResult, RiskLevel } from '../classifier/llm-layer.ts'
import { redact } from '../telemetry/telemetry.ts'
import { createHash } from 'node:crypto'

export interface DecisionExternalScope {
  outsideCwd: boolean
  externalDir?: string
  action?: 'allow' | 'ask' | 'deny'
}

export interface DecisionRiskDetail {
  score: number
  level: RiskLevel
  category?: string
  reason?: string
  riskOrigin?: 'rule' | 'llm'
  decision?: 'allow' | 'block' | 'ask'
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
  cwd?: string
  fullCommand?: string
  segments?: string[]
  externalScope?: DecisionExternalScope
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
  risk?: ClassifierResult['risk'] & { decision?: 'allow' | 'block' | 'ask' }
  startedAt: number
  strategy?: string
  cwd?: string
  fullCommand?: string
  segments?: string[]
  externalScope?: DecisionExternalScope
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
      ...((args.risk as { decision?: 'allow' | 'block' | 'ask' }).decision !==
      undefined
        ? {
            decision: (args.risk as { decision?: 'allow' | 'block' | 'ask' })
              .decision,
          }
        : {}),
    }
  }
  if (args.strategy !== undefined) {
    detail.strategy = args.strategy
  }
  if (args.cwd !== undefined) {
    detail.cwd = redactedString(args.cwd)
  }
  if (args.fullCommand !== undefined) {
    detail.fullCommand = redactedString(args.fullCommand)
  }
  if (args.segments !== undefined && args.segments.length > 0) {
    detail.segments = args.segments.map((s) => redactedString(s))
  }
  if (args.externalScope !== undefined) {
    detail.externalScope = {
      outsideCwd: args.externalScope.outsideCwd,
      ...(args.externalScope.externalDir === undefined
        ? {}
        : { externalDir: redactedString(args.externalScope.externalDir) }),
      ...(args.externalScope.action === undefined
        ? {}
        : { action: args.externalScope.action }),
    }
  }
  return { detail }
}
