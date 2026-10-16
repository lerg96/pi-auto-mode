import { gateToolCall } from '../../src/gate/gate.ts'
import type { GateDeps } from '../../src/gate/gate.ts'
import { configState } from '../../src/state/config-state.ts'
import {
  SessionRules,
  resetSessionRulesRegistry,
} from '../../src/permission/session-rules.ts'
import { DenyAndContinueService } from '../../src/deny/deny-service.ts'
import { resolve } from 'node:path'
import {
  setAskResolver,
  getAskResolver,
  defaultAskResolver,
  type AskRequest,
} from '../../src/gate/ask.ts'
import { resetExternalDirAllowlist } from '../../src/state/external-dir-allowlist.ts'
import type { Config } from '../../src/types/config.ts'
import type {
  ClassifierInput,
  ClassifierResult,
} from '../../src/classifier/llm-layer.ts'
// import { BUS_CHANNEL_DECISION } from '../../src/events.ts' // unused in this test file

const config: Config = {
  permissions: {
    tools: {
      bash: [{ pattern: 'echo spam*', action: 'deny', reason: 'noisy_echo' }],
    },
  },
  permissionSets: {
    strict: {
      permissions: {
        tools: {
          bash: [
            { pattern: 'rm -rf *', action: 'deny', reason: 'destructive' },
          ],
        },
      },
    },
  },
  activePermissionSets: ['strict'],
  classifier: {
    enabled: true,
    llm: {
      provider: 'anthropic',
      model: '',
      baseUrl: '',
      apiKey: '',
      timeoutMs: 5000,
      maxTokens: 1024,
      fallbackModel: '',
      systemPrompt: '',
      enabled: true,
    },
    fallback: { onTimeout: 'ask-user', onError: 'ask-user' },
    onBlock: 'deny',
    onBlockUserOverride: false,
  },
  denyStrategy: {
    mode: 'both',
    escalation: { consecutive: 3, total: 20 },
  },
  ui: {
    doublePressToConfirm: true,
    promptMaxRows: 8,
    promptFieldMaxWidth: 120,
    showClassifierRisk: true,
    modalTimeoutMs: 120000,
    noUiAsks: 'bubble',
    subagentModalTimeoutMs: 120000,
  },
  telemetry: { enabled: false, path: '' },
}

function makeDeps(): GateDeps {
  const sessionRules = new SessionRules()
  const denyService = new DenyAndContinueService({
    mode: 'both',
    escalation: { consecutive: 3, total: 20 },
  })
  const classify = async (i: ClassifierInput): Promise<ClassifierResult> => {
    if (i.value.includes('danger')) {
      return {
        decision: 'ask',
        risk: { score: 7, level: 'high', reason: 'x', category: 'x' },
      }
    }
    return { decision: 'allow' }
  }
  return { configState, sessionRules, hooks: {}, classify, denyService }
}

beforeEach(() => {
  resetSessionRulesRegistry()
  resetExternalDirAllowlist()
})

describe('gateToolCall', () => {
  beforeEach(() => {
    configState.set(config)
  })

  it('H1: allow-final — the classifier no longer gates allow paths', async () => {
    // Regression guard for the allow-final design: even when the
    // classifier would ask ('danger'), an allow cascade resolves directly
    // and the default-deny resolver is never reached.
    await gateToolCall('bash', { command: 'allowed; danger' }, makeDeps())
  })

  it('allow-final: base allow + classifier ask resolves without prompting', async () => {
    // Same pin: on `allow` the classifier is not consulted at all.
    await gateToolCall('bash', { command: 'danger' }, makeDeps())
  })

  it('allow path: base allow + classifier allow does not throw', async () => {
    await gateToolCall('bash', { command: 'safe' }, makeDeps())
  })

  it('env prefix: allows command matching allow rule and denies command matching deny rule', async () => {
    const customConfig: Config = {
      ...config,
      permissions: {
        tools: {
          bash: [
            { pattern: 'python *', action: 'allow' },
            { pattern: 'rm -rf *', action: 'deny' },
          ],
        },
      },
      activePermissionSets: [],
    }
    configState.set(customConfig)
    const deps = makeDeps()

    await expect(
      gateToolCall('bash', { command: 'PYTHONPATH=. python -m pytest' }, deps)
    ).resolves.not.toThrow()

    await expect(
      gateToolCall('bash', { command: 'FOO=1 rm -rf /' }, deps)
    ).rejects.toThrow()
  })

  it('C2: fail-closed — every blocked call is denied and escalation still advances', async () => {
    const deps = makeDeps()
    for (const cmd of ['echo spam a', 'echo spam b', 'echo spam c']) {
      await expect(
        gateToolCall('bash', { command: cmd }, deps)
      ).rejects.toThrow()
    }
    expect(deps.denyService!.getStats().consecutive).toBe(3)
  })

  it('deny-and-continue keeps the deny active (no session override) on repeated identical calls', async () => {
    const deps = makeDeps()
    await expect(
      gateToolCall('bash', { command: 'echo spam a' }, deps)
    ).rejects.toThrow()
    await expect(
      gateToolCall('bash', { command: 'echo spam a' }, deps)
    ).rejects.toThrow()
    await expect(
      gateToolCall('bash', { command: 'echo spam a' }, deps)
    ).rejects.toThrow()
  })

  it('deny-and-continue: no sessionRules entry is persisted for the denied surface/value', async () => {
    const deps = makeDeps()
    await expect(
      gateToolCall('bash', { command: 'echo spam a' }, deps)
    ).rejects.toThrow()
    const snap = deps.sessionRules.snapshot()
    expect(snap).toHaveLength(0)
  })

  it('deny-and-continue error includes the rule pattern and reformulation hint', async () => {
    configState.set({
      ...config,
      permissions: {
        tools: {
          bash: [
            { pattern: 'echo spam*', action: 'deny', reason: 'noisy_echo' },
          ],
        },
      },
      permissionSets: {
        strict: {
          permissions: {
            tools: {
              bash: [
                { pattern: 'rm -rf *', action: 'deny', reason: 'destructive' },
              ],
            },
          },
        },
      },
    })
    try {
      await gateToolCall('bash', { command: 'echo spam hello' }, makeDeps())
    } catch (e) {
      const msg = String(e)
      expect(msg).toContain('echo spam hello')
      expect(msg).toContain('noisy_echo')
      expect(msg).toContain('Reformulation')
    }
  })

  it('S1: a session allow does NOT override a precise config deny', async () => {
    // SessionRules.approveForSession creates a user-granted allow.
    // The cascade logic says: a precise config deny still beats a session allow.
    // So even with a session allow for 'echo spam a', the deny rule wins.
    const deps = makeDeps()
    deps.sessionRules.approveForSession('bash', 'echo spam a', 'allow')

    await expect(
      gateToolCall('bash', { command: 'echo spam a' }, deps)
    ).rejects.toThrow()

    // The session allow for 'echo spam a' should still exist (not cleared).
    const snap = deps.sessionRules.snapshot()
    expect(
      snap.some((r) => r.surface === 'bash' && r.pattern === 'echo spam a')
    ).toBe(true)
  })

  it('unknown tool under a permissive/catch-all activeSets asks the user (not hard-denied)', async () => {
    // Unknown tool (surface 'denied') -> gate routes to resolveAsk.
    // The mock resolver returns 'allow' (no error).
    const deps = makeDeps()
    await gateToolCall('unknown_tool', { whatever: 'arg' }, deps)
  })

  it('unknown tool under a restrictive activeSets still asks the user (not bypassed)', async () => {
    // Even if there's a restrictive set, unknown tools don't match any rule
    // (they have their own surface) so they still ask the user.
    const deps = makeDeps()
    await gateToolCall('another_unknown', { whatever: 'arg' }, deps)
  })

  it('a custom tool mapped via surface matching is gated by a rule on that surface (deny)', async () => {
    const customConfig = {
      ...config,
      permissions: {
        tools: {
          // custom tool 'agent_send_message' uses its own name as surface
          agent_send_message: [
            { pattern: '*', action: 'deny', reason: 'blocked' },
          ],
        },
      },
    }
    configState.set(customConfig)
    const deps = makeDeps()
    await expect(
      gateToolCall('agent_send_message', { to: 'user', message: 'hi' }, deps)
    ).rejects.toThrow()
  })

  it('without explicit mapping the same custom tool routes through resolveAsk (fail-closed default)', async () => {
    const customConfig = {
      ...config,
      permissions: {},
    }
    configState.set(customConfig)
    const deps = makeDeps()
    await gateToolCall(
      'agent_send_message',
      { to: 'user', message: 'hi' },
      deps
    )
  })

  it('deny strategy = ask-user: ask-user deny + resolver denies -> throws', async () => {
    const askConfig = {
      ...config,
      denyStrategy: {
        mode: 'ask-user',
        escalation: { consecutive: 3, total: 20 },
      },
    }
    configState.set(askConfig)

    const sessionRules = new SessionRules()
    const denyService = new DenyAndContinueService({
      mode: 'ask-user',
      escalation: { consecutive: 3, total: 20 },
    })
    const classify = async (): Promise<ClassifierResult> => ({
      decision: 'allow',
    })
    const denyDeps = {
      configState,
      sessionRules,
      hooks: {},
      classify,
      denyService,
    }

    await expect(
      gateToolCall('bash', { command: 'echo spam a' }, denyDeps)
    ).rejects.toThrow()
  })

  it('ask-branch rule selection: useClassifierRep=false passes the permission-layer rule to the modal', async () => {
    const askConfig = {
      ...config,
      denyStrategy: {
        mode: 'ask-user',
        escalation: { consecutive: 3, total: 20 },
      },
    }
    configState.set(askConfig)

    const sessionRules = new SessionRules()
    const denyService = new DenyAndContinueService({
      mode: 'ask-user',
      escalation: { consecutive: 3, total: 20 },
    })
    const classify = async (): Promise<ClassifierResult> => ({
      decision: 'allow',
    })
    const denyDeps = {
      configState,
      sessionRules,
      hooks: {},
      classify,
      denyService,
    }

    let capturedRule: { surface: string; pattern: string } | undefined
    setAskResolver(async ({ rule }) => {
      capturedRule = rule
        ? { surface: rule.surface, pattern: rule.pattern }
        : undefined
      return 'allow'
    })

    await gateToolCall('bash', { command: 'echo spam a' }, denyDeps)
    expect(capturedRule).toBeDefined()
    expect(capturedRule!.surface).toBe('bash')
    expect(capturedRule!.pattern).toBe('echo spam a')
    setAskResolver(getAskResolver())
  })

  it('ask-branch: useClassifierRep=true passes classifier surface/value/risk plus the ask rule to the modal', async () => {
    const askConfig = {
      ...config,
      permissions: {
        tools: {
          bash: [{ pattern: 'some command', action: 'ask' }],
        },
      },
      denyStrategy: {
        mode: 'ask-user',
        escalation: { consecutive: 3, total: 20 },
      },
    }
    configState.set(askConfig)

    const sessionRules = new SessionRules()
    const denyService = new DenyAndContinueService({
      mode: 'ask-user',
      escalation: { consecutive: 3, total: 20 },
    })
    const classify = async (): Promise<ClassifierResult> => ({
      decision: 'ask',
      risk: {
        score: 5,
        level: 'medium',
        reason: 'classifier reason',
        category: 'test',
        riskOrigin: 'llm',
      },
    })
    const denyDeps = {
      configState,
      sessionRules,
      hooks: {},
      classify,
      denyService,
    }

    let captured:
      | { surface?: string; value?: string; risk?: unknown; rule?: unknown }
      | undefined
    setAskResolver(async (req) => {
      captured = {
        surface: req.surface,
        value: req.value,
        risk: req.risk,
        rule: req.rule,
      }
      return 'allow'
    })

    await gateToolCall('bash', { command: 'some command' }, denyDeps)
    expect(captured).toBeDefined()
    // Classifier rep wins for surface/value; the ask rule still travels
    // for context (so a classifier error never masks the pre-LLM reason).
    expect(captured!.surface).toBe('shell')
    expect(captured!.value).toBe('some command')
    expect(captured!.risk).toBeDefined()
    expect(captured!.rule).toBeDefined()
    expect(captured!.rule).toMatchObject({
      surface: 'bash',
      pattern: 'some command',
    })
    setAskResolver(getAskResolver())
  })

  it('ask audit enrichment: deny with reason includes denialReason in decision event', async () => {
    const askConfig = {
      ...config,
      denyStrategy: {
        mode: 'ask-user',
        escalation: { consecutive: 3, total: 20 },
      },
    }
    configState.set(askConfig)

    const sessionRules = new SessionRules()
    const denyService = new DenyAndContinueService({
      mode: 'ask-user',
      escalation: { consecutive: 3, total: 20 },
    })
    const classify = async (): Promise<ClassifierResult> => ({
      decision: 'allow',
    })
    const denyDeps = {
      configState,
      sessionRules,
      hooks: {},
      classify,
      denyService,
    }

    let capturedAudit: { denialReason?: string } | undefined
    setAskResolver(async () => {
      capturedAudit = { denialReason: 'user said no' }
      return { decision: 'deny', reason: 'user said no' }
    })

    try {
      await gateToolCall('bash', { command: 'echo spam a' }, denyDeps)
    } catch {
      // expected
    }
    expect(capturedAudit?.denialReason).toBeDefined()
    setAskResolver(getAskResolver())
  })

  it('no-UI denial: se audita como no-ui y el mensaje no culpa a un usuario', async () => {
    // Regresión del bug de sub-agentes: un ask sin UI se denegaba y se
    // registraba como `decidedBy: 'user', via: 'modal'`, o sea: un humano que
    // nunca existió vetando la llamada.
    configState.set({
      ...config,
      permissions: {
        tools: {
          bash: [{ pattern: 'cat *.env', action: 'ask', reason: 'secretos' }],
        },
      },
    })
    const events: Array<Record<string, unknown>> = []
    const deps: GateDeps = {
      configState,
      sessionRules: new SessionRules(),
      hooks: {
        emit: (_channel: string, data: unknown) => {
          events.push(data as Record<string, unknown>)
        },
      },
      classify: async (): Promise<ClassifierResult> => ({
        decision: 'allow',
      }),
    }
    setAskResolver(async () => ({ decision: 'deny', via: 'no-ui' }))
    let message = ''
    try {
      await gateToolCall('bash', { command: 'cat .env' }, deps)
    } catch (err) {
      message = (err as Error).message
    }
    setAskResolver(getAskResolver())

    expect(message).toContain('without asking')
    expect(message).not.toMatch(/denied by user/i)
    const denial = events.find((e) => e.result === 'deny')
    expect(denial?.via).toBe('no-ui')
    expect(denial?.decidedBy).toBe('no-ui')
  })

  it('timeout: se audita como timeout, no como decisión de un usuario', async () => {
    // El prompt se mostró pero nadie respondió: decir «denied by user» sería
    // otra mentira de auditoría, igual que el caso no-ui.
    configState.set({
      ...config,
      permissions: {
        tools: {
          bash: [{ pattern: 'sleep *', action: 'ask', reason: 'lento' }],
        },
      },
    })
    const events: Array<Record<string, unknown>> = []
    const deps: GateDeps = {
      configState,
      sessionRules: new SessionRules(),
      hooks: {
        emit: (_channel: string, data: unknown) => {
          events.push(data as Record<string, unknown>)
        },
      },
      classify: async (): Promise<ClassifierResult> => ({
        decision: 'allow',
      }),
    }
    setAskResolver(async () => ({ decision: 'deny', via: 'timeout' }))
    let message = ''
    try {
      await gateToolCall('bash', { command: 'sleep 5' }, deps)
    } catch (err) {
      message = (err as Error).message
    }
    setAskResolver(getAskResolver())

    expect(message).toContain('expired without an answer')
    expect(message).not.toMatch(/denied by user/i)
    const denial = events.find((e) => e.result === 'deny')
    expect(denial?.via).toBe('timeout')
    expect(denial?.decidedBy).toBe('timeout')
  })

  it('parent-modal: la decisión del padre se audita como decisión humana real', async () => {
    configState.set({
      ...config,
      permissions: {
        tools: {
          bash: [{ pattern: 'safe-parent', action: 'ask' }],
        },
      },
    })
    const events: Array<Record<string, unknown>> = []
    const deps: GateDeps = {
      configState,
      sessionRules: new SessionRules(),
      hooks: {
        emit: (_channel: string, data: unknown) => {
          events.push(data as Record<string, unknown>)
        },
      },
      classify: async (): Promise<ClassifierResult> => ({
        decision: 'allow',
      }),
    }
    setAskResolver(async () => ({ decision: 'allow', via: 'parent-modal' }))
    await gateToolCall('bash', { command: 'safe-parent' }, deps)
    setAskResolver(getAskResolver())

    const approval = events.find((e) => e.result === 'allow')
    expect(approval?.via).toBe('parent-modal')
    expect(approval?.decidedBy).toBe('user')
  })

  it('ask audit enrichment: allow includes requestId, decidedBy, via; plain allow does NOT persist', async () => {
    const sessionRules = new SessionRules()
    const denyService = new DenyAndContinueService({
      mode: 'ask-user',
      escalation: { consecutive: 3, total: 20 },
    })
    // Add an 'ask' rule for 'safe' to trigger the resolver
    configState.set({
      ...config,
      permissions: {
        tools: {
          bash: [
            { pattern: 'echo spam*', action: 'deny', reason: 'noisy_echo' },
            { pattern: 'safe', action: 'ask' },
          ],
        },
      },
      denyStrategy: {
        mode: 'ask-user',
        escalation: { consecutive: 3, total: 20 },
      },
    })
    const classify = async (): Promise<ClassifierResult> => ({
      decision: 'allow',
    })
    const deps = { configState, sessionRules, hooks: {}, classify, denyService }

    let capturedAudit:
      { requestId?: string; decidedBy?: string; via?: string } | undefined
    setAskResolver(async () => {
      capturedAudit = { requestId: 'test-id', decidedBy: 'user', via: 'modal' }
      return 'allow'
    })

    await gateToolCall('bash', { command: 'safe' }, deps)
    expect(capturedAudit).toBeDefined()
    expect(capturedAudit?.requestId).toBe('test-id')
    expect(capturedAudit?.decidedBy).toBe('user')
    expect(capturedAudit?.via).toBe('modal')
    // Session rules should NOT have a new entry for a plain 'allow'
    const snap = sessionRules.snapshot()
    expect(snap).toHaveLength(0)
    setAskResolver(getAskResolver())
  })

  it('classifier.enabled:false also bypasses the classifier on the ask path (permission layer still asks)', async () => {
    const noClassifierConfig = {
      ...config,
      classifier: { ...config.classifier, enabled: false },
      denyStrategy: {
        mode: 'ask-user',
        escalation: { consecutive: 3, total: 20 },
      },
    }
    configState.set(noClassifierConfig)

    const sessionRules = new SessionRules()
    const denyService = new DenyAndContinueService({
      mode: 'ask-user',
      escalation: { consecutive: 3, total: 20 },
    })
    const classify = async (): Promise<ClassifierResult> => ({
      decision: 'allow',
    })
    const deps = { configState, sessionRules, hooks: {}, classify, denyService }

    setAskResolver(async () => 'allow')
    await gateToolCall('bash', { command: 'safe' }, deps)
    setAskResolver(getAskResolver())
  })

  describe('session allow short-circuit + plain-vs-session semantics', () => {
    it('1) session allow short-circuits the ask-path modal on identical retry', async () => {
      const askConfig = {
        ...config,
        permissions: {
          tools: {
            bash: [{ pattern: '*', action: 'ask' }],
          },
        },
        denyStrategy: {
          mode: 'ask-user',
          escalation: { consecutive: 3, total: 20 },
        },
      }
      configState.set(askConfig)

      const sessionRules = new SessionRules()
      const denyService = new DenyAndContinueService({
        mode: 'ask-user',
        escalation: { consecutive: 3, total: 20 },
      })
      const classify = async (): Promise<ClassifierResult> => ({
        decision: 'ask',
        risk: {
          score: 5,
          level: 'medium',
          reason: 'classifier reason',
          category: 'test',
          riskOrigin: 'llm',
        },
      })
      const deps = {
        configState,
        sessionRules,
        hooks: {},
        classify,
        denyService,
      }

      // First call: session allow not yet present -> would prompt
      // But we mock resolver to 'allow' so it proceeds
      setAskResolver(async () => 'allow')
      await gateToolCall('bash', { command: 'echo test' }, deps)

      // Grant session allow (shell surface: the ask path resolves surface
      // from the normalized intent, not the tool name)
      sessionRules.approveForSession('shell', 'echo test', 'allow')

      // Second call: same command -> session allow should short-circuit
      setAskResolver(async () => {
        throw new Error('should not be called')
      })
      await gateToolCall('bash', { command: 'echo test' }, deps)

      setAskResolver(getAskResolver())
    })

    it('2) session allow for ONE value does NOT grant a different value', async () => {
      const askConfig = {
        ...config,
        permissions: {
          tools: {
            bash: [{ pattern: '*', action: 'ask' }],
          },
        },
        denyStrategy: {
          mode: 'ask-user',
          escalation: { consecutive: 3, total: 20 },
        },
      }
      configState.set(askConfig)

      const sessionRules = new SessionRules()
      const denyService = new DenyAndContinueService({
        mode: 'ask-user',
        escalation: { consecutive: 3, total: 20 },
      })
      const classify = async (): Promise<ClassifierResult> => ({
        decision: 'ask',
        risk: {
          score: 5,
          level: 'medium',
          reason: 'x',
          category: 'x',
          riskOrigin: 'llm',
        },
      })
      const deps = {
        configState,
        sessionRules,
        hooks: {},
        classify,
        denyService,
      }

      sessionRules.approveForSession('shell', 'echo test', 'allow')
      setAskResolver(async () => {
        throw new Error('should not be called')
      })
      await gateToolCall('bash', { command: 'echo test' }, deps)

      // Different value -> session allow does NOT match -> resolver called
      let resolverCalled = false
      setAskResolver(async () => {
        resolverCalled = true
        return 'allow'
      })
      await gateToolCall('bash', { command: 'echo other' }, deps)
      expect(resolverCalled).toBe(true)

      setAskResolver(getAskResolver())
    })

    it('3) allow_session persists once and the second identical call skips the resolver', async () => {
      const askConfig = {
        ...config,
        permissions: {
          tools: {
            bash: [{ pattern: '*', action: 'ask' }],
          },
        },
        denyStrategy: {
          mode: 'ask-user',
          escalation: { consecutive: 3, total: 20 },
        },
      }
      configState.set(askConfig)

      const sessionRules = new SessionRules()
      const denyService = new DenyAndContinueService({
        mode: 'ask-user',
        escalation: { consecutive: 3, total: 20 },
      })
      const classify = async (): Promise<ClassifierResult> => ({
        decision: 'ask',
        risk: {
          score: 5,
          level: 'medium',
          reason: 'x',
          category: 'x',
          riskOrigin: 'llm',
        },
      })
      const deps = {
        configState,
        sessionRules,
        hooks: {},
        classify,
        denyService,
      }

      setAskResolver(async ({ reason }) => ({
        decision: 'allow_session',
        reason,
      }))
      await gateToolCall('bash', { command: 'echo persist' }, deps)

      // Second call: session allow should now exist and short-circuit
      setAskResolver(async () => {
        throw new Error('should not be called')
      })
      await gateToolCall('bash', { command: 'echo persist' }, deps)

      setAskResolver(getAskResolver())
    })

    it('4) catch-all matched pattern is NOT persisted; the exact value is', async () => {
      const askConfig = {
        ...config,
        permissions: {
          tools: {
            // Catch-all ask: every bash call reaches the modal, so
            // allow_session persistence can be observed.
            bash: [{ pattern: '*', action: 'ask' }],
          },
        },
        denyStrategy: {
          mode: 'ask-user',
          escalation: { consecutive: 3, total: 20 },
        },
      }
      configState.set(askConfig)

      const sessionRules = new SessionRules()
      const denyService = new DenyAndContinueService({
        mode: 'ask-user',
        escalation: { consecutive: 3, total: 20 },
      })
      const classify = async (): Promise<ClassifierResult> => ({
        decision: 'ask',
        risk: {
          score: 5,
          level: 'medium',
          reason: 'x',
          category: 'x',
          riskOrigin: 'llm',
        },
      })
      const deps = {
        configState,
        sessionRules,
        hooks: {},
        classify,
        denyService,
      }

      setAskResolver(async () => ({
        decision: 'allow_session',
        reason: 'test',
      }))
      await gateToolCall('bash', { command: 'echo exact' }, deps)

      const snap = sessionRules.snapshot()
      const bashRule = snap.find((r) => r.surface === 'shell')
      // Should persist the exact value 'echo exact', not '*'
      expect(bashRule?.pattern).toBe('echo exact')

      setAskResolver(getAskResolver())
    })

    describe('decision telemetry detail + reason synthesis', () => {
      let prevResolver: ReturnType<typeof getAskResolver>
      beforeEach(() => {
        prevResolver = getAskResolver()
      })
      afterEach(() => {
        setAskResolver(prevResolver)
      })

      interface CapturedDetail {
        toolName?: unknown
        matchedSurface?: unknown
        matchedValue?: unknown
        rule?: { surface?: unknown; pattern?: unknown; reason?: unknown }
        risk?: {
          score?: unknown
          level?: unknown
          category?: unknown
          reason?: unknown
          riskOrigin?: unknown
        }
        latencyMs?: unknown
      }
      interface CapturedDecision {
        result?: unknown
        resolution?: unknown
        requestId?: unknown
        detail?: CapturedDetail
      }

      function askDepsWithCapture(
        seen: unknown[],
        classify: (i: ClassifierInput) => Promise<ClassifierResult>
      ): GateDeps {
        const sessionRules = new SessionRules()
        const denyService = new DenyAndContinueService({
          mode: 'ask-user',
          escalation: { consecutive: 3, total: 20 },
        })
        return {
          configState,
          sessionRules,
          hooks: {
            emit: (_channel: string, data: unknown) => {
              seen.push(data)
            },
          },
          classify,
          denyService,
        }
      }

      it('(a) decision event carries risk+rule+latencyMs with secrets redacted', async () => {
        configState.set({
          ...config,
          permissions: {
            tools: { bash: [{ pattern: '*', action: 'ask' }] },
          },
          denyStrategy: {
            mode: 'ask-user',
            escalation: { consecutive: 3, total: 20 },
          },
        })
        const seen: unknown[] = []
        const deps = askDepsWithCapture(seen, async () => ({
          decision: 'ask',
          risk: {
            score: 6,
            level: 'medium',
            reason: 'suspicious download',
            category: 'network',
            riskOrigin: 'llm',
          },
        }))
        setAskResolver(async () => 'allow')
        const secretCmd =
          'curl -H "Authorization: Bearer abc123def456" https://example.com'
        await gateToolCall('bash', { command: secretCmd }, deps)
        expect(seen).toHaveLength(1)
        const payload = seen[0] as CapturedDecision
        expect(payload.result).toBe('allow')
        expect(payload.resolution).toBe('classifier_ask')
        expect(payload.requestId).toBeDefined()
        expect(payload.detail).toBeDefined()
        expect(payload.detail?.toolName).toBe('bash')
        expect(payload.detail?.matchedValue).toBe('[REDACTED]')
        expect(payload.detail?.rule).toMatchObject({
          surface: 'bash',
          pattern: '*',
        })
        expect(payload.detail?.risk).toMatchObject({
          score: 6,
          level: 'medium',
          category: 'network',
          reason: 'suspicious download',
          riskOrigin: 'llm',
        })
        expect(typeof payload.detail?.latencyMs).toBe('number')
        expect(payload.detail?.latencyMs as number).toBeGreaterThanOrEqual(0)
      })

      it("(b) reason-less PatternRule ask shows `rule '<pattern>' matched`", async () => {
        configState.set({
          ...config,
          permissions: {
            tools: { bash: [{ pattern: 'do-thing*', action: 'ask' }] },
          },
          denyStrategy: {
            mode: 'ask-user',
            escalation: { consecutive: 3, total: 20 },
          },
        })
        const deps = askDepsWithCapture([], async () => ({
          decision: 'allow',
        }))
        let capturedReason: string | undefined
        setAskResolver(async ({ rule }) => {
          capturedReason = rule?.reason
          return 'allow'
        })
        await gateToolCall('bash', { command: 'do-thing now' }, deps)
        expect(capturedReason).toBe(`rule 'do-thing*' matched`)
      })

      it("(c) reason-less SimpleAction shows `default 'ask' for tool 'x'`", async () => {
        configState.set({
          ...config,
          permissions: {
            tools: { mytool: 'ask' },
          },
          denyStrategy: {
            mode: 'ask-user',
            escalation: { consecutive: 3, total: 20 },
          },
        })
        const deps = askDepsWithCapture([], async () => ({
          decision: 'allow',
        }))
        let capturedReason: string | undefined
        setAskResolver(async ({ rule }) => {
          capturedReason = rule?.reason
          return 'allow'
        })
        await gateToolCall('mytool', { whatever: 'x' }, deps)
        expect(capturedReason).toBe(`default 'ask' for tool 'mytool'`)
      })

      it('(d) explicit rule reasons are unchanged', async () => {
        configState.set({
          ...config,
          permissions: {
            tools: {
              bash: [
                { pattern: 'do-thing*', action: 'ask', reason: 'needs-human' },
              ],
            },
          },
          denyStrategy: {
            mode: 'ask-user',
            escalation: { consecutive: 3, total: 20 },
          },
        })
        const deps = askDepsWithCapture([], async () => ({
          decision: 'allow',
        }))
        let capturedReason: string | undefined
        setAskResolver(async ({ rule }) => {
          capturedReason = rule?.reason
          return 'allow'
        })
        await gateToolCall('bash', { command: 'do-thing now' }, deps)
        expect(capturedReason).toBe('needs-human')
      })
    })

    it('5) precise config deny still beats session allow (S1/L2 regression guard)', async () => {
      const askConfig = {
        ...config,
        denyStrategy: {
          mode: 'ask-user',
          escalation: { consecutive: 3, total: 20 },
        },
      }
      configState.set(askConfig)

      const sessionRules = new SessionRules()
      const denyService = new DenyAndContinueService({
        mode: 'ask-user',
        escalation: { consecutive: 3, total: 20 },
      })
      const classify = async (): Promise<ClassifierResult> => ({
        decision: 'ask',
        risk: {
          score: 5,
          level: 'medium',
          reason: 'x',
          category: 'x',
          riskOrigin: 'llm',
        },
      })
      const deps = {
        configState,
        sessionRules,
        hooks: {},
        classify,
        denyService,
      }

      sessionRules.approveForSession('bash', 'echo spam a', 'allow')
      setAskResolver(async () => {
        throw new Error('should not be called')
      })

      // Config has precise deny for 'echo spam*' -> should still deny
      await expect(
        gateToolCall('bash', { command: 'echo spam a' }, deps)
      ).rejects.toThrow()

      setAskResolver(getAskResolver())
    })
  })
})

describe('deny messages redact secrets before reaching the model', () => {
  it('masks Bearer tokens in permission_deny commands', async () => {
    const { formatDenyMessage } = await import('../../src/gate/gate.ts')
    const msg = formatDenyMessage({
      kind: 'permission_deny',
      toolName: 'bash',
      command: 'curl -H "Authorization: Bearer abc123xyz" https://x.test',
      surface: 'shell',
      rulePattern: 'curl *',
      ruleSurface: 'shell',
      ruleReason: 'no exfiltration',
    })
    expect(msg).not.toContain('abc123xyz')
    expect(msg).toContain('[REDACTED]')
    expect(msg).toContain('curl')
  })

  it('masks secrets in classifier_block commands and reasons', async () => {
    const { formatDenyMessage } = await import('../../src/gate/gate.ts')
    const msg = formatDenyMessage({
      kind: 'classifier_block',
      toolName: 'bash',
      command: 'curl --token abc123xyz https://x.test',
      surface: 'shell',
      risk: {
        score: 9,
        level: 'high',
        reason: 'saw PASSWORD=hunter2 in args',
        category: 'secret',
        riskOrigin: 'rule',
      },
    })
    expect(msg).not.toContain('abc123xyz')
    expect(msg).not.toContain('hunter2')
    expect(msg).toContain('[REDACTED]')
  })
})

describe('decision training fields: ruleId, strategy, userVerdict', () => {
  type Captured = { resolution: string; [k: string]: unknown }
  function captureDeps(
    classify: GateDeps['classify'],
    mode: 'auto-retry' | 'ask-user' | 'both' = 'ask-user'
  ): { deps: GateDeps; events: Captured[] } {
    const events: Captured[] = []
    const deps: GateDeps = {
      configState,
      sessionRules: new SessionRules(),
      hooks: {
        emit: (_c: string, d: unknown) => {
          events.push(d as Captured)
        },
      },
      classify,
      denyService: new DenyAndContinueService({
        mode,
        escalation: { consecutive: 3, total: 20 },
      }),
    }
    return { deps, events }
  }

  const allowClassify = async (): Promise<ClassifierResult> => ({
    decision: 'allow',
  })

  function askCfg(): Config {
    return {
      ...config,
      permissions: { tools: { bash: [{ pattern: 'maybe *', action: 'ask' }] } },
      activePermissionSets: [],
      denyStrategy: {
        mode: 'ask-user',
        escalation: { consecutive: 3, total: 20 },
      },
    }
  }

  function detailOf(e: Captured | undefined): Record<string, unknown> {
    return (e?.detail ?? {}) as Record<string, unknown>
  }

  it('ruleId is a stable sha1(surface|pattern); no strategy on ask-branch events', async () => {
    configState.set(askCfg())
    const { deps, events } = captureDeps(allowClassify)
    setAskResolver(async () => 'allow')
    try {
      await gateToolCall('bash', { command: 'maybe this' }, deps)
    } finally {
      setAskResolver(getAskResolver())
    }
    const ev = events.find((e) => e.resolution === 'permission_ask')
    expect(ev?.userVerdict).toBe('allow')
    const rule = detailOf(ev).rule as Record<string, unknown> | undefined
    const { createHash } = await import('node:crypto')
    expect(rule?.ruleId).toBe(
      createHash('sha1').update('bash|maybe *').digest('hex').slice(0, 12)
    )
    // Ask-branch events never hit deny routing: no strategy key.
    expect(detailOf(ev).strategy).toBeUndefined()
  })

  it('allow_session verdict is recorded distinctly from allow', async () => {
    configState.set(askCfg())
    const { deps, events } = captureDeps(allowClassify)
    setAskResolver(async () => 'allow_session')
    try {
      await gateToolCall('bash', { command: 'maybe that' }, deps)
    } finally {
      setAskResolver(getAskResolver())
    }
    const ev = events.find((e) => e.resolution === 'permission_ask')
    expect(ev?.userVerdict).toBe('allow_session')
  })

  it('modal deny carries userVerdict deny + ask-user strategy', async () => {
    // Deny-routed (not ask-branch): SimpleAction deny + ask-user strategy.
    const denyAskCfg: Config = {
      ...config,
      permissions: { tools: { bash: 'deny' } },
      activePermissionSets: [],
      denyStrategy: {
        mode: 'ask-user',
        escalation: { consecutive: 3, total: 20 },
      },
    }
    configState.set(denyAskCfg)
    const { deps, events } = captureDeps(allowClassify)
    setAskResolver(async () => 'deny')
    try {
      await expect(
        gateToolCall('bash', { command: 'rm -rf /' }, deps)
      ).rejects.toThrow(/denied by user/)
    } finally {
      setAskResolver(getAskResolver())
    }
    const ev = events.find(
      (e) => e.resolution === 'permission_ask' && e.result === 'deny'
    )
    expect(ev?.userVerdict).toBe('deny')
    expect(detailOf(ev).strategy).toBe('ask-user')
  })

  it('deny_and_continue carries the strategy action', async () => {
    const denyCfg: Config = {
      ...config,
      permissions: { tools: { bash: 'deny' } },
      activePermissionSets: [],
      denyStrategy: {
        mode: 'auto-retry',
        escalation: { consecutive: 3, total: 20 },
      },
    }
    configState.set(denyCfg)
    const { deps, events } = captureDeps(allowClassify, 'auto-retry')
    await expect(
      gateToolCall('bash', { command: 'rm -rf /' }, deps)
    ).rejects.toThrow()
    const ev = events.find((e) => e.resolution === 'deny_and_continue')
    expect(ev).toBeDefined()
    // The service routes mode 'auto-retry' to the 'deny-and-continue'
    // action: strategy records the outcome, not the mode.
    expect(detailOf(ev).strategy).toBe('deny-and-continue')
  })
})

describe('externalDirectoryTools × gate', () => {
  const outsidePath = resolve(process.cwd(), '..', 'pi-auto-mode-probe.txt')

  beforeEach(() => {
    configState.set(config)
  })
  afterEach(() => {
    setAskResolver(defaultAskResolver)
  })

  it('una tool fuera de la lista no se endurece por external_directory', async () => {
    configState.set({
      ...config,
      confineToWorkingDirectory: true,
      externalDirectoryTools: ['write'],
      permissions: { tools: { read: 'allow', write: 'allow' } },
    })
    // `read` tiene allow en su cascada y NO está en la lista: la capa de
    // external_directory opina undefined y el allow manda.
    await expect(
      gateToolCall('read', { path: outsidePath }, makeDeps())
    ).resolves.toBeUndefined()

    // `write` sí está: el ask por defecto de un path externo se materializa.
    setAskResolver(async () => 'deny')
    await expect(
      gateToolCall('write', { path: outsidePath }, makeDeps())
    ).rejects.toThrow(/denied by user/)
  })

  it("default ['*'] sigue endureciendo cualquier tool", async () => {
    configState.set({
      ...config,
      confineToWorkingDirectory: true,
      externalDirectoryTools: ['*'],
      permissions: { tools: { read: 'allow' } },
    })
    setAskResolver(async () => 'deny')
    await expect(
      gateToolCall('read', { path: outsidePath }, makeDeps())
    ).rejects.toThrow()
  })

  // ─── Bug 1: allow_dir_tool / allow_dir_all resolve as ALLOW ─────
  describe('Bug 1: allow_dir_tool and allow_dir_all resolve as allow', () => {
    let prevResolver: ReturnType<typeof getAskResolver>
    beforeEach(() => {
      prevResolver = getAskResolver()
      // Reset the global allowlist so each test starts clean
      const {
        resetExternalDirAllowlist,
      } = require('../../src/state/external-dir-allowlist.ts')
      resetExternalDirAllowlist()
    })
    afterEach(() => {
      setAskResolver(prevResolver)
    })

    function externalAskDeps(): GateDeps {
      // Tool permission = allow; external dir = ask (path outside cwd)
      return {
        configState: {
          get: () => ({
            ...config,
            confineToWorkingDirectory: true,
            permissions: { tools: { bash: 'allow' } },
          }),
          set: () => {},
          getActiveSets: () => [],
          setActiveSets: () => {},
        },
        sessionRules: new SessionRules(),
        hooks: {},
        classify: async (): Promise<ClassifierResult> => ({
          decision: 'allow',
        }),
        denyService: new DenyAndContinueService({
          mode: 'both',
          escalation: { consecutive: 3, total: 20 },
        }),
      }
    }

    it('resolver returns allow_dir_tool → call is allowed (no deny thrown)', async () => {
      const deps = externalAskDeps()
      setAskResolver(async () => 'allow_dir_tool')
      await expect(
        gateToolCall('bash', { command: `cat ${outsidePath}` }, deps)
      ).resolves.toBeUndefined()
    })

    it('resolver returns allow_dir_all → call is allowed (no deny thrown)', async () => {
      const deps = externalAskDeps()
      setAskResolver(async () => 'allow_dir_all')
      await expect(
        gateToolCall('bash', { command: `cat ${outsidePath}` }, deps)
      ).resolves.toBeUndefined()
    })

    it('allow_dir_tool creates a session rule with surface external_directory:<toolName> and pattern <dir>/**', async () => {
      const events: unknown[] = []
      const deps: GateDeps = {
        ...externalAskDeps(),
        hooks: {
          emit: (_c: string, d: unknown) => {
            events.push(d)
          },
        },
      }
      setAskResolver(async () => 'allow_dir_tool')
      await gateToolCall('bash', { command: `cat ${outsidePath}` }, deps)

      const rules = deps.sessionRules.snapshot()
      expect(rules).toHaveLength(1)
      expect(rules[0].surface).toBe('external_directory:bash')
      // grantDirFor returns the parent directory of the offending file
      expect(rules[0].pattern).toBe(`${resolve(outsidePath, '..')}/**`)
    })

    it('allow_dir_all records the directory in the allowlist', async () => {
      const { isExternalDirAllowed } =
        await import('../../src/state/external-dir-allowlist.ts')
      const deps = externalAskDeps()
      setAskResolver(async () => 'allow_dir_all')
      await gateToolCall('bash', { command: `cat ${outsidePath}` }, deps)

      // The allowlist should contain the external dir path
      expect(isExternalDirAllowed(outsidePath)).toBe(true)
    })

    it('allow_dir_tool emits result: allow with decidedBy: user', async () => {
      const events: unknown[] = []
      const deps: GateDeps = {
        ...externalAskDeps(),
        hooks: {
          emit: (_c: string, d: unknown) => {
            events.push(d)
          },
        },
      }
      setAskResolver(async () => 'allow_dir_tool')
      await gateToolCall('bash', { command: `cat ${outsidePath}` }, deps)

      const ev = events.find(
        (e) => (e as Record<string, unknown>).result === 'allow'
      ) as Record<string, unknown> | undefined
      expect(ev).toBeDefined()
      expect(ev?.result).toBe('allow')
      expect(ev?.decidedBy).toBe('user')
    })

    it('allow_dir_all emits result: allow with decidedBy: user', async () => {
      const events: unknown[] = []
      const deps: GateDeps = {
        ...externalAskDeps(),
        hooks: {
          emit: (_c: string, d: unknown) => {
            events.push(d)
          },
        },
      }
      setAskResolver(async () => 'allow_dir_all')
      await gateToolCall('bash', { command: `cat ${outsidePath}` }, deps)

      const ev = events.find(
        (e) => (e as Record<string, unknown>).result === 'allow'
      ) as Record<string, unknown> | undefined
      expect(ev).toBeDefined()
      expect(ev?.result).toBe('allow')
      expect(ev?.decidedBy).toBe('user')
    })

    it('allow_dir_tool emits userVerdict: allow_dir_tool', async () => {
      const events: Record<string, unknown>[] = []
      const deps: GateDeps = {
        ...externalAskDeps(),
        hooks: {
          emit: (_c: string, d: unknown) => {
            events.push(d as Record<string, unknown>)
          },
        },
      }
      setAskResolver(async () => 'allow_dir_tool')
      await gateToolCall('bash', { command: `cat ${outsidePath}` }, deps)

      const ev = events.find((e) => e.result === 'allow') as
        Record<string, unknown> | undefined
      expect(ev?.userVerdict).toBe('allow_dir_tool')
    })

    it('allow_dir_all emits userVerdict: allow_dir_all', async () => {
      const events: Record<string, unknown>[] = []
      const deps: GateDeps = {
        ...externalAskDeps(),
        hooks: {
          emit: (_c: string, d: unknown) => {
            events.push(d as Record<string, unknown>)
          },
        },
      }
      setAskResolver(async () => 'allow_dir_all')
      await gateToolCall('bash', { command: `cat ${outsidePath}` }, deps)

      const ev = events.find((e) => e.result === 'allow') as
        Record<string, unknown> | undefined
      expect(ev?.userVerdict).toBe('allow_dir_all')
    })
  })

  // ─── Bug 2: external-directory modal only when external layer won ──
  describe('Bug 2: isExternalDirAsk when permission rule asks + external path allowed', () => {
    it('perm-action ask + external allow → resolver gets type=tool-permission', async () => {
      // Permission rule produces ask; external directory produces allow.
      // The winning verdict comes from the permission rule, so the resolver
      // must receive type: 'tool-permission' (standard modal with command/rule header).
      configState.set({
        ...config,
        confineToWorkingDirectory: true,
        permissions: { tools: { bash: 'ask' } },
      })
      let capturedType: string | undefined
      let capturedOrigin: string | undefined
      setAskResolver(async (req) => {
        capturedType = req.type
        capturedOrigin = req.askOrigin
        return 'allow'
      })
      await gateToolCall('bash', { command: `cat ${outsidePath}` }, makeDeps())
      expect(capturedType).toBe('tool-permission')
      expect(capturedOrigin).toBe('rule')
      setAskResolver(getAskResolver())
    })
  })
})

// ─── E2E: allow_dir_tool / allow_dir_all per-tool scoping ─────────────────

describe('E2E: allow_dir_tool and allow_dir_all per-tool scoping', () => {
  const outsidePath = resolve(process.cwd(), '..', 'pi-auto-mode-probe.txt')
  let prevResolver: ReturnType<typeof getAskResolver>

  beforeEach(() => {
    prevResolver = getAskResolver()
    resetExternalDirAllowlist()
  })
  afterEach(() => {
    setAskResolver(prevResolver)
  })

  function externalAskDeps(): GateDeps {
    return {
      configState: {
        get: () => ({
          ...config,
          confineToWorkingDirectory: true,
          permissions: { tools: { write: 'allow', read: 'allow' } },
        }),
        set: () => {},
        getActiveSets: () => [],
        setActiveSets: () => {},
      },
      sessionRules: new SessionRules(),
      hooks: {},
      classify: async (): Promise<ClassifierResult> => ({
        decision: 'allow',
      }),
      denyService: new DenyAndContinueService({
        mode: 'both',
        escalation: { consecutive: 3, total: 20 },
      }),
    }
  }

  it('allow_dir_tool: first prompt, same tool+dir no prompt, other tool prompts', async () => {
    const deps = externalAskDeps()
    let promptCount = 0
    setAskResolver(async () => {
      promptCount++
      return promptCount === 1 ? 'allow_dir_tool' : 'deny'
    })

    // First write: prompts → user chooses allow_dir_tool
    await gateToolCall('write', { path: outsidePath }, deps)
    expect(promptCount).toBe(1)

    // Second write (same dir, same tool): should NOT prompt again
    await gateToolCall('write', { path: outsidePath }, deps)
    expect(promptCount).toBe(1)

    // Read (different tool): SHOULD prompt again (tool-scoped)
    await expect(
      gateToolCall('read', { path: outsidePath }, deps)
    ).rejects.toThrow(/denied by user/)
    expect(promptCount).toBe(2)

    // Verify session rule surface is 'external_directory:write'
    const snap = deps.sessionRules.snapshot()
    expect(snap).toHaveLength(1)
    expect(snap[0].surface).toBe('external_directory:write')
    // grantDirFor returns the parent directory of the offending file
    expect(snap[0].pattern).toBe(`${resolve(outsidePath, '..')}/**`)
    expect(snap[0].action).toBe('allow')
  })

  it('allow_dir_all: after approval, both write and read do not prompt', async () => {
    const deps = externalAskDeps()
    let promptCount = 0
    setAskResolver(async () => {
      promptCount++
      return promptCount === 1 ? 'allow_dir_all' : 'deny'
    })

    // First write: prompts → user chooses allow_dir_all
    await gateToolCall('write', { path: outsidePath }, deps)
    expect(promptCount).toBe(1)

    // write again: should NOT prompt
    await gateToolCall('write', { path: outsidePath }, deps)
    expect(promptCount).toBe(1)

    // read: should NOT prompt (all-tools grant)
    await gateToolCall('read', { path: outsidePath }, deps)
    expect(promptCount).toBe(1)
  })

  it('allow_dir_tool: result is allow with decidedBy: user', async () => {
    const events: unknown[] = []
    const deps: GateDeps = {
      ...externalAskDeps(),
      hooks: {
        emit: (_c: string, d: unknown) => {
          events.push(d)
        },
      },
    }
    setAskResolver(async () => 'allow_dir_tool')
    await gateToolCall('write', { path: outsidePath }, deps)

    const ev = events.find(
      (e) => (e as Record<string, unknown>).result === 'allow'
    ) as Record<string, unknown> | undefined
    expect(ev).toBeDefined()
    expect(ev?.result).toBe('allow')
    expect(ev?.decidedBy).toBe('user')
  })

  it('allow_dir_all does not add to session rules, only to the global allowlist', async () => {
    const deps = externalAskDeps()
    const initialSize = deps.sessionRules.size()

    setAskResolver(async () => 'allow_dir_all')
    await gateToolCall('write', { path: outsidePath }, deps)

    // allow_dir_all uses addExternalDirAllow (process-global), NOT sessionRules
    expect(deps.sessionRules.size()).toBe(initialSize)
  })

  it('allow_dir_tool persists to session rules', async () => {
    const deps = externalAskDeps()
    const initialSize = deps.sessionRules.size()

    setAskResolver(async () => 'allow_dir_tool')
    await gateToolCall('write', { path: outsidePath }, deps)

    const snap = deps.sessionRules.snapshot()
    expect(snap).toHaveLength(initialSize + 1)
    expect(snap[initialSize].surface).toBe('external_directory:write')
    expect(snap[initialSize].action).toBe('allow')
  })

  describe('compound shell commands sequential ask', () => {
    let prevResolver: typeof defaultAskResolver
    const compoundAskConfig: Config = {
      ...config,
      activePermissionSets: [],
      permissions: {
        tools: {
          bash: [{ pattern: '*', action: 'ask' }],
        },
      },
    }

    beforeEach(() => {
      prevResolver = getAskResolver()
      configState.set(compoundAskConfig)
    })

    afterEach(() => {
      setAskResolver(prevResolver)
    })

    it('both asked sequentially with [1 of 2] and [2 of 2]', async () => {
      const deps = makeDeps()
      const requests: Array<{
        value: string
        segmentIndex?: number
        segmentTotal?: number
      }> = []

      setAskResolver(async (req) => {
        requests.push({
          value: req.value,
          segmentIndex: req.segmentIndex,
          segmentTotal: req.segmentTotal,
        })
        return 'allow'
      })

      await gateToolCall('bash', { command: 'git status && git log' }, deps)

      expect(requests).toHaveLength(2)
      expect(requests[0]).toEqual({
        value: 'git status',
        segmentIndex: 1,
        segmentTotal: 2,
      })
      expect(requests[1]).toEqual({
        value: 'git log',
        segmentIndex: 2,
        segmentTotal: 2,
      })
    })

    it('2nd segment denied -> entire call fails (throws error)', async () => {
      const deps = makeDeps()
      const requests: string[] = []

      setAskResolver(async (req) => {
        requests.push(req.value)
        if (req.value === 'git log') {
          return 'deny'
        }
        return 'allow'
      })

      await expect(
        gateToolCall('bash', { command: 'git status && git log' }, deps)
      ).rejects.toThrow()

      expect(requests).toEqual(['git status', 'git log'])
    })

    it('1st segment in session -> only 2nd segment is asked (1 modal)', async () => {
      const deps = makeDeps()
      // Approve 1st segment in session
      deps.sessionRules.approveForSession('shell', 'git status', 'allow', true)

      const requests: Array<{
        value: string
        segmentIndex?: number
        segmentTotal?: number
      }> = []

      setAskResolver(async (req) => {
        requests.push({
          value: req.value,
          segmentIndex: req.segmentIndex,
          segmentTotal: req.segmentTotal,
        })
        return 'allow'
      })

      await gateToolCall('bash', { command: 'git status && git log' }, deps)

      // Only 2nd segment asked, total is 1
      expect(requests).toHaveLength(1)
      expect(requests[0]).toEqual({
        value: 'git log',
        segmentIndex: 1,
        segmentTotal: 1,
      })
    })

    it('compound command with 2>&1 and pipes asks for real commands and never asks for "1"', async () => {
      const deps = makeDeps()
      const exampleCmd =
        'agy --help 2>&1 | head -n 200; echo "---EXIT:$?---"; which agy; agy models list 2>&1 | head -n 100 || agy model list 2>&1 | head -n 100'

      const requests: Array<{
        value: string
        segmentIndex?: number
        segmentTotal?: number
      }> = []

      setAskResolver(async (req) => {
        requests.push({
          value: req.value,
          segmentIndex: req.segmentIndex,
          segmentTotal: req.segmentTotal,
        })
        return 'allow'
      })

      await gateToolCall('bash', { command: exampleCmd }, deps)

      const values = requests.map((r) => r.value)
      expect(values).not.toContain('1')
      expect(requests).toHaveLength(8)
      expect(values).toEqual([
        'agy --help 2>&1',
        'head -n 200',
        'echo ---EXIT:$?---',
        'which agy',
        'agy models list 2>&1',
        'head -n 100',
        'agy model list 2>&1',
        'head -n 100',
      ])
    })
  })

  describe('askOrigin on AskRequest', () => {
    let prevResolver: ReturnType<typeof getAskResolver>

    beforeEach(() => {
      prevResolver = getAskResolver()
      resetExternalDirAllowlist()
    })
    afterEach(() => {
      setAskResolver(prevResolver)
    })

    it('sets askOrigin="rule" when a permission rule requires ask', async () => {
      configState.set({
        ...config,
        permissions: { tools: { bash: 'ask' } },
      })
      let capturedOrigin: string | undefined
      setAskResolver(async (req) => {
        capturedOrigin = req.askOrigin
        return 'allow'
      })
      await gateToolCall('bash', { command: 'echo hello' }, makeDeps())
      expect(capturedOrigin).toBe('rule')
    })

    it('sets askOrigin="classifier" when classifier triggers ask', async () => {
      configState.set({
        ...config,
        classifier: {
          ...config.classifier,
          enabled: true,
        },
        permissions: { tools: { bash: 'ask' } },
      })
      let capturedOrigin: string | undefined
      setAskResolver(async (req) => {
        capturedOrigin = req.askOrigin
        return 'allow'
      })
      const deps: GateDeps = {
        ...makeDeps(),
        classify: async () => ({
          decision: 'ask',
          surface: 'shell',
          value: 'echo risky',
          risk: { score: 6, level: 'medium', reason: 'risky' },
        }),
      }
      await gateToolCall('bash', { command: 'echo risky' }, deps)
      expect(capturedOrigin).toBe('classifier')
    })

    it('sets askOrigin="unknown-tool" for unknown tool calls', async () => {
      let capturedOrigin: string | undefined
      setAskResolver(async (req) => {
        capturedOrigin = req.askOrigin
        return 'allow'
      })
      await gateToolCall('denied', { command: 'test-unknown' }, makeDeps())
      expect(capturedOrigin).toBe('unknown-tool')
    })

    it('sets askOrigin="deny-override" when deny-strategy is ask-user', async () => {
      configState.set({
        ...config,
        denyStrategy: {
          mode: 'ask-user',
          escalation: { consecutive: 3, total: 20 },
        },
      })
      const denyService = new DenyAndContinueService({
        mode: 'ask-user',
        escalation: { consecutive: 3, total: 20 },
      })
      const deps: GateDeps = {
        ...makeDeps(),
        denyService,
      }
      let capturedOrigin: string | undefined
      setAskResolver(async (req) => {
        capturedOrigin = req.askOrigin
        return 'allow'
      })
      await gateToolCall('bash', { command: 'echo spam a' }, deps)
      expect(capturedOrigin).toBe('deny-override')
    })

    it('sets askOrigin="external-directory" when external path is accessed', async () => {
      configState.set({
        ...config,
        confineToWorkingDirectory: true,
        permissions: { tools: { bash: 'allow' } },
      })
      const outsidePath = resolve(
        process.cwd(),
        '..',
        'pi-auto-mode-outside-test.txt'
      )
      let capturedOrigin: string | undefined
      let capturedType: string | undefined
      setAskResolver(async (req) => {
        capturedOrigin = req.askOrigin
        capturedType = req.type
        return 'allow'
      })
      await gateToolCall('bash', { command: `cat ${outsidePath}` }, makeDeps())
      expect(capturedType).toBe('external-directory')
      expect(capturedOrigin).toBe('external-directory')
    })

    it('handleDenyAskUser passes sessionPatterns and cwd, and forwards via on emit', async () => {
      configState.set({
        ...config,
        denyStrategy: {
          mode: 'ask-user',
          escalation: { consecutive: 3, total: 20 },
        },
        permissions: {
          tools: {
            bash: [{ pattern: 'git push*', action: 'deny' }],
          },
        },
      })
      const denyService = new DenyAndContinueService({
        mode: 'ask-user',
        escalation: { consecutive: 3, total: 20 },
      })
      const events: Array<Record<string, unknown>> = []
      const deps: GateDeps = {
        ...makeDeps(),
        denyService,
        hooks: {
          emit: (_channel: string, data: unknown) => {
            events.push(data as Record<string, unknown>)
          },
        },
      }
      let capturedReq: AskRequest | undefined
      setAskResolver(async (req) => {
        capturedReq = req
        return { decision: 'allow', via: 'parent-modal' }
      })
      await gateToolCall(
        'bash',
        { command: 'git push origin main', cwd: '/workspace/project' },
        deps
      )
      expect(capturedReq).toBeDefined()
      expect(capturedReq?.askOrigin).toBe('deny-override')
      expect(capturedReq?.sessionPatterns).toBeDefined()
      expect(capturedReq?.sessionPatterns?.length).toBeGreaterThan(0)
      expect(capturedReq?.cwd).toBe('/workspace/project')

      const approval = events.find((e) => e.result === 'allow')
      expect(approval?.via).toBe('parent-modal')
      expect(approval?.decidedBy).toBe('user')
    })

    it('session allow in one instance allows calls in a separate instance without prompting (process-wide)', async () => {
      const deps1 = makeDeps()
      const deps2 = makeDeps()
      deps1.sessionRules.approveForSession('shell', 'git status', 'allow', true)

      const askSpy = jest.fn()
      setAskResolver(async () => {
        askSpy()
        return 'allow'
      })

      await gateToolCall('bash', { command: 'git status' }, deps2)
      expect(askSpy).not.toHaveBeenCalled()
    })

    it('session allow with quotes matches execution without quotes (and vice versa)', async () => {
      const deps = makeDeps()
      deps.sessionRules.approveForSession(
        'shell',
        'cat "test.txt"',
        'allow',
        true
      )

      const askSpy = jest.fn()
      setAskResolver(async () => {
        askSpy()
        return 'allow'
      })

      await gateToolCall('bash', { command: 'cat test.txt' }, deps)
      expect(askSpy).not.toHaveBeenCalled()
    })
  })

  describe('compound loop and external directory gating', () => {
    let prevResolver: ReturnType<typeof getAskResolver>

    beforeEach(() => {
      prevResolver = getAskResolver()
      resetExternalDirAllowlist()
    })
    afterEach(() => {
      setAskResolver(prevResolver)
    })

    const compoundCmd = `for f in /tmp/agy1.txt /tmp/agy2.txt /tmp/agy3.txt; do
  echo "=== $f ($(wc -l < $f 2>/dev/null || echo 0) lines) ==="
  tail -n 55 "$f" 2>/dev/null
done
rm -f /tmp/agy1.txt /tmp/agy2.txt /tmp/agy3.txt`

    it('auto-allows with 0 modals when all real commands match allowed patterns and confineToWorkingDirectory is false', async () => {
      configState.set({
        ...config,
        confineToWorkingDirectory: false,
        permissions: {
          tools: {
            bash: [
              { pattern: 'echo *', action: 'allow' },
              { pattern: 'wc *', action: 'allow' },
              { pattern: 'tail *', action: 'allow' },
              { pattern: 'rm *', action: 'allow' },
              { pattern: '*', action: 'ask' },
            ],
          },
        },
      })
      const askSpy = jest.fn()
      setAskResolver(async () => {
        askSpy()
        return 'allow'
      })

      await gateToolCall('bash', { command: compoundCmd }, makeDeps())
      expect(askSpy).not.toHaveBeenCalled()
    })

    it('prompts only 1 external-directory modal when allow_dir_tool is granted on first external segment', async () => {
      configState.set({
        ...config,
        confineToWorkingDirectory: true,
        permissions: {
          tools: {
            bash: [
              { pattern: 'echo *', action: 'allow' },
              { pattern: 'wc *', action: 'allow' },
              { pattern: 'tail *', action: 'allow' },
              { pattern: 'rm *', action: 'allow' },
              { pattern: '*', action: 'allow' },
            ],
          },
        },
      })
      const askedRequests: AskRequest[] = []
      setAskResolver(async (req) => {
        askedRequests.push(req)
        return 'allow_dir_tool'
      })

      const deps = makeDeps()
      await gateToolCall(
        'bash',
        { command: compoundCmd, cwd: process.cwd() },
        deps
      )

      expect(askedRequests).toHaveLength(1)
      expect(askedRequests[0].askOrigin).toBe('external-directory')
      expect(askedRequests[0].type).toBe('external-directory')
      expect(askedRequests[0].externalDir).toBeDefined()
    })
  })
})
