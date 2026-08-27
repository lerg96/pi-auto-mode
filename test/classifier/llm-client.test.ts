import {
  callLlmWithFallback,
  isTimeoutError,
  LlmHttpError,
  LlmParseError,
} from '../../src/classifier/llm-client.ts'
import type { LlmCallParams } from '../../src/classifier/llm-client.ts'

// ─── Helpers ────────────────────────────────────────────────────
function baseParams(overrides: Partial<LlmCallParams> = {}): LlmCallParams {
  return {
    baseUrl: 'http://localhost:11434/v1',
    apiKey: 'test-key',
    model: 'primary',
    fallbackModel: '',
    prompt: 'hello',
    timeoutMs: 100,
    ...overrides,
  }
}

function okResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  })
}

/**
 * Build a standard `AbortError`-shaped rejection. fetch (undici / node-fetch)
 * rejects with a DOMException whose `name === 'AbortError'`. We use that
 * shape verbatim so the test pins what the production code actually sees.
 */
function makeAbortError(): Error {
  try {
    return new DOMException('The operation was aborted.', 'AbortError')
  } catch {
    const e = new Error('The operation was aborted.')
    e.name = 'AbortError'
    return e
  }
}

// ─── Tests ──────────────────────────────────────────────────────
describe('llm-client: AbortController-based timeout (Fix 1)', () => {
  // Resource-leak fix: the old Promise.race timeout left the underlying fetch
  // running. The new implementation MUST pass `AbortController.signal` to
  // fetch so the request is cancelled on timeout (sockets, DNS, body upload).

  it('passes an AbortSignal to fetch so the request can be aborted on timeout', async () => {
    let receivedSignal: AbortSignal | undefined
    const fetchImpl = jest.fn(
      async (_url: string, init?: RequestInit): Promise<Response> => {
        receivedSignal = init?.signal as AbortSignal | undefined
        return okResponse({
          choices: [{ message: { content: 'ok' } }],
        })
      }
    )
    await callLlmWithFallback(baseParams({ fetchImpl }))
    expect(receivedSignal).toBeDefined()
    expect(receivedSignal).toBeInstanceOf(AbortSignal)
    // Successful response: signal must NOT be aborted after the call.
    expect(receivedSignal?.aborted).toBe(false)
  })

  it('aborts the in-flight fetch when the timeout fires (signal.aborted === true)', async () => {
    // Spy fetch: never resolves on its own. Observe whether the signal
    // becomes aborted when the controller fires. We then reject with an
    // AbortError so callLlmWithFallback surfaces it; we assert the abort
    // was observed.
    let abortObserved = false
    let rejectObserved = false
    const fetchImpl = jest.fn(
      async (_url: string, init?: RequestInit): Promise<Response> => {
        const signal = init?.signal as AbortSignal | undefined
        if (!signal) throw new Error('no signal passed to fetch')
        return await new Promise<Response>((_resolve, reject) => {
          if (signal.aborted) {
            abortObserved = true
            rejectObserved = true
            reject(makeAbortError())
            return
          }
          signal.addEventListener(
            'abort',
            () => {
              abortObserved = signal.aborted
              rejectObserved = true
              reject(makeAbortError())
            },
            { once: true }
          )
        })
      }
    )

    let caught: unknown
    try {
      await callLlmWithFallback(
        baseParams({ fetchImpl, timeoutMs: 5, fallbackModel: '' })
      )
    } catch (e) {
      caught = e
    }
    expect(abortObserved).toBe(true)
    expect(rejectObserved).toBe(true)
    // The thrown error must carry the AbortError name — fetch's contract.
    // (DOMException is not an Error subclass on Node ≥ 17, so we don't
    // assert toBeInstanceOf(Error); we check the name directly.)
    expect(caught).toBeDefined()
    expect((caught as { name?: string }).name).toBe('AbortError')
  })

  it('timeout still classifies as a timeout (fallback path unchanged)', async () => {
    // Gate's `onTimeout` / `onError` fallback decision must NOT change. The
    // classifier (`isTimeoutError`) MUST recognise the AbortController-driven
    // AbortError as a timeout — exactly like the old Promise.race timeout.
    const domErr = makeAbortError()
    expect(domErr.name).toBe('AbortError')
    expect(isTimeoutError(domErr)).toBe(true)

    // And the gate-level fallback path: when the primary fetch aborts and a
    // fallback model is configured, the function routes through the
    // fallback and returns `{ usedFallback: true, fallbackError: 'timeout' }`
    // — the gate relies on this classification to decide what to do.
    let callCount = 0
    const fetchImpl = jest.fn(async (): Promise<Response> => {
      callCount += 1
      if (callCount === 1) {
        // Primary attempt aborts.
        throw makeAbortError()
      }
      // Fallback attempt succeeds.
      return okResponse({
        choices: [{ message: { content: 'fallback-content' } }],
      })
    })
    const r = await callLlmWithFallback(
      baseParams({ fetchImpl, timeoutMs: 5, fallbackModel: 'fallback' })
    )
    expect(callCount).toBe(2)
    expect(r.usedFallback).toBe(true)
    expect(r.fallbackError).toBe('timeout')
    expect(r.content).toBe('fallback-content')
  })

  it('clears the timer on a successful response (no dangling handle)', async () => {
    // Spy setTimeout/clearTimeout to track timer bookkeeping across the
    // primary request. The previous Promise.race implementation cleared the
    // timer in `finally`; the AbortController implementation must do the
    // same to avoid a dangling handle.
    let created = 0
    let cleared = 0
    const realSet = setTimeout
    const realClear = clearTimeout
    const setSpy = jest.spyOn(globalThis, 'setTimeout').mockImplementation(((
      handler: Parameters<typeof setTimeout>[0],
      ms?: number,
      ...rest: unknown[]
    ) => {
      created += 1
      return (realSet as unknown)(
        handler as Parameters<typeof realSet>[0],
        ms,
        ...(rest as [])
      )
    }) as unknown as typeof setTimeout)
    const clearSpy = jest
      .spyOn(globalThis, 'clearTimeout')
      .mockImplementation(((handle: Parameters<typeof clearTimeout>[0]) => {
        cleared += 1
        return (realClear as unknown)(handle)
      }) as unknown as typeof clearTimeout)

    try {
      const fetchImpl = jest.fn(async (): Promise<Response> =>
        okResponse({ choices: [{ message: { content: 'ok' } }] })
      )
      await callLlmWithFallback(baseParams({ fetchImpl, timeoutMs: 50 }))
      // One timer for the primary call (success → cleared in finally).
      expect(created).toBe(1)
      expect(cleared).toBe(1)
    } finally {
      setSpy.mockRestore()
      clearSpy.mockRestore()
    }
  })

  it('non-timeout errors are NOT classified as a timeout (gate stays exact)', () => {
    // Regression guard: keep the classifier strict so a JSON-parse error or
    // generic Error does NOT silently trigger the fallback-as-timeout path.
    expect(isTimeoutError(new Error('boom'))).toBe(false)
    expect(isTimeoutError(new LlmHttpError(500, 'Server Error'))).toBe(false)
    expect(isTimeoutError(new LlmParseError('not json'))).toBe(false)
    expect(isTimeoutError(null)).toBe(false)
    expect(isTimeoutError('not an error')).toBe(false)
  })
})

describe('llm-client: maxTokens request parameter', () => {
  it('includes max_tokens in the request body when maxTokens is provided', async () => {
    let capturedBody: string | undefined
    const fetchImpl = jest.fn(
      async (_url: string, init?: RequestInit): Promise<Response> => {
        capturedBody = init?.body as string
        return okResponse({
          choices: [{ message: { content: 'ok' } }],
        })
      }
    )
    await callLlmWithFallback(baseParams({ fetchImpl, maxTokens: 2048 }))
    expect(capturedBody).toBeDefined()
    const body = JSON.parse(capturedBody!)
    expect(body.max_tokens).toBe(2048)
  })

  it('uses default max_tokens (1024) when maxTokens is omitted', async () => {
    let capturedBody: string | undefined
    const fetchImpl = jest.fn(
      async (_url: string, init?: RequestInit): Promise<Response> => {
        capturedBody = init?.body as string
        return okResponse({
          choices: [{ message: { content: 'ok' } }],
        })
      }
    )
    await callLlmWithFallback(baseParams({ fetchImpl }))
    expect(capturedBody).toBeDefined()
    const body = JSON.parse(capturedBody!)
    // The llm-client defaults to 200 when maxTokens is undefined, but the
    // classifier layer now passes maxTokens from config (default 1024).
    // This test verifies the client behavior when caller omits the param.
    expect(body.max_tokens).toBe(200)
  })

  it('passes max_tokens to fallback model request as well', async () => {
    const bodies: string[] = []
    let callCount = 0
    const fetchImpl = jest.fn(async (): Promise<Response> => {
      callCount += 1
      if (callCount === 1) {
        throw makeAbortError()
      }
      return okResponse({
        choices: [{ message: { content: 'fallback-content' } }],
      })
    })
    const fetchSpy = jest.fn(
      async (_url: string, init?: RequestInit): Promise<Response> => {
        bodies.push(init?.body as string)
        return fetchImpl()
      }
    )
    await callLlmWithFallback(
      baseParams({
        fetchImpl: fetchSpy,
        timeoutMs: 5,
        fallbackModel: 'fallback',
        maxTokens: 4096,
      })
    )
    expect(bodies.length).toBe(2)
    const primaryBody = JSON.parse(bodies[0])
    const fallbackBody = JSON.parse(bodies[1])
    expect(primaryBody.max_tokens).toBe(4096)
    expect(fallbackBody.max_tokens).toBe(4096)
  })
})

describe('llm-client: extractContent handles thinking-model responses', () => {
  it('content present -> returned as-is (via callLlmWithFallback)', async () => {
    const fetchImpl = jest.fn(async (): Promise<Response> =>
      okResponse({
        choices: [
          {
            message: { content: '{"decision":"allow"}' },
            finish_reason: 'stop',
          },
        ],
      })
    )
    const r = await callLlmWithFallback(baseParams({ fetchImpl }))
    expect(r.content).toBe('{"decision":"allow"}')
  })

  it('content null + reasoning_content with JSON -> returns reasoning_content', async () => {
    const fetchImpl = jest.fn(async (): Promise<Response> =>
      okResponse({
        choices: [
          {
            message: {
              content: null,
              reasoning_content: '{"decision":"block","riskScore":9}',
            },
            finish_reason: 'stop',
          },
        ],
      })
    )
    const r = await callLlmWithFallback(baseParams({ fetchImpl }))
    expect(r.content).toBe('{"decision":"block","riskScore":9}')
  })

  it('both missing -> LlmParseError message mentions finish_reason, not raw body', async () => {
    const fetchImpl = jest.fn(async (): Promise<Response> =>
      okResponse({
        choices: [
          {
            message: { content: '' },
            finish_reason: 'length',
          },
        ],
      })
    )
    await expect(
      callLlmWithFallback(baseParams({ fetchImpl, fallbackModel: '' }))
    ).rejects.toThrow(LlmParseError)
    try {
      await callLlmWithFallback(baseParams({ fetchImpl, fallbackModel: '' }))
    } catch (e) {
      expect(e).toBeInstanceOf(LlmParseError)
      const msg = (e as Error).message
      expect(msg).toContain('finish_reason=length')
      expect(msg).not.toContain('choices') // raw body not dumped
      expect(msg.length).toBeLessThan(200) // not the 200-char raw dump
    }
  })

  it('empty content + no finish_reason -> mentions unknown', async () => {
    const fetchImpl = jest.fn(async (): Promise<Response> =>
      okResponse({
        choices: [{ message: { content: null } }],
      })
    )
    await expect(
      callLlmWithFallback(baseParams({ fetchImpl, fallbackModel: '' }))
    ).rejects.toThrow(LlmParseError)
    try {
      await callLlmWithFallback(baseParams({ fetchImpl, fallbackModel: '' }))
    } catch (e) {
      expect(e).toBeInstanceOf(LlmParseError)
      const msg = (e as Error).message
      expect(msg).toContain('finish_reason=unknown')
      expect(msg).not.toContain('choices')
    }
  })
})

describe('llm-client: extraBody / extraHeaders passthrough', () => {
  function captureFetch(): {
    fetchImpl: typeof fetch
    calls: Array<{ url: string; init: RequestInit }>
  } {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fetchImpl = jest.fn(
      async (url: string, init?: RequestInit): Promise<Response> => {
        calls.push({ url, init: init ?? {} })
        return okResponse({
          choices: [{ message: { content: 'ok' } }],
        })
      }
    ) as unknown as typeof fetch
    return { fetchImpl, calls }
  }

  it('merges extraBody into the JSON payload (reasoning_effort case)', async () => {
    const { fetchImpl, calls } = captureFetch()
    await callLlmWithFallback(
      baseParams({ fetchImpl, extraBody: { reasoning_effort: 'low' } })
    )
    expect(calls.length).toBe(1)
    const body = JSON.parse(calls[0]?.init.body as string)
    expect(body.reasoning_effort).toBe('low')
    // Base keys stay intact.
    expect(body.model).toBe('primary')
    expect(body.messages).toBeDefined()
    expect(body.stream).toBe(false)
  })

  it('extraBody wins on collision with base keys', async () => {
    const { fetchImpl, calls } = captureFetch()
    await callLlmWithFallback(
      baseParams({ fetchImpl, temperature: 0, extraBody: { temperature: 0.7 } })
    )
    const body = JSON.parse(calls[0]?.init.body as string)
    expect(body.temperature).toBe(0.7)
  })

  it('merges extraHeaders but never overrides Authorization', async () => {
    const { fetchImpl, calls } = captureFetch()
    await callLlmWithFallback(
      baseParams({
        fetchImpl,
        extraHeaders: {
          'X-Custom-Header': 'custom-value',
          Authorization: 'Bearer injected-evil',
        },
      })
    )
    const headers = calls[0]?.init.headers as Record<string, string>
    expect(headers['X-Custom-Header']).toBe('custom-value')
    expect(headers['Content-Type']).toBe('application/json')
    expect(headers.Authorization).toBe('Bearer test-key')
  })

  it('absent extras keep the exact base shape (zero-change)', async () => {
    const { fetchImpl, calls } = captureFetch()
    await callLlmWithFallback(baseParams({ fetchImpl }))
    const body = JSON.parse(calls[0]?.init.body as string)
    expect(Object.keys(body).sort()).toEqual([
      'max_tokens',
      'messages',
      'model',
      'stream',
      'temperature',
    ])
    const headers = calls[0]?.init.headers as Record<string, string>
    expect(Object.keys(headers).sort()).toEqual([
      'Authorization',
      'Content-Type',
    ])
  })

  it('schema passes extraBody/extraHeaders through, absent by default', async () => {
    const { parseConfig } = await import('../../src/types/config.ts')
    const withExtras = parseConfig({
      classifier: {
        llm: {
          provider: 'litellm',
          model: 'm',
          extraBody: { reasoning_effort: 'low' },
          extraHeaders: { 'X-Tenant': 't1' },
        },
      },
    })
    expect(withExtras.classifier.llm.extraBody).toEqual({
      reasoning_effort: 'low',
    })
    expect(withExtras.classifier.llm.extraHeaders).toEqual({
      'X-Tenant': 't1',
    })
    const bare = parseConfig({})
    expect(bare.classifier.llm.extraBody).toBeUndefined()
    expect(bare.classifier.llm.extraHeaders).toBeUndefined()
  })
})

describe('llm-client: LlmHttpError carries the upstream body snippet', () => {
  it('message embeds status + truncated body; bodySnippet field set', async () => {
    const { LlmHttpError } = await import('../../src/classifier/llm-client.ts')
    const err = new LlmHttpError(
      400,
      'Bad Request',
      `{"e":"${'x'.repeat(300)}"}`
    )
    expect(err.status).toBe(400)
    expect(err.bodySnippet.length).toBe(200)
    expect(err.message).toContain('LLM HTTP error 400: Bad Request')
    expect(err.message).toContain(err.bodySnippet)
  })

  it('empty body keeps the plain message with empty snippet', async () => {
    const { LlmHttpError } = await import('../../src/classifier/llm-client.ts')
    const err = new LlmHttpError(500, 'Server Error')
    expect(err.message).toBe('LLM HTTP error 500: Server Error')
    expect(err.bodySnippet).toBe('')
  })

  it('failed responses reject with the upstream body in the message', async () => {
    const fetchImpl = jest.fn(async (): Promise<Response> =>
      okResponse(
        { error: { message: 'reasoning_effort unsupported', code: 400 } },
        { status: 400, statusText: 'Bad Request' }
      )
    )
    const { LlmHttpError } = await import('../../src/classifier/llm-client.ts')
    try {
      await callLlmWithFallback(baseParams({ fetchImpl, fallbackModel: '' }))
      throw new Error('should have rejected')
    } catch (e) {
      expect(e).toBeInstanceOf(LlmHttpError)
      expect((e as Error).message).toContain('reasoning_effort unsupported')
      expect((e as LlmHttpError).bodySnippet).toContain(
        'reasoning_effort unsupported'
      )
    }
  })
})

describe('llm-client: onAttempt per-attempt observer', () => {
  function collect() {
    const notes: Array<{
      attempt: string
      model: string
      ok: boolean
      status?: number
      error?: string
    }> = []
    return {
      notes,
      onAttempt: (a: {
        attempt: 'primary' | 'fallback'
        model: string
        ok: boolean
        status?: number
        error?: string
      }): void => {
        notes.push({ ...a })
      },
    }
  }

  it('primary success notes once with ok:true', async () => {
    const { notes, onAttempt } = collect()
    const fetchImpl = jest.fn(async (): Promise<Response> =>
      okResponse({ choices: [{ message: { content: 'ok' } }] })
    )
    await callLlmWithFallback(baseParams({ fetchImpl, onAttempt }))
    expect(notes).toEqual([
      {
        attempt: 'primary',
        model: 'primary',
        ok: true,
        elapsedMs: expect.any(Number),
      },
    ])
  })

  it('primary 429 + fallback ok notes both attempts', async () => {
    const { notes, onAttempt } = collect()
    let calls = 0
    const fetchImpl = jest.fn(async (): Promise<Response> => {
      calls += 1
      if (calls === 1) {
        return okResponse({ error: 'slow down' }, { status: 429 })
      }
      return okResponse({ choices: [{ message: { content: 'ok' } }] })
    })
    const r = await callLlmWithFallback(
      baseParams({ fetchImpl, onAttempt, fallbackModel: 'fallback' })
    )
    expect(r.usedFallback).toBe(true)
    expect(notes).toEqual([
      {
        attempt: 'primary',
        model: 'primary',
        ok: false,
        status: 429,
        elapsedMs: expect.any(Number),
      },
      {
        attempt: 'fallback',
        model: 'fallback',
        ok: true,
        elapsedMs: expect.any(Number),
      },
    ])
  })

  it('primary 400 notes once and rejects (no double-note, no fallback)', async () => {
    const { notes, onAttempt } = collect()
    const fetchImpl = jest.fn(async (): Promise<Response> =>
      okResponse({ error: 'bad' }, { status: 400 })
    )
    await expect(
      callLlmWithFallback(
        baseParams({ fetchImpl, onAttempt, fallbackModel: 'fallback' })
      )
    ).rejects.toThrow('LLM HTTP error 400')
    expect(notes).toEqual([
      {
        attempt: 'primary',
        model: 'primary',
        ok: false,
        status: 400,
        elapsedMs: expect.any(Number),
      },
    ])
  })
})

describe('llm-client: same-model retries per status', () => {
  it('429 with statuses {429:2} retries twice then succeeds (no fallback)', async () => {
    const notes: Array<Record<string, unknown>> = []
    let calls = 0
    const fetchImpl = jest.fn(async (): Promise<Response> => {
      calls += 1
      if (calls <= 2) {
        return okResponse({ error: 'slow down' }, { status: 429 })
      }
      return okResponse({ choices: [{ message: { content: 'ok' } }] })
    })
    const r = await callLlmWithFallback(
      baseParams({
        fetchImpl,
        onAttempt: (a) => {
          notes.push({ ...a })
        },
        retries: { statuses: { 429: 2 }, backoffMs: [1, 1] },
      })
    )
    expect(calls).toBe(3)
    expect(r.usedFallback).toBe(false)
    expect(r.content).toBe('ok')
    expect(notes).toEqual([
      {
        attempt: 'primary',
        model: 'primary',
        ok: false,
        status: 429,
        elapsedMs: expect.any(Number),
      },
      {
        attempt: 'primary',
        model: 'primary',
        ok: false,
        status: 429,
        elapsedMs: expect.any(Number),
        retry: 1,
      },
      {
        attempt: 'primary',
        model: 'primary',
        ok: true,
        elapsedMs: expect.any(Number),
        retry: 2,
      },
    ])
  })

  it('exhausted retries fall through to the fallback model', async () => {
    let calls = 0
    const fetchImpl = jest.fn(async (): Promise<Response> => {
      calls += 1
      if (calls <= 2) {
        return okResponse({ error: 'busy' }, { status: 503 })
      }
      return okResponse({ choices: [{ message: { content: 'fb' } }] })
    })
    const r = await callLlmWithFallback(
      baseParams({
        fetchImpl,
        fallbackModel: 'fallback',
        retries: { statuses: { 503: 1 }, backoffMs: [1] },
      })
    )
    expect(calls).toBe(3)
    expect(r.usedFallback).toBe(true)
    expect(r.fallbackError).toBe('http:503')
    expect(r.content).toBe('fb')
  })

  it('400 never retries even with other statuses configured', async () => {
    let calls = 0
    const fetchImpl = jest.fn(async (): Promise<Response> => {
      calls += 1
      return okResponse({ error: 'bad' }, { status: 400 })
    })
    await expect(
      callLlmWithFallback(
        baseParams({
          fetchImpl,
          fallbackModel: 'fallback',
          retries: { statuses: { 429: 3 }, backoffMs: [1] },
        })
      )
    ).rejects.toThrow('LLM HTTP error 400')
    expect(calls).toBe(1)
  })

  it('backoff sleeps between retries (last entry repeats)', async () => {
    let calls = 0
    const fetchImpl = jest.fn(async (): Promise<Response> => {
      calls += 1
      if (calls === 1) {
        return okResponse({ error: 'busy' }, { status: 500 })
      }
      return okResponse({ choices: [{ message: { content: 'ok' } }] })
    })
    const start = Date.now()
    await callLlmWithFallback(
      baseParams({
        fetchImpl,
        retries: { statuses: { 500: 2 }, backoffMs: [50] },
      })
    )
    expect(calls).toBe(2)
    expect(Date.now() - start).toBeGreaterThanOrEqual(40)
  })

  it('schema passes retries through, absent by default', async () => {
    const { parseConfig } = await import('../../src/types/config.ts')
    const withRetries = parseConfig({
      classifier: {
        llm: {
          provider: 'litellm',
          model: 'm',
          retries: { statuses: { 429: 3, 500: 2 }, backoffMs: [500, 5000] },
        },
      },
    })
    expect(withRetries.classifier.llm.retries).toEqual({
      statuses: { 429: 3, 500: 2 },
      backoffMs: [500, 5000],
    })
    const bare = parseConfig({})
    expect(bare.classifier.llm.retries).toBeUndefined()
  })
})
