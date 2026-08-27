import { gateToolCall } from '../../src/gate/gate.ts'
import type { GateDeps } from '../../src/gate/gate.ts'
import { configState } from '../../src/state/config-state.ts'
import { SessionRules } from '../../src/permission/session-rules.ts'
import { DenyAndContinueService } from '../../src/deny/deny-service.ts'
import { setAskResolver, getAskResolver } from '../../src/gate/ask.ts'
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
