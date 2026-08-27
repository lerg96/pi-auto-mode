import { TelemetryLogger, redact } from '../../src/telemetry/telemetry.ts'
import { appendFileSync } from 'node:fs'
import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import {
  BUS_CHANNEL_DECISION,
  BUS_CHANNEL_UI_PROMPT,
} from '../../src/events.ts'

// Mock node:fs but delegate appendFileSync to the real implementation so the
// file is genuinely written (per spec) while still being spying-friendly.
jest.mock('node:fs', () => {
  const actual = jest.requireActual('node:fs') as typeof import('node:fs')
  const realAppend = actual.appendFileSync
  const mockAppend = jest.fn((...args: Parameters<typeof realAppend>) =>
    realAppend(...args)
  )
  return { ...actual, appendFileSync: mockAppend }
})

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

describe('TelemetryLogger', () => {
  beforeEach(() => {
    jest.mocked(appendFileSync).mockClear()
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

  it('record does not write when disabled', () => {
    const logger = new TelemetryLogger(false, '/tmp/does-not-matter.log')
    logger.record('tool_call_blocked', { error: 'boom' })
    expect(appendFileSync).not.toHaveBeenCalled()
  })

  it('record does not write when path is empty', () => {
    // Safety net: with enabled:true and path:'' the logger falls back to the
    // schema default (~/.pi/pi-auto-mode.jsonl) instead of silently dropping
    // the event. Verify the call goes to the default path, NOT nowhere.
    const logger = new TelemetryLogger(true, '')
    logger.record('tool_call_blocked', { error: 'boom' })
    expect(appendFileSync).toHaveBeenCalledTimes(1)
    const [calledPath] = jest.mocked(appendFileSync).mock.calls[0] as [
      string,
      string,
    ]
    expect(calledPath).toMatch(/pi-auto-mode\.jsonl$/)
  })

  it('empty/whitespace path falls back to the schema default path', () => {
    // Three flavours of "no path": '', '   ', '\n\t' — all should pick up the
    // default telemetry path so telemetry stays on by default.
    for (const bad of ['', '   ', '\n\t']) {
      jest.mocked(appendFileSync).mockClear()
      const logger = new TelemetryLogger(true, bad)
      logger.record('tool_call_blocked', { reason: bad })
      expect(appendFileSync).toHaveBeenCalledTimes(1)
      const [calledPath] = jest.mocked(appendFileSync).mock.calls[0] as [
        string,
        string,
      ]
      expect(calledPath).toMatch(/pi-auto-mode\.jsonl$/)
    }
  })

  it('enabled:true with the schema default path writes to ~/.pi/pi-auto-mode.jsonl (temp HOME)', () => {
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

    expect(fs.existsSync(expectedFile)).toBe(true)
    const ev = JSON.parse(fs.readFileSync(expectedFile, 'utf8').trim())
    expect(ev.type).toBe('permissions:decision')
    expect(ev.payload).toEqual({ surface: 'shell', value: 'ls' })

    if (fs.existsSync(expectedFile)) fs.unlinkSync(expectedFile)
    fs.rmSync(homeDir, { recursive: true, force: true })
  })

  it('record writes a JSON line when enabled and path set', () => {
    const p = tempPath()
    const logger = new TelemetryLogger(true, p)
    logger.record('tool_call_blocked', { error: 'boom' })
    expect(appendFileSync).toHaveBeenCalledTimes(1)
    const [calledPath, calledData] = jest.mocked(appendFileSync).mock
      .calls[0] as [string, string]
    expect(calledPath).toBe(p)
    const ev = JSON.parse(calledData.trim())
    expect(ev.type).toBe('tool_call_blocked')
    expect(ev.payload).toEqual({ error: 'boom' })
    expect(typeof ev.ts).toBe('string')
    if (existsSync(p)) unlinkSync(p)
  })

  it('subscribed decision handler records to a temp file', () => {
    const { pi, handlers } = makePi()
    const p = tempPath()
    const logger = new TelemetryLogger(true, p)
    logger.subscribe(pi)
    handlers[BUS_CHANNEL_DECISION]({ foo: 'bar' })
    expect(existsSync(p)).toBe(true)
    const ev = JSON.parse(readFileSync(p, 'utf8').trim())
    // The file `type` is the log format (unchanged), not the bus channel.
    expect(ev.type).toBe('permissions:decision')
    expect(ev.payload).toEqual({ foo: 'bar' })
    if (existsSync(p)) unlinkSync(p)
  })

  it('update changes enabled/path state so a later record writes', () => {
    const p = tempPath()
    const logger = new TelemetryLogger(false, '')
    logger.update(true, p)
    logger.record('after-update', { ok: 1 })
    expect(existsSync(p)).toBe(true)
    if (existsSync(p)) unlinkSync(p)
  })

  // M9: secret-bearing payloads must be redacted on disk; the original
  // payload object must NOT be mutated.
  it('record redacts a SECRET_KEY= assignment written to the file', () => {
    const p = tempPath()
    const logger = new TelemetryLogger(true, p)
    const original = { value: 'SECRET_KEY=xyz', path: '/tmp/x' }
    logger.record('permissions:decision', original)
    const raw = readFileSync(p, 'utf8')
    expect(raw).toContain('[REDACTED]')
    expect(raw).not.toContain('SECRET_KEY=xyz')
    // payload object is untouched (no mutation).
    expect(original.value).toBe('SECRET_KEY=xyz')
    if (existsSync(p)) unlinkSync(p)
  })

  it('record redacts a password= assignment written to the file', () => {
    const p = tempPath()
    const logger = new TelemetryLogger(true, p)
    logger.record('permissions:decision', 'password=abc')
    const raw = readFileSync(p, 'utf8')
    expect(raw).toContain('[REDACTED]')
    expect(raw).not.toContain('password=abc')
    if (existsSync(p)) unlinkSync(p)
  })

  it('record redacts secret-valued object keys but keeps benign fields', () => {
    const p = tempPath()
    const logger = new TelemetryLogger(true, p)
    const original = { token: 'super-secret', action: 'read', count: 3 }
    logger.record('permissions:decision', original)
    const raw = readFileSync(p, 'utf8')
    const ev = JSON.parse(raw.trim())
    expect(ev.payload.token).toBe('[REDACTED]')
    expect(ev.payload.action).toBe('read')
    expect(ev.payload.count).toBe(3)
    expect(original.token).toBe('super-secret')
    if (existsSync(p)) unlinkSync(p)
  })

  it('record leaves non-secret payloads unchanged', () => {
    const p = tempPath()
    const logger = new TelemetryLogger(true, p)
    logger.record('tool_call_blocked', { error: 'boom' })
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

    it('record writes a Map payload without losing information', () => {
      const p = tempPath()
      const logger = new TelemetryLogger(true, p)
      const m = new Map<string, unknown>([
        ['action', 'read'],
        ['token', 'SECRET_KEY=xyz'],
      ])
      logger.record('permissions:decision', m)
      const raw = readFileSync(p, 'utf8')
      const ev = JSON.parse(raw.trim())
      expect(ev.payload).toEqual([
        ['action', 'read'],
        ['token', '[REDACTED]'],
      ])
      if (existsSync(p)) unlinkSync(p)
    })
  })
})
