import type {
  ExtensionAPI,
  ExtensionContext,
  PiEventHandler,
  PiEventData,
} from '@earendil-works/pi-coding-agent'
import type { Config } from './types/config.ts'
import {
  loadConfig,
  watchConfig,
  isSecurityWeakening,
  resolveConfigPath,
} from './config/config-loader.ts'

import { handleSessionStart, handleSessionShutdown } from './handlers/stub.ts'
import { configState } from './state/config-state.ts'
import { setUiContext, notifyUi } from './state/ui-context.ts'
import { registerSetCommands } from './commands/set-commands.ts'
import { SessionRules } from './permission/session-rules.ts'
import { evaluatePermission } from './permission/visibility.ts'

import { initShellParser } from './permission/shell-parse.ts'
import { surfaceForTool } from './gate/normalize.ts'
import { createBeforeAgentStartHandler } from './handlers/before-agent-start.ts'
import { gateToolCall } from './gate/gate.ts'
import { setAskResolver } from './gate/ask.ts'
import { createModalAskResolver } from './ui/permission-modal.ts'
import { classifyToolCall } from './classifier/llm-layer.ts'
import { DenyAndContinueService } from './deny/deny-service.ts'
import { TelemetryLogger } from './telemetry/telemetry.ts'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

// Resolved at module load: the directory this extension file lives in, used
// to locate `config.example.json` when seeding the user config.
const __filename = fileURLToPath(import.meta.url)
const extensionDir = dirname(__filename)

const sessionRules = new SessionRules()

// ─── Fail-closed wrapper ────────────────────────────────────────
/**
 * Wraps a tool-call handler so that ANY error blocks execution (fail-closed).
 */
export function createFailClosedToolCall(
  handler: PiEventHandler,
  onError?: (err: unknown) => void
): PiEventHandler {
  return async (event: PiEventData, ctx: ExtensionContext) => {
    try {
      await handler(event, ctx)
    } catch (err) {
      onError?.(err)
      throw err // block execution
    }
  }
}

// ─── Initial config load (fail-closed) ──────────────────────────
/**
 * Loads and validates the initial config. On any read/parse/schema error it
 * reports the detail via `onError` and rethrows — it NEVER falls back to an
 * empty default config that would silently disable every rule (M4 fail-closed).
 */
export function loadInitialConfig(
  cfgPath: string,
  opts: { onError?: (detail: string) => void } = {}
): Config {
  try {
    return loadConfig(cfgPath)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    const cause = (err as { cause?: unknown })?.cause
    const causeMsg = cause instanceof Error ? cause.message : ''
    const message = causeMsg ? `${detail} — ${causeMsg}` : detail
    if (opts.onError) opts.onError(message)
    else console.error(`pi-auto-mode: ${message}`)
    throw err
  }
}

// ─── Session lifecycle (M3) ─────────────────────────────────────
/**
 * Begins a session: clears per-session permission rules AND resets the
 * deny-service counters so denials from a previous session can't carry over and
 * force escalation in the new one.
 */
export function beginSession(
  sessionRules: SessionRules,
  denyService: DenyAndContinueService,
  base: PiEventHandler,
  event: PiEventData,
  ctx: ExtensionContext
): void {
  sessionRules.clear()
  denyService.reset()
  void base(event, ctx)
}

/** Ends a session; mirrors {@link beginSession} for symmetry of reset. */
export function endSession(
  sessionRules: SessionRules,
  denyService: DenyAndContinueService,
  base: PiEventHandler,
  event: PiEventData,
  ctx: ExtensionContext
): void {
  sessionRules.clear()
  denyService.reset()
  void base(event, ctx)
}

// ─── Config reload (S3 fail-closed) ─────────────────────────────
export interface ReloadDeps {
  configState: typeof configState
  denyService: DenyAndContinueService
  telemetry: Pick<TelemetryLogger, 'update'>
  // Optional so older/tests-built ReloadDeps keep compiling.
  debug?: Pick<TelemetryLogger, 'update'>
  pi: ExtensionAPI
}

/**
 * Applies a runtime config reload only if it does NOT weaken the security
 * posture. A tampered file that disables the classifier, relaxes the deny
 * strategy, introduces a fail-open fallback, or injects allows over restricted
 * surfaces is rejected and the last good config is kept.
 *
 * @returns true if the reload was applied, false if it was rejected.
 */
export function applyConfigReload(next: Config, deps: ReloadDeps): boolean {
  const prev = deps.configState.get()
  if (isSecurityWeakening(prev, next)) {
    console.warn(
      'pi-auto-mode: rejecting config reload — it would weaken security; keeping previous config'
    )
    notifyUi(
      'pi-auto-mode: config reload rejected (would weaken security)',
      'warning'
    )
    return false
  }
  deps.configState.set(next)
  deps.denyService.updateConfig(next.denyStrategy)
  deps.telemetry.update(next.telemetry.enabled, next.telemetry.path, {
    maxBytes: next.telemetry.maxBytes,
    maxFiles: next.telemetry.maxFiles,
  })
  deps.debug?.update(next.debug.enabled, next.debug.path, {
    maxBytes: next.debug.maxBytes,
    maxFiles: next.debug.maxFiles,
  })
  return true
}

// ─── Active tool computation (fail-closed) ────────────────────
const toolNameOf = (t: unknown): string =>
  String((t as { name?: unknown })?.name ?? '')

/**
 * Computes the active tool set using the new cascade-based permission
 * model. Only tools explicitly denied by the cascade are hidden.
 * If the result would be empty, falls back to previous active tools
 * (or all tools) so the agent is never left tool-less.
 */
export function computeAndApplyActiveTools(
  pi: ExtensionAPI,
  state: typeof configState
): void {
  const cfg = state.get()
  const tools = pi.getAllTools()
  const active = tools
    .filter((t) => {
      const name = toolNameOf(t)
      if (!name) return false
      const surface = surfaceForTool(name)
      const evalResult = evaluatePermission(
        cfg,
        surface as 'tools' | 'skills' | 'mcps',
        name,
        '*'
      )
      return evalResult.action !== 'deny'
    })
    .map(toolNameOf)
    .filter(Boolean)

  if (active.length === 0) {
    const prev = pi.getActiveTools()
    const fallback =
      prev.length > 0 ? prev : tools.map(toolNameOf).filter(Boolean)
    pi.setActiveTools(fallback)
    return
  }
  pi.setActiveTools(active)
}

// ─── Extension entry point ──────────────────────────────────────
export default function piAutoMode(pi: ExtensionAPI): void {
  // Shell AST parser (tree-sitter): loads async, never throws or blocks
  // mounting. Until ready the external scope uses the heuristic engine.
  void initShellParser()
  // Resolve config path: env var → ~/.pi/pi-auto-mode.json → seed from example.
  // resolveConfigPath may copy config.example.json into the user dir; the
  // notify channel below uses console.* because no UI ctx has been bound yet
  // (extension is not mounted; the first `ctx` arrives with `session_start`).
  // The visible UI notification fires after a successful load, gated by
  // `resolved.seeded`, and uses the helper that falls back to console.* when
  // no UI is bound yet.
  let resolved
  try {
    resolved = resolveConfigPath({
      extensionDir,
      notify: (level, msg) => {
        if (level === 'error') console.error(`pi-auto-mode: ${msg}`)
        else if (level === 'warning') console.warn(`pi-auto-mode: ${msg}`)
        else console.log(`pi-auto-mode: ${msg}`)
      },
    })
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    console.error(`pi-auto-mode: failed to resolve config: ${detail}`)
    throw err
  }
  const cfgPath = resolved.path

  let initialConfig: Config
  try {
    initialConfig = loadInitialConfig(cfgPath, {
      onError: (detail) => {
        // M4: fail loudly with the schema/zod detail — never silently swallow.
        console.error(
          `pi-auto-mode: failed to load config from "${cfgPath}": ${detail}`
        )
        notifyUi(`pi-auto-mode: config load failed: ${detail}`, 'error')
      },
    })
  } catch (err) {
    // M4: fail-closed. Refuse to start with an empty/permissive config rather
    // than disabling every rule.
    throw err
  }

  if (resolved.seeded) {
    notifyUi(
      'pi-auto-mode: seeded ~/.pi/pi-auto-mode.json from config.example.json. Edit it to customize.',
      'info'
    )
  }

  configState.set(initialConfig)

  const telemetry = new TelemetryLogger(
    initialConfig.telemetry.enabled,
    initialConfig.telemetry.path,
    {
      maxBytes: initialConfig.telemetry.maxBytes,
      maxFiles: initialConfig.telemetry.maxFiles,
    }
  )
  telemetry.subscribe(pi)
  // Debug jsonl (opt-in, separado de telemetry): diagnósticos LLM con
  // body upstream. Sin subscribe al bus — solo escribe vía record().
  const debugLog = new TelemetryLogger(
    initialConfig.debug.enabled,
    initialConfig.debug.path,
    {
      maxBytes: initialConfig.debug.maxBytes,
      maxFiles: initialConfig.debug.maxFiles,
    }
  )

  const denyService = new DenyAndContinueService(initialConfig.denyStrategy)

  watchConfig(
    cfgPath,
    (cfg) => {
      applyConfigReload(cfg, {
        configState,
        denyService,
        telemetry,
        debug: debugLog,
        pi,
      })
    },
    (err) => {
      const message = err instanceof Error ? err.message : String(err)
      console.warn(`pi-auto-mode: config reload failed: ${message}`)
      notifyUi(
        'pi-auto-mode: config reload failed, keeping previous config',
        'warning'
      )
    }
  )

  pi.on('session_start', (event, ctx) => {
    // Bind the UI surface early so any code that fires before the first
    // tool_call (config reload errors, slash commands, etc.) can notify
    // through the visible TUI channel.
    setUiContext(ctx.ui, ctx.hasUI)
    beginSession(sessionRules, denyService, handleSessionStart, event, ctx)
  })

  // Capa 1: visibility filter. Runs before every LLM call. The handler:
  //   1. Computes the visible tool set (permission-set `tools` map + mode).
  //   2. Calls `setActiveTools` so the LLM cannot invoke hidden tools.
  //   3. Scrubs the system prompt (drops tool bullets and skill blocks that
  //      should not be visible).
  //   4. Returns the sanitised prompt via `BeforeAgentStartEventResult`.
  // Idempotent: same `cfg` + same prompt → same output (byte-stable).
  const beforeAgentStart = createBeforeAgentStartHandler({
    cfg: () => configState.get(),
    pi,
  })
  pi.on('before_agent_start', async (event, ctx) => {
    setUiContext(ctx.ui, ctx.hasUI)
    const result = await beforeAgentStart(event, ctx)
    return result
  })

  // NOTE: no `input` handler is registered. The previous stub was a no-op
  // that only console.logged (which corrupts the TUI); input gating is not
  // implemented by design — the tool_call gate is the enforcement point.

  // Phase 2: gate tool calls via permission engine.
  //
  // The `ctx` argument carries the UI surface (`ctx.ui`) — this is the ONLY
  // place the UI lives at runtime (`pi.ui` does not exist). We bind it into
  // the per-process holder BEFORE `gateToolCall` so the modal resolver can
  // read `getUiContext()` and render the dialog. Without this bind the modal
  // returned 'deny' instantly because `pi.ui` was undefined (the invisible-
  // modal bug).
  pi.on(
    'tool_call',
    createFailClosedToolCall(
      async (event: PiEventData, ctx: ExtensionContext) => {
        setUiContext(ctx.ui, ctx.hasUI)
        const cfg = configState.get()
        const classify = (
          input: import('./classifier/llm-layer.ts').ClassifierInput
        ) =>
          classifyToolCall(
            input,
            {
              config: cfg.classifier,
              llm: cfg.classifier.llm,
            },
            // Fase 3: surface file-extraction events to the telemetry pipeline
            // (a no-op when telemetry is disabled). Other deps can be added
            // here without touching the classifier signature.
            //
            // Reuse Pi's provider credentials: when the user leaves
            // `classifier.llm.apiKey` and/or `baseUrl` empty in their config
            // we resolve them at classification time from `ctx.modelRegistry`
            // (`getApiKeyForProvider` / `find().baseUrl`). Resolution is
            // lazy per call so a mid-session model switch picks up the new
            // credentials without restarting the extension. Explicit config
            // values always win. Resolution failures route through the
            // existing `fallbackDecision(cfg, 'onError', e)` path (default
            // `'ask-user'`, fail-closed). NEVER logged. The apiKey never
            // appears in telemetry, deny messages, or thrown errors — only
            // in the `Authorization` header on the outbound HTTPS request.
            { telemetry, debug: debugLog, models: ctx.modelRegistry }
          )
        const raw = event as Record<string, unknown>
        const toolName = String(raw.toolName ?? 'unknown')
        const input = (raw.input ?? {}) as Record<string, unknown>
        await gateToolCall(toolName, input, {
          configState,
          sessionRules,
          hooks: { emit: (c, d) => pi.events.emit(c, d) },
          classify,
          denyService,
        })
      },
      (err) => {
        const message = err instanceof Error ? err.message : String(err)
        telemetry.record('tool_call_blocked', { error: message })
        notifyUi(`Blocked tool call: ${message}`, 'error')
      }
    )
  )

  // No `resources_discover` handler either (same no-op stub removal).
  pi.on('session_shutdown', (event, ctx) => {
    endSession(sessionRules, denyService, handleSessionShutdown, event, ctx)
  })

  registerSetCommands(pi, configState)
  setAskResolver(createModalAskResolver(pi, sessionRules, configState))
}
