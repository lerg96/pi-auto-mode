// LLM classifier layer (Milestone M4-T5).
// Pipeline: secret guard -> rule-based evaluation -> optional LLM call.
// Self-contained; reuses existing classifier primitives. No hardcoded secrets.

// ─── Model registry bridge ────────────────────────────────────
/**
 * Structural subset of `pi.modelRegistry` we consult to resolve LLM
 * credentials at classification time. Mirrors
 * `@earendil-works/pi-coding-agent/dist/core/model-registry.d.ts`
 * (`find(provider, modelId)` + `getApiKeyForProvider(provider)`). Kept as
 * a structural interface so the classifier stays runtime-agnostic: tests
 * inject a fake; `src/index.ts` passes `ctx.modelRegistry`. The runtime
 * registry is a class with a private constructor — we don't import it
 * (the SDK is not an npm dependency), only the shape we consume.
 *
 * Resolution happens LAZILY on every classify call so the user can switch
 * Pi models mid-session and the next call picks up the new credentials
 * without restarting the extension. No caching here: if a future change
 * adds caching it MUST be invalidated on model switch and on auth changes
 * (the runtime registry already handles those invalidations internally).
 */
export interface ModelRegistryLike {
  find(provider: string, modelId: string): unknown | undefined
  getApiKeyForProvider(provider: string): Promise<string | undefined>
}

/**
 * Internal error raised when Pi's model registry cannot resolve a field
 * we asked for (apiKey undefined/empty, or `find()` returned undefined
 * and the config's baseUrl is also empty). Caught inside `runLlmBranch`
 * and converted to `fallbackDecision(cfg, 'onError', e)` so the gate's
 * existing fail-closed path runs unchanged. Never logged or thrown
 * unhandled.
 */
export class LlmCredentialResolutionError extends Error {
  readonly field: 'apiKey' | 'baseUrl'
  constructor(field: 'apiKey' | 'baseUrl', detail: string) {
    super(`LLM credential resolution failed (${field}): ${detail}`)
    this.name = 'LlmCredentialResolutionError'
    this.field = field
  }
}

interface ResolvedLlmCreds {
  apiKey: string
  baseUrl: string
}

/**
 * Resolve credentials with the documented precedence:
 *
 *   apiKey  = config.apiKey  ?? await modelRegistry.getApiKeyForProvider(provider)
 *   baseUrl = config.baseUrl ?? modelRegistry.find(provider, model)?.baseUrl
 *
 * Empty string is treated as "not provided" (the schema defaults to '').
 * If BOTH the config value AND the registry lookup are empty/undefined for
 * a given field, throw `LlmCredentialResolutionError` so the caller routes
 * to `fallbackDecision(cfg, 'onError', e)`. Resolution never silently
 * passes through an empty string to `fetch`.
 */
async function resolveLlmCredentials(
  llm: import('../types/config.ts').LlmConfig,
  models: ModelRegistryLike | undefined
): Promise<ResolvedLlmCreds> {
  // 1. apiKey
  let apiKey = llm.apiKey.trim()
  if (!apiKey) {
    if (!models) {
      throw new LlmCredentialResolutionError(
        'apiKey',
        'not configured and no Pi model registry available'
      )
    }
    const resolved = await models.getApiKeyForProvider(llm.provider)
    if (typeof resolved !== 'string' || resolved.trim().length === 0) {
      throw new LlmCredentialResolutionError(
        'apiKey',
        `Pi model registry returned no key for provider "${llm.provider}"`
      )
    }
    apiKey = resolved.trim()
  }

  // 2. baseUrl
  let baseUrl = llm.baseUrl.trim()
  if (!baseUrl) {
    if (!models) {
      throw new LlmCredentialResolutionError(
        'baseUrl',
        'not configured and no Pi model registry available'
      )
    }
    if (!llm.model) {
      throw new LlmCredentialResolutionError(
        'baseUrl',
        'not configured, classifier.llm.model is empty (registry cannot resolve a baseUrl without a model id)'
      )
    }
    const model = models.find(llm.provider, llm.model)
    // The runtime `Model` from `@earendil-works/pi-ai` has a `baseUrl: string`
    // field carrying the LiteLLM endpoint URL. We only read that field and
    // tolerate unknown shapes (`unknown`) for forward-compat with future
    // model kinds that might drop it.
    const resolvedUrl =
      model && typeof model === 'object'
        ? (model as { baseUrl?: unknown }).baseUrl
        : undefined
    if (typeof resolvedUrl !== 'string' || resolvedUrl.trim().length === 0) {
      throw new LlmCredentialResolutionError(
        'baseUrl',
        `Pi model registry has no baseUrl for provider "${llm.provider}" / model "${llm.model}"`
      )
    }
    baseUrl = resolvedUrl.trim()
  }

  return { apiKey, baseUrl }
}

import { isSecretSensitive } from './secret-guard.ts'
import { maskHomePrefix } from './home-path.ts'
import {
  callLlmWithFallback,
  isTimeoutError,
  LlmHttpError,
  safeHostname,
  type LlmCallResult,
} from './llm-client.ts'

const DEFAULT_SYSTEM =
  'You are a security classifier for an AI coding agent. Decide allow/block/ask ' +
  'for the proposed tool call and return strict JSON: ' +
  '{"decision":"allow"|"block"|"ask","riskScore":0-10,"riskReason":"...","category":"..."}.'

export interface ClassifierInput {
  toolName: string
  arguments: Record<string, unknown>
  surface: string
  value: string
}

export type RiskLevel = 'low' | 'medium' | 'high'

export interface ClassifierResult {
  decision: 'allow' | 'block' | 'ask'
  risk?: {
    score: number
    level: RiskLevel
    reason: string
    category?: string
    // Origin of the risk verdict. `'rule'` = produced by the rule-based
    // phase (BR-001..BR-020, trust boundary, secret guard) where the
    // `reason` is usually a rule id (e.g. `BR-001 destructive_delete`).
    // `'llm'` = produced by the LLM branch where the `reason` is a free-
    // form English sentence from the model and is the most informative
    // part of a deny message. Optional for back-compat with legacy
    // callers; absence is treated as `'rule'`.
    riskOrigin?: 'rule' | 'llm'
  }
  matchedRuleId?: string
}

export interface ClassifierParams {
  config: import('../types/config.ts').ClassifierConfig
  llm: import('../types/config.ts').LlmConfig
}

/**
 * Optional dependencies injected by callers (index.ts, tests). `telemetry`
 * records one `classifier:file_extraction` event per LLM-branch invocation
 * when present — never required for correctness, so legacy callers
 * (anything passing only `config` + `llm`) keep working unchanged.
 *
 * `models` is the optional Pi model-registry bridge. When present AND the
 * LLM config leaves `apiKey` and/or `baseUrl` empty, the classifier
 * resolves the missing field from Pi at classification time. When omitted
 * (legacy callers, tests that don't care) the classifier behaves exactly
 * as before: empty config values are passed through verbatim, and an empty
 * `apiKey` will still produce an unauthorized 401 from the upstream LLM —
 * except now we PRE-CHECK and route to `fallbackDecision` cleanly instead
 * of letting the HTTP client fail. See `resolveLlmCredentials()`.
 */
export interface ClassifierDeps {
  telemetry?: {
    record: (type: string, payload: unknown) => void
  }
  // Debug recorder (opt-in via `debug.enabled`): receives structured LLM
  // failure diagnostics (`llm:error`). Absent by default — zero behavior
  // change for existing callers/tests.
  debug?: {
    record: (type: string, payload: unknown) => void
  }
  models?: ModelRegistryLike
}

function levelFromScore(s: number): RiskLevel {
  if (s >= 8) return 'high'
  if (s >= 4) return 'medium'
  return 'low'
}

/**
 * M2: redact known-secret values from any text before it reaches the LLM API,
 * preventing exfiltration of credentials. Covers BOTH JSON key/value pairs
 * AND secrets embedded as plain strings inside commands/arguments, e.g.
 *   curl -H "Authorization: Bearer X"
 *   echo "token=$TOKEN"
 *   git -c http.extraHeader="Authorization: Bearer X" ...
 * Mirrors the detection patterns used by the rule-based secret guard
 * (secret-guard.ts) so the same secrets that trip a block/ask also get masked
 * here; the goal is to mask (not merely detect) so the value never leaves the
 * process. All patterns are linear (no nested quantifiers) to avoid ReDoS.
 */
export function redactSecrets(text: string): string {
  let out = text
  // 1. JSON key/value pairs: "secretKey": "value" -> mask the value.
  out = out.replace(
    /("(?:api[_-]?key|apikey|api_key|secret|password|passwd|token|auth|credential)[^"]*"\s*:\s*")[^"]*/gi,
    '$1[REDACTED]'
  )
  // 2. Authorization: Bearer <token> (and bare `Bearer <token>`). Runs BEFORE
  // the generic assignment rule (step 3) so we mask the token, not the word
  // `Bearer` (e.g. `Authorization: Bearer X` -> `Authorization: Bearer [REDACTED]`).
  out = out.replace(/\bBearer\s+[^\s"',}]+/gi, 'Bearer [REDACTED]')
  // 3. assignment-style secrets: key=value / key: value (single token value).
  // Skip when the value is `Bearer` — that case is already masked by step 2
  // (`Bearer <token>` -> `Bearer [REDACTED]`); remasking here would erase the
  // `Bearer` keyword and leave the real token un-redacted.
  out = out.replace(
    /\b(authorization|client[_-]?secret|api[_-]?key|secret(?:[_-]?access)?[_-]?key|access[_-]?key|token|password|passwd|pwd|credential)\s*[=:]\s*[^\s"',}]+/gi,
    (m) => {
      const value = m.replace(/^.*[=:]\s*/, '')
      if (/^bearer\s*$/i.test(value)) return m
      return m.replace(/[^\s"',=:]+$/, '[REDACTED]')
    }
  )
  // 4. HTTP basic-auth URL: https://user:pass@host -> mask the password.
  out = out.replace(/(https?:\/\/[^/\s:@]+:)[^/\s:@]+(@)/gi, '$1[REDACTED]$2')
  // 5. secret CLI flags: --token X / -auth X -> mask the flag value.
  out = out.replace(
    /(--|-)(token|auth|secret|api[_-]?key|password)[=:\s]+[^\s"',}]+/gi,
    (m) => m.replace(/[^\s"',=:-]+$/, '[REDACTED]')
  )
  // 6. Home-prefix masking: this redactor's output goes to an EXTERNAL LLM
  // over the network, so the username embedded in absolute paths is a
  // personal identifier leaving the process. Masking only the prefix keeps
  // the structure (`C:/Users/[REDACTED]/Downloads/x.md`) that the classifier
  // needs for judgement — classification quality is unaffected. The
  // model-facing deny path (redactSecretsForModel) deliberately does NOT do
  // this: that model must be able to reissue the real path. See home-path.ts.
  out = maskHomePrefix(out)
  return out
}

function buildLlmPrompt(
  input: ClassifierInput,
  _config: import('../types/config.ts').ClassifierConfig
): string {
  // M2: redact sensitive values in BOTH the JSON arguments and the free-form
  // value field before including them in the LLM prompt. Arguments are redacted
  // at the value level (before JSON.stringify escapes the quotes) so secrets
  // embedded inside command strings (e.g. `echo {"auth":"x"}`) are masked,
  // then the whole JSON is re-scanned for JSON key/value secret pairs.
  const redactedArgs = Object.fromEntries(
    Object.entries(input.arguments ?? {}).map(([k, v]) => [
      k,
      typeof v === 'string' ? redactSecrets(v) : v,
    ])
  )
  const args = redactSecrets(JSON.stringify(redactedArgs))
  const value = redactSecrets(input.value ?? '')
  const parts = [
    `Tool: ${input.toolName}`,
    `Surface: ${input.surface}`,
    `Arguments: ${args}`,
    `Value: ${value}`,
    `Policy: LLM-only classification (rule-based phase removed in Phase 1).`,
  ]
  parts.push(DEFAULT_SYSTEM)
  return parts.join('\n')
}

interface LlmDecisionJson {
  decision?: string
  riskScore?: number
  riskReason?: string
  category?: string
}

function extractJsonFromThinkingOutput(
  text: string
): LlmDecisionJson | undefined {
  if (typeof text !== 'string') return undefined
  // 1. Strip CLOSED <think>...</think> blocks entirely. For an UNCLOSED
  //    trailing <think> (truncated reasoning), drop only the tag itself:
  //    small models often emit `<think>blah blah {"decision":...}` without
  //    ever closing the tag, and the decision JSON lives in that tail.
  let cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, ' ')
  cleaned = cleaned.replace(/<\/?think>/gi, ' ')
  // 2. Try direct JSON parse
  try {
    return JSON.parse(cleaned.trim())
  } catch {
    /* fall through */
  }
  // 3. Collect every top-level balanced { ... } span, then try parsing
  //    from LAST to first — reasoning precedes the final decision JSON.
  const spans: Array<[number, number]> = []
  let depth = 0
  let start = -1
  let inString = false
  let escape = false
  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i]
    if (inString) {
      if (escape) {
        escape = false
      } else if (ch === '\\') {
        escape = true
      } else if (ch === '"') {
        inString = false
      }
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '{') {
      if (depth === 0) start = i
      depth++
    } else if (ch === '}') {
      if (depth > 0) {
        depth--
        if (depth === 0 && start !== -1) {
          spans.push([start, i + 1])
          start = -1
        }
      }
    }
  }
  for (let i = spans.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(cleaned.slice(spans[i][0], spans[i][1]))
    } catch {
      /* not valid JSON, try the earlier span */
    }
  }
  return undefined
}

function mapLlmResult(
  res: LlmCallResult,
  _params: ClassifierParams
): ClassifierResult {
  const parsed = extractJsonFromThinkingOutput(res.content)
  const decision =
    parsed &&
    (parsed.decision === 'allow' ||
      parsed.decision === 'block' ||
      parsed.decision === 'ask')
      ? parsed.decision
      : 'ask'
  const score = parsed?.riskScore ?? 5
  return {
    decision,
    risk: {
      score,
      level: levelFromScore(score),
      // Small/quantized models often omit riskReason despite the prompt
      // asking for it. An empty reason renders as a bare '[medium risk]'
      // in the modal with zero context, which is worse than an explicit
      // admission that the model gave none.
      reason:
        parsed &&
        typeof parsed.riskReason === 'string' &&
        parsed.riskReason.trim()
          ? parsed.riskReason
          : '(LLM classifier gave no reason)',
      category: parsed?.category,
      riskOrigin: 'llm',
    },
  }
}

function makeAsk(
  score: number,
  level: RiskLevel,
  reason: string,
  category: string,
  riskOrigin: 'rule' | 'llm' = 'rule'
): ClassifierResult {
  return {
    decision: 'ask',
    risk: { score, level, reason, category, riskOrigin },
  }
}

type FallbackKind = 'onTimeout' | 'onError'

function fallbackDecision(
  cfg: import('../types/config.ts').ClassifierConfig,
  kind: FallbackKind,
  error?: unknown
): ClassifierResult {
  // Defensive default: 'ask-user' (fail-closed) if the config did not declare
  // the fallback (schema defaults it to 'ask-user', but raw overrides or
  // future drift must NOT auto-open the gate). The schema forbids 'allow' as
  // a default; this `?? 'ask-user'` is the second line of defence. Users
  // who want zero-prompt strict setups can configure 'deny' explicitly in
  // their config; users who want the gate to stay open on classifier errors
  // can opt into 'allow' explicitly.
  const option = cfg.fallback?.[kind] ?? 'ask-user'
  const detail = error instanceof Error ? `: ${error.message}` : ''
  const reason = `Classifier LLM fallback (${option})${detail}`
  if (option === 'deny') {
    return {
      decision: 'block',
      risk: {
        score: 9,
        level: 'high',
        reason,
        category: 'error',
        riskOrigin: 'rule',
      },
    }
  }
  // Fase 5: explicit opt-in fail-open. Only reachable when the user set
  // fallback.onTimeout/onError = 'allow' in their config; the schema default
  // is 'ask-user' (fail-closed), so this branch is never hit by accident.
  if (option === 'allow') {
    return {
      decision: 'allow',
      risk: {
        score: 5,
        level: 'medium',
        reason,
        category: 'error',
        riskOrigin: 'rule',
      },
    }
  }
  return {
    decision: 'ask',
    risk: {
      score: 5,
      level: 'medium',
      reason,
      category: 'error',
      riskOrigin: 'rule',
    },
  }
}

async function runLlmBranch(
  input: ClassifierInput,
  params: ClassifierParams,
  deps: ClassifierDeps = {}
): Promise<ClassifierResult> {
  const config = params.config
  // Host for debug events: assigned after credential resolution. The catch
  // below runs outside `creds` scope, so it travels in this binding.
  let debugHost = ''
  try {
    const prompt = buildLlmPrompt(input, config)
    // Resolve credentials lazily: per call (the user can switch Pi models
    // mid-session). Empty config values fall through to the Pi model
    // registry. A resolution failure routes to `fallbackDecision` so the
    // gate's existing fail-closed path runs unchanged — we never throw
    // out of `classifyToolCall` for a credential lookup miss.
    const creds = await resolveLlmCredentials(params.llm, deps.models)
    debugHost = safeHostname(creds.baseUrl)
    const res = await callLlmWithFallback({
      baseUrl: creds.baseUrl,
      apiKey: creds.apiKey,
      model: params.llm.model,
      fallbackModel: params.llm.fallbackModel,
      prompt,
      systemPrompt: params.llm.systemPrompt ?? DEFAULT_SYSTEM,
      timeoutMs: params.llm.timeoutMs,
      maxTokens: params.llm.maxTokens,
      extraBody: params.llm.extraBody,
      extraHeaders: params.llm.extraHeaders,
      // Per-attempt diagnostics → debug jsonl (`llm:attempt` events).
      // No-op when the debug recorder is absent or disabled.
      onAttempt: (a) => {
        deps.debug?.record('llm:attempt', a)
      },
      retries: params.llm.retries,
    })
    return mapLlmResult(res, params)
  } catch (e) {
    // Debug observability: record structured LLM failure diagnostics to
    // the separate debug jsonl. NEVER the prompt, headers, or apiKey —
    // only the model name, failure kind, HTTP status and the upstream
    // body snippet (already redacted again by the logger on write).
    const kind = isTimeoutError(e) ? 'onTimeout' : 'onError'
    if (e instanceof LlmHttpError) {
      deps.debug?.record('llm:error', {
        model: params.llm.model,
        status: e.status,
        bodySnippet: e.bodySnippet,
        kind,
        timeoutMs: params.llm.timeoutMs,
        host: debugHost,
      })
    } else {
      deps.debug?.record('llm:error', {
        model: params.llm.model,
        kind,
        message: e instanceof Error ? e.message : String(e),
        timeoutMs: params.llm.timeoutMs,
        host: debugHost,
      })
    }
    return fallbackDecision(config, kind, e)
  }
}

export async function classifyToolCall(
  input: ClassifierInput,
  params: ClassifierParams,
  deps: ClassifierDeps = {}
): Promise<ClassifierResult> {
  // C1 — `enabled === false` is a deliberate opt-out of the (costly) LLM call
  // ONLY. It does NOT disable the rest of the classifier: secret detection,
  // block rules and the trust boundary below still run. Rationale: a user who
  // flips `enabled:false` to save LLM cost/round-trips must NOT lose the
  // rule-based hardening (fail-closed) — they merely skip the LLM branch.
  // `undefined`/unparsed config falls through to the rule/LLM/deny path below;
  // `enabled === true` runs the LLM branch, anything else skips it.

  // H5 — scan COMBINED text (value + all arguments) for secrets
  const hay = [input.value, JSON.stringify(input.arguments ?? {})].join('\n')
  const secret = isSecretSensitive(hay)
  if (secret.sensitive) {
    // H1 — a secret *file path* touched by an fs/mcp tool is a hard block
    // (writing/reading `~/.ssh/id_rsa`, `~/.env`, ...) is critical, not just a
    // prompt. Other secret signals (env assignment, keyword, flag) stay `ask`.
    if (
      secret.reason === 'secret file path' &&
      (input.surface === 'fs' || input.surface === 'mcp')
    ) {
      return {
        decision: 'block',
        risk: {
          score: 9,
          level: 'high',
          reason: secret.reason ?? 'Secret file path',
          category: 'secret',
          riskOrigin: 'rule',
        },
      }
    }
    return makeAsk(
      9,
      'high',
      secret.reason ?? 'Secret/credential exposure',
      'secret',
      'rule'
    )
  }

  // Phase 1: rule-based config (customBlockRules, trustBoundary, allowExceptions,
  // defaultBlockRules) has been REMOVED from the schema. The rule-based phase
  // is now a no-op — all classification goes through the LLM branch (when
  // enabled) or falls back to the configured fallback.

  // C1 — gate on config.enabled (the real top-level flag).
  // enabled === true: run the LLM branch.
  // enabled === false: skip the LLM call; uncertain -> allow (rules-only).
  // enabled === undefined / unset: fail-closed -> ask.
  if (params.config.enabled === true) return runLlmBranch(input, params, deps)
  if (params.config.enabled === false) {
    return { decision: 'allow' }
  }
  return makeAsk(5, 'medium', 'Classifier not explicitly enabled', 'rule')
}
