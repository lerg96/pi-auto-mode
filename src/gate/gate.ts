import type { Config } from '../types/config.ts'
import type { configState } from '../state/config-state.ts'
import type { SessionRules } from '../permission/session-rules.ts'
import type {
  ClassifierInput,
  ClassifierResult,
  RiskLevel,
} from '../classifier/llm-layer.ts'
import type { PermissionState } from '../permission/rule.ts'
import type {
  DenyAndContinueService,
  DenialAction,
} from '../deny/deny-service.ts'
import { evaluatePermission } from '../permission/visibility.ts'
import { evaluateExternalDirectory } from '../permission/external-directory.ts'
import { wildcardMatch } from '../permission/wildcard-matcher.ts'
import { normalizeToolCall, type AccessIntent } from './normalize.ts'
import { getAskResolver, normalizeAskDecision, type AskVia } from './ask.ts'
import { BUS_CHANNEL_DECISION } from '../events.ts'
import { redactSecretsForModel } from '../classifier/secret-guard.ts'
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

function buildDecisionDetail(args: {
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

export interface GateHooks {
  emit?: (channel: string, data: unknown) => void
}

export interface GateDeps {
  configState: typeof configState
  sessionRules: SessionRules
  hooks: GateHooks
  classify?: (input: ClassifierInput) => Promise<ClassifierResult>
  denyService?: DenyAndContinueService
}

interface AskAudit {
  requestId?: string
  // 'no-ui' = no se mostró ningún modal: no hubo humano que decidiera. Darlo
  // como 'user' falsea la auditoría (y entrena al modelo con datos falsos).
  // 'timeout' = se mostró, pero nadie respondió antes de expirar.
  decidedBy: 'user' | 'session' | 'no-ui' | 'timeout'
  // 'parent-modal' = el modal se renderizó en la UI de otra sesión del
  // proceso (sub-sesión sin UI propia). Derivado de AskVia para que el gate no
  // pueda quedarse atrás cuando ask.ts añade un origen nuevo.
  via: AskVia | 'session-rules'
  matchedPattern?: string
  denialReason?: string
}

function emit(
  hooks: GateHooks,
  surface: string,
  value: string,
  result: string,
  resolution: string,
  extra?: AskAudit | Record<string, unknown>
): void {
  try {
    hooks.emit?.(BUS_CHANNEL_DECISION, {
      surface,
      value,
      result,
      resolution,
      ...extra,
    })
  } catch {
    /* fire-and-forget */
  }
}

// Quién hay detrás de la decisión de un ask. `no-ui` nunca es un usuario: no
// se mostró ningún prompt, así que atribuirla a una persona falsea la
// auditoría y el mensaje que recibe el modelo. Lo mismo con `timeout` (nadie
// respondió) y `session-rules` (quién decidió fue una aprobación previa).
function askActor(via: AskAudit['via']): AskAudit['decidedBy'] {
  switch (via) {
    case 'no-ui':
      return 'no-ui'
    case 'timeout':
      return 'timeout'
    case 'session-rules':
      return 'session'
    default:
      return 'user'
  }
}

const RISK_RANK: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 }

function classifyDecision(
  r: ClassifierResult,
  onBlock: 'ask' | 'deny' = 'deny'
): 'allow' | 'ask' | 'deny' {
  if (r.decision === 'block') return onBlock === 'deny' ? 'deny' : 'ask'
  if (r.decision === 'allow') return 'allow'
  return 'ask'
}

function applyDenyStrategy(
  toolName: string,
  reason: string,
  trigger: 'permission' | 'classifier',
  deps: GateDeps
): DenialAction | 'ask' {
  if (!deps.denyService) return 'ask'
  return deps.denyService.recordDenial({ toolName, reason, trigger })
}

async function handleClassifierBlock(
  toolName: string,
  surface: string,
  value: string,
  risk: ClassifierResult['risk'] | undefined,
  deps: GateDeps,
  cfg: Config,
  opts: {
    startedAt: number
    rule?: { surface: string; pattern: string; reason?: string }
  }
): Promise<boolean> {
  const blockMessage = () =>
    formatDenyMessage({
      kind: 'classifier_block',
      toolName,
      command: value,
      surface,
      risk,
    })
  // strategy defaults to 'deny': the direct-deny paths (no override,
  // crashed resolver) never reach a modal. Override + auto-retry pass
  // their routing explicitly.
  const detail = (strategy: string = 'deny') =>
    buildDecisionDetail({
      toolName,
      matchedSurface: surface,
      matchedValue: value,
      rule: opts.rule,
      risk,
      startedAt: opts.startedAt,
      strategy,
    })
  if (cfg.classifier.onBlockUserOverride !== true) {
    emit(deps.hooks, surface, value, 'deny', 'classifier_block', {
      ...detail(),
    })
    throw new Error(blockMessage())
  }
  const reason = risk?.reason ?? 'classifier_block'
  let action: DenialAction | 'ask'
  try {
    action = applyDenyStrategy(toolName, reason, 'classifier', deps)
  } catch {
    emit(deps.hooks, surface, value, 'deny', 'classifier_block', {
      ...detail(),
    })
    throw new Error(blockMessage())
  }
  if (action === 'auto-retry' || action === 'deny-and-continue') {
    emit(deps.hooks, surface, value, 'deny', 'classifier_block', {
      ...detail(action),
    })
    throw new Error(blockMessage())
  }
  // action === 'ask-user'
  let requestId: string
  let verdict: AskVerdict = 'allow'
  let via: AskAudit['via'] = 'modal'
  try {
    ;({ requestId, verdict, via } = await resolveAsk(
      surface,
      value,
      risk,
      deps,
      undefined,
      toolName,
      undefined,
      opts.startedAt
    ))
  } catch (err) {
    if (err instanceof AskDeniedError) {
      emit(deps.hooks, surface, value, 'deny', 'classifier_block_override', {
        requestId: err.audit.requestId,
        decidedBy: err.audit.decidedBy,
        via: err.audit.via,
        userVerdict: 'deny',
        ...detail('ask-user'),
      })
      throw new Error(blockMessage())
    }
    emit(deps.hooks, surface, value, 'deny', 'classifier_block', {
      ...detail(),
    })
    throw new Error(blockMessage())
  }
  emit(deps.hooks, surface, value, 'allow', 'classifier_block_override', {
    requestId,
    decidedBy: askActor(via),
    via,
    ...verdictExtra(verdict),
    ...detail('ask-user'),
  })
  return true
}

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
  if (p.kind === 'unknown_tool') {
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
  if (p.kind === 'classifier_block') {
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
  // permission_deny, deny-and-continue, escalate
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

class AskDeniedError extends Error {
  readonly audit: AskAudit
  constructor(message: string, audit: AskAudit) {
    super(message)
    this.name = 'AskDeniedError'
    this.audit = audit
  }
}

// Modal outcomes worth training on: grant-once vs grant-for-session are
// different approval strengths. 'session' (no modal shown) maps to NO
// userVerdict key at all.
type AskVerdict = 'allow' | 'allow_session' | 'session'

function verdictExtra(verdict: AskVerdict): {
  userVerdict?: 'allow' | 'allow_session'
} {
  return verdict === 'session' ? {} : { userVerdict: verdict }
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

async function resolveAsk(
  surface: string,
  value: string,
  risk: ClassifierResult['risk'] | undefined,
  deps: GateDeps,
  matchedRule?: { surface: string; pattern: string; reason?: string },
  toolName?: string,
  fullCommand?: string,
  startedAt?: number
): Promise<{ requestId: string; verdict: AskVerdict; via: AskAudit['via'] }> {
  const requestId =
    globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)

  // Session allow short-circuit (Bug A fix)
  // Check if there's a session allow rule matching this surface and value
  const sessionApproved = deps.sessionRules
    .snapshot()
    .find(
      (r) =>
        r.origin === 'session' &&
        r.action === 'allow' &&
        r.surface === surface &&
        wildcardMatch(r.pattern, value)
    )
  if (sessionApproved) {
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
  })
  const { decision, reason, via } = normalizeAskDecision(res)

  if (decision === 'allow') {
    deps.denyService?.onContinueSucceeded()
    return { requestId, verdict: 'allow', via }
  }
  if (decision === 'allow_session') {
    deps.denyService?.onContinueSucceeded()
    // Persist exact value for catch-all patterns
    const safePattern = value
    deps.sessionRules.approveForSession(surface, safePattern, 'allow')
    return { requestId, verdict: 'allow_session', via }
  }
  // Plain 'deny' carries no user-typed reason: inherit the reason shown in
  // the modal header (permission-rule reason first, classifier risk
  // second) so the model still learns why it was denied.
  const denialReason = reason ?? matchedRule?.reason ?? risk?.reason
  throw askDenial(via, requestId, denialReason)
}

async function aggregateClassify(
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

function mostRestrictive(
  a: 'allow' | 'ask' | 'deny',
  b: 'allow' | 'ask' | 'deny'
): 'allow' | 'ask' | 'deny' {
  const rank = { allow: 0, ask: 1, deny: 2 }
  return rank[a] >= rank[b] ? a : b
}

export async function gateToolCall(
  toolName: string,
  input: Record<string, unknown>,
  deps: GateDeps
): Promise<void> {
  const startedAt = Date.now()
  const cfg = deps.configState.get()
  const intents = normalizeToolCall(toolName, input)
  const fullCommand =
    typeof input.command === 'string' && input.command.length > 0
      ? input.command
      : undefined

  // Unknown tools (surface === 'denied') are visible and ask the user
  const deniedIntent = intents.find((i) => i.surface === 'denied')
  if (deniedIntent) {
    try {
      const { requestId, verdict, via } = await resolveAsk(
        toolName,
        deniedIntent.value,
        undefined,
        deps,
        undefined,
        toolName,
        fullCommand,
        startedAt
      )
      emit(
        deps.hooks,
        toolName,
        deniedIntent.value,
        'allow',
        'unknown_tool_ask',
        {
          requestId,
          decidedBy: askActor(via),
          via,
          ...verdictExtra(verdict),
          ...buildDecisionDetail({
            toolName,
            matchedSurface: toolName,
            matchedValue: deniedIntent.value,
            startedAt,
          }),
        }
      )
      return
    } catch (err) {
      const audit = err instanceof AskDeniedError ? err.audit : undefined
      emit(
        deps.hooks,
        toolName,
        deniedIntent.value,
        'deny',
        'unknown_tool_ask',
        {
          ...audit,
          ...(err instanceof AskDeniedError
            ? { userVerdict: 'deny' as const }
            : {}),
          ...buildDecisionDetail({
            toolName,
            matchedSurface: toolName,
            matchedValue: deniedIntent.value,
            startedAt,
          }),
        }
      )
      throw new Error(
        formatDenyMessage({
          kind: 'unknown_tool',
          toolName,
          command: deniedIntent.value,
          surface: toolName,
        })
      )
    }
  }

  // Evaluate permission cascade for all intents.
  // Returns: 'allow' | 'ask' | 'deny' | undefined
  let permAction: 'allow' | 'ask' | 'deny' = 'allow'
  let matchedSurface = toolName
  let matchedValue = '*'
  let rulePattern = '*'
  let ruleSurface = toolName
  let ruleReason: string | undefined

  for (const intent of intents) {
    // Evaluate permission cascade (config) - use toolName as key, not surface
    // Session allows do NOT skip cascade evaluation here (config deny beats session allow)
    // Session short-circuit only happens in resolveAsk (Bug A fix).
    const evalResult = evaluatePermission(
      cfg,
      'tools',
      toolName,
      intent.value // callValue = the full command string for pattern matching
    )
    const cascadeAction = evalResult.action

    if (cascadeAction !== undefined) {
      if (
        cascadeAction !== 'unknown' &&
        mostRestrictive(permAction, cascadeAction) === cascadeAction
      ) {
        permAction = cascadeAction
        matchedSurface = intent.surface
        matchedValue = intent.value
        ruleSurface = intent.surface
        rulePattern = evalResult.matchedRule?.pattern ?? intent.value
        // A bare action ('ask'/'deny') is not an explanation: synthesize a
        // reason that names the match instead of leaking the action string.
        // Explicit rule reasons are left untouched.
        const matched = evalResult.matchedRule
        if (matched?.reason !== undefined) {
          ruleReason = matched.reason
        } else if (matched === undefined) {
          ruleReason = `default '${cascadeAction}' for tool '${toolName}'`
        } else {
          ruleReason = `rule '${matched.pattern}' matched`
        }
      }
    }
  }

  // Session allow does NOT override permission cascade result here.
  // Session short-circuit only happens in resolveAsk (Bug A fix).

  // External directory scope (opt-in via confineToWorkingDirectory).
  // Only tightens: overwrite permAction ONLY when strictly more restrictive
  // (deny > ask > allow), so an explicit tool deny always beats an explicit
  // external allow. Reporting follows the triggering intent (not intent[0]).
  const externalVerdict = evaluateExternalDirectory(cfg, intents)
  if (externalVerdict !== undefined) {
    const rank = { allow: 0, ask: 1, deny: 2 } as const
    if (rank[externalVerdict.action] > rank[permAction]) {
      permAction = externalVerdict.action
      rulePattern = externalVerdict.pattern ?? '*'
      ruleReason = `access outside the working directory is not allowed: ${externalVerdict.absPath}`
      if (externalVerdict.matchedValue !== undefined) {
        matchedValue = externalVerdict.matchedValue
        matchedSurface = externalVerdict.matchedSurface ?? matchedSurface
      }
    }
  }

  if (permAction === 'deny') {
    const action = applyDenyStrategy(
      toolName,
      ruleReason ?? 'policy_deny',
      'permission',
      deps
    )
    if (action === 'auto-retry' || action === 'deny-and-continue') {
      emit(
        deps.hooks,
        matchedSurface,
        matchedValue,
        'deny',
        'deny_and_continue',
        {
          ...buildDecisionDetail({
            toolName,
            matchedSurface,
            matchedValue,
            rule: {
              surface: ruleSurface,
              pattern: rulePattern,
              reason: ruleReason,
            },
            startedAt,
            strategy: action,
          }),
        }
      )
      throw new Error(
        formatDenyMessage({
          kind: 'permission_deny',
          toolName,
          command: matchedValue,
          surface: matchedSurface,
          rulePattern,
          ruleSurface,
          ruleReason,
        })
      )
    }
    if (action === 'ask-user') {
      try {
        const { requestId, verdict } = await resolveAsk(
          matchedSurface,
          matchedValue,
          undefined,
          deps,
          { surface: toolName, pattern: matchedValue, reason: ruleReason },
          toolName,
          fullCommand,
          startedAt
        )
        emit(
          deps.hooks,
          matchedSurface,
          matchedValue,
          'allow',
          'permission_ask',
          {
            requestId,
            decidedBy: 'user',
            via: 'modal',
            ...verdictExtra(verdict),
            ...buildDecisionDetail({
              toolName,
              matchedSurface,
              matchedValue,
              rule: {
                surface: ruleSurface,
                pattern: rulePattern,
                reason: ruleReason,
              },
              startedAt,
              strategy: 'ask-user',
            }),
          }
        )
      } catch (err) {
        const audit = err instanceof AskDeniedError ? err.audit : undefined
        emit(
          deps.hooks,
          matchedSurface,
          matchedValue,
          'deny',
          'permission_ask',
          {
            ...audit,
            ...(err instanceof AskDeniedError
              ? { userVerdict: 'deny' as const }
              : {}),
            ...buildDecisionDetail({
              toolName,
              matchedSurface,
              matchedValue,
              rule: {
                surface: ruleSurface,
                pattern: rulePattern,
                reason: ruleReason,
              },
              startedAt,
              strategy: 'ask-user',
            }),
          }
        )
        throw err
      }
      return
    }
    // action === "escalate" (legacy, mapped to 'both')
    emit(deps.hooks, matchedSurface, matchedValue, 'deny', 'escalate', {
      ...buildDecisionDetail({
        toolName,
        matchedSurface,
        matchedValue,
        rule: {
          surface: ruleSurface,
          pattern: rulePattern,
          reason: ruleReason,
        },
        startedAt,
        strategy: 'escalate',
      }),
    })
    throw new Error(
      formatDenyMessage({
        kind: 'escalate',
        toolName,
        command: matchedValue,
        surface: matchedSurface,
        rulePattern,
        ruleSurface,
        ruleReason,
      })
    )
  }

  if (permAction === 'allow') {
    // Explicit allow is final: the permission layer owns the decision and
    // the classifier is NOT consulted (it only hardens `ask`, see below).
    // Trade-off: an allow bypasses the LLM safety net for that call —
    // uncovered commands (cascade `unknown`) also land here permissively.
    emit(deps.hooks, matchedSurface, matchedValue, 'allow', 'allow', {
      ...buildDecisionDetail({
        toolName,
        matchedSurface,
        matchedValue,
        startedAt,
      }),
    })
    return
  }

  // permAction === "ask": harden with classifier BEFORE prompting
  const agg = await aggregateClassify(intents, toolName, input, deps)
  if (agg.action === 'deny') {
    const proceeded = await handleClassifierBlock(
      toolName,
      agg.surface,
      agg.value,
      agg.risk,
      deps,
      cfg,
      {
        startedAt,
        rule: { surface: toolName, pattern: rulePattern, reason: ruleReason },
      }
    )
    if (proceeded) return
    throw new Error(
      formatDenyMessage({
        kind: 'classifier_block',
        toolName,
        command: agg.value,
        surface: agg.surface,
        risk: agg.risk,
      })
    )
  }
  const useClassifierRep =
    agg.risk != null && (agg.surface !== toolName || agg.value !== '*')
  const askSurface = useClassifierRep ? agg.surface : matchedSurface
  const askValue = useClassifierRep ? agg.value : matchedValue
  const classifierInvoked = cfg.classifier.enabled === true && agg.risk != null
  const resolution = classifierInvoked ? 'classifier_ask' : 'permission_ask'
  // Always surface the permission/external rule that produced this ask:
  // when the classifier errored, its fallback reason must not mask the
  // pre-LLM reason in the modal header (rule.reason wins over risk.reason).
  const matchedRuleForAsk = {
    surface: toolName,
    pattern: rulePattern,
    reason: ruleReason,
  }
  try {
    const { requestId, verdict, via } = await resolveAsk(
      askSurface,
      askValue,
      agg.risk,
      deps,
      matchedRuleForAsk,
      toolName,
      fullCommand,
      startedAt
    )
    emit(deps.hooks, askSurface, askValue, 'allow', resolution, {
      requestId,
      decidedBy: askActor(via),
      via,
      ...verdictExtra(verdict),
      ...buildDecisionDetail({
        toolName,
        matchedSurface: askSurface,
        matchedValue: askValue,
        rule: matchedRuleForAsk,
        risk: agg.risk,
        startedAt,
      }),
    })
  } catch (err) {
    const audit = err instanceof AskDeniedError ? err.audit : undefined
    emit(deps.hooks, askSurface, askValue, 'deny', resolution, {
      ...audit,
      ...(err instanceof AskDeniedError
        ? { userVerdict: 'deny' as const }
        : {}),
      ...buildDecisionDetail({
        toolName,
        matchedSurface: askSurface,
        matchedValue: askValue,
        rule: matchedRuleForAsk,
        risk: agg.risk,
        startedAt,
      }),
    })
    throw err
  }
}
