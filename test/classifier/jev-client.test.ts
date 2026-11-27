import {
  callJevWithFallback,
  DEFAULT_JEV_BASE_URL,
  DEFAULT_JEV_MODEL,
  mapJevResult,
  type JevApiResponse,
} from '../../src/classifier/jev-client.ts'
import { classifyToolCall } from '../../src/classifier/llm-layer.ts'
import type { ClassifierConfig, LlmConfig } from '../../src/types/config.ts'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: { 'Content-Type': 'application/json' },
  })
}

function makeJevParams(
  llmOverrides: Partial<LlmConfig> = {},
  cfgOverrides: Partial<ClassifierConfig> = {}
): { config: ClassifierConfig; llm: LlmConfig } {
  const llm: LlmConfig = {
    provider: 'typesafe',
    api: 'jev',
    model: 'jev-latest',
    baseUrl: 'https://api.typesafe.ai/v1',
    apiKey: 'ts_test_key',
    timeoutMs: 5000,
    maxTokens: 1024,
    fallbackModel: '',
    systemPrompt: '',
    enabled: true,
    ...llmOverrides,
  }
  const config: ClassifierConfig = {
    enabled: true,
    onlyFlagged: false,
    llm,
    fallback: { onTimeout: 'ask-user', onError: 'ask-user' },
    onBlock: 'deny',
    onBlockUserOverride: false,
    ...cfgOverrides,
  }
  return { config, llm }
}

describe('jev-client', () => {
  it('posts to /systemone with Bearer auth pinned last and parses structured answers', async () => {
    let seenUrl = ''
    let seenAuth = ''
    let seenBody: Record<string, unknown> = {}

    const mockFetch: typeof fetch = async (input, init) => {
      seenUrl = String(input)
      const headers = (init?.headers ?? {}) as Record<string, string>
      seenAuth = headers.Authorization
      seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return jsonResponse({
        model: 'jev-1.13.0',
        answers: {
          decision: {
            type: 'choice',
            choice: 'allow',
            confidence: 0.96,
            probabilities: { allow: 0.96, ask: 0.03, block: 0.01 },
          },
          risk: { type: 'score', score: 1.1 },
          category: { type: 'choice', choice: 'safe_local_dev' },
        },
      } satisfies JevApiResponse)
    }

    const res = await callJevWithFallback({
      baseUrl: 'https://api.typesafe.ai/v1/',
      apiKey: 'real-secret',
      model: 'jev-latest',
      state: 'Tool: bash\nValue: python3 -c "print(1)"',
      extraHeaders: { Authorization: 'Bearer spoofed', 'X-Custom': '1' },
      fetchImpl: mockFetch,
    })

    expect(seenUrl).toBe('https://api.typesafe.ai/v1/systemone')
    expect(seenAuth).toBe('Bearer real-secret')
    expect(seenBody.model).toBe('jev-latest')
    expect(seenBody.questions).toBeDefined()

    const mapped = mapJevResult(res, 0.85)
    expect(mapped.decision).toBe('allow')
    expect(mapped.risk?.level).toBe('low')
    expect(mapped.risk?.category).toBe('safe_local_dev')
    expect(mapped.risk?.reason).toContain(
      'Jev [safe_local_dev]: decision=allow'
    )
    expect(mapped.risk?.reason).toContain('confidence=0.96')
  })

  it('does not double-append /systemone when baseUrl already ends with /systemone', async () => {
    let seenUrl = ''
    const mockFetch: typeof fetch = async (input) => {
      seenUrl = String(input)
      return jsonResponse({
        answers: {
          decision: { choice: 'ask', confidence: 0.8 },
        },
      })
    }

    await callJevWithFallback({
      baseUrl: 'https://api.typesafe.ai/v1/systemone',
      apiKey: 'k',
      model: 'jev-latest',
      state: 'test',
      fetchImpl: mockFetch,
    })
    expect(seenUrl).toBe('https://api.typesafe.ai/v1/systemone')
  })

  it('downgrades allow to ask (fail-closed) when confidence is below minAllowConfidence', () => {
    const mapped = mapJevResult(
      {
        response: {
          answers: {
            decision: {
              choice: 'allow',
              confidence: 0.72,
              probabilities: { allow: 0.72, ask: 0.25, block: 0.03 },
            },
            risk: { score: 1.5 },
            category: { choice: 'uncertain' },
          },
        },
        usedFallback: false,
      },
      0.85
    )

    expect(mapped.decision).toBe('ask')
    expect(mapped.risk?.reason).toContain('0.72 < threshold 0.85 -> ask')
  })

  it('downgrades allow to ask when confidence and probabilities are missing (fail-closed)', () => {
    const mapped = mapJevResult(
      {
        response: {
          answers: {
            decision: { choice: 'allow' },
          },
        },
        usedFallback: false,
      },
      0.85
    )

    expect(mapped.decision).toBe('ask')
    expect(mapped.risk?.reason).toContain('missing confidence')
  })

  it('maps block verdict with high risk and category in reason', () => {
    const mapped = mapJevResult({
      response: {
        answers: {
          decision: {
            choice: 'block',
            confidence: 0.98,
            probabilities: { allow: 0.01, ask: 0.01, block: 0.98 },
          },
          risk: { score: 2.9 },
          category: { choice: 'db_delete' },
        },
      },
      usedFallback: false,
    })

    expect(mapped.decision).toBe('block')
    expect(mapped.risk?.level).toBe('high')
    expect(mapped.risk?.score).toBe(10)
    expect(mapped.risk?.category).toBe('db_delete')
    expect(mapped.risk?.reason).toContain('Jev [db_delete]: decision=block')
  })

  it('retries retryable HTTP status and falls back to fallbackModel when primary exhausts retries', async () => {
    const modelsSeen: string[] = []
    const mockFetch: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { model: string }
      modelsSeen.push(body.model)
      if (body.model === 'jev-primary') {
        return jsonResponse({ error: 'rate limited' }, 429)
      }
      return jsonResponse({
        answers: {
          decision: {
            choice: 'allow',
            confidence: 0.95,
            probabilities: { allow: 0.95, ask: 0.04, block: 0.01 },
          },
          risk: { score: 1.0 },
          category: { choice: 'safe_local_dev' },
        },
      })
    }

    const res = await callJevWithFallback({
      baseUrl: DEFAULT_JEV_BASE_URL,
      apiKey: 'k',
      model: 'jev-primary',
      fallbackModel: 'jev-fallback',
      state: 'test',
      retries: { statuses: { '429': 1 }, backoffMs: [0] },
      fetchImpl: mockFetch,
    })

    expect(modelsSeen).toEqual(['jev-primary', 'jev-primary', 'jev-fallback'])
    expect(res.usedFallback).toBe(true)
    expect(res.fallbackError).toBe('http:429')
  })
})

describe('classifyToolCall with api=jev', () => {
  const originalFetch = globalThis.fetch
  const originalEnvKey = process.env.TYPESAFE_API_KEY

  afterEach(() => {
    globalThis.fetch = originalFetch
    if (originalEnvKey === undefined) {
      delete process.env.TYPESAFE_API_KEY
    } else {
      process.env.TYPESAFE_API_KEY = originalEnvKey
    }
  })

  it('resolves TYPESAFE_API_KEY, default baseUrl, and default model when omitted', async () => {
    process.env.TYPESAFE_API_KEY = 'ts_env_key'
    let seenUrl = ''
    let seenAuth = ''
    let seenModel = ''

    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit
    ) => {
      seenUrl = String(input)
      seenAuth = ((init?.headers ?? {}) as Record<string, string>).Authorization
      seenModel = (JSON.parse(String(init?.body)) as { model: string }).model
      return jsonResponse({
        answers: {
          decision: {
            choice: 'allow',
            confidence: 0.93,
            probabilities: { allow: 0.93, ask: 0.05, block: 0.02 },
          },
          risk: { score: 1.1 },
          category: { choice: 'safe_local_dev' },
        },
      })
    }) as typeof fetch

    const params = makeJevParams({ apiKey: '', baseUrl: '', model: '' })
    const result = await classifyToolCall(
      {
        toolName: 'bash',
        arguments: { command: 'node script.js' },
        surface: 'shell',
        value: 'node script.js',
      },
      params
    )

    expect(seenUrl).toBe(`${DEFAULT_JEV_BASE_URL}/systemone`)
    expect(seenAuth).toBe('Bearer ts_env_key')
    expect(seenModel).toBe(DEFAULT_JEV_MODEL)
    expect(result.decision).toBe('allow')
  })

  it('routes to fail-closed fallback on HTTP error', async () => {
    globalThis.fetch = (async () =>
      jsonResponse({ error: 'boom' }, 500)) as typeof fetch

    const params = makeJevParams()
    const result = await classifyToolCall(
      {
        toolName: 'bash',
        arguments: { command: 'python3 run.py' },
        surface: 'shell',
        value: 'python3 run.py',
      },
      params
    )

    expect(result.decision).toBe('ask')
    expect(result.risk?.category).toBe('error')
  })
})
