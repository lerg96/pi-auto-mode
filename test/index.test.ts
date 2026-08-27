import {
  createFailClosedToolCall,
  beginSession,
  endSession,
  applyConfigReload,
  loadInitialConfig,
  computeAndApplyActiveTools,
} from '../src/index.ts'
import piAutoMode from '../src/index.ts'
import { getAskResolver, setAskResolver } from '../src/gate/ask.ts'
import type {
  ExtensionAPI,
  ExtensionContext,
  PiEventData,
  PiEventHandler,
} from '@earendil-works/pi-coding-agent'
import { configState } from '../src/state/config-state.ts'
import { DEFAULT_CONFIG } from '../src/types/config.ts'
import { SessionRules } from '../src/permission/session-rules.ts'
import { DenyAndContinueService } from '../src/deny/deny-service.ts'
import { setUiContext, getUiContext } from '../src/state/ui-context.ts'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Importing ../src/index transitively imports permission-modal which value-
// imports @earendil-works/pi-tui at runtime; stub it so resolution succeeds.
jest.mock('@earendil-works/pi-tui', () => ({
  SettingsList: class {
    constructor(..._args: unknown[]) {}
  },
}))

const event = {} as PiEventData
const ctx = {} as ExtensionContext

describe('createFailClosedToolCall', () => {
  it('re-throws when the inner handler throws (fail-closed) and invokes onError', async () => {
    const onError = jest.fn()
    const err = new Error('boom')
    const handler: PiEventHandler = async () => {
      throw err
    }
    const wrapped = createFailClosedToolCall(handler, onError)
    await expect(wrapped(event, ctx)).rejects.toThrow('boom')
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledWith(err)
  })

  it('does not throw when the inner handler resolves', async () => {
    const onError = jest.fn()
    const handler: PiEventHandler = async () => {
      /* success */
    }
    const wrapped = createFailClosedToolCall(handler, onError)
    await expect(wrapped(event, ctx)).resolves.toBeUndefined()
    expect(onError).not.toHaveBeenCalled()
  })

  it('works without an onError callback when the handler throws', async () => {
    const handler: PiEventHandler = async () => {
      throw new Error('x')
    }
    const wrapped = createFailClosedToolCall(handler)
    await expect(wrapped(event, ctx)).rejects.toThrow('x')
  })

  it('forwards arguments to the inner handler', async () => {
    const spy: PiEventHandler = jest.fn(async () => {})
    const wrapped = createFailClosedToolCall(spy)
    await wrapped(event, ctx)
    expect(spy).toHaveBeenCalledWith(event, ctx)
  })
})

describe('session lifecycle (M3)', () => {
  it('reset() between sessions prevents denial escalation carry-over', () => {
    const sessionRules = new SessionRules()
    const denyService = new DenyAndContinueService({
      mode: 'both',
      escalation: { consecutive: 3, total: 20 },
    })
    const noop = (async () => {}) as unknown as PiEventHandler

    // Session 1: 20 denials fill the total cap.
    for (let i = 0; i < 20; i++) {
      denyService.recordDenial({
        toolName: 'bash',
        reason: 'x',
        trigger: 'permission',
      })
    }
    expect(denyService.getStats().total).toBe(20)

    // Start session 2 -> counters reset (M3 fix).
    beginSession(sessionRules, denyService, noop, event, ctx)
    expect(denyService.getStats()).toEqual({ consecutive: 0, total: 0 })

    // A single denial in session 2 must NOT escalate.
    const action = denyService.recordDenial({
      toolName: 'bash',
      reason: 'x',
      trigger: 'permission',
    })
    expect(action).toBe('deny-and-continue')
    expect(denyService.getStats().total).toBe(1)
  })

  it('also resets on session_shutdown (endSession)', () => {
    const sessionRules = new SessionRules()
    const denyService = new DenyAndContinueService({
      mode: 'both',
      escalation: { consecutive: 3, total: 20 },
    })
    denyService.recordDenial({
      toolName: 'bash',
      reason: 'x',
      trigger: 'permission',
    })
    endSession(
      sessionRules,
      denyService,
      (async () => {}) as unknown as PiEventHandler,
      event,
      ctx
    )
    expect(denyService.getStats()).toEqual({ consecutive: 0, total: 0 })
  })
})

describe('config reload (S3 fail-closed)', () => {
  it('rejects a reload that disables the classifier; keeps the previous safe config', () => {
    configState.set({ ...DEFAULT_CONFIG })
    const denyService = new DenyAndContinueService(DEFAULT_CONFIG.denyStrategy)
    const telemetryUpdate = jest.fn()
    const telemetry = { update: telemetryUpdate } as Pick<
      import('../src/telemetry/telemetry.ts').TelemetryLogger,
      'update'
    >
    const pi = { ui: { notify: jest.fn() } } as unknown as ExtensionAPI
    const weak: typeof DEFAULT_CONFIG = {
      ...DEFAULT_CONFIG,
      classifier: { ...DEFAULT_CONFIG.classifier, enabled: false },
    }

    const result = applyConfigReload(weak, {
      configState,
      denyService,
      telemetry,
      pi,
    })
    expect(result).toBe(false)
    expect(configState.get().classifier.enabled).toBe(true)
    expect(telemetryUpdate).not.toHaveBeenCalled()
  })

  it('applies a non-weakening reload', () => {
    configState.set({ ...DEFAULT_CONFIG })
    const denyService = new DenyAndContinueService(DEFAULT_CONFIG.denyStrategy)
    const telemetryUpdate = jest.fn()
    const telemetry = { update: telemetryUpdate } as Pick<
      import('../src/telemetry/telemetry.ts').TelemetryLogger,
      'update'
    >
    const pi = { ui: { notify: jest.fn() } } as unknown as ExtensionAPI
    const next: typeof DEFAULT_CONFIG = {
      ...DEFAULT_CONFIG,
      telemetry: { enabled: true, path: 'out.log' },
    }

    const result = applyConfigReload(next, {
      configState,
      denyService,
      telemetry,
      pi,
    })
    expect(result).toBe(true)
    expect(configState.get().telemetry.enabled).toBe(true)
    expect(telemetryUpdate).toHaveBeenCalledWith(true, 'out.log')
  })
})

describe('initial config load (M4 fail-closed)', () => {
  it('fails loudly on schema-invalid config and never returns an empty default', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-am-m4-'))
    const path = join(dir, 'bad.json')
    writeFileSync(
      path,
      JSON.stringify({ permissionSets: 'not-an-object' }),
      'utf8'
    )
    const onError = jest.fn()
    try {
      expect(() => loadInitialConfig(path, { onError })).toThrow()
      expect(onError).toHaveBeenCalledTimes(1)
      expect(String(onError.mock.calls[0][0])).toMatch(/permissionSets/i)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('active tools (fail-closed)', () => {
  it('never disables all tools when cascade denies everything', () => {
    configState.set({
      ...DEFAULT_CONFIG,
      permissions: {
        tools: {
          bash: [{ pattern: '*', action: 'deny' }],
          read: [{ pattern: '*', action: 'deny' }],
        },
      },
      activePermissionSets: [],
    })
    const tools = [{ name: 'bash' }, { name: 'read' }, { name: 'audit_log' }]
    const setActiveTools = jest.fn()
    const pi = {
      getAllTools: () => tools,
      getActiveTools: () => tools.map((t) => t.name),
      setActiveTools,
    } as unknown as ExtensionAPI

    computeAndApplyActiveTools(pi, configState)

    expect(setActiveTools).toHaveBeenCalledTimes(1)
    const arg = setActiveTools.mock.calls[0][0] as string[]
    expect(arg.length).toBeGreaterThan(0)
  })
})

// ─── Integration: piAutoMode wiring gate→decision ─────────────
describe('piAutoMode integration: gate→decision flow', () => {
  let dir: string
  let cfgPath: string
  let prevEnv: string | undefined
  let prevResolver: ReturnType<typeof getAskResolver>
  const handlers: Record<string, PiEventHandler | undefined> = {}

  const fakePi = {
    on: (event: string, handler: PiEventHandler) => {
      handlers[event] = handler
    },
    events: { on: () => {} },
    registerCommand: () => {},
  } as unknown as ExtensionAPI

  const config = {
    permissions: {
      tools: {
        bash: [{ pattern: 'rm -rf *', action: 'deny', reason: 'destructive' }],
      },
    },
    activePermissionSets: [],
    classifier: { enabled: false },
    denyStrategy: {
      mode: 'both',
      escalation: { consecutive: 3, total: 20 },
    },
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pi-am-l6-'))
    cfgPath = join(dir, 'config.json')
    writeFileSync(cfgPath, JSON.stringify(config), 'utf8')
    prevEnv = process.env.PI_AUTO_MODE_CONFIG
    process.env.PI_AUTO_MODE_CONFIG = cfgPath
    prevResolver = getAskResolver()
    for (const k of Object.keys(handlers)) delete handlers[k]
    jest.useFakeTimers()
    piAutoMode(fakePi)
    jest.useRealTimers()
  })

  afterEach(() => {
    if (prevEnv === undefined) delete process.env.PI_AUTO_MODE_CONFIG
    else process.env.PI_AUTO_MODE_CONFIG = prevEnv
    setAskResolver(prevResolver)
    setUiContext(undefined, false)
    rmSync(dir, { recursive: true, force: true })
  })

  it('registers a tool_call handler that gates tool calls', () => {
    expect(typeof handlers.tool_call).toBe('function')
  })

  it('blocks a tool call whose command matches a deny rule (gate→deny)', async () => {
    await expect(
      handlers.tool_call!(
        {
          type: 'tool_call',
          toolName: 'bash',
          toolCallId: 'test-1',
          input: { command: 'rm -rf /tmp/foo' },
        } as unknown as PiEventData,
        {} as ExtensionContext
      )
    ).rejects.toThrow()
  })

  it('allows a tool call whose command matches no deny rule (gate→allow)', async () => {
    await expect(
      handlers.tool_call!(
        {
          type: 'tool_call',
          toolName: 'bash',
          toolCallId: 'test-2',
          input: { command: 'echo hello' },
        } as unknown as PiEventData,
        {} as ExtensionContext
      )
    ).resolves.toBeUndefined()
  })

  it('handles a tool call with the real Pi event shape (toolName at top level)', async () => {
    await expect(
      handlers.tool_call!(
        {
          type: 'tool_call',
          toolName: 'read',
          toolCallId: 'test-3',
          input: { path: 'C:/Users/test-user/pi-auto-mode/README.md' },
        } as unknown as PiEventData,
        {} as ExtensionContext
      )
    ).resolves.toBeUndefined()
  })

  // ─── Root-cause fix: ctx.ui binding ─────────────────────────
  it('binds ctx.ui into the holder at the start of a tool_call handler', async () => {
    setUiContext(undefined, false)
    expect(getUiContext()).toBeNull()

    const fakeUi = {
      notify: jest.fn(),
      custom: jest.fn(() => Promise.resolve(undefined)),
      input: jest.fn(() => Promise.resolve(undefined)),
    }
    const ctx = {
      ui: fakeUi,
      hasUI: true,
    } as unknown as ExtensionContext

    await handlers.tool_call!(
      {
        type: 'tool_call',
        toolName: 'bash',
        toolCallId: 'ctx-bind-test',
        input: { command: 'echo bind check' },
      } as unknown as PiEventData,
      ctx
    ).catch(() => {
      /* either allow or deny is fine; we only assert the side-effect */
    })

    const bound = getUiContext()
    expect(bound).not.toBeNull()
    expect(bound?.ui).toBe(fakeUi)
    expect(bound?.hasUI).toBe(true)

    setUiContext(undefined, false)
  })

  it('clears the holder when ctx has no UI (noOp ctx in print/RPC mode)', async () => {
    setUiContext(
      { notify: jest.fn(), custom: jest.fn(), input: jest.fn() } as never,
      true
    )
    expect(getUiContext()).not.toBeNull()

    const ctx = {
      ui: undefined,
      hasUI: false,
    } as unknown as ExtensionContext

    await handlers.tool_call!(
      {
        type: 'tool_call',
        toolName: 'bash',
        toolCallId: 'no-ui-ctx-test',
        input: { command: 'echo no-ui' },
      } as unknown as PiEventData,
      ctx
    ).catch(() => {
      /* side-effect only */
    })

    expect(getUiContext()).toBeNull()
  })
})
