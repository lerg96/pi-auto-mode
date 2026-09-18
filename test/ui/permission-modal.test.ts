import { createModalAskResolver } from '../../src/ui/permission-modal.ts'
import { SessionRules } from '../../src/permission/session-rules.ts'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import type { configState } from '../../src/state/config-state.ts'
import { parseConfig } from '../../src/types/config.ts'
import type { SettingItem } from '../../test/stubs/pi-tui.ts'
import { setUiContext, getUiContext } from '../../src/state/ui-context.ts'
import { publishUi, resetUiRegistry } from '../../src/state/ui-registry.ts'
import { BUS_CHANNEL_UI_PROMPT } from '../../src/events.ts'
import type { AskDecision, AskRequest } from '../../src/gate/ask.ts'

// ─── Mock @earendil-works/pi-tui ────────────────────────────────
// Hoisted `var` so the jest.mock factory (also hoisted) can assign to it
// without tripping a TDZ error.
var captures: {
  onChange?: (itemId: string, newValue: string) => void | Promise<void>
  onCancel?: () => void
  items?: SettingItem[]
  pageLength?: number
  theme?: unknown
  options?: { overlay?: boolean; overlayOptions?: { title?: string } }
}

captures = { onChange: undefined, onCancel: undefined, items: undefined }

jest.mock('@earendil-works/pi-tui', () => ({
  SettingsList: class {
    constructor(
      items: SettingItem[],
      pageLength: number,
      theme: unknown,
      onChange: (itemId: string, newValue: string) => void | Promise<void>,
      onCancel: () => void
    ) {
      captures.items = items
      captures.pageLength = pageLength
      captures.theme = theme
      captures.onChange = onChange
      captures.onCancel = onCancel
    }
  },
}))

type RenderFn = (
  tui: unknown,
  theme: unknown,
  kb: unknown,
  close: () => void
) => unknown

function makeConfigState(
  modalTimeoutMs = 120_000,
  noUiAsks: 'bubble' | 'deny' = 'bubble'
): typeof configState {
  const cfg = parseConfig({ ui: { modalTimeoutMs, noUiAsks } })
  return {
    get: () => cfg,
    set: () => {},
    getActiveSets: () => [],
    setActiveSets: () => {},
  }
}

describe('createModalAskResolver (ctx.ui.custom + overlay:false)', () => {
  let renderCapture: RenderFn | undefined
  let optsCapture: unknown
  let uiNotify: ReturnType<typeof jest.fn>
  let eventsEmit: ReturnType<typeof jest.fn>
  let customImpl: jest.Mock
  let inputImpl: jest.Mock
  let inputResult: string | undefined
  let inputCalls: Array<{
    title: string
    placeholder: string | undefined
    opts: unknown
  }>

  beforeEach(() => {
    captures.onChange = undefined
    captures.onCancel = undefined
    captures.items = undefined
    captures.pageLength = undefined
    captures.theme = undefined
    captures.options = undefined
    renderCapture = undefined
    optsCapture = undefined
    uiNotify = jest.fn()
    eventsEmit = jest.fn()
    inputResult = undefined
    inputCalls = []
    inputImpl = jest.fn(
      (title: string, placeholder?: string, opts?: unknown) => {
        inputCalls.push({ title, placeholder, opts })
        return Promise.resolve(inputResult)
      }
    )
    customImpl = jest.fn((render: RenderFn, opts: unknown) => {
      renderCapture = render
      optsCapture = opts
      return Promise.resolve(undefined)
    })
    // Seed the UI holder with a fresh UI mock. Tests that want a no-UI or
    // noOp-UI flow explicitly clear / override this with `setUiContext(...)`
    // AND clear the process registry (that handle is what lets a UI-less
    // session borrow the parent's modal target).
    resetUiRegistry()
    setUiContext(makeFakeUi(), true)
  })

  afterEach(() => {
    // Clear the UI holder between tests so leakage cannot bleed across cases.
    setUiContext(undefined, false)
    resetUiRegistry()
    expect(getUiContext()).toBeNull()
  })

  function makeFakeUi(custom: jest.Mock = customImpl): {
    custom: jest.Mock
    notify: jest.Mock
    input: jest.Mock
  } {
    return {
      custom,
      notify: uiNotify,
      input: inputImpl,
    }
  }

  function makePi(): ExtensionAPI {
    // The factory still receives `pi` for `events.emit`, but it never reads
    // `pi.ui` (the holder is the source of truth now).
    return {
      events: { emit: eventsEmit },
    } as unknown as ExtensionAPI
  }

  // A UI whose custom() never invokes the render callback and never settles.
  // Useful for verifying the fail-closed timeout fires.
  function makePiNeverRender(): ExtensionAPI {
    setUiContext(
      {
        custom: jest.fn(() => new Promise<void>(() => {})),
        notify: uiNotify,
        input: inputImpl,
      },
      true
    )
    return makePi()
  }

  function makeResolver(
    sessionRules = new SessionRules(),
    modalTimeoutMs = 120_000,
    pi: ExtensionAPI = makePi()
  ): ReturnType<typeof createModalAskResolver> {
    return createModalAskResolver(
      pi,
      sessionRules,
      makeConfigState(modalTimeoutMs)
    )
  }

  // Drive the modal: invoke the captured render to wire up the SettingsList,
  // then fire the captured onChange for the chosen row. With the new shape
  // each row is an "action" row (single-element `values`), so onChange fires
  // with the sentinel value '❯' and we dispatch on `id`.
  //
  // Fake global theme with `.fg` so the SettingsListTheme adapter can build
  // itself (regression: missing fg crashed previously when the modal passed
  // the raw global theme to SettingsList).
  const fakeGlobalTheme = {
    fg: (_color: string, text: string): string => text,
  }
  function choose(rowId: string): void {
    expect(typeof renderCapture).toBe('function')
    renderCapture!(undefined, fakeGlobalTheme, undefined, () => {})
    expect(typeof captures.onChange).toBe('function')
    void captures.onChange!(rowId, '❯')
  }

  // Render the modal view and return its text lines (header + footer; the
  // mocked SettingsList contributes no lines). Returns a `settle` helper
  // that fires onChange for the chosen row, mirroring `choose()`.
  function renderModal(req: AskRequest): {
    lines: string[]
    settle: (rowId: string) => void
    promise: Promise<AskDecision>
  } {
    const resolver = makeResolver()
    const promise = resolver(req)
    expect(typeof renderCapture).toBe('function')
    const view = renderCapture!(
      undefined,
      fakeGlobalTheme,
      undefined,
      () => {}
    ) as unknown as { render(width: number): string[] }
    expect(typeof view.render).toBe('function')
    return {
      lines: view.render(80),
      settle: (rowId: string) => {
        expect(typeof captures.onChange).toBe('function')
        void captures.onChange!(rowId, '❯')
      },
      promise,
    }
  }

  // ─── Critical fix: overlay:false (NOT overlay:true) ──────────
  it('calls ctx.ui.custom with overlay: false (the proven pi-permission-system pattern)', async () => {
    const resolver = makeResolver()
    const promise = resolver({ surface: 'fs', value: '/tmp/x' })
    expect(optsCapture).toEqual({ overlay: false })
    // No overlayOptions anymore (the broken overlay:true modal passed
    // { overlay: true, overlayOptions: { title: 'Permission request' } }).
    expect(optsCapture).not.toEqual(
      expect.objectContaining({ overlayOptions: expect.anything() })
    )
    choose('allow')
    expect(await promise).toBe('allow')
  })

  it('does NOT pass overlay: true to ctx.ui.custom (regression: was invisible)', async () => {
    const resolver = makeResolver()
    const promise = resolver({ surface: 'fs', value: '/tmp/x' })
    const opts = optsCapture as { overlay?: boolean }
    expect(opts.overlay).not.toBe(true)
    choose('allow')
    expect(await promise).toBe('allow')
  })

  // ─── Default option: Allow (NOT Deny) ────────────────────────
  it('renders 4 decision rows with Allow pre-highlighted (index 0)', async () => {
    const resolver = makeResolver()
    const promise = resolver({ surface: 'fs', value: '/tmp/x' })
    renderCapture!(undefined, fakeGlobalTheme, undefined, () => {})
    expect(captures.items).toBeDefined()
    const items = captures.items!
    expect(items).toHaveLength(4)
    expect(items.map((i) => i.id)).toEqual([
      'allow',
      'allow_session',
      'deny',
      'deny_reason',
    ])
    // Row labels are plain action names; the request context moved to the
    // static header above the list. Each row keeps a non-empty currentValue
    // (right-side hint), a single-element values array (Enter fires
    // onChange(id, '❯')), and a description explaining that choice.
    expect(items.map((i) => i.label)).toEqual([
      'Allow',
      'Allow for session',
      'Deny',
      'Deny with reason',
    ])
    for (const it of items) {
      expect(typeof it.currentValue).toBe('string')
      expect(it.currentValue.length).toBeGreaterThan(0)
      expect(it.values).toEqual(['❯'])
      expect(typeof it.description).toBe('string')
    }
    // currentValue hints differ per row.
    expect(items[0].currentValue).toBe('grant once')
    expect(items[1].currentValue).toBe('remember for session')
    expect(items[2].currentValue).toBe('block once')
    expect(items[3].currentValue).toBe('block & tell the model why')
    expect(items[0].description).toContain('Grant once')
    expect(items[1].description).toContain('Remember for this session')
    expect(items[2].description).toContain('Block once')
    expect(items[3].description).toContain('attach your reason')
    choose('allow')
    expect(await promise).toBe('allow')
  })

  // ─── Theme adapter: SettingsListTheme built from the global theme ─
  it('adapts the global theme into a SettingsListTheme (regression: passing the global theme directly crashed visibleWidth)', async () => {
    // The factory receives the global theme (has only `.fg`) and MUST
    // build a SettingsListTheme with label/value/description/cursor/hint.
    // Previously we passed the global theme straight to SettingsList, which
    // crashed because SettingsList called `theme.fg('accent', undefined)`
    // (visibleWidth → .length on undefined).
    const fakeGlobalTheme = {
      fg: (color: string, text: string): string =>
        `[${color}]${text}[/${color}]`,
    }
    const resolver = makeResolver()
    const promise = resolver({ surface: 'fs', value: '/tmp/x' })
    expect(typeof renderCapture).toBe('function')
    renderCapture!(undefined, fakeGlobalTheme, undefined, () => {})
    expect(captures.theme).toBeDefined()
    const theme = captures.theme as {
      label: (text: string, selected: boolean) => string
      value: (text: string, selected: boolean) => string
      description: (text: string) => string
      cursor: string
      hint: (text: string) => string
    }
    expect(typeof theme.label).toBe('function')
    expect(typeof theme.value).toBe('function')
    expect(typeof theme.description).toBe('function')
    expect(typeof theme.hint).toBe('function')
    // Recipe (Pi's getSettingsListTheme):
    //   label(text, true)  -> accent, label(text, false) -> raw
    expect(theme.label('L', true)).toBe('[accent]L[/accent]')
    expect(theme.label('L', false)).toBe('L')
    //   value(text, true)  -> accent, value(text, false) -> muted
    expect(theme.value('V', true)).toBe('[accent]V[/accent]')
    expect(theme.value('V', false)).toBe('[muted]V[/muted]')
    //   description(text)  -> dim
    expect(theme.description('D')).toBe('[dim]D[/dim]')
    //   cursor            -> accent-wrapped '→ '
    expect(theme.cursor).toBe('[accent]→ [/accent]')
    //   hint(text)        -> dim
    expect(theme.hint('H')).toBe('[dim]H[/dim]')
    choose('allow')
    expect(await promise).toBe('allow')
  })

  // ─── Decision matrix ─────────────────────────────────────────
  it('resolves to "allow" when user selects Allow', async () => {
    const resolver = makeResolver()
    const promise = resolver({ surface: 'fs', value: '/tmp/x' })
    choose('allow')
    expect(await promise).toBe('allow')
  })

  it('resolves to "allow_session" when user selects Allow for session', async () => {
    // The modal no longer collapses both options to 'allow': the "Allow for
    // session" row returns the distinct 'allow_session' decision so the gate
    // can persist it (the modal itself does not touch sessionRules).
    const sessionRules = new SessionRules()
    const resolver = makeResolver(sessionRules)
    const promise = resolver({ surface: 'fs', value: '/tmp/x' })
    choose('allow_session')
    expect(await promise).toBe('allow_session')
    // The gate (not the modal) records the session rule.
    expect(sessionRules.size()).toBe(0)
  })

  it('resolves to "deny" when user selects Deny', async () => {
    const resolver = makeResolver()
    const promise = resolver({ surface: 'fs', value: '/tmp/x' })
    choose('deny')
    expect(await promise).toBe('deny')
  })

  // ─── Row activation: direct onChange dispatch on row id ─────
  it('activates each decision row via onChange(id, sentinel)', async () => {
    // Mirror what the real SettingsList does: Enter on a single-value row
    // fires onChange(rowId, value). The modal dispatches on id and ignores
    // the value, so we test each row id maps to its expected decision.
    const cases: Array<{
      rowId: 'allow' | 'allow_session' | 'deny'
      expected: 'allow' | 'allow_session' | 'deny'
    }> = [
      { rowId: 'allow', expected: 'allow' },
      { rowId: 'allow_session', expected: 'allow_session' },
      { rowId: 'deny', expected: 'deny' },
    ]
    for (const c of cases) {
      const resolver = makeResolver()
      const promise = resolver({ surface: 'fs', value: '/tmp/x' })
      renderCapture!(undefined, fakeGlobalTheme, undefined, () => {})
      await captures.onChange!(c.rowId, '❯')
      expect(await promise).toBe(c.expected)
    }
  })

  it('resolves to {decision: "deny", reason: "..."} when user selects Deny with reason and provides a reason', async () => {
    inputResult = 'would delete prod'
    const resolver = makeResolver()
    const promise = resolver({ surface: 'fs', value: '/tmp/x' })
    choose('deny_reason')
    const result = await promise
    expect(result).toEqual({ decision: 'deny', reason: 'would delete prod' })
    expect(inputCalls).toHaveLength(1)
    expect(inputCalls[0].title).toBe('Reason for denial')
    expect(inputCalls[0].placeholder).toBe(
      'Why is this denied? Shown to the model.'
    )
    expect(inputCalls[0].opts).toEqual({ timeout: 120_000 })
  })

  it('resolves to "deny" when user selects Deny with reason and provides no reason', async () => {
    inputResult = undefined
    const resolver = makeResolver()
    const promise = resolver({ surface: 'fs', value: '/tmp/x' })
    choose('deny_reason')
    expect(await promise).toBe('deny')
  })

  it('resolves to "deny" when user selects Deny with reason and provides whitespace-only reason', async () => {
    inputResult = '   '
    const resolver = makeResolver()
    const promise = resolver({ surface: 'fs', value: '/tmp/x' })
    choose('deny_reason')
    expect(await promise).toBe('deny')
  })

  it('sanitizes the reason in the deny-with-reason flow', async () => {
    inputResult = '  bad\n\rstuff here that is way too long ' + 'x'.repeat(300)
    const resolver = makeResolver()
    const promise = resolver({ surface: 'fs', value: '/tmp/x' })
    choose('deny_reason')
    const result = await promise
    if (typeof result !== 'object') throw new Error('expected structured deny')
    expect(result.decision).toBe('deny')
    expect(result.reason).toBeDefined()
    const reason = result.reason as string
    expect(reason.length).toBeLessThanOrEqual(200)
    expect(reason).not.toContain('\n')
    expect(reason).not.toContain('\r')
    expect(reason.startsWith('bad  stuff')).toBe(true)
  })

  it('falls back to "deny" if ui.input throws during the reason capture', async () => {
    inputImpl.mockImplementationOnce(() =>
      Promise.reject(new Error('input gone'))
    )
    const resolver = makeResolver()
    const promise = resolver({ surface: 'fs', value: '/tmp/x' })
    choose('deny_reason')
    expect(await promise).toBe('deny')
  })

  // ─── Esc → deny (SettingsList onCancel wiring) ───────────
  it('resolves to "deny" when SettingsList onCancel fires (Esc / dismiss = deny, fail-closed)', async () => {
    const resolver = makeResolver()
    const promise = resolver({ surface: 'fs', value: '/tmp/x' })
    // Wire the SettingsList up.
    renderCapture!(undefined, fakeGlobalTheme, undefined, () => {})
    expect(typeof captures.onCancel).toBe('function')
    // Fire onCancel (SettingsList fires this on Esc / dismiss).
    captures.onCancel!()
    // Esc-as-deny: the promise resolves to 'deny' immediately.
    expect(await promise).toBe('deny')
  })

  it('does NOT auto-deny when closeOverlay is called without a selection', async () => {
    // The factory stores `close` in a closure. If the modal ever
    // auto-resolves to 'deny' on a focus-loss close (the original bug),
    // this test would catch it. We replace ctx.ui.custom with a mock that
    // invokes the factory synchronously and exposes the closeOverlay.
    let capturedClose: (() => void) | undefined
    const localCustom = jest.fn((render: RenderFn) => {
      // Provide a no-op closeOverlay directly; capture it for the test.
      const close: () => void = () => {}
      capturedClose = close
      render({}, fakeGlobalTheme, {}, close)
      return Promise.resolve(undefined)
    })
    setUiContext(
      {
        custom: localCustom,
        notify: uiNotify,
        input: inputImpl,
      },
      true
    )
    const resolver = createModalAskResolver(
      makePi(),
      new SessionRules(),
      makeConfigState()
    )
    // The factory runs synchronously inside custom(), so capturedClose
    // is set by the time resolver() returns.
    const promise = resolver({ surface: 'fs', value: '/tmp/x' })
    expect(typeof capturedClose).toBe('function')
    // Simulate focus loss: closeOverlay fires. The modal must NOT have
    // resolved to 'deny' (closeOverlay is a no-op until finish() runs).
    capturedClose!()
    let resolved: unknown
    void promise.then((r) => {
      resolved = r
    })
    await Promise.resolve()
    expect(resolved).toBeUndefined()
    // The user then makes a real selection; the modal settles.
    captures.onChange!('allow', '❯')
    expect(await promise).toBe('allow')
  })

  // ─── Fail-closed timeout ─────────────────────────────────────
  it('resolves to "deny" when modal times out (no selection made)', async () => {
    jest.useFakeTimers()
    try {
      const resolver = createModalAskResolver(
        makePiNeverRender(),
        new SessionRules(),
        makeConfigState(120_000)
      )
      const promise = resolver({ surface: 'fs', value: '/tmp/x' })
      expect(renderCapture).toBeUndefined()
      await jest.advanceTimersByTimeAsync(120_000 + 10)
      expect(await promise).toBe('deny')
    } finally {
      jest.useRealTimers()
    }
  })

  it('does not time out when modalTimeoutMs is -1', async () => {
    jest.useFakeTimers()
    try {
      const resolver = makeResolver(new SessionRules(), -1)
      const promise = resolver({ surface: 'fs', value: '/tmp/x' })
      // Advance well past any reasonable timer; the promise must NOT have
      // resolved.
      await jest.advanceTimersByTimeAsync(1_000_000)
      let resolved: unknown
      void promise.then((r) => {
        resolved = r
      })
      await Promise.resolve()
      expect(resolved).toBeUndefined()
      // Settle via onChange to release the pending promise and let
      // fakeTimers clean up.
      renderCapture!(undefined, fakeGlobalTheme, undefined, () => {})
      captures.onChange!('allow', '❯')
      expect(await promise).toBe('allow')
    } finally {
      jest.useRealTimers()
    }
  })

  it('uses the configured modalTimeoutMs for the deny-with-reason input timeout', async () => {
    inputResult = 'because'
    const resolver = makeResolver(new SessionRules(), 45_000)
    const promise = resolver({ surface: 'fs', value: '/tmp/x' })
    choose('deny_reason')
    expect(await promise).toEqual({ decision: 'deny', reason: 'because' })
    expect(inputCalls[0].opts).toEqual({ timeout: 45_000 })
  })

  // ─── UI prompt ordering ──────────────────────────────────────
  it('emits the UI prompt before showing the dialog', async () => {
    const order: string[] = []
    eventsEmit.mockImplementation((channel: string) => {
      order.push(`emit:${channel}`)
    })
    customImpl.mockImplementationOnce((render: RenderFn, opts: unknown) => {
      order.push('custom')
      renderCapture = render
      optsCapture = opts
      return Promise.resolve(undefined)
    })
    const resolver = makeResolver()
    const promise = resolver({
      surface: 'fs',
      value: '/tmp/x',
      requestId: 'req-1',
    })
    expect(order).toEqual([`emit:${BUS_CHANNEL_UI_PROMPT}`, 'custom'])
    expect(eventsEmit).toHaveBeenCalledWith(
      BUS_CHANNEL_UI_PROMPT,
      expect.objectContaining({
        surface: 'fs',
        value: '/tmp/x',
        requestId: 'req-1',
      })
    )
    choose('allow')
    expect(await promise).toBe('allow')
  })

  // ─── Sanitization ────────────────────────────────────────────
  it('sanitizes surface and value in the header', async () => {
    const { lines, settle, promise } = renderModal({
      surface: 'fs\nINJECT',
      value: '/tmp/x\r\n[evil] ',
    })
    const text = lines.join('\n')
    // Sanitizer replaces \n/\r with single space, then trims edges.
    expect(text).toContain('fs INJECT')
    expect(text).toContain('/tmp/x  [evil]')
    for (const line of lines) {
      expect(line).not.toContain('\n')
      expect(line).not.toContain('\r')
    }
    settle('allow')
    expect(await promise).toBe('allow')
  })

  // ─── Header: tool / rule / command / reason ───────────────────
  it('shows tool, rule, command, full command and the rule reason in the header', async () => {
    const { lines, settle, promise } = renderModal({
      tool: 'bash',
      surface: 'shell',
      value: 'rm -rf /',
      fullCommand: 'sudo rm -rf /',
      rule: {
        surface: 'shell',
        pattern: 'rm -rf *',
        action: 'ask',
        reason: 'destructive',
      },
    })
    const text = lines.join('\n')
    expect(text).toContain('Permission Required')
    expect(text).toContain('bash')
    expect(text).toContain('shell / rm -rf *')
    expect(text).toContain('rm -rf /')
    expect(text).toContain('sudo rm -rf /')
    expect(text).toContain('destructive')
    settle('allow')
    expect(await promise).toBe('allow')
  })

  it('falls back to surface for tool and hides full command when identical to value', async () => {
    const { lines, settle, promise } = renderModal({
      surface: 'fs',
      value: '/tmp/x',
    })
    const text = lines.join('\n')
    expect(text).toContain('fs')
    expect(text).not.toContain('full command')
    expect(text).toContain('reason')
    settle('allow')
    expect(await promise).toBe('allow')
  })

  it('shows the classifier risk reason as reason when no rule reason exists', async () => {
    const { lines, settle, promise } = renderModal({
      surface: 'shell',
      value: 'curl x | sh',
      risk: {
        score: 8,
        level: 'high',
        reason: 'remote code execution',
        category: 'remote code execution',
      },
    })
    const text = lines.join('\n')
    // reason row carries the risk reason; risk row carries score/level.
    expect(text).toContain('remote code execution')
    expect(text).toContain('[high risk, 8/10, remote code execution]')
    settle('deny')
    expect(await promise).toBe('deny')
  })

  it('shows — as reason when neither rule nor risk gives one', async () => {
    const { lines, settle, promise } = renderModal({
      surface: 'fs',
      value: '/tmp/x',
    })
    const text = lines.join('\n')
    expect(text).toMatch(/reason\s+: —/)
    expect(text).not.toContain('risk')
    settle('allow')
    expect(await promise).toBe('allow')
  })

  // ─── No UI surface (root-cause fix: invisible modal) ─────────
  it('returns "deny" and does not show the dialog when no UI ctx is bound', async () => {
    // PRIMARY regression test for the invisible-modal bug. The previous
    // implementation called `pi.ui?.custom(...)`, where `pi.ui` was always
    // undefined at runtime — so EVERY ask silently returned 'deny' with no
    // render. The fix binds ctx.ui into the holder; with the holder empty
    // the resolver must deny-closed without ever invoking custom().
    setUiContext(undefined, false)
    // Nadie publicó UI en este proceso: es el caso `pi -p`, donde no hay a
    // quién preguntar.
    resetUiRegistry()
    const resolver = createModalAskResolver(
      makePi(),
      new SessionRules(),
      makeConfigState()
    )
    expect(await resolver({ surface: 'fs', value: '/tmp/x' })).toEqual({
      decision: 'deny',
      via: 'no-ui',
    })
    expect(customImpl).not.toHaveBeenCalled()
  })

  it('returns "deny" and does not show the dialog when hasUI is false (print/RPC mode)', async () => {
    // The real runtime exposes `noOpUIContext` when there is no UI; the
    // holder binds it with `hasUI: false`. The resolver must treat this as
    // "no UI to ask the user" and fail-closed.
    setUiContext(
      {
        custom: customImpl,
        notify: uiNotify,
        input: inputImpl,
      },
      false
    )
    resetUiRegistry()
    const resolver = createModalAskResolver(
      makePi(),
      new SessionRules(),
      makeConfigState()
    )
    expect(await resolver({ surface: 'fs', value: '/tmp/x' })).toEqual({
      decision: 'deny',
      via: 'no-ui',
    })
    expect(customImpl).not.toHaveBeenCalled()
  })

  // ─── Sub-sesión sin UI propia: el modal se presta la UI del padre ──
  it('borra la UI publicada cuando noUiAsks=deny: deniega sin preguntar', async () => {
    const parentUi = makeFakeUi()
    setUiContext(parentUi, true)
    resetUiRegistry()
    publishUi(parentUi as never)
    setUiContext(undefined, false) // esta sesión (la hija) no tiene UI

    const resolver = createModalAskResolver(
      makePi(),
      new SessionRules(),
      makeConfigState(120_000, 'deny')
    )
    expect(await resolver({ surface: 'fs', value: '/tmp/x' })).toEqual({
      decision: 'deny',
      via: 'no-ui',
    })
    expect(parentUi.custom).not.toHaveBeenCalled()
  })

  it('renderiza en la UI del padre cuando esta sesión no tiene UI', async () => {
    const parentUi = makeFakeUi()
    setUiContext(parentUi, true)
    resetUiRegistry()
    publishUi(parentUi as never)
    setUiContext(undefined, false) // la sub-sesión hereda: ctx.hasUI === false

    // custom() queda pendiente: el modal sigue abierto hasta que disparemos
    // onChange, como en `makePiNeverRender`.
    const pending = makeFakeUi(jest.fn(() => new Promise<undefined>(() => {})))
    setUiContext(pending, true)
    resetUiRegistry()
    publishUi(pending as never)
    setUiContext(undefined, false)

    const resolver = makeResolver()
    const promise = resolver({ surface: 'fs', value: '/tmp/x' })

    // El modal tiene que haberse renderizado en la UI del PADRE, no en la suya.
    expect(pending.custom).toHaveBeenCalledTimes(1)
    const render = pending.custom.mock.calls[0]?.[0] as RenderFn
    const view = render(
      undefined,
      fakeGlobalTheme,
      undefined,
      () => {}
    ) as unknown as { render(width: number): string[] }
    const lines = view.render(80).join('\n')
    // Y tiene que decir de dónde viene la pregunta.
    expect(lines).toContain('child session')

    const onChange = captures.onChange
    expect(typeof onChange).toBe('function')
    onChange!('allow', '❯')
    expect(await promise).toEqual({ decision: 'allow', via: 'parent-modal' })
  })

  // ─── Defensive: ctx.ui.custom() rejection → fail-closed ───────
  it('falls back to "deny" if ctx.ui.custom throws', async () => {
    setUiContext(
      {
        custom: jest.fn(() => Promise.reject(new Error('ui gone'))),
        notify: uiNotify,
        input: inputImpl,
      },
      true
    )
    const resolver = createModalAskResolver(
      makePi(),
      new SessionRules(),
      makeConfigState()
    )
    const result = await resolver({ surface: 'fs', value: '/tmp/x' })
    expect(result).toBe('deny')
  })

  // ─── Defensive: unknown option → fail-closed ─────────────────
  it('falls back to "deny" if an unforeseen selection arrives', async () => {
    const resolver = makeResolver()
    const promise = resolver({ surface: 'fs', value: '/tmp/x' })
    choose('Surprise me')
    expect(await promise).toBe('deny')
  })

  // ─── sessionRules arg is accepted but not used here ──────────
  it('accepts sessionRules without altering the decision', async () => {
    const sessionRules = new SessionRules()
    const resolver = makeResolver(sessionRules)
    const promise = resolver({ surface: 'fs', value: '/tmp/x' })
    choose('allow')
    expect(await promise).toBe('allow')
    expect(sessionRules.size()).toBe(0)
  })

  // ─── Long values wrap instead of cutting ─────────────────────
  it('wraps a long full command across header lines (head, middle, tail visible)', async () => {
    const tail = 'x'.repeat(120)
    const full = `sleep 240; timeout 60 ssh -o BatchMode=yes oracle 'pgrep -f sync >/dev/null && echo "aun corre" || echo "termino"; grep -cE x /root/muy/largo/${tail}`
    expect(full.length).toBeGreaterThan(160)
    const { lines, settle, promise } = renderModal({
      tool: 'bash',
      surface: 'shell',
      value: 'sleep 240',
      fullCommand: full,
    })
    const text = lines.join('\n')
    expect(text).toContain('sleep 240; timeout 60 ssh')
    expect(text).toContain('termino')
    // Tail straddles the wrap boundary: rejoin continuation lines to
    // prove nothing was cut (7 header lines + 1 footer = 8 total).
    expect(text.replace(/\n +/g, '')).toContain(tail)
    expect(lines).toHaveLength(8)
    for (const line of lines) {
      expect(line).not.toContain('\n')
      expect(line).not.toContain('\r')
    }
    settle('deny')
    expect(await promise).toBe('deny')
  })

  // ─── Sound notification (opt-in chime + reminders) ──────────
  function makeSoundConfigState(sound: unknown): typeof configState {
    const cfg = parseConfig({ ui: { sound } })
    return {
      get: () => cfg,
      set: () => {},
      getActiveSets: () => [],
      setActiveSets: () => {},
    }
  }

  it('chimes on open and reminds every remindEveryMs until settled', async () => {
    jest.useFakeTimers()
    try {
      const player = jest.fn(() => {})
      const resolver = createModalAskResolver(
        makePi(),
        new SessionRules(),
        makeSoundConfigState({ enabled: true, remindEveryMs: 200 }),
        { soundPlayer: player }
      )
      const promise = resolver({ surface: 'fs', value: '/tmp/x' })
      expect(player).toHaveBeenCalledTimes(1)
      await jest.advanceTimersByTimeAsync(200)
      expect(player).toHaveBeenCalledTimes(2)
      await jest.advanceTimersByTimeAsync(400)
      expect(player).toHaveBeenCalledTimes(4)
      renderCapture!(undefined, fakeGlobalTheme, undefined, () => {})
      captures.onChange!('deny', '❯')
      expect(await promise).toBe('deny')
      await jest.advanceTimersByTimeAsync(1000)
      expect(player).toHaveBeenCalledTimes(4)
    } finally {
      jest.useRealTimers()
    }
  })

  it('single chime only when remindEveryMs is 0', async () => {
    jest.useFakeTimers()
    try {
      const player = jest.fn(() => {})
      const resolver = createModalAskResolver(
        makePi(),
        new SessionRules(),
        makeSoundConfigState({ enabled: true, remindEveryMs: 0 }),
        { soundPlayer: player }
      )
      const promise = resolver({ surface: 'fs', value: '/tmp/x' })
      expect(player).toHaveBeenCalledTimes(1)
      await jest.advanceTimersByTimeAsync(5000)
      expect(player).toHaveBeenCalledTimes(1)
      renderCapture!(undefined, fakeGlobalTheme, undefined, () => {})
      captures.onChange!('allow', '❯')
      expect(await promise).toBe('allow')
    } finally {
      jest.useRealTimers()
    }
  })

  it('stays silent when ui.sound is absent', async () => {
    jest.useFakeTimers()
    try {
      const player = jest.fn(() => {})
      const resolver = createModalAskResolver(
        makePi(),
        new SessionRules(),
        makeConfigState(),
        { soundPlayer: player }
      )
      const promise = resolver({ surface: 'fs', value: '/tmp/x' })
      await jest.advanceTimersByTimeAsync(5000)
      expect(player).not.toHaveBeenCalled()
      renderCapture!(undefined, fakeGlobalTheme, undefined, () => {})
      captures.onChange!('allow', '❯')
      expect(await promise).toBe('allow')
    } finally {
      jest.useRealTimers()
    }
  })
})

afterEach(() => {
  // No fake timers left set between tests; ensure real timers are active.
  jest.useRealTimers()
})
