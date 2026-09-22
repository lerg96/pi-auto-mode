import {
  handleSessionStart,
  handleSessionShutdown,
} from '../../src/handlers/stub.ts'
import type {
  PiEventData,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent'

// Regression guard for the "input STUB" ghost-text bug: these lifecycle
// handlers run inside Pi's event loop while the TUI is rendering. ANY write
// to stdout/stderr from an event handler corrupts the render (ghost "input
// STUB" text in the prompt). The handlers must stay completely silent.

const event = { type: 'session_start' } as unknown as PiEventData
const ctx = {} as unknown as ExtensionContext

describe('session lifecycle no-op handlers (stdout-silence invariant)', () => {
  let stdoutWrite: jest.SpyInstance
  let stderrWrite: jest.SpyInstance
  let logSpy: jest.SpyInstance
  let errorSpy: jest.SpyInstance

  beforeEach(() => {
    stdoutWrite = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true)
    stderrWrite = jest
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true)
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    stdoutWrite.mockRestore()
    stderrWrite.mockRestore()
    logSpy.mockRestore()
    errorSpy.mockRestore()
  })

  it('handleSessionStart resolves without writing anything to stdout/stderr', async () => {
    await expect(handleSessionStart(event, ctx)).resolves.toBeUndefined()
    expect(stdoutWrite).not.toHaveBeenCalled()
    expect(stderrWrite).not.toHaveBeenCalled()
    expect(logSpy).not.toHaveBeenCalled()
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('handleSessionShutdown resolves without writing anything to stdout/stderr', async () => {
    await expect(handleSessionShutdown(event, ctx)).resolves.toBeUndefined()
    expect(stdoutWrite).not.toHaveBeenCalled()
    expect(stderrWrite).not.toHaveBeenCalled()
    expect(logSpy).not.toHaveBeenCalled()
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('stays silent even when invoked back-to-back with rich event payloads', async () => {
    const richEvent = {
      type: 'session_start',
      input: 'user typed something',
      nested: { config: { path: 'C:/x' } },
    } as unknown as PiEventData
    await handleSessionStart(richEvent, ctx)
    await handleSessionShutdown(richEvent, ctx)
    expect(stdoutWrite).not.toHaveBeenCalled()
    expect(stderrWrite).not.toHaveBeenCalled()
    expect(logSpy).not.toHaveBeenCalled()
    expect(errorSpy).not.toHaveBeenCalled()
  })
})
