import type { ClassifierResult } from '../classifier/llm-layer.ts'
import type { PermissionState } from '../permission/rule.ts'
import { wildcardMatch } from '../permission/wildcard-matcher.ts'
import { externalDirSurfaceFor } from '../permission/external-directory.ts'
import { addExternalDirAllow } from '../state/external-dir-allowlist.ts'
import { getAskResolver, normalizeAskDecision } from './ask.ts'
import { emit, type AskAudit } from './ask-audit.ts'
import { buildDecisionDetail } from './decision-detail.ts'
import type { GateDeps } from './gate.ts'

export class AskDeniedError extends Error {
  readonly audit: AskAudit
  constructor(message: string, audit: AskAudit) {
    super(message)
    this.name = 'AskDeniedError'
    this.audit = audit
  }
}

// Modal outcomes worth training on: grant-once vs grant-for-session vs
// directory-specific approvals. 'session' (no modal shown) maps to NO
// userVerdict key at all.
export type AskVerdict =
  'allow' | 'allow_session' | 'allow_dir_tool' | 'allow_dir_all' | 'session'

export function verdictExtra(verdict: AskVerdict): {
  userVerdict?: 'allow' | 'allow_session' | 'allow_dir_tool' | 'allow_dir_all'
} {
  return verdict === 'session' ? {} : { userVerdict: verdict }
}

// Audit extra fields for the ask-denied catch blocks used across the gate:
// AskDeniedError contributes its audit plus a 'deny' verdict; anything else
// contributes nothing.
export function askDeniedAudit(
  err: unknown
): Partial<AskAudit> & { userVerdict?: 'deny' } {
  if (err instanceof AskDeniedError) {
    return { ...err.audit, userVerdict: 'deny' as const }
  }
  return {}
}

// El mensaje al modelo tiene que decir la verdad: si no hubo UI nadie negó la
// llamada, y un prompt expirado tampoco es una decisión de una persona.
function askDenial(
  via: AskAudit['via'],
  requestId: string,
  denialReason?: string
): AskDeniedError {
  const suffix = denialReason ? ` (${denialReason})` : ''
  if (via === 'no-ui') {
    return new AskDeniedError(
      `Permission denied without asking: this session has no UI, so no user could approve it${suffix}. Run pi interactively, or allow the action in config.`,
      { requestId, decidedBy: 'no-ui', via, denialReason }
    )
  }
  if (via === 'timeout') {
    return new AskDeniedError(
      `Permission denied: the confirmation prompt expired without an answer${suffix}. Nothing ran; ask the user to approve it, or allow it in the config.`,
      { requestId, decidedBy: 'timeout', via, denialReason }
    )
  }
  return new AskDeniedError(
    `Permission denied by user${denialReason ? `: ${denialReason}` : ''}`,
    { requestId, decidedBy: 'user', via, denialReason }
  )
}

export interface ExternalDirAsk {
  isExternalDir: boolean
  externalDirPath?: string
  externalGrantDir?: string
}

type AllowDecision =
  'allow' | 'allow_session' | 'allow_dir_tool' | 'allow_dir_all'

// Session allow short-circuit (Bug A fix)
// Check if there's a session allow rule matching this surface and value
function trySessionAllow(
  deps: GateDeps,
  surface: string,
  value: string,
  risk: ClassifierResult['risk'] | undefined,
  toolName: string | undefined,
  startedAt: number | undefined,
  requestId: string
): boolean {
  const sessionApproved = deps.sessionRules
    .snapshot()
    .find(
      (r) =>
        r.origin === 'session' &&
        r.action === 'allow' &&
        r.surface === surface &&
        wildcardMatch(r.pattern, value)
    )
  if (!sessionApproved) return false
  emit(deps.hooks, surface, value, 'allow', 'session_allow', {
    requestId,
    decidedBy: 'session',
    via: 'session-rules',
    matchedPattern: sessionApproved.pattern,
    ...buildDecisionDetail({
      toolName: toolName ?? surface,
      matchedSurface: surface,
      matchedValue: value,
      rule: { surface, pattern: sessionApproved.pattern },
      risk,
      startedAt: startedAt ?? Date.now(),
    }),
  })
  deps.denyService?.onContinueSucceeded()
  return true
}

function applyAllowDecision(
  decision: AllowDecision,
  deps: GateDeps,
  surface: string,
  value: string,
  externalDir: ExternalDirAsk | undefined,
  toolName: string | undefined
): AskVerdict {
  deps.denyService?.onContinueSucceeded()
  if (decision === 'allow') {
    return 'allow'
  }
  if (decision === 'allow_session') {
    // Persist exact value for catch-all patterns
    const safePattern = value
    deps.sessionRules.approveForSession(surface, safePattern, 'allow')
    return 'allow_session'
  }
  if (decision === 'allow_dir_tool') {
    if (externalDir?.externalGrantDir && toolName !== undefined) {
      deps.sessionRules.approveForSession(
        externalDirSurfaceFor(toolName),
        `${externalDir.externalGrantDir}/**`,
        'allow'
      )
    }
    return 'allow_dir_tool'
  }
  if (externalDir?.externalGrantDir) {
    addExternalDirAllow(externalDir.externalGrantDir)
  }
  return 'allow_dir_all'
}

export async function resolveAsk(
  surface: string,
  value: string,
  risk: ClassifierResult['risk'] | undefined,
  deps: GateDeps,
  matchedRule?: { surface: string; pattern: string; reason?: string },
  toolName?: string,
  fullCommand?: string,
  startedAt?: number,
  externalDir?: ExternalDirAsk
): Promise<{ requestId: string; verdict: AskVerdict; via: AskAudit['via'] }> {
  const requestId =
    globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)

  if (
    trySessionAllow(deps, surface, value, risk, toolName, startedAt, requestId)
  ) {
    return { requestId, verdict: 'session', via: 'session-rules' }
  }

  const ruleForResolver = matchedRule
    ? {
        surface: matchedRule.surface,
        pattern: matchedRule.pattern,
        action: 'ask' as PermissionState,
        reason: matchedRule.reason,
      }
    : undefined

  const res = await getAskResolver()({
    surface,
    value,
    rule: ruleForResolver,
    risk,
    requestId,
    tool: toolName,
    fullCommand,
    type: externalDir?.isExternalDir ? 'external-directory' : 'tool-permission',
    externalDir: externalDir?.externalGrantDir ?? externalDir?.externalDirPath,
  })
  const { decision, reason, via } = normalizeAskDecision(res)

  if (decision !== 'deny') {
    return {
      requestId,
      via,
      verdict: applyAllowDecision(
        decision,
        deps,
        surface,
        value,
        externalDir,
        toolName
      ),
    }
  }
  // Plain 'deny' carries no user-typed reason: inherit the reason shown in
  // the modal header (permission-rule reason first, classifier risk
  // second) so the model still learns why it was denied.
  const denialReason = reason ?? matchedRule?.reason ?? risk?.reason
  throw askDenial(via, requestId, denialReason)
}
