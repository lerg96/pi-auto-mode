import {
  buildHerdrBlockedLabel,
  buildSelectOptions,
  buildSelectTitle,
  sanitizeSelectText,
} from '../../src/ui/herdr-select-modal.ts'
import { createModalAskResolver } from '../../src/ui/permission-modal.ts'
import { SessionRules } from '../../src/permission/session-rules.ts'
import { parseConfig } from '../../src/types/config.ts'
import { setUiContext } from '../../src/state/ui-context.ts'
import { publishUi, resetUiRegistry } from '../../src/state/ui-registry.ts'
import type { ExtensionAPI, ExtensionUI } from '@earendil-works/pi-coding-agent'
import type { configState } from '../../src/state/config-state.ts'
import type { AskRequest } from '../../src/gate/ask.ts'

jest.mock('@earendil-works/pi-tui', () => ({
  matchesKey: () => false,
  isKeyRelease: () => false,
  SettingsList: class {
    selectedIndex = 0
    items: unknown[]
    constructor(
      items: unknown[],
      _pageLength: number,
      _theme: unknown,
      onChange: (itemId: string, newValue: string) => void | Promise<void>,
      _onCancel: () => void
    ) {
      this.items = items
      queueMicrotask(() => {
        void onChange('deny', '❯')
      })
    }
  },
}))

function makeConfigState(
  overrides: Record<string, unknown> = {}
): typeof configState {
  const cfg = parseConfig(overrides)
  return {
    get: () => cfg,
  } as unknown as typeof configState
}

function makePi(): {
  pi: ExtensionAPI
  emitted: Array<{ channel: string; data: unknown }>
} {
  const emitted: Array<{ channel: string; data: unknown }> = []
  const pi = {
    events: {
      on: jest.fn(),
      emit: jest.fn((channel: string, data: unknown) => {
        emitted.push({ channel, data })
      }),
    },
  } as unknown as ExtensionAPI
  return { pi, emitted }
}

function makeUi(overrides: Partial<ExtensionUI> = {}): {
  ui: ExtensionUI
  select: jest.Mock
  input: jest.Mock
  custom: jest.Mock
} {
  const select = jest.fn<
    ReturnType<ExtensionUI['select']>,
    Parameters<ExtensionUI['select']>
  >(async () => 'Allow once')
  const input = jest.fn<
    ReturnType<ExtensionUI['input']>,
    Parameters<ExtensionUI['input']>
  >(async () => undefined)
  const custom = jest.fn<
    ReturnType<ExtensionUI['custom']>,
    Parameters<ExtensionUI['custom']>
  >(async (factory) => {
    let done!: () => void
    const p = new Promise<void>((r) => {
      done = r
    })
    await factory({}, {}, {}, done)
    await p
    return undefined as never
  })

  const ui: ExtensionUI = {
    setStatus: jest.fn(),
    notify: jest.fn(),
    confirm: jest.fn(async () => false),
    select,
    input,
    custom,
    ...overrides,
  }
  return { ui, select, input, custom }
}

describe('herdr-select-modal helpers', () => {
  it('defaults ui.herdrSelectModal to false in config schema', () => {
    expect(parseConfig({}).ui.herdrSelectModal).toBe(false)
    expect(
      parseConfig({ ui: { herdrSelectModal: true } }).ui.herdrSelectModal
    ).toBe(true)
  })

  it('sanitizes newlines and collapses double spaces for Ovis compatibility', () => {
    expect(sanitizeSelectText('git  push\n\rorigin   main')).toBe(
      'git push origin main'
    )
  })

  it('never produces option labels containing double spaces or newlines', () => {
    const req: AskRequest = {
      surface: 'shell',
      tool: 'bash',
      value: 'npm   run\nbuild',
      sessionPatterns: ['npm   run   *', 'npm   run\nbuild'],
    }
    const opts = buildSelectOptions(req)
    expect(opts.length).toBeGreaterThanOrEqual(2)
    for (const o of opts) {
      expect(o.label).not.toMatch(/\s{2,}/)
      expect(o.label).not.toMatch(/[\n\r]/)
    }
  })

  it('builds select title with subagent prefix and classifier risk when enabled', () => {
    const req: AskRequest = {
      surface: 'shell',
      tool: 'bash',
      value: 'rm -rf /tmp/foo',
      risk: { score: 85, level: 'high', reason: 'Destructive delete' },
    }
    const title = buildSelectTitle(req, 'parent-modal', true)
    expect(title).toContain('[subagent] Permission required: bash')
    expect(title).toContain('Command: rm -rf /tmp/foo')
    expect(title).toContain('Risk: high (85) - Destructive delete')
  })

  it('builds herdr:blocked label from tool and target', () => {
    expect(
      buildHerdrBlockedLabel({
        surface: 'shell',
        tool: 'bash',
        value: 'git push',
      })
    ).toBe('bash: git push')
  })
})

describe('createModalAskResolver with herdrSelectModal toggle', () => {
  const prevHerdrEnv = process.env.HERDR_ENV

  afterEach(() => {
    if (prevHerdrEnv === undefined) {
      delete process.env.HERDR_ENV
    } else {
      process.env.HERDR_ENV = prevHerdrEnv
    }
    resetUiRegistry()
    setUiContext(undefined as unknown as ExtensionUI, false)
  })

  it('keeps custom modal when herdrSelectModal is false even under HERDR_ENV=1', async () => {
    process.env.HERDR_ENV = '1'
    const { pi, emitted } = makePi()
    const { ui, select, custom } = makeUi()
    setUiContext(ui, true)

    const resolver = createModalAskResolver(
      pi,
      new SessionRules(),
      makeConfigState({ ui: { herdrSelectModal: false, modalTimeoutMs: -1 } })
    )
    const res = await resolver({
      surface: 'shell',
      tool: 'bash',
      value: 'echo hi',
    })

    expect(res).toBe('deny')
    expect(custom).toHaveBeenCalledTimes(1)
    expect(select).not.toHaveBeenCalled()
    expect(emitted.filter((e) => e.channel === 'herdr:blocked')).toEqual([
      {
        channel: 'herdr:blocked',
        data: { active: true, label: 'bash: echo hi' },
      },
      { channel: 'herdr:blocked', data: { active: false } },
    ])
  })

  it('keeps custom modal when herdrSelectModal is true but HERDR_ENV is not 1', async () => {
    delete process.env.HERDR_ENV
    const { pi } = makePi()
    const { ui, select, custom } = makeUi()
    setUiContext(ui, true)

    const resolver = createModalAskResolver(
      pi,
      new SessionRules(),
      makeConfigState({ ui: { herdrSelectModal: true, modalTimeoutMs: -1 } })
    )
    await resolver({ surface: 'shell', tool: 'bash', value: 'echo hi' })

    expect(custom).toHaveBeenCalledTimes(1)
    expect(select).not.toHaveBeenCalled()
  })

  it('uses ui.select when herdrSelectModal is true and HERDR_ENV=1', async () => {
    process.env.HERDR_ENV = '1'
    const { pi, emitted } = makePi()
    const { ui, select, custom } = makeUi()
    setUiContext(ui, true)

    const resolver = createModalAskResolver(
      pi,
      new SessionRules(),
      makeConfigState({ ui: { herdrSelectModal: true, modalTimeoutMs: -1 } })
    )
    const res = await resolver({
      surface: 'shell',
      tool: 'bash',
      value: 'git status',
    })

    expect(res).toBe('allow')
    expect(select).toHaveBeenCalledTimes(1)
    expect(custom).not.toHaveBeenCalled()
    expect(emitted.filter((e) => e.channel === 'herdr:blocked')).toEqual([
      {
        channel: 'herdr:blocked',
        data: { active: true, label: 'bash: git status' },
      },
      { channel: 'herdr:blocked', data: { active: false } },
    ])
  })

  it('maps session pattern and permanent choices correctly', async () => {
    process.env.HERDR_ENV = '1'
    const { pi } = makePi()
    const { ui, select } = makeUi()
    select.mockResolvedValueOnce('Allow for session: git *')
    setUiContext(ui, true)

    const resolver = createModalAskResolver(
      pi,
      new SessionRules(),
      makeConfigState({ ui: { herdrSelectModal: true, modalTimeoutMs: -1 } })
    )
    const res = await resolver({
      surface: 'shell',
      tool: 'bash',
      value: 'git push',
      sessionPatterns: ['git push', 'git *'],
    })

    expect(res).toEqual({ decision: 'allow_session', pattern: 'git *' })
  })

  it('opens Allow permanently submenu for multiple patterns and supports Back', async () => {
    process.env.HERDR_ENV = '1'
    const { pi } = makePi()
    const { ui, select } = makeUi()
    select
      .mockResolvedValueOnce('Allow permanently...')
      .mockResolvedValueOnce('Back')
      .mockResolvedValueOnce('Allow permanently...')
      .mockResolvedValueOnce('Allow permanently: git *')
    setUiContext(ui, true)

    const resolver = createModalAskResolver(
      pi,
      new SessionRules(),
      makeConfigState({ ui: { herdrSelectModal: true, modalTimeoutMs: -1 } })
    )
    const res = await resolver({
      surface: 'shell',
      tool: 'bash',
      value: 'git push origin main',
      sessionPatterns: ['git push origin main', 'git push *', 'git *'],
    })

    expect(select).toHaveBeenCalledTimes(4)
    expect(res).toEqual({ decision: 'allow_permanent', pattern: 'git *' })
  })

  it('shows direct Allow permanently option when only one sessionPattern exists', async () => {
    process.env.HERDR_ENV = '1'
    const { pi } = makePi()
    const { ui, select } = makeUi()
    select.mockResolvedValueOnce('Allow permanently: git status')
    setUiContext(ui, true)

    const resolver = createModalAskResolver(
      pi,
      new SessionRules(),
      makeConfigState({ ui: { herdrSelectModal: true, modalTimeoutMs: -1 } })
    )
    const res = await resolver({
      surface: 'shell',
      tool: 'bash',
      value: 'git status',
      sessionPatterns: ['git status'],
    })

    expect(select).toHaveBeenCalledTimes(1)
    expect(res).toEqual({ decision: 'allow_permanent', pattern: 'git status' })
  })

  it('maps external-directory choices correctly', async () => {
    process.env.HERDR_ENV = '1'
    const { pi } = makePi()
    const { ui, select } = makeUi()
    select.mockResolvedValueOnce('Allow path for this tool')
    setUiContext(ui, true)

    const resolver = createModalAskResolver(
      pi,
      new SessionRules(),
      makeConfigState({ ui: { herdrSelectModal: true, modalTimeoutMs: -1 } })
    )
    const res = await resolver({
      surface: 'fs',
      tool: 'read',
      type: 'external-directory',
      value: '/tmp/foo.txt',
      externalDir: '/tmp',
    })

    expect(res).toBe('allow_dir_tool')
  })

  it('handles deny_reason via ui.input and sanitizes the reason', async () => {
    process.env.HERDR_ENV = '1'
    const { pi } = makePi()
    const { ui, select, input } = makeUi()
    select.mockResolvedValueOnce('Deny with reason')
    input.mockResolvedValueOnce('use   staging\ninstead')
    setUiContext(ui, true)

    const resolver = createModalAskResolver(
      pi,
      new SessionRules(),
      makeConfigState({ ui: { herdrSelectModal: true, modalTimeoutMs: -1 } })
    )
    const res = await resolver({
      surface: 'shell',
      tool: 'bash',
      value: 'deploy prod',
    })

    expect(input).toHaveBeenCalledTimes(1)
    expect(res).toEqual({ decision: 'deny', reason: 'use staging instead' })
  })

  it('fails closed on cancel (undefined) and select error', async () => {
    process.env.HERDR_ENV = '1'
    const { pi } = makePi()
    const { ui, select } = makeUi()
    select.mockResolvedValueOnce(undefined)
    setUiContext(ui, true)

    const resolver = createModalAskResolver(
      pi,
      new SessionRules(),
      makeConfigState({ ui: { herdrSelectModal: true, modalTimeoutMs: -1 } })
    )
    expect(
      await resolver({ surface: 'shell', tool: 'bash', value: 'rm foo' })
    ).toBe('deny')

    select.mockRejectedValueOnce(new Error('boom'))
    expect(
      await resolver({ surface: 'shell', tool: 'bash', value: 'rm foo' })
    ).toBe('deny')
  })

  it('fails closed with via: timeout when modalTimeoutMs expires', async () => {
    process.env.HERDR_ENV = '1'
    const { pi } = makePi()
    const { ui, select } = makeUi()
    select.mockImplementationOnce(
      () => new Promise<string | undefined>(() => {})
    )
    setUiContext(ui, true)

    const resolver = createModalAskResolver(
      pi,
      new SessionRules(),
      makeConfigState({ ui: { herdrSelectModal: true, modalTimeoutMs: 25 } })
    )
    const res = await resolver({
      surface: 'shell',
      tool: 'bash',
      value: 'sleep 10',
    })

    expect(res).toEqual({ decision: 'deny', via: 'timeout' })
  })

  it('uses custom modal for subagent (parent-modal) even when herdrSelectModal is true, and emits herdr:blocked on parent bus', async () => {
    process.env.HERDR_ENV = '1'
    const parentEmitted: Array<{ channel: string; data: unknown }> = []
    const { pi: childPi, emitted: childEmitted } = makePi()
    const { ui, select, custom } = makeUi()
    publishUi(ui, (channel, data) => {
      parentEmitted.push({ channel, data })
    })
    setUiContext(undefined, false)

    const resolver = createModalAskResolver(
      childPi,
      new SessionRules(),
      makeConfigState({ ui: { herdrSelectModal: true, modalTimeoutMs: -1 } })
    )
    const res = await resolver({
      surface: 'shell',
      tool: 'bash',
      value: 'git status',
    })

    expect(res).toEqual({ decision: 'deny', via: 'parent-modal' })
    expect(custom).toHaveBeenCalledTimes(1)
    expect(select).not.toHaveBeenCalled()
    expect(parentEmitted).toEqual([
      {
        channel: 'herdr:blocked',
        data: { active: true, label: 'bash: git status' },
      },
      { channel: 'herdr:blocked', data: { active: false } },
    ])
    expect(
      childEmitted.filter((e) => e.channel === 'herdr:blocked')
    ).toHaveLength(0)
  })

  it('omits Allow permanently options when suppressPermanent is true', () => {
    const opts = buildSelectOptions({
      surface: 'shell',
      tool: 'bash',
      value: 'sed -i -e 87,108d src/libs/lambda.ts',
      sessionPatterns: ['sed -i -e 87,108d src/libs/lambda.ts'],
      suppressPermanent: true,
    })
    expect(opts.map((o) => o.label)).toEqual([
      'Allow once',
      'Allow for session: sed -i -e 87,108d src/libs/lambda.ts',
      'Deny',
      'Deny with reason',
    ])
  })

  it('offers View full command only when command exceeds select title length and returns via Back', async () => {
    const shortOpts = buildSelectOptions({
      surface: 'shell',
      tool: 'bash',
      value: 'echo line1\necho line2',
      fullCommand: 'echo line1\necho line2',
      sessionPatterns: ['echo line1\necho line2'],
    })
    expect(shortOpts.map((o) => o.label)).not.toContain('View full command')

    process.env.HERDR_ENV = '1'
    const { pi } = makePi()
    const { ui, select } = makeUi()
    const fullCmd = `python3 - <<'EOF'\n${'x = 12345678901234567890123456789012345678901234567890\n'.repeat(4)}print('line 2')\nEOF`
    select
      .mockResolvedValueOnce('View full command')
      .mockResolvedValueOnce('Back')
      .mockResolvedValueOnce('Allow once')
    setUiContext(ui, true)

    const resolver = createModalAskResolver(
      pi,
      new SessionRules(),
      makeConfigState({ ui: { herdrSelectModal: true, modalTimeoutMs: -1 } })
    )
    const res = await resolver({
      surface: 'shell',
      tool: 'bash',
      value: fullCmd,
      fullCommand: fullCmd,
      sessionPatterns: [fullCmd],
    })

    expect(res).toBe('allow')
    expect(select).toHaveBeenCalledTimes(3)
    expect(select.mock.calls[1][0]).toContain("print('line 2')")
    expect(select.mock.calls[1][1]).toEqual(['Back'])
  })

  it('middle-truncates very long patterns so differing tails stay distinct without (2)/(3)', () => {
    const prefix =
      'bash /home/user/.pi/agent/skills/very-long-skill-name-directory/nested/subpath/scripts/wait-greptile-checks-runner-v2-extended.sh'
    const opts = buildSelectOptions({
      surface: 'shell',
      tool: 'bash',
      value: `${prefix} 985 120 30`,
      sessionPatterns: [
        `${prefix} 985 120 30`,
        `${prefix} 985 120 *`,
        `${prefix} 985 *`,
        `${prefix} *`,
      ],
    })
    const labels = opts
      .filter((o) => o.label.startsWith('Allow for session:'))
      .map((o) => o.label)
    expect(labels.every((l) => !/\(\d+\)$/.test(l))).toBe(true)
    expect(labels[0]).toContain('985 120 30')
    expect(labels[1]).toContain('985 120 *')
    expect(labels[2]).toContain('985 *')
    expect(labels[3]).toContain('…')
  })

  it('passes blockedKind="permission" to ui.select and ui.input', async () => {
    process.env.HERDR_ENV = '1'
    const { pi } = makePi()
    const { ui, select, input } = makeUi()
    select.mockResolvedValueOnce('Deny with reason')
    input.mockResolvedValueOnce('nope')
    setUiContext(ui, true)

    const resolver = createModalAskResolver(
      pi,
      new SessionRules(),
      makeConfigState({ ui: { herdrSelectModal: true, modalTimeoutMs: -1 } })
    )
    await resolver({
      surface: 'shell',
      tool: 'bash',
      value: 'rm foo',
    })

    expect(select.mock.calls[0][2]).toMatchObject({
      blockedKind: 'permission',
    })
    expect(input.mock.calls[0][2]).toMatchObject({
      blockedKind: 'permission',
    })
  })
})
