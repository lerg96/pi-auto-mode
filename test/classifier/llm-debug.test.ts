import { classifyToolCall } from '../../src/classifier/llm-layer.ts'
import type { ClassifierInput } from '../../src/classifier/llm-layer.ts'
import { parseConfig } from '../../src/types/config.ts'

function llmConfig() {
  return parseConfig({
    classifier: {
      llm: {
        provider: 'litellm',
        model: 'litellm/title-generator',
        baseUrl: 'http://127.0.0.1:1/v1',
        apiKey: 'test-key',
      },
    },
  })
}

const input: ClassifierInput = {
  toolName: 'bash',
  arguments: { command: 'echo hi' },
  surface: 'shell',
  value: 'echo hi',
}

function mockFetch(status: number, body: string): jest.SpyInstance {
  return jest.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(body, {
      status,
      statusText: status === 400 ? 'Bad Request' : 'Error',
      headers: { 'Content-Type': 'application/json' },
    })
  )
}

describe('llm-debug: llm:error diagnostics (opt-in debug log)', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('records model + status + upstream body snippet on HTTP 400', async () => {
    const fetchSpy = mockFetch(
      400,
      '{"error":{"message":"reasoning_effort is not supported for this model"}}'
    )
    try {
      const cfg = llmConfig()
      const recorded: Array<{ type: string; payload: unknown }> = []
      const res = await classifyToolCall(
        input,
        { config: cfg.classifier, llm: cfg.classifier.llm },
        {
          debug: {
            record: (type, payload) => {
              recorded.push({ type, payload })
            },
          },
        }
      )
      expect(fetchSpy).toHaveBeenCalled()
      expect(res.decision).toBe('ask')
      // Two records: the per-attempt note (primary failed) + the error.
      const types = recorded.map((r) => r.type)
      expect(types).toEqual(['llm:attempt', 'llm:error'])
      const attempt = recorded[0]?.payload as Record<string, unknown>
      expect(attempt.attempt).toBe('primary')
      expect(attempt.ok).toBe(false)
      expect(attempt.status).toBe(400)
      const payload = recorded[1]?.payload as Record<string, unknown>
      expect(payload.model).toBe('litellm/title-generator')
      expect(payload.status).toBe(400)
      expect(payload.timeoutMs).toBe(5000)
      expect(payload.host).toBe('127.0.0.1')
      expect(String(payload.bodySnippet)).toContain('reasoning_effort')
      // Modal benefit: the fallback reason carries the snippet too.
      expect(String(res.risk?.reason)).toContain('reasoning_effort')
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('absent debug recorder changes nothing (same verdict, no throw)', async () => {
    const fetchSpy = mockFetch(400, '{"error":{"message":"bad request"}}')
    try {
      const cfg = llmConfig()
      const res = await classifyToolCall(
        input,
        { config: cfg.classifier, llm: cfg.classifier.llm },
        {}
      )
      expect(res.decision).toBe('ask')
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('schema: debug off by default, default path under ~/.pi', async () => {
    const bare = parseConfig({})
    expect(bare.debug.enabled).toBe(false)
    expect(bare.debug.path.endsWith('pi-auto-mode.debug.jsonl')).toBe(true)
    const on = parseConfig({ debug: { enabled: true } })
    expect(on.debug.enabled).toBe(true)
    expect(on.debug.path.endsWith('pi-auto-mode.debug.jsonl')).toBe(true)
  })
})
