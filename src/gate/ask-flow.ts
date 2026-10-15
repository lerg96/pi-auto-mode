import type { ClassifierResult } from '../classifier/llm-layer.ts'
import type { PermissionState } from '../permission/rule.ts'
import {
  wildcardMatch,
  sessionPatternMatches,
} from '../permission/wildcard-matcher.ts'
import { externalDirSurfaceFor } from '../permission/external-directory.ts'
import { addExternalDirAllow } from '../state/external-dir-allowlist.ts'
import { getAskResolver, normalizeAskDecision, type AskOrigin } from './ask.ts'
import { emit, type AskAudit } from './ask-audit.ts'
import { buildDecisionDetail } from './decision-detail.ts'
import type { GateDeps } from './gate.ts'
import { persistPermanentAllow } from '../config/permanent-allow.ts'

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
  | 'allow'
  | 'allow_session'
  | 'allow_permanent'
  | 'allow_dir_tool'
  | 'allow_dir_all'
  | 'session'

export function verdictExtra(verdict: AskVerdict): {
  userVerdict?:
    | 'allow'
    | 'allow_session'
    | 'allow_permanent'
    | 'allow_dir_tool'
    | 'allow_dir_all'
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
  | 'allow'
  | 'allow_session'
  | 'allow_permanent'
  | 'allow_dir_tool'
  | 'allow_dir_all'

function normalizePatternOrValue(str: string): string {
  const collapsed = str.replace(/["']/g, '').replace(/\s+/g, ' ').trim()
  return process.platform === 'win32' ? collapsed.toLowerCase() : collapsed
}

// Session allow short-circuit (Bug A fix)
// Check if there's a session allow rule matching this surface and value
export function trySessionAllow(
  deps: GateDeps,
  surface: string,
  value: string,
  risk: ClassifierResult['risk'] | undefined,
  toolName: string | undefined,
  startedAt: number | undefined,
  requestId: string
): boolean {
  const sessionApproved = deps.sessionRules.snapshot().find((r) => {
    if (
      r.origin !== 'session' ||
      r.action !== 'allow' ||
      r.surface !== surface
    ) {
      return false
    }
    const isWin = process.platform === 'win32'
    if (r.isExact) {
      const exactMatch = isWin
        ? r.pattern.toLowerCase() === value.toLowerCase()
        : r.pattern === value
      const normMatch =
        normalizePatternOrValue(r.pattern) === normalizePatternOrValue(value)
      return (
        exactMatch ||
        normMatch ||
        sessionPatternMatches(r.pattern, value) ||
        sessionPatternMatches(
          normalizePatternOrValue(r.pattern),
          normalizePatternOrValue(value)
        )
      )
    }
    return (
      sessionPatternMatches(r.pattern, value) ||
      sessionPatternMatches(
        normalizePatternOrValue(r.pattern),
        normalizePatternOrValue(value)
      ) ||
      normalizePatternOrValue(r.pattern) === normalizePatternOrValue(value)
    )
  })
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
  toolName: string | undefined,
  chosenPattern?: string
): AskVerdict {
  deps.denyService?.onContinueSucceeded()
  if (decision === 'allow') {
    return 'allow'
  }
  if (decision === 'allow_session') {
    const safePattern = chosenPattern ?? value
    const isExact = chosenPattern ? chosenPattern === value : true
    deps.sessionRules.approveForSession(surface, safePattern, 'allow', isExact)
    return 'allow_session'
  }
  if (decision === 'allow_permanent') {
    const safePattern =
      chosenPattern ??
      (externalDir?.isExternalDir && externalDir.externalGrantDir
        ? `${externalDir.externalGrantDir}/**`
        : value)
    const isExact = chosenPattern ? chosenPattern === value : true
    deps.sessionRules.approveForSession(surface, safePattern, 'allow', isExact)
    persistPermanentAllow({
      surface: externalDir?.isExternalDir ? 'external_directory' : surface,
      pattern: safePattern,
      toolName,
      isExternalDir: externalDir?.isExternalDir,
    })
    return 'allow_permanent'
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

export interface ResolveAskExtra {
  sessionPatterns?: string[]
  segmentIndex?: number
  segmentTotal?: number
  askOrigin?: AskOrigin
  cwd?: string
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
  externalDir?: ExternalDirAsk,
  extra?: ResolveAskExtra
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

  const askOrigin: AskOrigin | undefined =
    extra?.askOrigin ??
    (externalDir?.isExternalDir ? 'external-directory' : undefined)

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
    sessionPatterns: extra?.sessionPatterns,
    segmentIndex: extra?.segmentIndex,
    segmentTotal: extra?.segmentTotal,
    askOrigin,
    cwd: extra?.cwd,
  })
  const { decision, reason, via, pattern } = normalizeAskDecision(res)

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
        toolName,
        pattern
      ),
    }
  }
  // Plain 'deny' carries no user-typed reason: inherit the reason shown in
  // the modal header (permission-rule reason first, classifier risk
  // second) so the model still learns why it was denied.
  const denialReason = reason ?? matchedRule?.reason ?? risk?.reason
  throw askDenial(via, requestId, denialReason)
}
