import { appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { isSecretSensitive } from '../classifier/secret-guard.ts'
import { DEFAULT_TELEMETRY_PATH } from '../types/config.ts'
import { notifyUi } from '../state/ui-context.ts'
import { BUS_CHANNEL_DECISION, BUS_CHANNEL_UI_PROMPT } from '../events.ts'

export interface TelemetryEvent {
  ts: string
  type: string
  payload: unknown
}

// M9: redact secret-bearing values before they are written to disk.
// We reuse the secret-guard heuristics (env-style assignments like
// `SECRET_KEY=...`, `password=...`, bearer tokens, etc.). The original
// payload is never mutated — redact() builds a new structure.
const SECRET_KEY_RE =
  /(?:secret|password|passwd|pwd|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|credential)/i

type RedactedValue =
  | string
  | number
  | boolean
  | null
  | RedactedValue[]
  | { [k: string]: RedactedValue }

export function redact(value: unknown): RedactedValue {
  if (typeof value === 'string') {
    return isSecretSensitive(value).sensitive ? '[REDACTED]' : value
  }
  if (Array.isArray(value)) {
    return value.map((v) => redact(v))
  }
  if (value instanceof Date) {
    return value.toISOString()
  }
  if (value instanceof Map) {
    return Array.from(value.entries()).map(([k, v]) => [redact(k), redact(v)])
  }
  if (value instanceof Set) {
    return Array.from(value).map((v) => redact(v))
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, RedactedValue> = {}
    for (const [k, v] of Object.entries(value)) {
      // A key name that signals a secret redacts a non-empty string value
      // even when the value itself is not an obvious assignment.
      const keySecret = SECRET_KEY_RE.test(k)
      out[k] =
        keySecret && typeof v === 'string' && v.length > 0
          ? '[REDACTED]'
          : redact(v)
    }
    return out
  }
  return value as RedactedValue
}

export class TelemetryLogger {
  constructor(
    private enabled: boolean,
    private path: string
  ) {}

  update(enabled: boolean, path: string): void {
    this.enabled = enabled
    this.path = path
  }

  record(type: string, payload: unknown): void {
    if (!this.enabled) return
    // Safety net for callers that bypass the schema (e.g. an in-memory Config
    // assembled by tests): an empty/whitespace path falls back to the same
    // default the schema applies, so `enabled: true` always has somewhere to
    // write. Same trim semantics as the zod transform.
    const target =
      this.path && this.path.trim().length > 0
        ? this.path
        : DEFAULT_TELEMETRY_PATH
    const ev: TelemetryEvent = {
      ts: new Date().toISOString(),
      type,
      payload: redact(payload),
    }
    try {
      appendFileSync(
        target,
        `${JSON.stringify(ev)}
`,
        'utf8'
      )
    } catch (e) {
      console.error('[telemetry] write failed:', e)
    }
  }

  subscribe(pi: ExtensionAPI): void {
    try {
      pi.events.on(BUS_CHANNEL_DECISION, (p: unknown) => {
        // M6: void fire-and-forget — telemetry must never affect main flow.
        void this.record('permissions:decision', p)
      })
      pi.events.on(BUS_CHANNEL_UI_PROMPT, (p: unknown) => {
        void this.record('permissions:ui_prompt', p)
      })
    } catch (e) {
      // Use the helper that reads the bound UI from the ctx holder; the
      // subscribe() call happens at extension startup before any handler has
      // bound a ctx, so this falls back to console.error.
      notifyUi(
        `telemetry subscribe failed: ${e instanceof Error ? e.message : String(e)}`,
        'error'
      )
    }
  }
}
