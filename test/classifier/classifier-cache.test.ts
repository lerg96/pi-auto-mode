import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearClassifierCache } from '../../src/classifier/classifier-cache.ts'
import { classifyToolCall } from '../../src/classifier/llm-layer.ts'
import type { ClassifierConfig, LlmConfig } from '../../src/types/config.ts'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText: 'OK',
    headers: { 'Content-Type': 'application/json' },
  })
}

function makeJevParams(): { config: ClassifierConfig; llm: LlmConfig } {
  const llm: LlmConfig = {
    provider: 'opencode',
    api: 'jev',
    model: 'jev-1.13-free',
    baseUrl: 'https://opencode.ai/zen/v1',
    apiKey: 'test-key',
    minAllowConfidence: 0.8,
    timeoutMs: 5000,
    maxTokens: 1024,
    fallbackModel: '',
    systemPrompt: '',
    enabled: true,
  }
  const config: ClassifierConfig = {
    enabled: true,
    onlyFlagged: true,
    llm,
    fallback: { onTimeout: 'ask-user', onError: 'ask-user' },
    onBlock: 'deny',
    onBlockUserOverride: false,
  }
  return { config, llm }
}

describe('classifier-cache', () => {
  const originalFetch = globalThis.fetch
  let tmpDir: string

  beforeEach(() => {
    clearClassifierCache()
    tmpDir = mkdtempSync(join(tmpdir(), 'pi-clf-cache-'))
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    clearClassifierCache()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('caches high-confidence allow verdicts and invalidates when referenced script changes', async () => {
    let fetchCalls = 0
    globalThis.fetch = (async () => {
      fetchCalls++
      return jsonResponse({
        answers: {
          decision: {
            choice: 'allow',
            confidence: 0.96,
            probabilities: { allow: 0.96, ask: 0.03, block: 0.01 },
          },
          risk: { score: 1.0 },
          category: { choice: 'safe_local_dev' },
        },
      })
    }) as typeof fetch

    const scriptPath = join(tmpDir, 'check.py')
    writeFileSync(scriptPath, 'print("v1")\n')
    const cmd = `python3 ${scriptPath}`
    const params = makeJevParams()
    const debugEvents: string[] = []
    const deps = {
      debug: { record: (t: string) => debugEvents.push(t) },
    }

    const r1 = await classifyToolCall(
      {
        toolName: 'bash',
        arguments: { command: cmd },
        surface: 'shell',
        value: cmd,
        cwd: tmpDir,
      },
      params,
      deps
    )
    expect(r1.decision).toBe('allow')
    expect(fetchCalls).toBe(1)

    const r2 = await classifyToolCall(
      {
        toolName: 'bash',
        arguments: { command: cmd },
        surface: 'shell',
        value: cmd,
        cwd: tmpDir,
      },
      params,
      deps
    )
    expect(r2.decision).toBe('allow')
    expect(fetchCalls).toBe(1)
    expect(debugEvents).toContain('classifier:cache_hit')

    writeFileSync(scriptPath, 'import os; os.remove("x")\n')
    const r3 = await classifyToolCall(
      {
        toolName: 'bash',
        arguments: { command: cmd },
        surface: 'shell',
        value: cmd,
        cwd: tmpDir,
      },
      params,
      deps
    )
    expect(r3.decision).toBe('allow')
    expect(fetchCalls).toBe(2)
  })

  it('never caches ask or block verdicts', async () => {
    let fetchCalls = 0
    globalThis.fetch = (async () => {
      fetchCalls++
      return jsonResponse({
        answers: {
          decision: {
            choice: 'ask',
            confidence: 0.6,
            probabilities: { allow: 0.2, ask: 0.7, block: 0.1 },
          },
          risk: { score: 2.0 },
          category: { choice: 'uncertain' },
        },
      })
    }) as typeof fetch

    const params = makeJevParams()
    const inp = {
      toolName: 'bash',
      arguments: { command: 'python3 -c "do_something()"' },
      surface: 'shell',
      value: 'python3 -c "do_something()"',
    }
    await classifyToolCall(inp, params)
    await classifyToolCall(inp, params)
    expect(fetchCalls).toBe(2)
  })
})
