import type { Config } from '../types/config.ts'
import type { configState } from '../state/config-state.ts'
import type { SessionRules } from '../permission/session-rules.ts'
import type {
  ClassifierInput,
  ClassifierResult,
} from '../classifier/llm-layer.ts'
import type { DenyAndContinueService } from '../deny/deny-service.ts'
import { evaluatePermission } from '../permission/visibility.ts'
import { evaluateExternalDirectory } from '../permission/external-directory.ts'
import { grantDirFor } from '../permission/path-scope.ts'
import { normalizeToolCall, type AccessIntent } from './normalize.ts'
import { emit, askActor, type GateHooks } from './ask-audit.ts'
import { buildDecisionDetail } from './decision-detail.ts'
import {
  resolveAsk,
  verdictExtra,
  askDeniedAudit,
  trySessionAllow,
  type ExternalDirAsk,
} from './ask-flow.ts'
import { buildSessionPatterns } from '../permission/command-prefix.ts'
import { applyDenyStrategy } from './deny-strategy.ts'
import { aggregateClassify, mostRestrictive } from './risk-aggregation.ts'
import { handleClassifierBlock } from './classifier-block.ts'
import { formatDenyMessage } from './deny-message.ts'

export { formatDenyMessage }
export type {
  DecisionRiskDetail,
  DecisionRuleDetail,
  DecisionDetail,
} from './decision-detail.ts'
export type { GateHooks } from './ask-audit.ts'

export interface GateDeps {
  configState: typeof configState
  sessionRules: SessionRules
  hooks: GateHooks
  classify?: (input: ClassifierInput) => Promise<ClassifierResult>
  denyService?: DenyAndContinueService
}

// Per-call context threaded through every phase of gateToolCall.
interface GateCtx {
  toolName: string
  input: Record<string, unknown>
  deps: GateDeps
  startedAt: number
  cfg: Config
  intents: AccessIntent[]
  fullCommand?: string
}

interface CascadeState {
  permAction: 'allow' | 'ask' | 'deny'
  matchedSurface: string
  matchedValue: string
  ruleSurface: string
  rulePattern: string
  ruleReason?: string
}

interface ExternalScopeResult {
  externalDirPath?: string
  externalGrantDir?: string
  isExternalDirAsk: boolean
}

type AggResult = Awaited<ReturnType<typeof aggregateClassify>>

type DetailFn = (strategy?: string) => ReturnType<typeof buildDecisionDetail>

// Unknown-tool path: tools with surface === 'denied' stay visible and ask
// the user; a denied ask throws the unknown-tool deny message.
async function handleUnknownToolIntent(
  ctx: GateCtx,
  value: string
): Promise<void> {
  const { deps, toolName, fullCommand, startedAt } = ctx
  const detailArgs = {
    toolName,
    matchedSurface: toolName,
    matchedValue: value,
    startedAt,
  }
  try {
    const { requestId, verdict, via } = await resolveAsk(
      toolName,
      value,
      undefined,
      deps,
      undefined,
      toolName,
      fullCommand,
      startedAt
    )
    emit(deps.hooks, toolName, value, 'allow', 'unknown_tool_ask', {
      requestId,
      decidedBy: askActor(via),
      via,
      ...verdictExtra(verdict),
      ...buildDecisionDetail(detailArgs),
    })
    return
  } catch (err) {
    emit(deps.hooks, toolName, value, 'deny', 'unknown_tool_ask', {
      ...askDeniedAudit(err),
      ...buildDecisionDetail(detailArgs),
    })
    throw new Error(
      formatDenyMessage({
        kind: 'unknown_tool',
        toolName,
        command: value,
        surface: toolName,
      })
    )
  }
}

// Evaluate permission cascade for all intents.
// Session allows do NOT skip cascade evaluation here (config deny beats
// session allow); the session short-circuit only happens in resolveAsk
// (Bug A fix).
function evaluateCascade(ctx: GateCtx): CascadeState {
  const { cfg, intents, toolName } = ctx
  const state: CascadeState = {
    permAction: 'allow',
    matchedSurface: toolName,
    matchedValue: '*',
    ruleSurface: toolName,
    rulePattern: '*',
  }
  for (const intent of intents) {
    // Evaluate permission cascade (config) - use toolName as key, not surface
    const evalResult = evaluatePermission(
      cfg,
      'tools',
      toolName,
      intent.value // callValue = the full command string for pattern matching
    )
    const cascadeAction = evalResult.action
    if (cascadeAction === undefined) continue
    if (
      cascadeAction !== 'unknown' &&
      mostRestrictive(state.permAction, cascadeAction) === cascadeAction
    ) {
      state.permAction = cascadeAction
      state.matchedSurface = intent.surface
      state.matchedValue = intent.value
      state.ruleSurface = intent.surface
      state.rulePattern = evalResult.matchedRule?.pattern ?? intent.value
      // A bare action ('ask'/'deny') is not an explanation: synthesize a
      // reason that names the match instead of leaking the action string.
      // Explicit rule reasons are left untouched.
      const matched = evalResult.matchedRule
      if (matched?.reason !== undefined) {
        state.ruleReason = matched.reason
      } else if (matched === undefined) {
        state.ruleReason = `default '${cascadeAction}' for tool '${toolName}'`
      } else {
        state.ruleReason = `rule '${matched.pattern}' matched`
      }
    }
  }
  return state
}

// External directory scope (opt-in via confineToWorkingDirectory).
// Only tightens: overwrite permAction ONLY when strictly more restrictive
// (deny > ask > allow), so an explicit tool deny always beats an explicit
// external allow. Reporting follows the triggering intent (not intent[0]).
// Track whether this ask came from the external-directory layer so the
// resolver can render the correct modal variant.
// Mutates `state` in place when the external verdict is more restrictive.
function applyExternalScope(
  ctx: GateCtx,
  state: CascadeState
): ExternalScopeResult {
  const { cfg, intents, toolName, deps } = ctx
  const externalVerdict = evaluateExternalDirectory(cfg, intents, {
    toolName,
    sessionRules: deps.sessionRules,
  })
  const externalDirPath =
    externalVerdict === undefined ? undefined : externalVerdict.absPath
  const externalGrantDir =
    externalVerdict === undefined
      ? undefined
      : grantDirFor(externalVerdict.absPath)
  let isExternalDirAsk = false
  if (externalVerdict !== undefined) {
    const rank = { allow: 0, ask: 1, deny: 2 } as const
    const wasExternalDirMoreRestrictive =
      rank[externalVerdict.action] > rank[state.permAction]
    if (wasExternalDirMoreRestrictive) {
      state.permAction = externalVerdict.action
      state.rulePattern = externalVerdict.pattern ?? '*'
      state.ruleReason = `access outside the working directory is not allowed: ${externalVerdict.absPath}`
      if (externalVerdict.matchedValue !== undefined) {
        state.matchedValue = externalVerdict.matchedValue
        state.matchedSurface =
          externalVerdict.matchedSurface ?? state.matchedSurface
      }
      isExternalDirAsk = externalVerdict.action === 'ask'
    }
  }
  return { externalDirPath, externalGrantDir, isExternalDirAsk }
}

// Hard deny (no modal): emit the deny event with the matched rule and throw
// the self-explanatory deny message.
function hardDeny(args: {
  ctx: GateCtx
  state: CascadeState
  resolution: string
  kind: 'permission_deny' | 'escalate'
  strategy: string
}): never {
  const { ctx, state, resolution, kind, strategy } = args
  const { deps, toolName, startedAt } = ctx
  emit(
    deps.hooks,
    state.matchedSurface,
    state.matchedValue,
    'deny',
    resolution,
    {
      ...buildDecisionDetail({
        toolName,
        matchedSurface: state.matchedSurface,
        matchedValue: state.matchedValue,
        rule: {
          surface: state.ruleSurface,
          pattern: state.rulePattern,
          reason: state.ruleReason,
        },
        startedAt,
        strategy,
      }),
    }
  )
  throw new Error(
    formatDenyMessage({
      kind,
      toolName,
      command: state.matchedValue,
      surface: state.matchedSurface,
      rulePattern: state.rulePattern,
      ruleSurface: state.ruleSurface,
      ruleReason: state.ruleReason,
    })
  )
}

// Deny-routing for the permission layer: auto-retry / deny-and-continue
// throw immediately, ask-user delegates to the resolver, 'escalate'
// (legacy, mapped to 'both') throws with its own strategy tag.
async function handlePermDeny(
  ctx: GateCtx,
  state: CascadeState
): Promise<void> {
  const action = applyDenyStrategy(
    ctx.toolName,
    state.ruleReason ?? 'policy_deny',
    'permission',
    ctx.deps
  )
  if (action === 'ask-user') {
    await handleDenyAskUser(ctx, state)
    return
  }
  if (action === 'auto-retry' || action === 'deny-and-continue') {
    hardDeny({
      ctx,
      state,
      resolution: 'deny_and_continue',
      kind: 'permission_deny',
      strategy: action,
    })
  }
  // action === "escalate" (legacy, mapped to 'both')
  hardDeny({
    ctx,
    state,
    resolution: 'escalate',
    kind: 'escalate',
    strategy: 'escalate',
  })
}

async function handleDenyAskUser(
  ctx: GateCtx,
  state: CascadeState
): Promise<void> {
  const { deps, toolName, fullCommand, startedAt } = ctx
  const { matchedSurface, matchedValue, ruleReason } = state
  const detail: DetailFn = (strategy) =>
    buildDecisionDetail({
      toolName,
      matchedSurface,
      matchedValue,
      rule: {
        surface: state.ruleSurface,
        pattern: state.rulePattern,
        reason: ruleReason,
      },
      startedAt,
      strategy,
    })
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
    emit(deps.hooks, matchedSurface, matchedValue, 'allow', 'permission_ask', {
      requestId,
      decidedBy: 'user',
      via: 'modal',
      ...verdictExtra(verdict),
      ...detail('ask-user'),
    })
  } catch (err) {
    emit(deps.hooks, matchedSurface, matchedValue, 'deny', 'permission_ask', {
      ...askDeniedAudit(err),
      ...detail('ask-user'),
    })
    throw err
  }
}

// Explicit allow is final: the permission layer owns the decision and
// the classifier is NOT consulted (it only hardens `ask`). Trade-off: an
// allow bypasses the LLM safety net for that call — uncovered commands
// (cascade `unknown`) also land here permissively.
function emitAllowDecision(ctx: GateCtx, state: CascadeState): void {
  emit(
    ctx.deps.hooks,
    state.matchedSurface,
    state.matchedValue,
    'allow',
    'allow',
    {
      ...buildDecisionDetail({
        toolName: ctx.toolName,
        matchedSurface: state.matchedSurface,
        matchedValue: state.matchedValue,
        startedAt: ctx.startedAt,
      }),
    }
  )
}

// permAction === "ask": harden with classifier BEFORE prompting.
async function handleAskPath(
  ctx: GateCtx,
  state: CascadeState,
  external: ExternalScopeResult
): Promise<void> {
  const agg = await aggregateClassify(
    ctx.intents,
    ctx.toolName,
    ctx.input,
    ctx.deps
  )
  if (agg.action === 'deny') {
    const proceeded = await handleClassifierBlock(ctx.deps, ctx.cfg, {
      toolName: ctx.toolName,
      surface: agg.surface,
      value: agg.value,
      risk: agg.risk,
      startedAt: ctx.startedAt,
      rule: {
        surface: ctx.toolName,
        pattern: state.rulePattern,
        reason: state.ruleReason,
      },
    })
    if (proceeded) return
    throw new Error(
      formatDenyMessage({
        kind: 'classifier_block',
        toolName: ctx.toolName,
        command: agg.value,
        surface: agg.surface,
        risk: agg.risk,
      })
    )
  }
  await promptAskAfterClassifier(ctx, state, external, agg)
}

// Which surface/value/resolution the ask prompt should carry once the
// classifier has hardened the permission ask.
function planAsk(
  ctx: GateCtx,
  state: CascadeState,
  agg: AggResult
): {
  askSurface: string
  askValue: string
  resolution: string
  matchedRuleForAsk: { surface: string; pattern: string; reason?: string }
} {
  const useClassifierRep =
    agg.risk != null && (agg.surface !== ctx.toolName || agg.value !== '*')
  const classifierInvoked =
    ctx.cfg.classifier.enabled === true && agg.risk != null
  return {
    askSurface: useClassifierRep ? agg.surface : state.matchedSurface,
    askValue: useClassifierRep ? agg.value : state.matchedValue,
    resolution: classifierInvoked ? 'classifier_ask' : 'permission_ask',
    // Always surface the permission/external rule that produced this ask:
    // when the classifier errored, its fallback reason must not mask the
    // pre-LLM reason in the modal header (rule.reason wins over risk.reason).
    matchedRuleForAsk: {
      surface: ctx.toolName,
      pattern: state.rulePattern,
      reason: state.ruleReason,
    },
  }
}

function toExternalDirAsk(
  external: ExternalScopeResult
): ExternalDirAsk | undefined {
  return external.isExternalDirAsk
    ? {
        isExternalDir: true,
        externalDirPath: external.externalDirPath,
        externalGrantDir: external.externalGrantDir,
      }
    : undefined
}

function evaluateSegmentAction(
  ctx: GateCtx,
  intent: AccessIntent
): {
  action: 'allow' | 'ask' | 'deny'
  extVerdict?: ReturnType<typeof evaluateExternalDirectory>
} {
  const evalResult = evaluatePermission(
    ctx.cfg,
    'tools',
    ctx.toolName,
    intent.value
  )
  const cascadeAction = evalResult.action
  let action: 'allow' | 'ask' | 'deny' =
    cascadeAction && cascadeAction !== 'unknown' ? cascadeAction : 'allow'
  const extVerdict = evaluateExternalDirectory(ctx.cfg, [intent], {
    toolName: ctx.toolName,
    sessionRules: ctx.deps.sessionRules,
  })
  if (extVerdict) {
    const rank = { allow: 0, ask: 1, deny: 2 } as const
    if (rank[extVerdict.action] > rank[action]) {
      action = extVerdict.action
    }
  }
  return { action, extVerdict }
}

function findUnapprovedShellSegments(
  ctx: GateCtx,
  agg: AggResult
): Array<{
  intent: AccessIntent
  extVerdict?: ReturnType<typeof evaluateExternalDirectory>
}> {
  const { deps, toolName, startedAt } = ctx
  const unapproved: Array<{
    intent: AccessIntent
    extVerdict?: ReturnType<typeof evaluateExternalDirectory>
  }> = []
  for (const intent of ctx.intents) {
    const { action, extVerdict } = evaluateSegmentAction(ctx, intent)
    if (action === 'allow') {
      continue
    }
    const reqId =
      globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)
    const approved = trySessionAllow(
      deps,
      intent.surface,
      intent.value,
      agg.risk,
      toolName,
      startedAt,
      reqId
    )
    if (!approved) {
      unapproved.push({ intent, extVerdict })
    }
  }
  return unapproved
}

async function promptAskMultiSegmentShell(
  ctx: GateCtx,
  state: CascadeState,
  external: ExternalScopeResult,
  agg: AggResult
): Promise<void> {
  const unapproved = findUnapprovedShellSegments(ctx, agg)
  const totalAsks = unapproved.length
  if (totalAsks === 0) return

  const { deps, toolName, fullCommand, startedAt } = ctx
  const { resolution } = planAsk(ctx, state, agg)
  const defaultExternalDirAsk = toExternalDirAsk(external)

  for (let k = 1; k <= totalAsks; k++) {
    const { intent: seg, extVerdict } = unapproved[k - 1]
    const sessionPatterns = buildSessionPatterns(seg.value)
    const matchedRule = {
      surface: toolName,
      pattern: state.rulePattern,
      reason: state.ruleReason,
    }
    const detailArgs = {
      toolName,
      matchedSurface: seg.surface,
      matchedValue: seg.value,
      rule: matchedRule,
      risk: agg.risk,
      startedAt,
    }
    const segExternalDirAsk =
      extVerdict && extVerdict.action === 'ask'
        ? {
            isExternalDir: true,
            externalDirPath: extVerdict.absPath,
            externalGrantDir: grantDirFor(extVerdict.absPath),
          }
        : defaultExternalDirAsk

    try {
      const { requestId, verdict, via } = await resolveAsk(
        seg.surface,
        seg.value,
        agg.risk,
        deps,
        matchedRule,
        toolName,
        fullCommand,
        startedAt,
        segExternalDirAsk,
        {
          sessionPatterns,
          segmentIndex: k,
          segmentTotal: totalAsks,
        }
      )
      emit(deps.hooks, seg.surface, seg.value, 'allow', resolution, {
        requestId,
        decidedBy: askActor(via),
        via,
        ...verdictExtra(verdict),
        ...buildDecisionDetail(detailArgs),
      })
    } catch (err) {
      emit(deps.hooks, seg.surface, seg.value, 'deny', resolution, {
        ...askDeniedAudit(err),
        ...buildDecisionDetail(detailArgs),
      })
      throw err
    }
  }
}

async function promptAskAfterClassifier(
  ctx: GateCtx,
  state: CascadeState,
  external: ExternalScopeResult,
  agg: AggResult
): Promise<void> {
  if (
    ctx.intents.length > 1 &&
    ctx.intents.every((i) => i.surface === 'shell')
  ) {
    return promptAskMultiSegmentShell(ctx, state, external, agg)
  }

  const { deps, toolName, fullCommand, startedAt } = ctx
  const { askSurface, askValue, resolution, matchedRuleForAsk } = planAsk(
    ctx,
    state,
    agg
  )
  const detailArgs = {
    toolName,
    matchedSurface: askSurface,
    matchedValue: askValue,
    rule: matchedRuleForAsk,
    risk: agg.risk,
    startedAt,
  }
  const externalDirAsk = toExternalDirAsk(external)
  const isShell =
    askSurface === 'shell' ||
    ctx.intents.some((i) => i.surface === 'shell') ||
    toolName === 'bash'
  const sessionPatterns = isShell ? buildSessionPatterns(askValue) : undefined

  try {
    const { requestId, verdict, via } = await resolveAsk(
      askSurface,
      askValue,
      agg.risk,
      deps,
      matchedRuleForAsk,
      toolName,
      fullCommand,
      startedAt,
      externalDirAsk,
      sessionPatterns ? { sessionPatterns } : undefined
    )
    emit(deps.hooks, askSurface, askValue, 'allow', resolution, {
      requestId,
      decidedBy: askActor(via),
      via,
      ...verdictExtra(verdict),
      ...buildDecisionDetail(detailArgs),
    })
  } catch (err) {
    emit(deps.hooks, askSurface, askValue, 'deny', resolution, {
      ...askDeniedAudit(err),
      ...buildDecisionDetail(detailArgs),
    })
    throw err
  }
}

export async function gateToolCall(
  toolName: string,
  input: Record<string, unknown>,
  deps: GateDeps
): Promise<void> {
  const ctx: GateCtx = {
    toolName,
    input,
    deps,
    startedAt: Date.now(),
    cfg: deps.configState.get(),
    intents: normalizeToolCall(toolName, input),
    fullCommand:
      typeof input.command === 'string' && input.command.length > 0
        ? input.command
        : undefined,
  }

  // Unknown tools (surface === 'denied') are visible and ask the user
  const deniedIntent = ctx.intents.find((i) => i.surface === 'denied')
  if (deniedIntent) {
    return handleUnknownToolIntent(ctx, deniedIntent.value)
  }

  const state = evaluateCascade(ctx)
  // Session allow does NOT override permission cascade result here.
  // Session short-circuit only happens in resolveAsk (Bug A fix).
  const external = applyExternalScope(ctx, state)

  if (state.permAction === 'deny') {
    return handlePermDeny(ctx, state)
  }

  if (state.permAction === 'allow') {
    return emitAllowDecision(ctx, state)
  }

  // permAction === "ask": harden with classifier BEFORE prompting
  return handleAskPath(ctx, state, external)
}
