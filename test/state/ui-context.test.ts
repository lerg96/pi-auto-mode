import {
  setUiContext,
  getUiContext,
  notifyUi,
} from '../../src/state/ui-context.ts'

function makeFakeUi() {
  return {
    notify: jest.fn(),
    custom: jest.fn(),
    input: jest.fn(),
    confirm: jest.fn(),
    select: jest.fn(),
    setStatus: jest.fn(),
  }
}

describe('ui-context holder', () => {
  // Always start each test from a clean holder so leakage across cases
  // cannot mask a regression.
  afterEach(() => {
    setUiContext(undefined, false)
  })

  it('returns null when no UI has been bound', () => {
    expect(getUiContext()).toBeNull()
  })

  it('returns the bound UI surface after setUiContext(ui, true)', () => {
    const ui = makeFakeUi()
    setUiContext(ui as never, true)
    const got = getUiContext()
    expect(got).not.toBeNull()
    expect(got?.ui).toBe(ui)
    expect(got?.hasUI).toBe(true)
  })

  it('clears the holder when called with ui=undefined', () => {
    const ui = makeFakeUi()
    setUiContext(ui as never, true)
    expect(getUiContext()).not.toBeNull()
    setUiContext(undefined, false)
    expect(getUiContext()).toBeNull()
  })

  it('clears the holder when called with hasUI=false (noOp UI fallback)', () => {
    const ui = makeFakeUi()
    // The real runtime exposes `noOpUIContext` with `hasUI: false` when the
    // session is in print / RPC mode; the holder must treat it as "no UI".
    setUiContext(ui as never, false)
    expect(getUiContext()).toBeNull()
  })

  it('clears the holder when called with hasUI=undefined', () => {
    const ui = makeFakeUi()
    setUiContext(ui as never, undefined as unknown as boolean)
    expect(getUiContext()).toBeNull()
  })

  it('re-binding replaces the previous UI surface', () => {
    const a = makeFakeUi()
    const b = makeFakeUi()
    setUiContext(a as never, true)
    expect(getUiContext()?.ui).toBe(a)
    setUiContext(b as never, true)
    expect(getUiContext()?.ui).toBe(b)
  })
})

describe('notifyUi', () => {
  afterEach(() => {
    setUiContext(undefined, false)
    jest.restoreAllMocks()
  })

  it('routes through the bound UI.notify when a UI is available', () => {
    const ui = makeFakeUi()
    setUiContext(ui as never, true)
    notifyUi('hello', 'warning')
    expect(ui.notify).toHaveBeenCalledTimes(1)
    expect(ui.notify).toHaveBeenCalledWith('hello', 'warning')
  })

  it('falls back to console.log for info when no UI is bound', () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
    notifyUi('info msg')
    expect(logSpy).toHaveBeenCalledTimes(1)
    expect(String(logSpy.mock.calls[0][0])).toContain('info msg')
    expect(warnSpy).not.toHaveBeenCalled()
    expect(errSpy).not.toHaveBeenCalled()
  })

  it('falls back to console.warn for warning when no UI is bound', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})
    notifyUi('warn msg', 'warning')
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(String(warnSpy.mock.calls[0][0])).toContain('warn msg')
  })

  it('falls back to console.error for error when no UI is bound', () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
    notifyUi('boom', 'error')
    expect(errSpy).toHaveBeenCalledTimes(1)
    expect(String(errSpy.mock.calls[0][0])).toContain('boom')
  })

  it('falls back to console when the bound ui.notify throws', () => {
    const ui = makeFakeUi()
    ui.notify.mockImplementation(() => {
      throw new Error('notify blew up')
    })
    setUiContext(ui as never, true)
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
    expect(() => notifyUi('still printed', 'info')).not.toThrow()
    expect(logSpy).toHaveBeenCalledTimes(1)
    expect(String(logSpy.mock.calls[0][0])).toContain('still printed')
  })
})
