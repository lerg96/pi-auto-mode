import {
  classifyToolCall,
  redactSecrets,
} from '../../src/classifier/llm-layer.ts'
import type { ClassifierConfig, LlmConfig } from '../../src/types/config.ts'

const baseConfig: ClassifierConfig = {
  enabled: true,
  llm: {
    provider: 'anthropic',
    model: 'test-model',
    baseUrl: 'http://localhost:11434/v1',
    apiKey: 'test-api-key',
    timeoutMs: 5000,
    maxTokens: 1024,
    fallbackModel: '',
    systemPrompt: '',
    enabled: true,
  },
  fallback: { onTimeout: 'ask-user', onError: 'ask-user' },
  onBlock: 'deny',
  onBlockUserOverride: false,
}

const llmCfg: LlmConfig = baseConfig.llm

function mockFetch(content: string): typeof fetch {
  return jest.fn(async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    text: async () => JSON.stringify({ choices: [{ message: { content } }] }),
  })) as unknown as typeof fetch
}

/** Extracts the full prompt text (system + user) sent to the LLM mock. */
function promptFromFetch(fetchSpy: ReturnType<typeof jest.fn>): string {
  const init = fetchSpy.mock.calls[0]?.[1] as { body?: string } | undefined
  if (!init?.body) return ''
  const parsed = JSON.parse(init.body) as {
    messages?: Array<{ role: string; content: string }>
  }
  return parsed.messages?.map((m) => m.content).join('\n') ?? ''
}

describe('llm-layer classifyToolCall', () => {
  beforeEach(() => {
    ;(globalThis as any).fetch = mockFetch('{"decision":"allow","riskScore":1}')
  })
  afterEach(() => {
    ;(globalThis as any).fetch = undefined
  })

  it('C1: enabled:false skips ONLY the LLM call; uncertain -> allow', async () => {
    // Phase 1: rule-based phase removed. enabled:false skips LLM, uncertain -> allow.
    const fetchSpy = globalThis.fetch as unknown as ReturnType<typeof jest.fn>
    const res = await classifyToolCall(
      {
        toolName: 'bash',
        arguments: { command: 'echo hello' },
        surface: 'bash',
        value: 'echo hello',
      },
      { config: { ...baseConfig, enabled: false }, llm: llmCfg }
    )
    expect(res.decision).toBe('allow')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('H5: secret detected in COMBINED hay (benign value, secret in arguments) -> ask secret', async () => {
    const res = await classifyToolCall(
      {
        toolName: 'bash',
        arguments: { command: 'cat ~/.npmrc && echo ok' },
        surface: 'bash',
        value: 'echo ok',
      },
      { config: baseConfig, llm: llmCfg }
    )
    expect(res.decision).toBe('ask')
    expect(res.risk?.category).toBe('secret')
  })

  it('H1: fs write to a secret path (~/.ssh/id_rsa) -> block (value/path evaluated)', async () => {
    const fetchSpy = globalThis.fetch as unknown as ReturnType<typeof jest.fn>
    const res = await classifyToolCall(
      {
        toolName: 'write',
        arguments: { path: 'C:\\Users\\test-user\\.ssh\\id_rsa' },
        surface: 'fs',
        value: 'C:\\Users\\test-user\\.ssh\\id_rsa',
      },
      { config: baseConfig, llm: llmCfg }
    )
    expect(res.decision).toBe('block')
    expect(res.risk?.category).toBe('secret')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('uncertain input falls through to the LLM branch (mocked fetch -> allow)', async () => {
    const fetchSpy = globalThis.fetch as unknown as ReturnType<typeof jest.fn>
    const res = await classifyToolCall(
      {
        toolName: 'bash',
        arguments: { command: 'echo hello' },
        surface: 'bash',
        value: 'echo hello',
      },
      { config: baseConfig, llm: llmCfg }
    )
    expect(fetchSpy).toHaveBeenCalled()
    expect(res.decision).toBe('allow')
  })

  it('A: secrets embedded in a benign command are redacted before reaching the LLM (full flow)', async () => {
    const fetchSpy = globalThis.fetch as unknown as ReturnType<typeof jest.fn>
    const res = await classifyToolCall(
      {
        toolName: 'bash',
        arguments: { command: 'echo {"auth":"topsecret123"}' },
        surface: 'bash',
        value: 'echo {"auth":"topsecret123"}',
      },
      { config: baseConfig, llm: llmCfg }
    )
    expect(res.decision).toBe('allow')
    expect(fetchSpy).toHaveBeenCalled()
    const prompt = promptFromFetch(fetchSpy)
    expect(prompt).toContain('[REDACTED]')
    expect(prompt).not.toContain('topsecret123')
  })

  it("LLM branch maps an LLM 'block' verdict to block", async () => {
    ;(globalThis as any).fetch = mockFetch('{"decision":"block","riskScore":9}')
    const res = await classifyToolCall(
      {
        toolName: 'bash',
        arguments: { command: 'echo hello' },
        surface: 'bash',
        value: 'echo hello',
      },
      { config: baseConfig, llm: llmCfg }
    )
    expect(res.decision).toBe('block')
  })

  it("S4: fallback with non-deny onError ('ask-user') never returns allow -> ask", async () => {
    ;(globalThis as any).fetch = jest.fn(async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch
    const res = await classifyToolCall(
      {
        toolName: 'bash',
        arguments: { command: 'echo hello' },
        surface: 'bash',
        value: 'echo hello',
      },
      {
        config: {
          ...baseConfig,
          fallback: { onTimeout: 'ask-user', onError: 'ask-user' },
        },
        llm: llmCfg,
      }
    )
    expect(res.decision).not.toBe('allow')
    expect(res.decision).toBe('ask')
    expect(res.risk?.level).toBe('medium')
  })

  it("LLM fetch throws -> fallback.onError 'ask-user' -> ask", async () => {
    ;(globalThis as any).fetch = jest.fn(async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch
    const res = await classifyToolCall(
      {
        toolName: 'bash',
        arguments: { command: 'echo hello' },
        surface: 'bash',
        value: 'echo hello',
      },
      {
        config: {
          ...baseConfig,
          fallback: { onTimeout: 'deny', onError: 'ask-user' },
        },
        llm: llmCfg,
      }
    )
    expect(res.decision).toBe('ask')
    expect(res.risk?.level).toBe('medium')
  })

  it('H8: config.enabled undefined does NOT fail-open to allow (falls through to LLM/deny)', async () => {
    const res = await classifyToolCall(
      {
        toolName: 'bash',
        arguments: { command: 'echo hello' },
        surface: 'bash',
        value: 'echo hello',
      },
      {
        config: {
          ...baseConfig,
          enabled: undefined,
        } as unknown as ClassifierConfig,
        llm: llmCfg,
      }
    )
    expect(res.decision).not.toBe('allow')
  })

  it("LLM timeout error -> fallback.onTimeout 'deny' -> block", async () => {
    ;(globalThis as any).fetch = jest.fn(async () => {
      throw new Error('Request timed out after 5000ms')
    }) as unknown as typeof fetch
    const res = await classifyToolCall(
      {
        toolName: 'bash',
        arguments: { command: 'echo hello' },
        surface: 'bash',
        value: 'echo hello',
      },
      {
        config: {
          ...baseConfig,
          fallback: { onTimeout: 'deny', onError: 'ask-user' },
        },
        llm: llmCfg,
      }
    )
    expect(res.decision).toBe('block')
    expect(res.risk?.level).toBe('high')
  })
})

describe('Fase 5: classifier fallback opt-in "allow"', () => {
  const throwingFetch = jest.fn(async () => {
    throw new TypeError('fetch failed')
  }) as unknown as typeof fetch

  beforeEach(() => {
    ;(globalThis as any).fetch = throwingFetch
  })
  afterEach(() => {
    ;(globalThis as any).fetch = undefined
  })

  it("F5-A: fallback.onError = 'allow' returns an allow verdict (opt-in fail-open)", async () => {
    const res = await classifyToolCall(
      {
        toolName: 'bash',
        arguments: { command: 'echo hello' },
        surface: 'bash',
        value: 'echo hello',
      },
      {
        config: {
          ...baseConfig,
          fallback: { onTimeout: 'ask-user', onError: 'allow' },
        },
        llm: llmCfg,
      }
    )
    expect(res.decision).toBe('allow')
    expect(res.risk?.category).toBe('error')
  })

  it("F5-T: fallback.onTimeout = 'allow' returns an allow verdict on timeout", async () => {
    ;(globalThis as any).fetch = jest.fn(async () => {
      throw new Error('Request timed out after 5000ms')
    }) as unknown as typeof fetch
    const res = await classifyToolCall(
      {
        toolName: 'bash',
        arguments: { command: 'echo hello' },
        surface: 'bash',
        value: 'echo hello',
      },
      {
        config: {
          ...baseConfig,
          fallback: { onTimeout: 'allow', onError: 'ask-user' },
        },
        llm: llmCfg,
      }
    )
    expect(res.decision).toBe('allow')
  })

  it("F5-D: fallback.onError = 'deny' returns a block verdict (existing fail-closed path)", async () => {
    const res = await classifyToolCall(
      {
        toolName: 'bash',
        arguments: { command: 'echo hello' },
        surface: 'bash',
        value: 'echo hello',
      },
      {
        config: {
          ...baseConfig,
          fallback: { onTimeout: 'ask-user', onError: 'deny' },
        },
        llm: llmCfg,
      }
    )
    expect(res.decision).toBe('block')
    expect(res.risk?.level).toBe('high')
  })

  it("F5-U: default config (no onTimeout/onError set) yields 'ask-user' fallback (fail-closed default)", async () => {
    const cfg: ClassifierConfig = {
      ...baseConfig,
      fallback: { onTimeout: 'ask-user', onError: 'ask-user' },
    }
    expect(cfg.fallback.onTimeout).toBe('ask-user')
    expect(cfg.fallback.onError).toBe('ask-user')

    const res = await classifyToolCall(
      {
        toolName: 'bash',
        arguments: { command: 'echo hello' },
        surface: 'bash',
        value: 'echo hello',
      },
      { config: cfg, llm: llmCfg }
    )
    expect(res.decision).toBe('ask')
    expect(res.risk?.level).toBe('medium')
  })

  it('F5-DEF: undefined fallback in the runtime config still defaults to ask-user (never allow)', async () => {
    const res = await classifyToolCall(
      {
        toolName: 'bash',
        arguments: { command: 'echo hello' },
        surface: 'bash',
        value: 'echo hello',
      },
      {
        config: {
          ...baseConfig,
          fallback: undefined,
        } as unknown as ClassifierConfig,
        llm: llmCfg,
      }
    )
    expect(res.decision).not.toBe('allow')
    expect(res.decision).toBe('ask')
  })
})

describe('llm-layer redactSecrets (Finding A)', () => {
  it('masks secret values in JSON key/value pairs (keeps non-secret keys)', () => {
    const out = redactSecrets(
      JSON.stringify({ apiKey: 'sk-live-1', note: 'ok' })
    )
    expect(out).toContain('[REDACTED]')
    expect(out).not.toContain('sk-live-1')
    expect(out).toContain('"note":"ok"')
  })

  it('masks Bearer tokens embedded in a command string', () => {
    const cmd = 'curl -H "Authorization: Bearer X"'
    const out = redactSecrets(cmd)
    expect(out).toContain('Bearer [REDACTED]')
    expect(out).not.toContain('Bearer X')
    expect(out).toContain('curl -H')
  })

  it('masks token= assignments inside a command string', () => {
    const cmd = 'echo "token=$TOKEN"'
    const out = redactSecrets(cmd)
    expect(out).toContain('token=[REDACTED]')
    expect(out).not.toContain('$TOKEN')
  })

  it('masks Authorization: Bearer in git -c http.extraHeader', () => {
    const cmd = 'git -c http.extraHeader="Authorization: Bearer X" push'
    const out = redactSecrets(cmd)
    expect(out).toContain('Bearer [REDACTED]')
    expect(out).not.toContain('Bearer X')
    expect(out).toContain('git -c http.extraHeader=')
  })

  it('masks HTTP basic-auth URL credentials', () => {
    const cmd = 'curl https://user:pass@host/'
    const out = redactSecrets(cmd)
    expect(out).toContain('user:[REDACTED]@')
    expect(out).not.toContain(':pass@')
  })

  it('masks secret CLI flag values (--token / -auth)', () => {
    const cmd = 'tool --token abc123 --auth xyz'
    const out = redactSecrets(cmd)
    expect(out).toContain('--token [REDACTED]')
    expect(out).toContain('--auth [REDACTED]')
    expect(out).not.toContain('abc123')
    expect(out).not.toContain(' xyz')
  })

  it('does NOT over-redact benign text', () => {
    const cmd = 'echo hello world && cat /etc/hosts'
    expect(redactSecrets(cmd)).toBe(cmd)
  })
})

describe('llm-layer fallback fail-closed (M2) & disabled opt-out (L2)', () => {
  const throwingFetch = jest.fn(async () => {
    throw new TypeError('fetch failed')
  }) as unknown as typeof fetch

  beforeEach(() => {
    ;(globalThis as any).fetch = throwingFetch
  })
  afterEach(() => {
    ;(globalThis as any).fetch = undefined
  })

  it("M2/Fase5: undefined fallback + LLM error -> fail-closed 'ask-user' -> ask (never allow)", async () => {
    const res = await classifyToolCall(
      {
        toolName: 'bash',
        arguments: { command: 'echo hello' },
        surface: 'bash',
        value: 'echo hello',
      },
      {
        config: {
          ...baseConfig,
          fallback: undefined,
        } as unknown as ClassifierConfig,
        llm: llmCfg,
      }
    )
    expect(res.decision).not.toBe('allow')
    expect(res.decision).toBe('ask')
    expect(res.risk?.level).toBe('medium')
    expect(res.risk?.category).toBe('error')
  })

  it("M2: explicit fallback.onError 'ask-user' still primes over default -> ask", async () => {
    const res = await classifyToolCall(
      {
        toolName: 'bash',
        arguments: { command: 'echo hello' },
        surface: 'bash',
        value: 'echo hello',
      },
      {
        config: {
          ...baseConfig,
          fallback: { onTimeout: 'ask-user', onError: 'ask-user' },
        },
        llm: llmCfg,
      }
    )
    expect(res.decision).toBe('ask')
    expect(res.risk?.level).toBe('medium')
  })

  it('L2: enabled:false benign command -> allow (skips LLM, LLM not invoked)', async () => {
    const localFetch = jest.fn() as unknown as typeof fetch
    ;(globalThis as any).fetch = localFetch
    const res = await classifyToolCall(
      {
        toolName: 'bash',
        arguments: { command: 'echo hello' },
        surface: 'bash',
        value: 'echo hello',
      },
      { config: { ...baseConfig, enabled: false }, llm: llmCfg }
    )
    expect(res.decision).toBe('allow')
    expect(localFetch).not.toHaveBeenCalled()
  })
})

describe('thinking-model response tolerance (extractJsonFromThinkingOutput via mapLlmResult)', () => {
  const input = {
    toolName: 'bash',
    arguments: { command: 'ls -la' },
    surface: 'bash',
    value: 'ls -la',
  }

  function mockThinkingFetch(body: unknown): typeof fetch {
    return jest.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => JSON.stringify(body),
    })) as unknown as typeof fetch
  }

  it('parses JSON after a closed block', async () => {
    ;(globalThis as any).fetch = mockFetch(
      '</think>{"decision":"block","riskScore":9,"riskReason":"danger"}'
    )
    const res = await classifyToolCall(input, {
      config: baseConfig,
      llm: llmCfg,
    })
    expect(res.decision).toBe('block')
    expect(res.risk?.score).toBe(9)
    expect(res.risk?.reason).toBe('danger')
  })

  it('parses JSON after an UNCLOSED (truncated) thinking block', async () => {
    ;(globalThis as any).fetch = mockFetch(
      'thinking got cut off by max_tokens... {"decision":"allow","riskScore":1}'
    )
    const res = await classifyToolCall(input, {
      config: baseConfig,
      llm: llmCfg,
    })
    expect(res.decision).toBe('allow')
  })

  it('parses JSON surrounded by prose', async () => {
    ;(globalThis as any).fetch = mockFetch(
      'Sure! Here is my analysis: {"decision":"block","riskScore":8,"riskReason":"risky"} Hope that helps.'
    )
    const res = await classifyToolCall(input, {
      config: baseConfig,
      llm: llmCfg,
    })
    expect(res.decision).toBe('block')
    expect(res.risk?.reason).toBe('risky')
  })

  it('picks the LAST balanced JSON object when several appear', async () => {
    ;(globalThis as any).fetch = mockFetch(
      '{"decision":"allow"} then reconsidering... {"decision":"block","riskScore":9}'
    )
    const res = await classifyToolCall(input, {
      config: baseConfig,
      llm: llmCfg,
    })
    expect(res.decision).toBe('block')
  })

  it('falls back to ask/5 on pure garbage (fail-closed, unchanged)', async () => {
    ;(globalThis as any).fetch = mockFetch('not json at all, no braces here')
    const res = await classifyToolCall(input, {
      config: baseConfig,
      llm: llmCfg,
    })
    expect(res.decision).toBe('ask')
    expect(res.risk?.score).toBe(5)
  })

  it('uses reasoning_content when message.content is null', async () => {
    ;(globalThis as any).fetch = mockThinkingFetch({
      choices: [
        {
          finish_reason: 'length',
          message: {
            role: 'assistant',
            content: null,
            reasoning_content:
              'thinking... therefore: {"decision":"block","riskScore":7,"riskReason":"from reasoning"}',
          },
        },
      ],
    })
    const res = await classifyToolCall(input, {
      config: baseConfig,
      llm: llmCfg,
    })
    expect(res.decision).toBe('block')
    expect(res.risk?.reason).toBe('from reasoning')
  })

  it('clean LlmParseError message (no raw body dump) when nothing is usable', async () => {
    ;(globalThis as any).fetch = mockThinkingFetch({
      choices: [
        {
          finish_reason: 'length',
          message: { role: 'assistant', content: '' },
        },
      ],
    })
    const res = await classifyToolCall(input, {
      config: baseConfig,
      llm: llmCfg,
    })
    expect(res.decision).toBe('ask')
  })
})
