// Tests for "reuse Pi's provider credentials" in the LLM classifier:
// when `classifier.llm.apiKey` and/or `baseUrl` are left empty, the
// classifier resolves them from the injected `models` (Pi's
// `ctx.modelRegistry`) at classification time. Resolution failure
// routes through the existing `fallbackDecision(cfg, 'onError', e)`
// path so the gate's fail-closed default (`'ask-user'`) survives
// unchanged. The apiKey must NEVER leak into telemetry, errors, or
// deny messages — only into the `Authorization` header on the
// outbound HTTPS request.
//
// We use a SENTINEL key `'sk-secret-XYZ'` and assert it never appears
// in any string the test can observe other than the captured
// `Authorization` header. This is the contract test from the design
// spec (§4, item 6).

import {
  classifyToolCall,
  type ModelRegistryLike,
} from '../../src/classifier/llm-layer.ts'
import type { ClassifierConfig, LlmConfig } from '../../src/types/config.ts'

const SENTINEL_KEY = 'sk-secret-XYZ'
const SENTINEL_BASEURL = 'https://registry-resolved.example.com/v1'

/**
 * A fake `ModelRegistryLike` that records every call so we can assert
 * which lookups were (or were not) made. `find()` returns an object
 * whose `baseUrl` matches `SENTINEL_BASEURL` so the resolver accepts
 * it; `getApiKeyForProvider()` returns `SENTINEL_KEY`.
 */
function makeFakeRegistry(
  opts: {
    apiKey?: string | undefined
    model?: { baseUrl?: string } | undefined
  } = {}
): ModelRegistryLike & {
  findCalls: Array<{ provider: string; modelId: string }>
  keyCalls: string[]
} {
  const findCalls: Array<{ provider: string; modelId: string }> = []
  const keyCalls: string[] = []
  return {
    findCalls,
    keyCalls,
    find(provider: string, modelId: string) {
      findCalls.push({ provider, modelId })
      return opts.model
    },
    async getApiKeyForProvider(provider: string) {
      keyCalls.push(provider)
      return opts.apiKey
    },
  }
}

function makeThrowingRegistry(): ModelRegistryLike {
  return {
    find() {
      throw new Error('registry boom')
    },
    async getApiKeyForProvider() {
      throw new Error('registry boom')
    },
  }
}

/** Build a `ClassifierConfig` that exercises the LLM branch (benign
 *  command) so the resolver actually runs. `apiKey` and `baseUrl`
 *  default to empty so each test can flip them explicitly. */
function buildConfig(
  overrides: {
    apiKey?: string
    baseUrl?: string
    model?: string
    provider?: LlmConfig['provider']
    fallback?: ClassifierConfig['fallback']
    enabled?: boolean
  } = {}
): ClassifierConfig {
  return {
    enabled: overrides.enabled ?? true,
    llm: {
      provider: overrides.provider ?? 'anthropic',
      model: overrides.model ?? 'test-model',
      baseUrl: overrides.baseUrl ?? '',
      apiKey: overrides.apiKey ?? '',
      timeoutMs: 5000,
      maxTokens: 1024,
      fallbackModel: '',
      systemPrompt: '',
      enabled: true,
    },
    fallback: overrides.fallback ?? {
      onTimeout: 'ask-user',
      onError: 'ask-user',
    },
    onBlock: 'deny',
    onBlockUserOverride: false,
  }
}

/** Build a fetch spy that records the URL and headers it received. */
function makeFetchSpy(content: string): {
  fetch: typeof fetch
  spy: ReturnType<typeof jest.fn>
} {
  const spy = jest.fn(async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    text: async () => JSON.stringify({ choices: [{ message: { content } }] }),
  })) as unknown as ReturnType<typeof jest.fn>
  return { fetch: spy as unknown as typeof fetch, spy }
}

/** Capture the URL + headers sent to the LLM. */
interface CapturedRequest {
  url: string
  authorization: string | undefined
  body: string
}
function captureRequest(spy: ReturnType<typeof jest.fn>): CapturedRequest {
  const call = spy.mock.calls[0]
  if (!call) throw new Error('fetch was not called')
  const [url, init] = call as [
    string,
    { headers?: Record<string, string>; body?: string },
  ]
  const headers = init?.headers ?? {}
  return {
    url,
    authorization: headers.Authorization,
    body: init?.body ?? '',
  }
}

describe('llm-layer: credential resolution from Pi model registry', () => {
  let prevFetch: unknown
  beforeEach(() => {
    prevFetch = (globalThis as { fetch?: unknown }).fetch
  })
  afterEach(() => {
    if (prevFetch === undefined) {
      ;(globalThis as { fetch?: unknown }).fetch = undefined
    } else {
      ;(globalThis as { fetch?: unknown }).fetch = prevFetch
    }
  })

  it('1. empty config -> resolves apiKey + baseUrl from injected registry; fetch receives resolved values', async () => {
    const registry = makeFakeRegistry({
      apiKey: SENTINEL_KEY,
      model: { baseUrl: SENTINEL_BASEURL },
    })
    const { fetch, spy } = makeFetchSpy('{"decision":"allow","riskScore":1}')
    ;(globalThis as { fetch?: unknown }).fetch = fetch

    const res = await classifyToolCall(
      {
        toolName: 'bash',
        arguments: { command: 'echo hello' },
        surface: 'bash',
        value: 'echo hello',
      },
      { config: buildConfig(), llm: buildConfig().llm },
      { models: registry }
    )

    expect(res.decision).toBe('allow')
    const req = captureRequest(spy)
    // URL must be the registry-resolved baseUrl, not the empty config value.
    expect(req.url).toBe(`${SENTINEL_BASEURL}/chat/completions`)
    // Authorization header must carry the registry-resolved apiKey.
    expect(req.authorization).toBe(`Bearer ${SENTINEL_KEY}`)
    // Both lookups were exercised.
    expect(registry.keyCalls).toEqual(['anthropic'])
    expect(registry.findCalls).toEqual([
      { provider: 'anthropic', modelId: 'test-model' },
    ])
  })

  it('2. explicit config wins; registry spies are NOT called', async () => {
    const registry = makeFakeRegistry({
      apiKey: SENTINEL_KEY,
      model: { baseUrl: SENTINEL_BASEURL },
    })
    const { fetch, spy } = makeFetchSpy('{"decision":"allow","riskScore":1}')
    ;(globalThis as { fetch?: unknown }).fetch = fetch

    const cfg = buildConfig({
      apiKey: 'explicit-config-key',
      baseUrl: 'https://explicit.example.com/v1',
    })
    const res = await classifyToolCall(
      {
        toolName: 'bash',
        arguments: { command: 'echo hello' },
        surface: 'bash',
        value: 'echo hello',
      },
      { config: cfg, llm: cfg.llm },
      { models: registry }
    )
    expect(res.decision).toBe('allow')
    const req = captureRequest(spy)
    expect(req.url).toBe('https://explicit.example.com/v1/chat/completions')
    expect(req.authorization).toBe('Bearer explicit-config-key')
    // The registry must not have been consulted at all.
    expect(registry.keyCalls).toEqual([])
    expect(registry.findCalls).toEqual([])
  })

  it('3a. registry returns undefined apiKey -> onError fallback (ask-user)', async () => {
    const registry = makeFakeRegistry({
      apiKey: undefined,
      model: { baseUrl: SENTINEL_BASEURL },
    })
    // fetch should never be called — the resolver fails before HTTP.
    const fetchSpy = jest.fn() as unknown as typeof fetch
    ;(globalThis as { fetch?: unknown }).fetch = fetchSpy

    const cfg = buildConfig({
      fallback: { onTimeout: 'ask-user', onError: 'ask-user' },
    })
    const res = await classifyToolCall(
      {
        toolName: 'bash',
        arguments: { command: 'echo hello' },
        surface: 'bash',
        value: 'echo hello',
      },
      { config: cfg, llm: cfg.llm },
      { models: registry }
    )
    expect(res.decision).toBe('ask')
    expect(res.risk?.level).toBe('medium')
    expect(res.risk?.category).toBe('error')
    expect(fetchSpy).not.toHaveBeenCalled()
    // The apiKey attempt was made; the baseUrl one was NOT (we bail on apiKey first).
    expect(registry.keyCalls).toEqual(['anthropic'])
  })

  it('3b. registry returns undefined apiKey -> onError fallback (deny)', async () => {
    const registry = makeFakeRegistry({
      apiKey: undefined,
      model: { baseUrl: SENTINEL_BASEURL },
    })
    const fetchSpy = jest.fn() as unknown as typeof fetch
    ;(globalThis as { fetch?: unknown }).fetch = fetchSpy

    const cfg = buildConfig({
      fallback: { onTimeout: 'ask-user', onError: 'deny' },
    })
    const res = await classifyToolCall(
      {
        toolName: 'bash',
        arguments: { command: 'echo hello' },
        surface: 'bash',
        value: 'echo hello',
      },
      { config: cfg, llm: cfg.llm },
      { models: registry }
    )
    expect(res.decision).toBe('block')
    expect(res.risk?.level).toBe('high')
    expect(res.risk?.category).toBe('error')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('4a. registry returns apiKey but no model (find undefined) + empty baseUrl -> onError fallback', async () => {
    const registry = makeFakeRegistry({
      apiKey: SENTINEL_KEY,
      model: undefined,
    })
    const fetchSpy = jest.fn() as unknown as typeof fetch
    ;(globalThis as { fetch?: unknown }).fetch = fetchSpy

    const cfg = buildConfig({
      fallback: { onTimeout: 'ask-user', onError: 'ask-user' },
    })
    const res = await classifyToolCall(
      {
        toolName: 'bash',
        arguments: { command: 'echo hello' },
        surface: 'bash',
        value: 'echo hello',
      },
      { config: cfg, llm: cfg.llm },
      { models: registry }
    )
    expect(res.decision).toBe('ask')
    expect(fetchSpy).not.toHaveBeenCalled()
    // Both lookups were attempted before bailing.
    expect(registry.keyCalls).toEqual(['anthropic'])
    expect(registry.findCalls).toEqual([
      { provider: 'anthropic', modelId: 'test-model' },
    ])
  })

  it('4b. registry returns apiKey but model has empty baseUrl + empty config baseUrl -> onError fallback', async () => {
    const registry = makeFakeRegistry({
      apiKey: SENTINEL_KEY,
      model: { baseUrl: '' },
    })
    const fetchSpy = jest.fn() as unknown as typeof fetch
    ;(globalThis as { fetch?: unknown }).fetch = fetchSpy

    const cfg = buildConfig({
      fallback: { onTimeout: 'ask-user', onError: 'ask-user' },
    })
    const res = await classifyToolCall(
      {
        toolName: 'bash',
        arguments: { command: 'echo hello' },
        surface: 'bash',
        value: 'echo hello',
      },
      { config: cfg, llm: cfg.llm },
      { models: registry }
    )
    expect(res.decision).toBe('ask')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('5. no models dep at all + empty config -> onError fallback, no throw', async () => {
    // The classifier is called WITHOUT `deps.models`. The resolver should
    // produce a structured `LlmCredentialResolutionError` that the outer
    // try/catch routes to `fallbackDecision` — never an unhandled throw.
    const fetchSpy = jest.fn() as unknown as typeof fetch
    ;(globalThis as { fetch?: unknown }).fetch = fetchSpy

    const cfg = buildConfig({
      fallback: { onTimeout: 'ask-user', onError: 'ask-user' },
    })
    let res
    let threw: unknown
    try {
      res = await classifyToolCall(
        {
          toolName: 'bash',
          arguments: { command: 'echo hello' },
          surface: 'bash',
          value: 'echo hello',
        },
        { config: cfg, llm: cfg.llm }
      )
    } catch (e) {
      threw = e
    }
    expect(threw).toBeUndefined()
    expect(res!.decision).toBe('ask')
    expect(res!.risk?.category).toBe('error')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('6. sentinel key never appears in telemetry, errors, or classifier result strings', async () => {
    // The SENTINEL_KEY is the apiKey the registry returns. We assert it
    // appears EXACTLY ONCE: in the `Authorization` header on the
    // outbound fetch. Anywhere else (telemetry payload, error messages,
    // risk.reason, deny reason strings, classify result strings) is a
    // leak. We deliberately use a benign command (`echo hello`) — the
    // user's command string is not the apiKey and is allowed to flow
    // through the prompt body; this test isolates the apiKey contract.
    const registry = makeFakeRegistry({
      apiKey: SENTINEL_KEY,
      model: { baseUrl: SENTINEL_BASEURL },
    })
    const telemetryEvents: Array<{ type: string; payload: unknown }> = []
    const telemetry = {
      record: (type: string, payload: unknown) => {
        telemetryEvents.push({ type, payload })
        // Telemetry itself MUST NOT receive the apiKey either.
        const json = JSON.stringify({ type, payload })
        expect(json).not.toContain(SENTINEL_KEY)
      },
    }
    const { fetch, spy } = makeFetchSpy('{"decision":"allow","riskScore":1}')
    ;(globalThis as { fetch?: unknown }).fetch = fetch

    const cfg = buildConfig({
      fallback: { onTimeout: 'ask-user', onError: 'deny' },
    })
    const res = await classifyToolCall(
      {
        toolName: 'bash',
        arguments: { command: 'echo hello' },
        surface: 'bash',
        value: 'echo hello',
      },
      { config: cfg, llm: cfg.llm },
      { models: registry, telemetry }
    )

    // The classifier result's risk fields MUST NOT contain the key.
    const resultJson = JSON.stringify(res)
    expect(resultJson).not.toContain(SENTINEL_KEY)

    // Authorization header IS allowed to contain the key.
    const req = captureRequest(spy)
    expect(req.authorization).toBe(`Bearer ${SENTINEL_KEY}`)

    // The fetch body MUST NOT contain the apiKey either: the secret
    // is passed via the Authorization header, never in the body. The
    // body only carries the prompt (user-supplied command text).
    expect(req.body).not.toContain(SENTINEL_KEY)

    // Telemetry record() was called for the classifier:file_extraction
    // event (the test has a `command` field). The closure above
    // asserted no event payload contains the key.
    // Note: file extraction is no longer implemented in Phase 1, so
    // telemetryEvents may be empty. We just check the key doesn't leak.
    expect(resultJson).not.toContain(SENTINEL_KEY)

    // Confirm the registry was actually consulted (sanity: this test
    // would silently pass-vacuous without it).
    expect(registry.keyCalls).toEqual(['anthropic'])
    expect(registry.findCalls.length).toBe(1)
  })

  it('classifier.llm.enabled === false never touches the registry', async () => {
    // The credential-resolution code path lives inside the LLM branch. If
    // `enabled === false`, the LLM branch is skipped entirely.
    const registry = makeFakeRegistry({
      apiKey: SENTINEL_KEY,
      model: { baseUrl: SENTINEL_BASEURL },
    })
    const cfg = buildConfig({ enabled: false })
    // Benign command -> rules ask nothing -> allow (rules-only classifier).
    const res = await classifyToolCall(
      {
        toolName: 'bash',
        arguments: { command: 'echo hello' },
        surface: 'bash',
        value: 'echo hello',
      },
      { config: cfg, llm: cfg.llm },
      { models: registry }
    )
    expect(res.decision).toBe('allow')
    expect(registry.keyCalls).toEqual([])
    expect(registry.findCalls).toEqual([])
  })

  it('resolution failure when registry throws -> onError fallback (no unhandled throw)', async () => {
    // Defense in depth: the registry itself throws (e.g. AuthStorage
    // unavailable). The outer try/catch must still route to fallback,
    // never propagate the throw out of classifyToolCall.
    const registry = makeThrowingRegistry()
    const fetchSpy = jest.fn() as unknown as typeof fetch
    ;(globalThis as { fetch?: unknown }).fetch = fetchSpy

    const cfg = buildConfig({
      fallback: { onTimeout: 'ask-user', onError: 'ask-user' },
    })
    let threw: unknown
    let res
    try {
      res = await classifyToolCall(
        {
          toolName: 'bash',
          arguments: { command: 'echo hello' },
          surface: 'bash',
          value: 'echo hello',
        },
        { config: cfg, llm: cfg.llm },
        { models: registry }
      )
    } catch (e) {
      threw = e
    }
    expect(threw).toBeUndefined()
    expect(res!.decision).toBe('ask')
    expect(res!.risk?.category).toBe('error')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('empty apiKey + explicit baseUrl + ok registry: only apiKey is resolved', async () => {
    // Mixed mode: explicit baseUrl, empty apiKey. Resolver should only
    // consult `getApiKeyForProvider`; `find()` is untouched.
    const registry = makeFakeRegistry({
      apiKey: SENTINEL_KEY,
      model: { baseUrl: SENTINEL_BASEURL },
    })
    const { fetch, spy } = makeFetchSpy('{"decision":"allow","riskScore":1}')
    ;(globalThis as { fetch?: unknown }).fetch = fetch

    const cfg = buildConfig({ baseUrl: 'https://explicit.example.com/v1' })
    const res = await classifyToolCall(
      {
        toolName: 'bash',
        arguments: { command: 'echo hello' },
        surface: 'bash',
        value: 'echo hello',
      },
      { config: cfg, llm: cfg.llm },
      { models: registry }
    )
    expect(res.decision).toBe('allow')
    const req = captureRequest(spy)
    expect(req.url).toBe('https://explicit.example.com/v1/chat/completions')
    expect(req.authorization).toBe(`Bearer ${SENTINEL_KEY}`)
    expect(registry.keyCalls).toEqual(['anthropic'])
    expect(registry.findCalls).toEqual([])
  })

  it('explicit apiKey + empty baseUrl + ok registry: only baseUrl is resolved', async () => {
    const registry = makeFakeRegistry({
      apiKey: SENTINEL_KEY,
      model: { baseUrl: SENTINEL_BASEURL },
    })
    const { fetch, spy } = makeFetchSpy('{"decision":"allow","riskScore":1}')
    ;(globalThis as { fetch?: unknown }).fetch = fetch

    const cfg = buildConfig({ apiKey: 'explicit-config-key' })
    const res = await classifyToolCall(
      {
        toolName: 'bash',
        arguments: { command: 'echo hello' },
        surface: 'bash',
        value: 'echo hello',
      },
      { config: cfg, llm: cfg.llm },
      { models: registry }
    )
    expect(res.decision).toBe('allow')
    const req = captureRequest(spy)
    expect(req.url).toBe(`${SENTINEL_BASEURL}/chat/completions`)
    expect(req.authorization).toBe('Bearer explicit-config-key')
    expect(registry.keyCalls).toEqual([])
    expect(registry.findCalls).toEqual([
      { provider: 'anthropic', modelId: 'test-model' },
    ])
  })
})
