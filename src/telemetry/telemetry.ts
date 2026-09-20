import { promises as fsPromises } from 'node:fs'
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

// Cap on how many events may be waiting for the drain (queued + in-flight).
// Chosen generously: a normal session emits one event per tool-call decision,
// and each append completes in single-digit ms, so the queue rarely passes
// single digits. Reaching 512 means disk I/O has stalled far behind the gate.
export const MAX_PENDING = 512

/**
 * Asynchronous JSONL audit sink. Telemetry must NEVER influence a permission
 * decision: `record()` only does cheap CPU work (redact + serialize) on the
 * caller's stack and then hands the serialized line to an internal drain, so
 * it returns without waiting for disk I/O (a synchronous appendFile measured
 * ~9 ms of blocking on Windows with Defender in play — ~25x the cost of the
 * whole gate evaluation it was blocking).
 *
 * Drain semantics:
 * - Serialized queue, one append at a time. Each append is chained onto a
 *   single tail promise and starts only after the previous one settles. This
 *   keeps event order on disk equal to emit order, and writing one whole
 *   line + '\n' per append means no interleaved or half-written lines.
 * - A failed append is caught per-item: it logs to console.error, the chain
 *   keeps draining, and the tail never rejects.
 *
 * Drop policy (bounded memory): when the queue is at `MAX_PENDING`, new
 * events are dropped (never blocking the caller) and counted. Once the queue
 * drains back below the cap, ONE synthetic `telemetry:dropped` event is
 * written reporting how many events were lost. Tradeoff, documented
 * deliberately: dropping is lossy, but an audit log with a *visible* gap is
 * still trustworthy, while an unbounded queue under a stalled disk is an OOM
 * waiting to happen inside the user's coding agent. Loss is never silent.
 *
 * There is no shutdown hook on the Pi extension bus (`events.on/emit` only),
 * and extensions must not register `process.on(...)` handlers, so the drain
 * cannot wait for pending writes at exit; `flush()` exists so tests (and any
 * future shutdown wiring) can await it explicitly.
 */
export class TelemetryLogger {
  private tail: Promise<void> = Promise.resolve()
  private pending = 0
  private dropped = 0

  constructor(
    private enabled: boolean,
    private path: string
  ) {}

  update(enabled: boolean, path: string): void {
    this.enabled = enabled
    this.path = path
  }

  /**
   * Non-blocking: redacts, serializes and enqueues. Never throws — a payload
   * that cannot be redacted (cyclic structure, throwing getter, ...) is
   * recorded with the literal payload '[REDACTED]' (fail-closed on secrets:
   * we never fall back to the raw value). The event itself is still written,
   * with `type` and `ts` intact, so the audit trail records that something
   * happened.
   */
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
    let line: string
    try {
      const ev: TelemetryEvent = {
        ts: new Date().toISOString(),
        type,
        payload: redact(payload),
      }
      line = `${JSON.stringify(ev)}\n`
    } catch {
      // redact() (or serialization) blew up — e.g. a cyclic payload causes
      // infinite recursion, a getter throws. Fail-closed: write the event
      // with an opaque payload instead of the raw structure.
      const ev: TelemetryEvent = {
        ts: new Date().toISOString(),
        type,
        payload: '[REDACTED]',
      }
      line = `${JSON.stringify(ev)}\n`
    }
    if (this.pending >= MAX_PENDING) {
      // Back-pressure: drop the NEW event instead of blocking the caller.
      // The loss is reported (once) by a synthetic telemetry:dropped event.
      this.dropped++
      return
    }
    this.enqueueAppend(target, line)
  }

  /**
   * Resolves when the queue is empty and the in-flight append has finished
   * (including any trailing telemetry:dropped notice). Safe to call
   * concurrently and safe to call with nothing pending. This is what tests
   * await before reading the log file, and what future shutdown wiring
   * should call.
   */
  async flush(): Promise<void> {
    for (;;) {
      const tail = this.tail
      await tail
      // A settled item may have chained the dropped-notice append onto a new
      // tail; keep looping until what we awaited is still the latest tail and
      // nothing is pending.
      if (this.tail === tail && this.pending === 0) return
    }
  }

  // Appends `line` after everything already enqueued. The chain never
  // rejects: append errors are caught per-item and logged. `pending` counts
  // queued + in-flight items so the cap and flush() see the real backlog.
  private enqueueAppend(target: string, line: string): void {
    this.pending++
    this.tail = this.tail
      .then(() => fsPromises.appendFile(target, line, 'utf8'))
      .catch((e: unknown) => {
        console.error('[telemetry] write failed:', e)
      })
      .then(() => {
        this.pending--
        if (this.dropped === 0) return
        // Queue is below the cap again (we just drained one): report the
        // loss once and reset the counter.
        const dropped = this.dropped
        this.dropped = 0
        const notice: TelemetryEvent = {
          ts: new Date().toISOString(),
          type: 'telemetry:dropped',
          payload: { dropped, reason: 'queue_full' },
        }
        this.enqueueAppend(target, `${JSON.stringify(notice)}\n`)
      })
  }

  subscribe(pi: ExtensionAPI): void {
    try {
      pi.events.on(BUS_CHANNEL_DECISION, (p: unknown) => {
        // Fire-and-forget for real now: record() is non-blocking and never
        // throws, so telemetry cannot affect the main flow.
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
