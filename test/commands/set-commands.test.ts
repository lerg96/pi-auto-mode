import {
  registerSetCommands,
  formatSets,
  setMode,
  MODES,
} from '../../src/commands/set-commands.ts'
import { setAskResolver } from '../../src/gate/ask.ts'
import { DEFAULT_CONFIG, type Config } from '../../src/types/config.ts'
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from '@earendil-works/pi-coding-agent'
import { configState } from '../../src/state/config-state.ts'
import { SessionRules } from '../../src/permission/session-rules.ts'
import { resetUiRegistry } from '../../src/state/ui-registry.ts'
import { setUiContext } from '../../src/state/ui-context.ts'

const baseConfig: Config = {
  ...DEFAULT_CONFIG,
  permissionSets: {
    base: { permissions: {} },
    extra: { permissions: {} },
  },
  activePermissionSets: [],
}

function makeState(initial: Config) {
  let current = initial
  let yoloSession = false
  return {
    get: () => ({ ...current }),
    set: (c: Config) => {
      current = c
    },
    getActiveSets: () => current.activePermissionSets,
    setActiveSets: (names: string[]) => {
      current = { ...current, activePermissionSets: names }
    },
    getMode: () => current.mode,
    setMode: (mode: Config['mode']) => {
      current = { ...current, mode }
    },
    isYoloSession: () => yoloSession,
    setYoloSession: (enabled: boolean) => {
      yoloSession = Boolean(enabled)
    },
  }
}

function makePi(): {
  pi: ExtensionAPI
  commands: Record<
    string,
    { handler: Function; getArgumentCompletions?: Function }
  >
  registerCommand: ReturnType<typeof jest.fn>
} {
  const commands: Record<
    string,
    { handler: Function; getArgumentCompletions?: Function }
  > = {}
  const registerCommand = jest.fn(
    (
      name: string,
      def: { handler: Function; getArgumentCompletions?: Function }
    ) => {
      commands[name] = def
    }
  )
  const pi = { registerCommand } as unknown as ExtensionAPI
  return { pi, commands, registerCommand }
}

describe('set-commands', () => {
  let state: ReturnType<typeof makeState>
  let commands: Record<
    string,
    { handler: Function; getArgumentCompletions?: Function }
  >
  let registerCommand: ReturnType<typeof jest.fn>

  beforeEach(() => {
    state = makeState(baseConfig)
    const m = makePi()
    registerCommand = m.registerCommand
    commands = m.commands
    // By default grant confirmation so pre-existing activation tests pass;
    // confirmation-specific tests override this per case.
    setAskResolver(async () => 'allow')
    registerSetCommands(m.pi, state as never)
  })

  it('registers the auto-mode:sets command', () => {
    expect(registerCommand).toHaveBeenCalledWith(
      'auto-mode:sets',
      expect.objectContaining({ handler: expect.any(Function) })
    )
    expect(commands['auto-mode:sets']).toBeDefined()
  })

  it('activate marks a set active (with confirmation)', async () => {
    setAskResolver(async () => 'allow')
    const ctx: ExtensionCommandContext = {
      ui: { notify: jest.fn() },
      hasUI: true,
    }
    await commands['auto-mode:sets'].handler('activate extra', ctx)
    expect(state.getActiveSets()).toContain('extra')
  })

  it('deactivate removes a set from active (with confirmation)', async () => {
    state.setActiveSets(['extra'])
    setAskResolver(async () => 'allow')
    const ctx: ExtensionCommandContext = {
      ui: { notify: jest.fn() },
      hasUI: true,
    }
    await commands['auto-mode:sets'].handler('deactivate extra', ctx)
    expect(state.getActiveSets()).not.toContain('extra')
  })

  it('activate without confirmation does NOT change activeSets', async () => {
    setAskResolver(async () => 'deny')
    const notify = jest.fn()
    const ctx: ExtensionCommandContext = { ui: { notify }, hasUI: true }
    await commands['auto-mode:sets'].handler('activate extra', ctx)
    expect(state.getActiveSets()).toEqual([])
    expect(state.get().activePermissionSets).not.toContain('extra')
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining('requires confirmation'),
      'warning'
    )
  })

  it('deactivate without confirmation does NOT change activeSets', async () => {
    state.setActiveSets(['extra'])
    setAskResolver(async () => 'deny')
    const notify = jest.fn()
    const ctx: ExtensionCommandContext = { ui: { notify }, hasUI: true }
    await commands['auto-mode:sets'].handler('deactivate extra', ctx)
    expect(state.getActiveSets()).toContain('extra')
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining('requires confirmation'),
      'warning'
    )
  })

  it('activate with confirmation DOES change activeSets', async () => {
    setAskResolver(async () => 'allow')
    const ctx: ExtensionCommandContext = {
      ui: { notify: jest.fn() },
      hasUI: true,
    }
    await commands['auto-mode:sets'].handler('activate extra', ctx)
    expect(state.getActiveSets()).toEqual(['extra'])
  })

  it('deactivate with confirmation DOES change activeSets', async () => {
    state.setActiveSets(['extra'])
    setAskResolver(async () => 'allow')
    const ctx: ExtensionCommandContext = {
      ui: { notify: jest.fn() },
      hasUI: true,
    }
    await commands['auto-mode:sets'].handler('deactivate extra', ctx)
    expect(state.getActiveSets()).toEqual([])
  })

  it('activate of an already-active set needs no new confirmation', async () => {
    state.setActiveSets(['extra'])
    setAskResolver(async () => 'deny')
    const ctx: ExtensionCommandContext = {
      ui: { notify: jest.fn() },
      hasUI: true,
    }
    await commands['auto-mode:sets'].handler('activate extra', ctx)
    expect(state.getActiveSets()).toEqual(['extra'])
  })

  it('activate of an unknown set notifies an error and does not change state', async () => {
    const notify = jest.fn()
    const ctx: ExtensionCommandContext = { ui: { notify }, hasUI: true }
    await commands['auto-mode:sets'].handler('activate nope', ctx)
    expect(state.getActiveSets()).toEqual([])
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining('unknown permission set'),
      'error'
    )
  })

  it('list renders the set status via notify', async () => {
    state.setActiveSets(['base'])
    const notify = jest.fn()
    const ctx: ExtensionCommandContext = { ui: { notify }, hasUI: true }
    await commands['auto-mode:sets'].handler('list', ctx)
    expect(notify).toHaveBeenCalledTimes(1)
    const msg = notify.mock.calls[0][0] as string
    expect(msg).toContain('activeRules=')
    expect(msg).toContain('[x]')
    expect(msg).toContain('[ ]')
  })

  it('getArgumentCompletions filters permission set names by prefix', () => {
    const def = commands['auto-mode:sets']
    expect(typeof def.getArgumentCompletions).toBe('function')
    const matches = def.getArgumentCompletions!('ext') as Array<{
      value: string
    }>
    expect(matches).toEqual([
      { value: 'extra', label: 'extra', description: 'permission set' },
    ])
    const all = def.getArgumentCompletions!('') as Array<{ value: string }>
    expect(all.map((m) => m.value).sort()).toEqual(['base', 'extra'])
  })

  it('formatSets shows active/inactive marks and the activeRules count', () => {
    const cfg: Config = { ...baseConfig, activePermissionSets: ['base'] }
    const out = formatSets(cfg)
    expect(out).toContain('[x] base')
    expect(out).toContain('[ ] extra')
    expect(out).toContain('activeRules=')
  })

  it('registers the auto-mode:mode command', () => {
    expect(registerCommand).toHaveBeenCalledWith(
      'auto-mode:mode',
      expect.objectContaining({ handler: expect.any(Function) })
    )
    expect(commands['auto-mode:mode']).toBeDefined()
  })
})

describe('setMode (pure helper)', () => {
  it('accepts each declared mode', () => {
    for (const m of MODES) {
      const r = setMode(baseConfig, m)
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.mode).toBe(m)
    }
  })

  it('rejects unknown modes', () => {
    const r = setMode(baseConfig, 'banana')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/unknown mode/)
  })

  it('marks already=true when the current mode equals the requested one', () => {
    const r = setMode({ ...baseConfig, mode: 'strict' }, 'strict')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.already).toBe(true)
  })
})

describe('auto-mode:mode command', () => {
  let state: ReturnType<typeof makeState>
  let commands: Record<
    string,
    { handler: Function; getArgumentCompletions?: Function }
  >
  let registerCommand: ReturnType<typeof jest.fn>

  beforeEach(() => {
    state = makeState({ ...baseConfig, mode: 'default' })
    const m = makePi()
    registerCommand = m.registerCommand
    commands = m.commands
    setAskResolver(async () => 'allow')
    registerSetCommands(m.pi, state as never)
  })

  it('changes the mode after confirmation', async () => {
    const ctx: ExtensionCommandContext = {
      ui: { notify: jest.fn() },
      hasUI: true,
    }
    await commands['auto-mode:mode'].handler('strict', ctx)
    expect(state.get().mode).toBe('strict')
  })

  it('does NOT change mode when confirmation is denied', async () => {
    setAskResolver(async () => 'deny')
    const notify = jest.fn()
    const ctx: ExtensionCommandContext = { ui: { notify }, hasUI: true }
    await commands['auto-mode:mode'].handler('yolo', ctx)
    expect(state.get().mode).toBe('default')
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining('requires confirmation'),
      'warning'
    )
  })

  it('reports an error for unknown modes', async () => {
    const notify = jest.fn()
    const ctx: ExtensionCommandContext = { ui: { notify }, hasUI: true }
    await commands['auto-mode:mode'].handler('banana', ctx)
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining('unknown mode'),
      'error'
    )
    expect(state.get().mode).toBe('default')
  })

  it('reports "already" when the current mode matches the request', async () => {
    const notify = jest.fn()
    const ctx: ExtensionCommandContext = { ui: { notify }, hasUI: true }
    state.setMode('strict')
    await commands['auto-mode:mode'].handler('strict', ctx)
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining('already'),
      'info'
    )
  })

  it('getArgumentCompletions filters mode names by prefix', () => {
    const def = commands['auto-mode:mode']
    expect(typeof def.getArgumentCompletions).toBe('function')
    const all = def.getArgumentCompletions!('') as Array<{ value: string }>
    expect(all.map((m) => m.value).sort()).toEqual(
      ['default', 'strict', 'yolo'].sort()
    )
    const yMatches = def.getArgumentCompletions!('y') as Array<{
      value: string
    }>
    expect(yMatches.map((m) => m.value)).toEqual(['yolo'])
  })
})

describe('yolo command', () => {
  let state: ReturnType<typeof makeState>
  let commands: Record<
    string,
    { handler: Function; getArgumentCompletions?: Function }
  >
  let registerCommand: ReturnType<typeof jest.fn>

  beforeEach(() => {
    state = makeState(baseConfig)
    const m = makePi()
    registerCommand = m.registerCommand
    commands = m.commands
    registerSetCommands(m.pi, state as never)
  })

  it('registers the yolo command', () => {
    expect(registerCommand).toHaveBeenCalledWith(
      'yolo',
      expect.objectContaining({ handler: expect.any(Function) })
    )
    expect(commands['yolo']).toBeDefined()
  })

  it('/yolo with no args toggles configState.isYoloSession() from false -> true and back true -> false', async () => {
    const notify = jest.fn()
    const ctx: ExtensionCommandContext = {
      ui: { notify },
      hasUI: true,
    } as unknown as ExtensionCommandContext

    expect(state.isYoloSession()).toBe(false)
    await commands['yolo'].handler('', ctx)
    expect(state.isYoloSession()).toBe(true)
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining('YOLO mode enabled'),
      'info'
    )

    await commands['yolo'].handler('', ctx)
    expect(state.isYoloSession()).toBe(false)
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining('YOLO mode disabled'),
      'info'
    )

    // Also test toggle keyword explicitly
    await commands['yolo'].handler('toggle', ctx)
    expect(state.isYoloSession()).toBe(true)
  })

  it('/yolo on enables it, /yolo off disables it, /yolo invalid warns and does not change state', async () => {
    const notify = jest.fn()
    const ctx: ExtensionCommandContext = {
      ui: { notify },
      hasUI: true,
    } as unknown as ExtensionCommandContext

    await commands['yolo'].handler('on', ctx)
    expect(state.isYoloSession()).toBe(true)
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining('YOLO mode enabled'),
      'info'
    )

    await commands['yolo'].handler('invalid', ctx)
    expect(state.isYoloSession()).toBe(true)
    expect(notify).toHaveBeenCalledWith('Usage: /yolo [on|off]', 'warning')

    await commands['yolo'].handler('off', ctx)
    expect(state.isYoloSession()).toBe(false)
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining('YOLO mode disabled'),
      'info'
    )

    // Test alternate boolean-like strings
    await commands['yolo'].handler('1', ctx)
    expect(state.isYoloSession()).toBe(true)
    await commands['yolo'].handler('0', ctx)
    expect(state.isYoloSession()).toBe(false)
    await commands['yolo'].handler('true', ctx)
    expect(state.isYoloSession()).toBe(true)
    await commands['yolo'].handler('false', ctx)
    expect(state.isYoloSession()).toBe(false)
  })

  it('provides argument completions for on and off', () => {
    const def = commands['yolo']
    expect(typeof def.getArgumentCompletions).toBe('function')
    const all = def.getArgumentCompletions!('') as Array<{ value: string }>
    expect(all.map((m) => m.value)).toEqual(['on', 'off'])
    const oMatches = def.getArgumentCompletions!('of') as Array<{
      value: string
    }>
    expect(oMatches.map((m) => m.value)).toEqual(['off'])
  })

  it('works with real configState', async () => {
    const m = makePi()
    configState.setYoloSession(false)
    registerSetCommands(m.pi, configState)
    const ctx = {
      ui: { notify: jest.fn() },
      hasUI: true,
    } as unknown as ExtensionCommandContext
    await m.commands['yolo'].handler('', ctx)
    expect(configState.isYoloSession()).toBe(true)
    await m.commands['yolo'].handler('off', ctx)
    expect(configState.isYoloSession()).toBe(false)
  })
})

describe('permissions-list command', () => {
  let state: ReturnType<typeof makeState>
  let sessionRules: SessionRules
  let commands: Record<
    string,
    { handler: Function; getArgumentCompletions?: Function }
  >
  let registerCommand: ReturnType<typeof jest.fn>

  beforeEach(() => {
    resetUiRegistry()
    setUiContext(undefined, false)
    state = makeState(baseConfig)
    sessionRules = new SessionRules()
    const m = makePi()
    registerCommand = m.registerCommand
    commands = m.commands
    registerSetCommands(m.pi, state as never, sessionRules)
  })

  it('registers both permissions-list and auto-mode:permissions commands', () => {
    expect(registerCommand).toHaveBeenCalledWith(
      'permissions-list',
      expect.objectContaining({
        description: expect.stringContaining('interactive modal'),
        handler: expect.any(Function),
      })
    )
    expect(registerCommand).toHaveBeenCalledWith(
      'auto-mode:permissions',
      expect.objectContaining({
        description: expect.stringContaining('Alias for /permissions-list'),
        handler: expect.any(Function),
      })
    )
    expect(commands['permissions-list']).toBeDefined()
    expect(commands['auto-mode:permissions']).toBeDefined()
  })

  it('invoking /permissions-list with interactive UI opens the modal and does not emit a warning', async () => {
    const custom = jest.fn(
      (
        render: (
          tui: unknown,
          theme: unknown,
          kb: unknown,
          done: () => void
        ) => { handleInput?: (key: string) => void }
      ) => {
        const comp = render(null, null, null, () => {})
        comp.handleInput?.('q')
        return Promise.resolve()
      }
    )
    const notify = jest.fn()
    const ctx = {
      ui: { custom, notify },
      hasUI: true,
    } as unknown as ExtensionCommandContext

    await commands['permissions-list'].handler('', ctx)

    expect(custom).toHaveBeenCalledWith(expect.any(Function), {
      overlay: false,
    })
    expect(notify).not.toHaveBeenCalled()
  })

  it('invoking /auto-mode:permissions alias also opens the modal', async () => {
    const custom = jest.fn(
      (
        render: (
          tui: unknown,
          theme: unknown,
          kb: unknown,
          done: () => void
        ) => { handleInput?: (key: string) => void }
      ) => {
        const comp = render(null, null, null, () => {})
        comp.handleInput?.('q')
        return Promise.resolve()
      }
    )
    const notify = jest.fn()
    const ctx = {
      ui: { custom, notify },
      hasUI: true,
    } as unknown as ExtensionCommandContext

    await commands['auto-mode:permissions'].handler('', ctx)

    expect(custom).toHaveBeenCalledWith(expect.any(Function), {
      overlay: false,
    })
    expect(notify).not.toHaveBeenCalled()
  })

  it('invoking /permissions-list when hasUI: false (and no borrowed UI) notifies a warning', async () => {
    resetUiRegistry()
    setUiContext(undefined, false)
    const notify = jest.fn()
    const ctx = {
      ui: { notify },
      hasUI: false,
    } as unknown as ExtensionCommandContext

    await commands['permissions-list'].handler('', ctx)

    expect(notify).toHaveBeenCalledWith(
      'Permissions list modal requires an interactive UI.',
      'warning'
    )
  })
})
