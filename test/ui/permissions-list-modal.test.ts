import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  PermissionsListModalView,
  parseAddPermissionInput,
  openPermissionsListModal,
  type GlobalTheme,
} from '../../src/ui/permissions-list-modal.ts'
import {
  SessionRules,
  resetSessionRulesRegistry,
} from '../../src/permission/session-rules.ts'
import { configState } from '../../src/state/config-state.ts'
import { parseConfig } from '../../src/types/config.ts'
import {
  addExternalDirAllow,
  resetExternalDirAllowlist,
  getExternalDirAllowlist,
} from '../../src/state/external-dir-allowlist.ts'
import { setUiContext } from '../../src/state/ui-context.ts'
import { publishUi, resetUiRegistry } from '../../src/state/ui-registry.ts'
import type { ExtensionUI, CustomComponent } from '../../src/pi-sdk.ts'

describe('parseAddPermissionInput', () => {
  it('returns null for empty or whitespace-only inputs', () => {
    expect(parseAddPermissionInput('', 'permanent')).toBeNull()
    expect(parseAddPermissionInput('   ', 'session')).toBeNull()
  })

  it('parses tool:pattern inputs correctly', () => {
    const res = parseAddPermissionInput('bash: git status *', 'permanent')
    expect(res).toEqual({
      target: 'bash',
      pattern: 'git status *',
      isExternalDir: false,
    })
  })

  it('returns null if target or pattern is missing in colon syntax', () => {
    expect(parseAddPermissionInput('bash:', 'permanent')).toBeNull()
    expect(parseAddPermissionInput('  : pattern', 'permanent')).toBeNull()
  })

  it('detects external_directory target explicitly', () => {
    const res = parseAddPermissionInput(
      'external_directory: /var/log/**',
      'permanent'
    )
    expect(res).toEqual({
      target: 'external_directory',
      pattern: '/var/log/**',
      isExternalDir: true,
    })
  })

  it('detects external_dir target prefix', () => {
    const res = parseAddPermissionInput('external_dir: /tmp/**', 'permanent')
    expect(res).toEqual({
      target: 'external_dir',
      pattern: '/tmp/**',
      isExternalDir: true,
    })
  })

  it('identifies unix absolute paths and home paths as external_directory', () => {
    expect(parseAddPermissionInput('/var/log/**', 'permanent')).toEqual({
      target: 'external_directory',
      pattern: '/var/log/**',
      isExternalDir: true,
    })
    expect(parseAddPermissionInput('~/.ssh/**', 'session')).toEqual({
      target: 'external_directory',
      pattern: '~/.ssh/**',
      isExternalDir: true,
    })
  })

  it('identifies Windows drive letter paths as external_directory', () => {
    expect(parseAddPermissionInput('C:\\Users\\test\\**', 'permanent')).toEqual(
      {
        target: 'external_directory',
        pattern: 'C:\\Users\\test\\**',
        isExternalDir: true,
      }
    )
    expect(parseAddPermissionInput('d:/workspace/**', 'session')).toEqual({
      target: 'external_directory',
      pattern: 'd:/workspace/**',
      isExternalDir: true,
    })
  })

  it('does not treat paths with slashes before colon as target:pattern', () => {
    const res = parseAddPermissionInput('path/with:colon', 'permanent')
    expect(res).toEqual({
      target: 'bash',
      pattern: 'path/with:colon',
      isExternalDir: false,
    })
  })

  it('defaults target to bash for permanent and shell for session', () => {
    expect(parseAddPermissionInput('npm test', 'permanent')).toEqual({
      target: 'bash',
      pattern: 'npm test',
      isExternalDir: false,
    })
    expect(parseAddPermissionInput('npm test', 'session')).toEqual({
      target: 'shell',
      pattern: 'npm test',
      isExternalDir: false,
    })
  })
})

describe('PermissionsListModalView', () => {
  let tmpDir: string
  let configPath: string
  let sessionRules: SessionRules

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'pi-modal-test-'))
    configPath = join(tmpDir, 'config.json')
    const initialConfig = parseConfig({
      permissions: {
        tools: {
          bash: [
            { pattern: 'git status *', action: 'allow' },
            { pattern: 'npm test', action: 'allow' },
          ],
        },
        external_directory: {
          '/var/log/**': 'allow',
        },
      },
    })
    writeFileSync(configPath, JSON.stringify(initialConfig, null, 2))
    configState.set(initialConfig)

    resetSessionRulesRegistry()
    resetExternalDirAllowlist()
    sessionRules = new SessionRules()
  })

  afterEach(() => {
    resetSessionRulesRegistry()
    resetExternalDirAllowlist()
    resetUiRegistry()
    setUiContext(undefined, false)
    try {
      rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  it('renders permanent and session columns side-by-side for width >= 70', () => {
    sessionRules.approveForSession('shell', 'echo hi', 'allow')
    addExternalDirAllow('/tmp/ext')

    const view = new PermissionsListModalView({
      configState,
      sessionRules,
      configPath,
      onClose: jest.fn(),
    })

    const lines = view.render(80)
    expect(lines[0]).toBe('Permissions Manager')
    expect(
      lines.some(
        (l) =>
          l.includes('Permanent Permissions') &&
          l.includes('Session Permissions')
      )
    ).toBe(true)
    expect(lines.some((l) => l.includes('git status *'))).toBe(true)
    expect(lines.some((l) => l.includes('echo hi'))).toBe(true)
    expect(lines.some((l) => l.includes('ext'))).toBe(true)
    expect(
      lines.some((l) =>
        l.includes('←/→/tab column · ↑/↓ move · a add · d delete · esc/q close')
      )
    ).toBe(true)
  })

  it('renders stacked columns when width < 70', () => {
    const view = new PermissionsListModalView({
      configState,
      sessionRules,
      configPath,
      onClose: jest.fn(),
    })

    const lines = view.render(60)
    const permHeaderIdx = lines.findIndex((l) =>
      l.includes('Permanent Permissions')
    )
    const sessHeaderIdx = lines.findIndex((l) =>
      l.includes('Session Permissions')
    )
    expect(permHeaderIdx).toBeGreaterThan(-1)
    expect(sessHeaderIdx).toBeGreaterThan(permHeaderIdx)
  })

  it('renders (none) when a column has no permissions', () => {
    const emptyConfig = parseConfig({ permissions: {} })
    configState.set(emptyConfig)
    writeFileSync(configPath, JSON.stringify(emptyConfig, null, 2))

    const view = new PermissionsListModalView({
      configState,
      sessionRules,
      configPath,
      onClose: jest.fn(),
    })

    const lines = view.render(80)
    expect(lines.filter((l) => l.includes('(none)')).length).toBeGreaterThan(0)
  })

  it('highlights the active section header when theme is supplied', () => {
    const theme: GlobalTheme = {
      fg: (color, text) => `<${color}>${text}</${color}>`,
    }
    const view = new PermissionsListModalView({
      configState,
      sessionRules,
      configPath,
      onClose: jest.fn(),
      theme,
    })

    let lines = view.render(80)
    expect(lines.some((l) => l.includes('<accent>Permanent'))).toBe(true)
    expect(lines.some((l) => l.includes('<accent>Session'))).toBe(false)

    view.handleInput('right')
    lines = view.render(80)
    expect(lines.some((l) => l.includes('<accent>Session'))).toBe(true)
    expect(lines.some((l) => l.includes('<accent>Permanent'))).toBe(false)
  })

  it('switches columns with left/right/tab keys', () => {
    const view = new PermissionsListModalView({
      configState,
      sessionRules,
      configPath,
      onClose: jest.fn(),
    })

    expect(view.activeColumn).toBe('permanent')
    view.handleInput('right')
    expect(view.activeColumn).toBe('session')
    view.handleInput('left')
    expect(view.activeColumn).toBe('permanent')
    view.handleInput('\t')
    expect(view.activeColumn).toBe('session')
    view.handleInput('\t')
    expect(view.activeColumn).toBe('permanent')
  })

  it('navigates up and down with arrow keys and clamps bounds', () => {
    const view = new PermissionsListModalView({
      configState,
      sessionRules,
      configPath,
      onClose: jest.fn(),
    })

    expect(view.permanentIndex).toBe(0)
    view.handleInput('down')
    expect(view.permanentIndex).toBe(1)
    view.handleInput('down')
    expect(view.permanentIndex).toBe(2)
    view.handleInput('down')
    expect(view.permanentIndex).toBe(2) // clamped to max

    view.handleInput('up')
    expect(view.permanentIndex).toBe(1)
    view.handleInput('up')
    expect(view.permanentIndex).toBe(0)
    view.handleInput('up')
    expect(view.permanentIndex).toBe(0) // clamped to 0
  })

  it('ignores key release events without moving selection', () => {
    const view = new PermissionsListModalView({
      configState,
      sessionRules,
      configPath,
      onClose: jest.fn(),
    })

    view.handleInput('\x1b[A:3u')
    expect(view.permanentIndex).toBe(0)
  })

  it('calls requestRender on handleInput', () => {
    const requestRender = jest.fn()
    const view = new PermissionsListModalView({
      configState,
      sessionRules,
      configPath,
      onClose: jest.fn(),
      requestRender,
    })

    view.handleInput('down')
    expect(requestRender).toHaveBeenCalled()
  })

  it('deletes permanent permission with d key and updates config', () => {
    const view = new PermissionsListModalView({
      configState,
      sessionRules,
      configPath,
      onClose: jest.fn(),
    })

    const initialCount = view.getPermanentItems().length
    view.handleInput('d')
    const remainingCount = view.getPermanentItems().length
    expect(remainingCount).toBe(initialCount - 1)
    expect(view.statusMessage).toContain('Deleted permanent')

    const fileContent = JSON.parse(readFileSync(configPath, 'utf8'))
    expect(fileContent.permissions.tools.bash).toHaveLength(1)
  })

  it('deletes session rule with d key', () => {
    sessionRules.approveForSession('shell', 'echo first', 'allow')
    sessionRules.approveForSession('shell', 'echo second', 'allow')

    const view = new PermissionsListModalView({
      configState,
      sessionRules,
      configPath,
      onClose: jest.fn(),
    })

    view.handleInput('right') // switch to session
    expect(view.sessionIndex).toBe(0)
    view.handleInput('d')

    expect(sessionRules.snapshot()).toHaveLength(1)
    expect(sessionRules.snapshot()[0]?.pattern).toBe('echo second')
    expect(view.statusMessage).toContain('Deleted session')
  })

  it('deletes external directory session allowlist entry with d key', () => {
    addExternalDirAllow('/tmp/session-dir')
    const view = new PermissionsListModalView({
      configState,
      sessionRules,
      configPath,
      onClose: jest.fn(),
    })

    view.handleInput('right') // switch to session
    expect(
      view.getSessionItems().some((i) => i.pattern.includes('session-dir'))
    ).toBe(true)

    view.handleInput('d')
    expect(getExternalDirAllowlist()).toHaveLength(0)
    expect(view.statusMessage).toContain('Deleted session')
  })

  it('enters add mode with a key and cancels with escape', () => {
    const view = new PermissionsListModalView({
      configState,
      sessionRules,
      configPath,
      onClose: jest.fn(),
    })

    view.handleInput('a')
    expect(view.isAdding).toBe(true)
    const renderLines = view.render(80)
    expect(
      renderLines.some((l) => l.includes('Add to permanent') && l.includes('█'))
    ).toBe(true)

    view.handleInput('escape')
    expect(view.isAdding).toBe(false)
    expect(view.addBuffer).toBe('')
  })

  it('supports typing and backspacing in add buffer', () => {
    const view = new PermissionsListModalView({
      configState,
      sessionRules,
      configPath,
      onClose: jest.fn(),
    })

    view.handleInput('a')
    view.handleInput('n')
    view.handleInput('p')
    view.handleInput('m')
    view.handleInput(' ')
    expect(view.addBuffer).toBe('npm ')

    view.handleInput('backspace')
    expect(view.addBuffer).toBe('npm')
  })

  it('adds a permanent permission with tool:pattern syntax', () => {
    const view = new PermissionsListModalView({
      configState,
      sessionRules,
      configPath,
      onClose: jest.fn(),
    })

    view.handleInput('a')
    for (const ch of 'bash: git diff *') {
      view.handleInput(ch)
    }
    view.handleInput('\r')

    expect(view.isAdding).toBe(false)
    expect(view.statusMessage).toContain('Added permanent: git diff *')
    expect(
      view.getPermanentItems().some((i) => i.pattern === 'git diff *')
    ).toBe(true)

    const fileContent = JSON.parse(readFileSync(configPath, 'utf8'))
    expect(
      fileContent.permissions.tools.bash.some(
        (r: { pattern: string }) => r.pattern === 'git diff *'
      )
    ).toBe(true)
  })

  it('adds a permanent permission with default bash tool', () => {
    const view = new PermissionsListModalView({
      configState,
      sessionRules,
      configPath,
      onClose: jest.fn(),
    })

    view.handleInput('a')
    for (const ch of 'cargo check') {
      view.handleInput(ch)
    }
    view.handleInput('\r')

    expect(view.isAdding).toBe(false)
    expect(
      view
        .getPermanentItems()
        .some((i) => i.toolName === 'bash' && i.pattern === 'cargo check')
    ).toBe(true)
  })

  it('adds a permanent external directory permission', () => {
    const view = new PermissionsListModalView({
      configState,
      sessionRules,
      configPath,
      onClose: jest.fn(),
    })

    view.handleInput('a')
    for (const ch of '/opt/custom/**') {
      view.handleInput(ch)
    }
    view.handleInput('\r')

    expect(
      view
        .getPermanentItems()
        .some(
          (i) =>
            i.surface === 'external_directory' && i.pattern === '/opt/custom/**'
        )
    ).toBe(true)
  })

  it('adds a session rule in session column', () => {
    const view = new PermissionsListModalView({
      configState,
      sessionRules,
      configPath,
      onClose: jest.fn(),
    })

    view.handleInput('right') // switch to session
    view.handleInput('a')
    for (const ch of 'shell: echo hello') {
      view.handleInput(ch)
    }
    view.handleInput('\r')

    expect(
      sessionRules.snapshot().some((r) => r.pattern === 'echo hello')
    ).toBe(true)
    expect(view.statusMessage).toContain('Added session: echo hello')
  })

  it('adds an external directory in session column', () => {
    const view = new PermissionsListModalView({
      configState,
      sessionRules,
      configPath,
      onClose: jest.fn(),
    })

    view.handleInput('right') // switch to session
    view.handleInput('a')
    for (const ch of '/tmp/session-ext') {
      view.handleInput(ch)
    }
    view.handleInput('\r')

    expect(
      getExternalDirAllowlist().some((d) => d.includes('session-ext'))
    ).toBe(true)
    expect(view.statusMessage).toContain('Added session')
  })

  it('handles invalid add input without crashing', () => {
    const view = new PermissionsListModalView({
      configState,
      sessionRules,
      configPath,
      onClose: jest.fn(),
    })

    view.handleInput('a')
    view.handleInput(':')
    view.handleInput('\r')

    expect(view.isAdding).toBe(false)
    expect(view.statusMessage).toBe('Invalid permission input.')
  })

  it('calls onClose when pressing escape or q in browse mode', () => {
    const onClose = jest.fn()
    const view = new PermissionsListModalView({
      configState,
      sessionRules,
      configPath,
      onClose,
    })

    view.handleInput('escape')
    expect(onClose).toHaveBeenCalledTimes(1)

    view.handleInput('q')
    expect(onClose).toHaveBeenCalledTimes(2)

    view.handleInput('Q')
    expect(onClose).toHaveBeenCalledTimes(3)
  })
})

describe('openPermissionsListModal', () => {
  let sessionRules: SessionRules

  beforeEach(() => {
    resetSessionRulesRegistry()
    resetExternalDirAllowlist()
    resetUiRegistry()
    setUiContext(undefined, false)
    sessionRules = new SessionRules()
  })

  afterEach(() => {
    resetSessionRulesRegistry()
    resetExternalDirAllowlist()
    resetUiRegistry()
    setUiContext(undefined, false)
  })

  it('returns false when no UI is available', async () => {
    const res = await openPermissionsListModal({
      configState,
      sessionRules,
    })
    expect(res).toBe(false)
  })

  it('returns true when closed via onClose using supplied ui', async () => {
    let capturedComponent: CustomComponent | undefined
    let closeOverlayCalled = false

    const mockUi: ExtensionUI = {
      setStatus: jest.fn(),
      notify: jest.fn(),
      custom: jest.fn(
        <T = void>(
          render: (
            tui: unknown,
            theme: unknown,
            keybindings: unknown,
            done: (result: T) => void
          ) => CustomComponent | Promise<CustomComponent>
        ): Promise<T> => {
          const comp = render(
            null,
            { fg: (_c: string, t: string) => t },
            null,
            () => {
              closeOverlayCalled = true
            }
          )
          if ('then' in comp) {
            return Promise.reject(new Error('Unexpected async component'))
          }
          capturedComponent = comp
          return new Promise<T>((resolve) => {
            // resolve when closeOverlay is called
            const check = setInterval(() => {
              if (closeOverlayCalled) {
                clearInterval(check)
                resolve(undefined as T)
              }
            }, 10)
          })
        }
      ),
      select: jest.fn(),
      confirm: jest.fn(),
      input: jest.fn(),
    }

    const modalPromise = openPermissionsListModal({
      configState,
      sessionRules,
      ui: mockUi,
    })

    // Simulate user pressing 'q'
    expect(capturedComponent).toBeDefined()
    capturedComponent?.handleInput?.('q')

    const res = await modalPromise
    expect(res).toBe(true)
    expect(closeOverlayCalled).toBe(true)
  })

  it('borrows UI when session hasUI is false and bubble is configured', async () => {
    let closeOverlayCalled = false
    const parentUi: ExtensionUI = {
      setStatus: jest.fn(),
      notify: jest.fn(),
      custom: jest.fn(
        <T = void>(
          render: (
            tui: unknown,
            theme: unknown,
            keybindings: unknown,
            done: (result: T) => void
          ) => CustomComponent | Promise<CustomComponent>
        ): Promise<T> => {
          const comp = render(
            null,
            { fg: (_c: string, t: string) => t },
            null,
            () => {
              closeOverlayCalled = true
            }
          )
          ;(comp as CustomComponent).handleInput?.('escape')
          return Promise.resolve(undefined as T)
        }
      ),
      select: jest.fn(),
      confirm: jest.fn(),
      input: jest.fn(),
    }

    publishUi(parentUi)

    const cfg = parseConfig({ ui: { noUiAsks: 'bubble' } })
    configState.set(cfg)

    const res = await openPermissionsListModal({
      configState,
      sessionRules,
      hasUI: false,
    })

    expect(res).toBe(true)
    expect(parentUi.custom).toHaveBeenCalled()
  })

  it('returns true if custom rejects', async () => {
    const mockUi: ExtensionUI = {
      setStatus: jest.fn(),
      notify: jest.fn(),
      custom: jest.fn().mockRejectedValue(new Error('UI crashed')),
      select: jest.fn(),
      confirm: jest.fn(),
      input: jest.fn(),
    }

    const res = await openPermissionsListModal({
      configState,
      sessionRules,
      ui: mockUi,
    })

    expect(res).toBe(true)
  })
})
