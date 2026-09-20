import { promises as fsPromises } from 'node:fs'
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

// Cap on how many events may be waiting for the drain (buffered + in-flight).
// Chosen generously: a normal session emits one event per tool-call decision,
// and each batched append completes in single-digit ms, so the queue rarely
// passes single digits. Reaching 512 means disk I/O has stalled far behind
// the gate.
export const MAX_PENDING = 512

// Batching thresholds. One appendFile per event capped throughput at the
// per-append latency (~9-27 ms with Defender, essentially FIXED regardless
// of payload size — a single-line append measured slower than a 3.5KB one),
// i.e. ~110 events/s: a 50-event burst left 49 events sitting in memory
// 15 ms after being recorded. Coalescing up to MAX_BATCH_LINES per append
// multiplies throughput by the batch factor while keeping the loss window
// (on SIGKILL) at a single batch instead of the whole backlog. 64 chosen
// over 32 because 5000/32 appends cannot physically finish in the 2s burst
// budget at measured per-append latency; 64 lines ≈ typical decision-event
// size stays far under the byte cap, and under a healthy trickle the batch
// drains on the 25 ms timer with a handful of lines, not 64.
export const MAX_BATCH_LINES = 64
// ~128 KB. Uses the UTF-16 string length as the byte proxy; good enough for
// bounding one append's payload (never a correctness property).
export const MAX_BATCH_BYTES = 128 * 1024
// Max time a line may wait in the buffer before it is appended, so a trickle
// of events is not held until the batch fills. MUST stay short: this is an
// audit log, every ms of delay is a ms of loss window.
export const MAX_BATCH_DELAY_MS = 25

interface PendingLine {
  target: string
  line: string
  // True for synthetic telemetry:dropped notices (see finishBatch).
  isNotice: boolean
}

/**
 * Asynchronous JSONL audit sink. Telemetry must NEVER influence a permission
 * decision: `record()` only does cheap CPU work (redact + serialize) on the
 * caller's stack and then hands the serialized line to an internal drain, so
 * it returns without waiting for disk I/O (a synchronous appendFile measured
 * ~9 ms of blocking on Windows with Defender in play — ~25x the cost of the
 * whole gate evaluation it was blocking).
 *
 * Drain semantics (batched, single writer):
 * - Serialized lines are coalesced in an in-memory buffer and appended with
 *   ONE appendFile per batch — never two appends in flight at once. When the
 *   in-flight append settles and the buffer is non-empty, the next batch
 *   starts. Single writer + whole lines per batch keeps event order on disk
 *   equal to emit order, with no interleaved or half-written lines.
 * - A batch is drained when it reaches MAX_BATCH_LINES, when it reaches
 *   MAX_BATCH_BYTES (a single huge payload must not wait for more lines),
 *   when MAX_BATCH_DELAY_MS elapsed since the buffer became non-empty, or on
 *   flush().
 * - A failed append is caught per-batch: it logs to console.error, its lines
 *   are counted and reported through the telemetry:dropped mechanism with
 *   reason 'append_failed', and draining continues. A failed batch is NOT
 *   retried — retrying could reorder it against later successful batches.
 *   The internal chain never rejects.
 *
 * Drop policy (bounded memory): when buffered + in-flight events reach
 * `MAX_PENDING`, new events are dropped (never blocking the caller) and
 * counted. Once there is room again, ONE synthetic `telemetry:dropped`
 * event per reason is written reporting how many events were lost. Tradeoff,
 * documented deliberately: dropping is lossy, but an audit log with a
 * *visible* gap is still trustworthy, while an unbounded queue under a
 * stalled disk is an OOM waiting to happen inside the user's coding agent.
 * Loss is never silent. Accounting invariant: lines written + lines reported
 * dropped == events recorded.
 *
 * There is no shutdown hook on the Pi extension bus (`events.on/emit` only),
 * and extensions must not register `process.on(...)` handlers, so the drain
 * cannot wait for pending writes at exit; `flush()` exists so tests (and any
 * future shutdown wiring) can await it explicitly.
 */
export class TelemetryLogger {
  private buffer: PendingLine[] = []
  private bufferBytes = 0
  // Single-writer invariant: at most one appendFile ever. Non-null while a
  // batch is in flight; the settle handler is the only place that may start
  // the next one.
  private inFlight: Promise<void> | null = null
  private inFlightLines = 0
  // Target of the last batch that started draining; telemetry:dropped
  // notices belong with that stream, not with a path update() may have
  // changed mid-flight.
  private lastTarget: string | null = null
  private droppedQueueFull = 0
  private droppedAppendFailed = 0
  private timer: ReturnType<typeof setTimeout> | null = null

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
    const target = this.resolveTarget()
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
    if (this.buffer.length + this.inFlightLines >= MAX_PENDING) {
      // Back-pressure: drop the NEW event instead of blocking the caller.
      // The loss is reported (once) by a synthetic telemetry:dropped event.
      this.droppedQueueFull++
      return
    }
    this.buffer.push({ target, line, isNotice: false })
    this.bufferBytes += line.length
    if (
      this.buffer.length >= MAX_BATCH_LINES ||
      this.bufferBytes >= MAX_BATCH_BYTES
    ) {
      // Threshold reached: drain now (startDrain clears the timer).
      this.startDrain()
    } else if (this.timer === null) {
      // The delay counts from when the buffer became non-empty, so a steady
      // trickle is never postponed indefinitely by later arrivals.
      this.armTimer()
    }
  }

  // Safety net for callers that bypass the schema (e.g. an in-memory Config
  // assembled by tests): an empty/whitespace path falls back to the same
  // default the schema applies, so `enabled: true` always has somewhere to
  // write. Same trim semantics as the zod transform.
  private resolveTarget(): string {
    return this.path && this.path.trim().length > 0
      ? this.path
      : DEFAULT_TELEMETRY_PATH
  }

  private armTimer(): void {
    const t = setTimeout(() => {
      if (this.timer === t) this.timer = null
      this.startDrain()
    }, MAX_BATCH_DELAY_MS)
    // NON-NEGOTIABLE: this extension must never keep the host process alive.
    // A plain setTimeout would hold Node open for up to MAX_BATCH_DELAY_MS
    // after the last event (and keep jest's event loop busy); unref() makes
    // the delay a convenience, not a lease on the process.
    t.unref()
    this.timer = t
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  /**
   * Resolves when the buffer is empty and the in-flight append has finished
   * (including any trailing telemetry:dropped notices). Ignores the batch
   * thresholds — whatever is buffered goes out immediately. Safe to call
   * concurrently, safe with nothing pending, safe to call twice, and leaves
   * no timer behind. This is what tests await before reading the log file,
   * and what future shutdown wiring should call.
   */
  async flush(): Promise<void> {
    for (;;) {
      this.clearTimer()
      this.startDrain()
      const f = this.inFlight
      // Invariant maintained by finishBatch/startDrain: when the writer is
      // idle there is nothing buffered, nothing dropped-to-be-reported and
      // no batch in flight, so a null inFlight here means fully drained.
      if (f === null) return
      // A settled batch may have started the next one (or a dropped-notice
      // append) synchronously inside its continuation; loop until the latest
      // in-flight append has finished and nothing follows it.
      await f
    }
  }

  // Starts the next batched append if the writer is idle. Never rejects:
  // append errors are caught and routed through finishBatch. Takes at least
  // one line (even a single line bigger than MAX_BATCH_BYTES) so a huge
  // payload cannot stall the drain, and never crosses a target boundary —
  // one appendFile, one path (per-event targets survive an update()
  // happening mid-flight).
  private startDrain(): void {
    if (this.inFlight !== null) return // single writer; its settle resumes
    this.clearTimer()
    this.emitDroppedNotices()
    if (this.buffer.length === 0) return

    const target = this.buffer[0].target
    const isNotice = this.buffer[0].isNotice
    let count = 0
    let bytes = 0
    while (
      count < this.buffer.length &&
      this.buffer[count].target === target &&
      count < MAX_BATCH_LINES &&
      (count === 0 || bytes + this.buffer[count].line.length <= MAX_BATCH_BYTES)
    ) {
      bytes += this.buffer[count].line.length
      count++
    }
    const batch = this.buffer.splice(0, count)
    this.bufferBytes -= bytes
    const data = batch.map((b) => b.line).join('') // join once per batch, never per push
    this.lastTarget = target
    this.inFlightLines = count
    this.inFlight = fsPromises.appendFile(target, data, 'utf8').then(
      () => {
        try {
          this.finishBatch(false, isNotice)
        } catch (e) {
          console.error('[telemetry] drain bookkeeping failed:', e)
        }
      },
      (e: unknown) => {
        console.error('[telemetry] batch append failed:', e)
        try {
          this.finishBatch(true, isNotice)
        } catch (e2) {
          console.error('[telemetry] drain bookkeeping failed:', e2)
        }
      }
    )
  }

  // Runs after the in-flight batch settles (success or failure), then keeps
  // the drain going. `failed` lines are counted and reported as dropped;
  // the batch is deliberately NOT retried — retrying could reorder it
  // against later batches that already succeeded. Ordering of surviving
  // lines is preserved because the writer is serialized.
  private finishBatch(failed: boolean, isNotice: boolean): void {
    this.inFlight = null
    const lost = this.inFlightLines
    this.inFlightLines = 0
    if (failed && !isNotice) {
      this.droppedAppendFailed += lost
    }
    // If the failed batch WAS a telemetry:dropped notice, swallow it: its
    // loss is already a reported gap, and re-reporting could loop forever
    // (notice fails -> new notice -> fails -> ...) on a broken disk.
    this.emitDroppedNotices()
    this.startDrain()
  }

  // Queues one synthetic telemetry:dropped line per pending reason (resetting
  // the counters), but only while there is room under MAX_PENDING — the
  // notice is a line like any other and must not sneak past the cap. Loss is
  // never silent.
  private emitDroppedNotices(): void {
    if (this.droppedQueueFull === 0 && this.droppedAppendFailed === 0) return
    if (this.buffer.length + this.inFlightLines >= MAX_PENDING) return
    const target = this.lastTarget ?? this.resolveTarget()
    if (this.droppedQueueFull > 0) {
      const dropped = this.droppedQueueFull
      this.droppedQueueFull = 0
      this.pushNotice(target, dropped, 'queue_full')
    }
    if (this.droppedAppendFailed > 0) {
      const dropped = this.droppedAppendFailed
      this.droppedAppendFailed = 0
      this.pushNotice(target, dropped, 'append_failed')
    }
  }

  private pushNotice(target: string, dropped: number, reason: string): void {
    const notice: TelemetryEvent = {
      ts: new Date().toISOString(),
      type: 'telemetry:dropped',
      payload: { dropped, reason },
    }
    const line = `${JSON.stringify(notice)}\n`
    this.buffer.push({ target, line, isNotice: true })
    this.bufferBytes += line.length
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
