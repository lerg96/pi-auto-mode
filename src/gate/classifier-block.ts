import type { ClassifierResult } from '../classifier/llm-layer.ts'
import type { Config } from '../types/config.ts'
import type { DenialAction } from '../deny/deny-service.ts'
import { emit, askActor, type AskAudit } from './ask-audit.ts'
import { buildDecisionDetail, type DecisionDetail } from './decision-detail.ts'
import { formatDenyMessage } from './deny-message.ts'
import { applyDenyStrategy } from './deny-strategy.ts'
import {
  AskDeniedError,
  resolveAsk,
  verdictExtra,
  type AskVerdict,
} from './ask-flow.ts'
import type { GateDeps } from './gate.ts'

export interface ClassifierBlockCtx {
  toolName: string
  surface: string
  value: string
  risk?: ClassifierResult['risk']
  startedAt: number
  rule?: { surface: string; pattern: string; reason?: string }
}

function blockMessage(ctx: ClassifierBlockCtx): string {
  return formatDenyMessage({
    kind: 'classifier_block',
    toolName: ctx.toolName,
    command: ctx.value,
    surface: ctx.surface,
    risk: ctx.risk,
  })
}

// strategy defaults to 'deny': the direct-deny paths (no override,
// crashed resolver) never reach a modal. Override + auto-retry pass
// their routing explicitly.
function detailFor(
  ctx: ClassifierBlockCtx,
  strategy?: string
): { detail: DecisionDetail } {
  return buildDecisionDetail({
    toolName: ctx.toolName,
    matchedSurface: ctx.surface,
    matchedValue: ctx.value,
    rule: ctx.rule,
    risk: ctx.risk,
    startedAt: ctx.startedAt,
    strategy,
  })
}

// Direct classifier_block deny: emit + throw, no modal involved.
function throwBlockDeny(
  deps: GateDeps,
  ctx: ClassifierBlockCtx,
  strategy: string = 'deny'
): never {
  emit(deps.hooks, ctx.surface, ctx.value, 'deny', 'classifier_block', {
    ...detailFor(ctx, strategy),
  })
  throw new Error(blockMessage(ctx))
}

export async function handleClassifierBlock(
  deps: GateDeps,
  cfg: Config,
  ctx: ClassifierBlockCtx
): Promise<boolean> {
  if (cfg.classifier.onBlockUserOverride !== true) throwBlockDeny(deps, ctx)
  let action: DenialAction | 'ask'
  try {
    action = applyDenyStrategy(
      ctx.toolName,
      ctx.risk?.reason ?? 'classifier_block',
      'classifier',
      deps
    )
  } catch {
    throwBlockDeny(deps, ctx)
  }
  if (action === 'auto-retry' || action === 'deny-and-continue') {
    throwBlockDeny(deps, ctx, action)
  }
  // action === 'ask-user'
  return classifierOverrideAsk(deps, ctx)
}

// The user pressed deny in the override modal: emit the override denial
// (audit subset only, no matchedPattern/denialReason) and throw.
function overrideDenied(
  deps: GateDeps,
  ctx: ClassifierBlockCtx,
  err: AskDeniedError
): never {
  emit(
    deps.hooks,
    ctx.surface,
    ctx.value,
    'deny',
    'classifier_block_override',
    {
      requestId: err.audit.requestId,
      decidedBy: err.audit.decidedBy,
      via: err.audit.via,
      userVerdict: 'deny',
      ...detailFor(ctx, 'ask-user'),
    }
  )
  throw new Error(blockMessage(ctx))
}

async function classifierOverrideAsk(
  deps: GateDeps,
  ctx: ClassifierBlockCtx
): Promise<boolean> {
  let requestId: string
  let verdict: AskVerdict = 'allow'
  let via: AskAudit['via'] = 'modal'
  try {
    ;({ requestId, verdict, via } = await resolveAsk(
      ctx.surface,
      ctx.value,
      ctx.risk,
      deps,
      undefined,
      ctx.toolName,
      undefined,
      ctx.startedAt,
      undefined,
      { askOrigin: 'classifier-override' }
    ))
  } catch (err) {
    if (err instanceof AskDeniedError) overrideDenied(deps, ctx, err)
    // Non-AskDeniedError failures while prompting are indistinguishable
    // from the direct classifier_block deny: same event, same message.
    throwBlockDeny(deps, ctx)
  }
  emit(
    deps.hooks,
    ctx.surface,
    ctx.value,
    'allow',
    'classifier_block_override',
    {
      requestId,
      decidedBy: askActor(via),
      via,
      ...verdictExtra(verdict),
      ...detailFor(ctx, 'ask-user'),
    }
  )
  return true
}
