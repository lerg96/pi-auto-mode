// LLM classifier HTTP client (Milestone M4-T4).
// Ollama-compatible chat-completions client with retry + fallback.
// Modeled on opencode-auto-mode LlmClient.ts. No hardcoded secrets/base URLs.

export class LlmHttpError extends Error {
  status: number
  bodySnippet: string
  constructor(status: number, statusText: string, rawBody = '') {
    // The upstream body usually explains the rejection (unknown param,
    // bad model, quota...). Keep a snippet: it flows into the fallback
    // reason (modal) and the debug log, so 4xx stops being a black box.
    const snippet = rawBody.slice(0, 200)
    super(
      `LLM HTTP error ${status}: ${statusText}` +
        (snippet.length > 0 ? ` — body: ${snippet}` : '')
    )
    this.name = 'LlmHttpError'
    this.status = status
    this.bodySnippet = snippet
  }
}

export class LlmParseError extends SyntaxError {
  constructor(rawBody: string) {
    super(`Failed to parse LLM response JSON: ${rawBody.slice(0, 200)}`)
    this.name = 'LlmParseError'
  }
}

export interface LlmCallParams {
  baseUrl: string
  apiKey: string
  model: string
  fallbackModel: string
  prompt: string
  systemPrompt?: string
  timeoutMs?: number
  maxTokens?: number
  temperature?: number
  fetchImpl?: typeof fetch
  extraBody?: Record<string, unknown>
  extraHeaders?: Record<string, string>
  // Per-attempt observer (debug observability): fired for the primary AND
  // the fallback attempts with their individual outcomes. Lets callers log
  // WHY the primary failed instead of only seeing the final exception.
  onAttempt?: (attempt: LlmAttempt) => void
  // Same-model retry policy (opt-in). Absent = fail fast to the
  // fallback-model path, exactly as before.
  retries?: {
    statuses?: Record<string, number>
    backoffMs?: number[]
  }
}

export interface LlmAttempt {
  attempt: 'primary' | 'fallback'
  model: string
  ok: boolean
  status?: number
  error?: string
  // Which same-model retry this was (1-based). Absent for first attempts.
  retry?: number
  // Wall-clock ms the attempt took. Key abort-hunting evidence: a tiny
  // value with a large timeoutMs proves the abort came from outside.
  elapsedMs?: number
}

// Hostname only (never path/query/credentials): identifies WHICH endpoint
// answered or aborted, for abort-hunting. Unparseable → ''.
export function safeHostname(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname
  } catch {
    return ''
  }
}

export interface LlmCallResult {
  content: string
  usedFallback: boolean
  fallbackError?: string
}

/**
 * Timeout helper. Wraps `fn()` and aborts it via an `AbortController` so the
 * underlying `fetch` is cancelled (socket, DNS, body upload all stop) instead
 * of being left running in the background as the previous `Promise.race`
 * implementation did. Resource leak fix: every timeout used to leak one
 * fetch's worth of sockets/handles/DNS until the upstream server answered.
 *
 * The `signal` is exposed via `opts.signal` so `fn()` can pass it into fetch:
 *
 *   withSignal(timeoutMs, ({ signal }) =>
 *     fetchImpl(url, { method: 'POST', signal, body: ... })
 *   )
 *
 * On timeout the controller aborts; fetch rejects with an `AbortError`-named
 * DOMException, which {@link isTimeoutError} classifies as a timeout so the
 * caller's fallback path (`onTimeout` / `onError`) sees identical behaviour to
 * before. Successful responses clear the timer in `finally` (no dangling).
 */
async function withSignal<T>(
  timeoutMs: number,
  fn: (opts: { signal: AbortSignal }) => Promise<T>
): Promise<T> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    return await fn({ signal: ctl.signal })
  } finally {
    clearTimeout(timer)
  }
}

export function isTimeoutError(e: unknown): boolean {
  // Accept anything with a `.message` and `.name` — `Error` AND
  // `DOMException` (which is NOT a subclass of `Error` on Node ≥ 17). The
  // AbortController-driven timeout throws a DOMException whose
  // `name === 'AbortError'`; the previous Promise.race implementation threw
  // an Error with `'Request timed out after Nms'` in its message. Both shapes
  // MUST classify as a timeout so the gate's fallback path is unchanged.
  if (e === null || e === undefined) return false
  if (typeof e !== 'object') return false
  const o = e as { message?: unknown; name?: unknown }
  if (typeof o.message !== 'string' || typeof o.name !== 'string') return false
  const m = o.message.toLowerCase()
  const n = o.name.toLowerCase()
  return (
    m.includes('timeout') ||
    m.includes('timed out') ||
    n === 'aborterror' ||
    n.includes('aborterror') ||
    m.includes('abort') ||
    m.includes('connrefused') ||
    m.includes('econnrefused') ||
    m.includes('network')
  )
}

function isRetryableHttpError(status: number): boolean {
  return (
    status === 408 ||
    status === 429 ||
    status === 503 ||
    status === 504 ||
    status >= 500
  )
}

function buildMessages(
  params: LlmCallParams
): Array<{ role: string; content: string }> {
  if (params.systemPrompt) {
    return [
      { role: 'system', content: params.systemPrompt },
      { role: 'user', content: params.prompt },
    ]
  }
  return [{ role: 'user', content: params.prompt }]
}

async function postChat(
  params: LlmCallParams,
  model: string,
  fetchImpl: typeof fetch,
  timeoutMs: number
): Promise<{ res: Response; rawText: string }> {
  const body = {
    model,
    messages: buildMessages(params),
    max_tokens: params.maxTokens ?? 200,
    temperature: params.temperature ?? 0,
    stream: false,
    ...params.extraBody,
  }
  const res = await withSignal(timeoutMs, ({ signal }) =>
    fetchImpl(`${params.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...params.extraHeaders,
        // Pinned last: extras can add headers but never override auth.
        Authorization: `Bearer ${params.apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    })
  )
  const rawText = await res.text()
  return { res, rawText }
}

function extractContent(rawText: string): string {
  let json: unknown
  try {
    json = JSON.parse(rawText)
  } catch {
    throw new LlmParseError(rawText)
  }
  const choices = (json as { choices?: unknown[] }).choices
  const message = choices?.[0] && (choices[0] as { message?: unknown }).message
  const content = message && (message as { content?: unknown }).content
  if (typeof content === 'string' && content.length > 0) {
    return content
  }
  const reasoning =
    message && (message as { reasoning_content?: unknown }).reasoning_content
  if (typeof reasoning === 'string' && reasoning.length > 0) {
    return reasoning
  }
  const finishReason =
    choices?.[0] && (choices[0] as { finish_reason?: unknown }).finish_reason
  const reasonStr = typeof finishReason === 'string' ? finishReason : 'unknown'
  throw new LlmParseError(
    `LLM response had no usable content (finish_reason=${reasonStr})`
  )
}

function retriesFor(policy: LlmCallParams['retries'], status: number): number {
  const n = policy?.statuses?.[String(status)]
  if (typeof n !== 'number' || !Number.isFinite(n)) return 0
  return Math.min(5, Math.max(0, Math.floor(n)))
}

function backoffFor(policy: LlmCallParams['retries'], retry: number): number {
  const arr = policy?.backoffMs
  if (!arr || arr.length === 0) return 0
  const ms = arr[Math.min(retry, arr.length - 1)] ?? 0
  return Math.max(0, ms)
}

function sleep(ms: number): Promise<void> {
  // Bounded by schema caps (≤30s per entry); the gate chose to wait.
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, ms))
  })
}

// One model, with same-model retries per the retry policy. Throws the last
// LlmHttpError (or network error) when retries are exhausted — the caller
// routes to the fallback model exactly as before. Network/timeout errors
// never same-model retry (policy is HTTP-status scoped); they fall through
// to the existing fallback path unchanged.
async function runModelAttempts(
  params: LlmCallParams,
  model: string,
  kind: 'primary' | 'fallback',
  fetchImpl: typeof fetch,
  timeoutMs: number,
  note: (a: LlmAttempt) => void
): Promise<{ res: Response; rawText: string }> {
  let retry = 0
  for (;;) {
    const marked = retry > 0 ? { retry } : {}
    const started = Date.now()
    try {
      const out = await postChat(params, model, fetchImpl, timeoutMs)
      const elapsedMs = Date.now() - started
      if (out.res.ok) {
        note({ attempt: kind, model, ok: true, elapsedMs, ...marked })
        return out
      }
      note({
        attempt: kind,
        model,
        ok: false,
        status: out.res.status,
        elapsedMs,
        ...marked,
      })
      if (retry >= retriesFor(params.retries, out.res.status)) {
        throw new LlmHttpError(out.res.status, out.res.statusText, out.rawText)
      }
      await sleep(backoffFor(params.retries, retry))
      retry += 1
    } catch (e) {
      if (e instanceof LlmHttpError) throw e
      note({
        attempt: kind,
        model,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        elapsedMs: Date.now() - started,
        ...marked,
      })
      throw e
    }
  }
}

export async function callLlmWithFallback(
  params: LlmCallParams
): Promise<LlmCallResult> {
  const fetchImpl = params.fetchImpl ?? fetch
  const timeoutMs = params.timeoutMs ?? 8000
  let usedFallback = false
  let fallbackError: string | undefined
  const note = params.onAttempt ?? ((): void => {})

  try {
    const { rawText } = await runModelAttempts(
      params,
      params.model,
      'primary',
      fetchImpl,
      timeoutMs,
      note
    )
    return { content: extractContent(rawText), usedFallback, fallbackError }
  } catch (e) {
    if (e instanceof LlmHttpError) {
      if (isRetryableHttpError(e.status) && params.fallbackModel) {
        usedFallback = true
        fallbackError = `http:${e.status}`
      } else {
        throw e
      }
    } else if (isTimeoutError(e) && params.fallbackModel) {
      usedFallback = true
      fallbackError = 'timeout'
    } else {
      throw e
    }
  }

  const { rawText } = await runModelAttempts(
    params,
    params.fallbackModel,
    'fallback',
    fetchImpl,
    timeoutMs,
    note
  )
  return { content: extractContent(rawText), usedFallback, fallbackError }
}
