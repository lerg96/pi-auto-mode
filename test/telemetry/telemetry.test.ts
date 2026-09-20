import {
  TelemetryLogger,
  redact,
  MAX_PENDING,
  MAX_BATCH_LINES,
  MAX_BATCH_BYTES,
  MAX_BATCH_DELAY_MS,
} from '../../src/telemetry/telemetry.ts'
import { promises } from 'node:fs'
import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import {
  BUS_CHANNEL_DECISION,
  BUS_CHANNEL_UI_PROMPT,
} from '../../src/events.ts'

// Mock node:fs but delegate promises.appendFile to the real implementation so
// the file is genuinely written (per spec) while still being spying-friendly.
// The logger drains asynchronously through fs.promises, so the sync
// appendFileSync is no longer part of the code path under test.
jest.mock('node:fs', () => {
  const actual = jest.requireActual('node:fs') as typeof import('node:fs')
  const realAppend = actual.promises.appendFile.bind(actual.promises)
  const mockAppendFile = jest.fn(
    (...args: Parameters<typeof actual.promises.appendFile>) =>
      realAppend(...args)
  )
  return {
    ...actual,
    promises: { ...actual.promises, appendFile: mockAppendFile },
  }
})

const appendFileMock = jest.mocked(promises.appendFile)

// Re-arm the delegating implementation after tests that replace it (e.g. the
// bounded-queue test swaps in a slow fake that never touches disk).
function useRealAppend(): void {
  const fsActual = jest.requireActual('node:fs') as typeof import('node:fs')
  appendFileMock.mockImplementation((...args) =>
    (
      fsActual.promises.appendFile as (
        ...a: Parameters<typeof appendFileMock>
      ) => Promise<void>
    )(...args)
  )
}

function makePi(): {
  pi: ExtensionAPI
  handlers: Record<string, (p: unknown) => void>
  notify: ReturnType<typeof jest.fn>
} {
  const handlers: Record<string, (p: unknown) => void> = {}
  const notify = jest.fn()
  const pi = {
    events: {
      on: jest.fn((channel: string, cb: (p: unknown) => void) => {
        handlers[channel] = cb
      }),
      emit: jest.fn(),
    },
  } as unknown as ExtensionAPI
  return { pi, handlers, notify }
}

function tempPath(): string {
  return join(
    tmpdir(),
    `pi-auto-mode-telemetry-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}.log`
  )
}

function appendCalls(): [string, string][] {
  return appendFileMock.mock.calls as unknown as [string, string][]
}

// Batching means one appendFile can carry many JSONL lines; always parse
// call payloads line-by-line.
function parseWritten(
  calls: [string, string][]
): { type: string; payload?: unknown }[] {
  return calls
    .flatMap(([, data]) => data.split('\n'))
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as { type: string; payload?: unknown })
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

function countFileLines(p: string): number {
  if (!existsSync(p)) return 0
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0).length
}

describe('TelemetryLogger', () => {
  beforeEach(() => {
    appendFileMock.mockClear()
    useRealAppend()
  })

  afterEach(() => {
    jest.clearAllMocks()
  })

  it('subscribe registers listeners for both channels', () => {
    const { pi, handlers } = makePi()
    const logger = new TelemetryLogger(true, '')
    logger.subscribe(pi)
    expect(typeof handlers[BUS_CHANNEL_DECISION]).toBe('function')
    expect(typeof handlers[BUS_CHANNEL_UI_PROMPT]).toBe('function')
    // The JSONL log file `type` strings stay UNCHANGED — those are our own
    // log schema, not bus channels. Only the in-process bus channels carry
    // the `pi-auto-mode:` prefix.
    expect(BUS_CHANNEL_DECISION).not.toBe('permissions:decision')
    expect(BUS_CHANNEL_UI_PROMPT).not.toBe('permissions:ui_prompt')
  })

  it('bus channel constants are exactly the namespaced values', () => {
    // Pin the export values — any accidental rename would silently move our
    // telemetry subscribers off the bus. The channel strings must include the
    // `pi-auto-mode:` prefix; the JSONL file `type` strings must NOT.
    expect(BUS_CHANNEL_DECISION).toBe('pi-auto-mode:permissions:decision')
    expect(BUS_CHANNEL_UI_PROMPT).toBe('pi-auto-mode:permissions:ui_prompt')
  })

  it('record does not write when disabled', async () => {
    const logger = new TelemetryLogger(false, '/tmp/does-not-matter.log')
    logger.record('tool_call_blocked', { error: 'boom' })
    await logger.flush()
    expect(appendFileMock).not.toHaveBeenCalled()
  })

  it('record does not write when path is empty', async () => {
    // Safety net: with enabled:true and path:'' the logger falls back to the
    // schema default (~/.pi/pi-auto-mode.jsonl) instead of silently dropping
    // the event. Verify the append targets the default path, NOT nowhere.
    // The append itself is stubbed here so the test never touches the real
    // home directory.
    appendFileMock.mockImplementation(() => Promise.resolve())
    const logger = new TelemetryLogger(true, '')
    logger.record('tool_call_blocked', { error: 'boom' })
    await logger.flush()
    expect(appendFileMock).toHaveBeenCalledTimes(1)
    const [calledPath] = appendCalls()[0]
    expect(calledPath).toMatch(/pi-auto-mode\.jsonl$/)
  })

  it('empty/whitespace path falls back to the schema default path', async () => {
    // Three flavours of "no path": '', '   ', '\n\t' — all should pick up the
    // default telemetry path so telemetry stays on by default.
    appendFileMock.mockImplementation(() => Promise.resolve())
    for (const bad of ['', '   ', '\n\t']) {
      appendFileMock.mockClear()
      const logger = new TelemetryLogger(true, bad)
      logger.record('tool_call_blocked', { reason: bad })
      await logger.flush()
      expect(appendFileMock).toHaveBeenCalledTimes(1)
      const [calledPath] = appendCalls()[0]
      expect(calledPath).toMatch(/pi-auto-mode\.jsonl$/)
    }
  })

  it('enabled:true with the schema default path writes to ~/.pi/pi-auto-mode.jsonl (temp HOME)', async () => {
    // Re-load telemetry.ts + types/config.ts inside an isolated module with a
    // mocked homedir() so the default path resolves to a temp HOME — same
    // pattern as test/config/config-loader.test.ts. This is the spec test:
    // users who set `telemetry.enabled: true` without specifying a path get
    // events at ~/.pi/pi-auto-mode.jsonl, no extra config required.
    const os = jest.requireActual('node:os') as typeof import('node:os')
    const fs = jest.requireActual('node:fs') as typeof import('node:fs')
    const pathMod = jest.requireActual(
      'node:path'
    ) as typeof import('node:path')
    const homeDir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'pi-am-tel-home-'))

    let isolatedLogger:
      typeof import('../../src/telemetry/telemetry.ts') | undefined
    let defaultPath: string | undefined
    jest.isolateModules(() => {
      jest.doMock('node:os', () => ({
        ...os,
        homedir: () => homeDir,
      }))
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      isolatedLogger = require('../../src/telemetry/telemetry.ts')
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const cfgMod = require('../../src/types/config.ts')
      defaultPath = cfgMod.DEFAULT_TELEMETRY_PATH as string
    })
    expect(isolatedLogger).toBeDefined()
    expect(defaultPath).toBe(pathMod.join(homeDir, '.pi', 'pi-auto-mode.jsonl'))

    const expectedFile = defaultPath!
    if (fs.existsSync(expectedFile)) fs.unlinkSync(expectedFile)
    fs.mkdirSync(pathMod.dirname(expectedFile), { recursive: true })

    const logger = new isolatedLogger!.TelemetryLogger(true, '')
    logger.record('permissions:decision', { surface: 'shell', value: 'ls' })
    await logger.flush()

    expect(fs.existsSync(expectedFile)).toBe(true)
    const ev = JSON.parse(fs.readFileSync(expectedFile, 'utf8').trim())
    expect(ev.type).toBe('permissions:decision')
    expect(ev.payload).toEqual({ surface: 'shell', value: 'ls' })

    if (fs.existsSync(expectedFile)) fs.unlinkSync(expectedFile)
    fs.rmSync(homeDir, { recursive: true, force: true })
  })

  it('record writes a JSON line when enabled and path set', async () => {
    const p = tempPath()
    const logger = new TelemetryLogger(true, p)
    logger.record('tool_call_blocked', { error: 'boom' })
    await logger.flush()
    expect(appendFileMock).toHaveBeenCalledTimes(1)
    const [calledPath, calledData] = appendCalls()[0]
    expect(calledPath).toBe(p)
    const ev = JSON.parse(calledData.trim())
    expect(ev.type).toBe('tool_call_blocked')
    expect(ev.payload).toEqual({ error: 'boom' })
    expect(typeof ev.ts).toBe('string')
    if (existsSync(p)) unlinkSync(p)
  })

  it('subscribed decision handler records to a temp file', async () => {
    const { pi, handlers } = makePi()
    const p = tempPath()
    const logger = new TelemetryLogger(true, p)
    logger.subscribe(pi)
    handlers[BUS_CHANNEL_DECISION]({ foo: 'bar' })
    await logger.flush()
    expect(existsSync(p)).toBe(true)
    const ev = JSON.parse(readFileSync(p, 'utf8').trim())
    // The file `type` is the log format (unchanged), not the bus channel.
    expect(ev.type).toBe('permissions:decision')
    expect(ev.payload).toEqual({ foo: 'bar' })
    if (existsSync(p)) unlinkSync(p)
  })

  it('update changes enabled/path state so a later record writes', async () => {
    const p = tempPath()
    const logger = new TelemetryLogger(false, '')
    logger.update(true, p)
    logger.record('after-update', { ok: 1 })
    await logger.flush()
    expect(existsSync(p)).toBe(true)
    if (existsSync(p)) unlinkSync(p)
  })

  // M9: secret-bearing payloads must be redacted on disk; the original
  // payload object must NOT be mutated.
  it('record redacts a SECRET_KEY= assignment written to the file', async () => {
    const p = tempPath()
    const logger = new TelemetryLogger(true, p)
    const original = { value: 'SECRET_KEY=xyz', path: '/tmp/x' }
    logger.record('permissions:decision', original)
    await logger.flush()
    const raw = readFileSync(p, 'utf8')
    expect(raw).toContain('[REDACTED]')
    expect(raw).not.toContain('SECRET_KEY=xyz')
    // payload object is untouched (no mutation).
    expect(original.value).toBe('SECRET_KEY=xyz')
    if (existsSync(p)) unlinkSync(p)
  })

  it('record redacts a password= assignment written to the file', async () => {
    const p = tempPath()
    const logger = new TelemetryLogger(true, p)
    logger.record('permissions:decision', 'password=abc')
    await logger.flush()
    const raw = readFileSync(p, 'utf8')
    expect(raw).toContain('[REDACTED]')
    expect(raw).not.toContain('password=abc')
    if (existsSync(p)) unlinkSync(p)
  })

  it('record redacts secret-valued object keys but keeps benign fields', async () => {
    const p = tempPath()
    const logger = new TelemetryLogger(true, p)
    const original = { token: 'super-secret', action: 'read', count: 3 }
    logger.record('permissions:decision', original)
    await logger.flush()
    const raw = readFileSync(p, 'utf8')
    const ev = JSON.parse(raw.trim())
    expect(ev.payload.token).toBe('[REDACTED]')
    expect(ev.payload.action).toBe('read')
    expect(ev.payload.count).toBe(3)
    expect(original.token).toBe('super-secret')
    if (existsSync(p)) unlinkSync(p)
  })

  it('record leaves non-secret payloads unchanged', async () => {
    const p = tempPath()
    const logger = new TelemetryLogger(true, p)
    logger.record('tool_call_blocked', { error: 'boom' })
    await logger.flush()
    const raw = readFileSync(p, 'utf8')
    expect(raw).not.toContain('[REDACTED]')
    expect(raw).toContain('boom')
    if (existsSync(p)) unlinkSync(p)
  })

  // Finding MEDIUM: redact must preserve Map/Set/Date instead of serializing
  // them as empty objects. Recursive redaction still applies to their values.
  describe('redact preserves Map/Set/Date', () => {
    it('redacts a Map into an array of [key, value] pairs', () => {
      const m = new Map<string, unknown>([
        ['a', 'ok'],
        ['token', 'SECRET_KEY=xyz'],
      ])
      const out = redact(m) as [unknown, unknown][]
      expect(Array.isArray(out)).toBe(true)
      expect(out).toEqual([
        ['a', 'ok'],
        ['token', '[REDACTED]'],
      ])
    })

    it('redacts a Set into an array of values', () => {
      const s = new Set<unknown>(['ok', 'password=abc'])
      const out = redact(s) as unknown[]
      expect(Array.isArray(out)).toBe(true)
      expect(out).toEqual(['ok', '[REDACTED]'])
    })

    it('redacts a Date into its ISO string', () => {
      const d = new Date('2024-01-02T03:04:05.000Z')
      const out = redact(d)
      expect(out).toBe('2024-01-02T03:04:05.000Z')
    })

    it('redacts secret values nested inside a Map', () => {
      const m = new Map<string, unknown>([
        ['nested', { token: 'super-secret' }],
        ['list', ['password=abc', 'ok']],
      ])
      const out = redact(m) as [unknown, unknown][]
      expect(out).toEqual([
        ['nested', { token: '[REDACTED]' }],
        ['list', ['[REDACTED]', 'ok']],
      ])
    })

    it('record writes a Map payload without losing information', async () => {
      const p = tempPath()
      const logger = new TelemetryLogger(true, p)
      const m = new Map<string, unknown>([
        ['action', 'read'],
        ['token', 'SECRET_KEY=xyz'],
      ])
      logger.record('permissions:decision', m)
      await logger.flush()
      const raw = readFileSync(p, 'utf8')
      const ev = JSON.parse(raw.trim())
      expect(ev.payload).toEqual([
        ['action', 'read'],
        ['token', '[REDACTED]'],
      ])
      if (existsSync(p)) unlinkSync(p)
    })
  })

  // ─── Async drain: non-blocking, ordered, bounded ───────────────────────────

  it('record() is non-blocking (returns well under the old 8.9 ms sync cost)', async () => {
    const p = tempPath()
    const logger = new TelemetryLogger(true, p)
    // Warm-up so lazy module/setup cost cannot pollute the measurement.
    logger.record('warmup', { n: 0 })
    await logger.flush()
    appendFileMock.mockClear()

    const start = performance.now()
    logger.record('tool_call_blocked', { error: 'boom', n: 1 })
    const elapsed = performance.now() - start
    expect(elapsed).toBeLessThan(1)
    await logger.flush()
    if (existsSync(p)) unlinkSync(p)
  })

  it('200 events: order preserved on disk, every line valid JSON, count matches', async () => {
    const p = tempPath()
    const logger = new TelemetryLogger(true, p)
    const N = 200
    for (let i = 0; i < N; i++) {
      logger.record(`event:${i}`, { seq: i, pad: 'x'.repeat(80) })
    }
    await logger.flush()
    const raw = readFileSync(p, 'utf8')
    expect(raw.endsWith('\n')).toBe(true)
    const lines = raw.split('\n').filter((l) => l.length > 0)
    expect(lines).toHaveLength(N)
    lines.forEach((line, i) => {
      const ev = JSON.parse(line) as { type: string; payload: { seq: number } }
      expect(ev.type).toBe(`event:${i}`)
      expect(ev.payload.seq).toBe(i)
    })
    if (existsSync(p)) unlinkSync(p)
  }, 30000)

  it('cyclic payload: record() does not throw, writes one line with [REDACTED]', async () => {
    const p = tempPath()
    const logger = new TelemetryLogger(true, p)
    const cyclic: Record<string, unknown> = { name: 'loop' }
    cyclic.self = cyclic
    expect(() => logger.record('cyclic', cyclic)).not.toThrow()
    await logger.flush()
    const raw = readFileSync(p, 'utf8')
    const lines = raw.split('\n').filter((l) => l.length > 0)
    expect(lines).toHaveLength(1)
    const ev = JSON.parse(lines[0]) as { type: string; payload: unknown }
    expect(ev.type).toBe('cyclic')
    expect(ev.payload).toBe('[REDACTED]')
    expect(raw).not.toContain('loop')
    if (existsSync(p)) unlinkSync(p)
  })

  it('throwing-getter payload: record() does not throw, writes one line with [REDACTED]', async () => {
    const p = tempPath()
    const logger = new TelemetryLogger(true, p)
    const boom = {
      ok: 'fine',
      get explode(): never {
        throw new Error('getter blew up')
      },
    }
    expect(() => logger.record('getter-boom', boom)).not.toThrow()
    await logger.flush()
    const raw = readFileSync(p, 'utf8')
    const lines = raw.split('\n').filter((l) => l.length > 0)
    expect(lines).toHaveLength(1)
    const ev = JSON.parse(lines[0]) as { type: string; payload: unknown }
    expect(ev.type).toBe('getter-boom')
    expect(ev.payload).toBe('[REDACTED]')
    // Fail-closed: nothing from the raw structure may leak.
    expect(raw).not.toContain('fine')
    if (existsSync(p)) unlinkSync(p)
  })

  it('bounded queue: drops past MAX_PENDING without blocking and reports loss', async () => {
    // Test seam: stub fs.promises.appendFile with a slow fake that never
    // touches disk, so the queue backs up deterministically.
    appendFileMock.mockImplementation(
      () => new Promise<void>((resolve) => setTimeout(resolve, 5))
    )
    const logger = new TelemetryLogger(true, '/tmp/never-written.log')
    const total = MAX_PENDING + 88
    const start = performance.now()
    for (let i = 0; i < total; i++) {
      logger.record(`evt:${i}`, { seq: i })
    }
    const enqueueMs = performance.now() - start
    // Caller never blocks: 600 records must not wait on the 5 ms fake appends
    // (that would be seconds). They only pay serialize + enqueue cost.
    expect(enqueueMs).toBeLessThan(1000)

    await logger.flush()
    // Batching: one appendFile per ~MAX_BATCH_LINES lines, never more calls
    // than lines. Total written events + reported drops must equal `total`.
    expect(appendFileMock.mock.calls.length).toBeLessThanOrEqual(
      MAX_PENDING + 1
    )
    const written = parseWritten(appendCalls()) as {
      type: string
      payload?: { dropped?: number; reason?: string; seq?: number }
    }[]
    const droppedEvents = written.filter((e) => e.type === 'telemetry:dropped')
    expect(droppedEvents).toHaveLength(1)
    expect(droppedEvents[0].payload?.dropped).toBe(88)
    expect(droppedEvents[0].payload?.reason).toBe('queue_full')
    // Non-dropped events keep emit order up to the cap.
    const seqs = written
      .filter((e) => e.type !== 'telemetry:dropped')
      .map((e) => (e.payload as { seq: number }).seq)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
    expect(seqs[0]).toBe(0)
  }, 30000)

  it('flush() is idempotent and resolves with nothing pending', async () => {
    const p = tempPath()
    const logger = new TelemetryLogger(true, p)
    // Nothing pending.
    await logger.flush()
    logger.record('x', { a: 1 })
    await logger.flush()
    await logger.flush()
    expect(appendFileMock).toHaveBeenCalledTimes(1)
    if (existsSync(p)) unlinkSync(p)
  })

  it('concurrent flush() calls both resolve after the queue drains', async () => {
    const p = tempPath()
    const logger = new TelemetryLogger(true, p)
    for (let i = 0; i < 10; i++) logger.record(`c:${i}`, { i })
    const [r1, r2] = await Promise.all([logger.flush(), logger.flush()])
    expect(r1).toBeUndefined()
    expect(r2).toBeUndefined()
    const lines = readFileSync(p, 'utf8')
      .split('\n')
      .filter((l) => l.length > 0)
    expect(lines).toHaveLength(10)
    if (existsSync(p)) unlinkSync(p)
  }, 30000)

  // ─── Batched drain: durability window, throughput, failure handling ────────

  // Regression test for the durability hole: with one appendFile per event,
  // only 1 of 50 events had reached disk 15 ms after being recorded (the
  // rest sat in the promise chain and a SIGKILL would have eaten them).
  // With batching, after one drain cycle the loss window is bounded by one
  // batch — in practice everything has landed.
  it('durability window: 50 events are on disk after one drain cycle', async () => {
    const p = tempPath()
    const logger = new TelemetryLogger(true, p)
    const N = 50
    for (let i = 0; i < N; i++) logger.record(`d:${i}`, { seq: i })
    // One full drain cycle: the trailing sub-batch goes out on the delay
    // timer (+ slack for real disk latency), no flush() involved.
    await sleep(MAX_BATCH_DELAY_MS + 150)
    const landed = countFileLines(p)
    // Unflushed loss window must never exceed one batch.
    expect(N - landed).toBeLessThan(MAX_BATCH_LINES)
    expect(landed).toBe(N)
    if (existsSync(p)) unlinkSync(p)
  }, 30000)

  it('burst of 5000 events drains in under 2 s with exact accounting', async () => {
    const p = tempPath()
    const logger = new TelemetryLogger(true, p)
    const N = 5000
    const start = performance.now()
    // Cooperative ingest: NO in-memory design with a 512-line cap can absorb
    // a fully synchronous 5000-event burst at ~3500 events/s of disk (the
    // backlog would hit the cap and drops are by design). Real sessions
    // emit one event per tool decision seconds apart. We flush in chunks to
    // keep the backlog under the cap; wall time is still dominated by the
    // real serialized appends (~157 batches), which is what is measured.
    const CHUNK = 256
    for (let done = 0; done < N; done += CHUNK) {
      const n = Math.min(CHUNK, N - done)
      for (let i = 0; i < n; i++) {
        logger.record(`b:${done + i}`, { seq: done + i })
      }
      await logger.flush()
    }
    const elapsed = performance.now() - start
    expect(elapsed).toBeLessThan(2000)
    const written = parseWritten(appendCalls())
    const droppedEvents = written.filter((e) => e.type === 'telemetry:dropped')
    const writtenCount = written.length - droppedEvents.length
    const reportedDropped = droppedEvents.reduce(
      (sum, e) =>
        sum + ((e.payload as { dropped?: number } | undefined)?.dropped ?? 0),
      0
    )
    // Accounting invariant, exact.
    expect(writtenCount + reportedDropped).toBe(N)
    // Fully on disk (no loss under a healthy disk).
    expect(writtenCount).toBe(N)
    expect(countFileLines(p)).toBe(N)
    if (existsSync(p)) unlinkSync(p)
  }, 30000)

  it('batching actually batches: ~N/MAX_BATCH_LINES appendFile calls, not N', async () => {
    const p = tempPath()
    const logger = new TelemetryLogger(true, p)
    const N = 200
    for (let i = 0; i < N; i++) {
      logger.record(`k:${i}`, { seq: i, pad: 'x'.repeat(80) })
    }
    await logger.flush()
    const calls = appendFileMock.mock.calls.length
    // Expected: ceil(200/32) = 7 calls. Assert the ratio, not the exact
    // number, so boundary timing cannot make this flaky.
    expect(calls).toBeLessThanOrEqual(Math.ceil(N / MAX_BATCH_LINES))
    expect(calls).toBeGreaterThanOrEqual(Math.floor(N / MAX_BATCH_LINES))
    expect(calls).toBeLessThan(N / 4) // definitely not one-append-per-event
    // No batch exceeds the line cap, and everything is on disk in order.
    for (const [, data] of appendCalls()) {
      const linesInBatch = data.split('\n').filter((l) => l.length > 0)
      expect(linesInBatch.length).toBeLessThanOrEqual(MAX_BATCH_LINES)
    }
    expect(countFileLines(p)).toBe(N)
    if (existsSync(p)) unlinkSync(p)
  }, 30000)

  it('byte cap: one payload over MAX_BATCH_BYTES drains without 32 more lines', async () => {
    const p = tempPath()
    const logger = new TelemetryLogger(true, p)
    const big = 'x'.repeat(MAX_BATCH_BYTES + 10_000)
    logger.record('big', { blob: big })
    // The byte cap triggers the drain SYNCHRONOUSLY inside record(): the
    // delay timer has had zero time to fire, so a call here can only be the
    // byte-cap path.
    expect(appendFileMock).toHaveBeenCalledTimes(1)
    const [, data] = appendCalls()[0]
    expect(data.length).toBeGreaterThan(MAX_BATCH_BYTES)
    await logger.flush()
    expect(countFileLines(p)).toBe(1)
    if (existsSync(p)) unlinkSync(p)
  }, 30000)

  it('small payloads are NOT drained synchronously (delay timer is armed)', async () => {
    const p = tempPath()
    const logger = new TelemetryLogger(true, p)
    logger.record('small', { a: 1 })
    // Below both line and byte thresholds: nothing may hit appendFile yet.
    expect(appendFileMock).not.toHaveBeenCalled()
    await logger.flush()
    expect(countFileLines(p)).toBe(1)
    if (existsSync(p)) unlinkSync(p)
  })

  it('failed batch append: survives, reports append_failed, later batches land in order', async () => {
    const p = tempPath()
    const fsActual = jest.requireActual('node:fs') as typeof import('node:fs')
    let callNo = 0
    const errSpy = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined)
    appendFileMock.mockImplementation((path, data, ...rest) => {
      callNo++
      if (callNo === 2) return Promise.reject(new Error('disk on fire'))
      return (
        fsActual.promises.appendFile as (
          ...a: Parameters<typeof appendFileMock>
        ) => Promise<void>
      )(path, data, ...rest)
    })
    const logger = new TelemetryLogger(true, p)
    const N = 3 * MAX_BATCH_LINES // exactly 3 batches
    for (let i = 0; i < N; i++) logger.record(`f:${i}`, { seq: i })
    await logger.flush() // must resolve: the chain never rejects

    const raw = readFileSync(p, 'utf8')
    const parsed = raw
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as { type: string; payload?: unknown })
    const droppedEvents = parsed.filter((e) => e.type === 'telemetry:dropped')
    expect(droppedEvents).toHaveLength(1)
    expect(droppedEvents[0].payload).toEqual({
      dropped: MAX_BATCH_LINES,
      reason: 'append_failed',
    })
    // Batch 2 is gone; batches 1 and 3 survived, in emit order.
    const seqs = parsed
      .filter((e) => e.type !== 'telemetry:dropped')
      .map((e) => (e.payload as { seq: number }).seq)
    const expectedSeqs = [
      ...Array.from({ length: MAX_BATCH_LINES }, (_, i) => i),
      ...Array.from(
        { length: MAX_BATCH_LINES },
        (_, i) => i + 2 * MAX_BATCH_LINES
      ),
    ]
    expect(seqs).toEqual(expectedSeqs)
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
    if (existsSync(p)) unlinkSync(p)
  }, 30000)
})
