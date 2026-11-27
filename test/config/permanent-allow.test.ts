import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  persistPermanentAllow,
  listPermanentPermissions,
  removePermanentAllow,
} from '../../src/config/permanent-allow.ts'
import { configState } from '../../src/state/config-state.ts'
import { DEFAULT_CONFIG, parseConfig } from '../../src/types/config.ts'
import { evaluatePermission } from '../../src/permission/visibility.ts'

describe('persistPermanentAllow', () => {
  let tmpDir: string
  let configPath: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'pi-permanent-allow-test-'))
    configPath = join(tmpDir, 'pi-auto-mode.json')
    configState.set(DEFAULT_CONFIG)
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('persists permanent allow for a tool when permissions.tools is empty', () => {
    writeFileSync(configPath, JSON.stringify({ mode: 'default' }, null, 2))

    persistPermanentAllow({
      surface: 'shell',
      pattern: 'echo hello',
      toolName: 'bash',
      configPath,
    })

    const onDisk = JSON.parse(readFileSync(configPath, 'utf8'))
    expect(onDisk.permissions.tools.bash).toEqual([
      { pattern: 'echo hello', action: 'allow' },
    ])

    const inMemory = configState.get()
    expect(inMemory.permissions.tools?.bash).toEqual([
      { pattern: 'echo hello', action: 'allow' },
    ])
  })

  it('converts a string action tool permission to pattern rules with catch-all', () => {
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          permissions: {
            tools: {
              bash: 'ask',
            },
          },
        },
        null,
        2
      )
    )

    persistPermanentAllow({
      surface: 'shell',
      pattern: 'npm test',
      toolName: 'bash',
      configPath,
    })

    const onDisk = JSON.parse(readFileSync(configPath, 'utf8'))
    expect(onDisk.permissions.tools.bash).toEqual([
      { pattern: 'npm test', action: 'allow' },
      { pattern: '*', action: 'ask' },
    ])

    const inMemory = configState.get()
    expect(inMemory.permissions.tools?.bash).toEqual([
      { pattern: 'npm test', action: 'allow' },
      { pattern: '*', action: 'ask' },
    ])
  })

  it('prepends to an existing array of pattern rules without duplicating', () => {
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          permissions: {
            tools: {
              bash: [{ pattern: 'git status', action: 'allow' }],
            },
          },
        },
        null,
        2
      )
    )

    persistPermanentAllow({
      surface: 'shell',
      pattern: 'git diff',
      toolName: 'bash',
      configPath,
    })

    let onDisk = JSON.parse(readFileSync(configPath, 'utf8'))
    expect(onDisk.permissions.tools.bash).toEqual([
      { pattern: 'git diff', action: 'allow' },
      { pattern: 'git status', action: 'allow' },
    ])

    // Call again with the same pattern to ensure no duplicates
    persistPermanentAllow({
      surface: 'shell',
      pattern: 'git diff',
      toolName: 'bash',
      configPath,
    })

    onDisk = JSON.parse(readFileSync(configPath, 'utf8'))
    expect(onDisk.permissions.tools.bash).toHaveLength(2)
  })

  it('persists permanent allow for external directory', () => {
    writeFileSync(configPath, JSON.stringify({ mode: 'default' }, null, 2))

    persistPermanentAllow({
      surface: 'external_directory',
      pattern: '/var/log/**',
      configPath,
    })

    const onDisk = JSON.parse(readFileSync(configPath, 'utf8'))
    expect(onDisk.permissions.external_directory['/var/log/**']).toBe('allow')

    const inMemory = configState.get()
    expect(inMemory.permissions.external_directory?.['/var/log/**']).toBe(
      'allow'
    )
  })

  it('supports isExternalDir flag even if surface is not external_directory', () => {
    writeFileSync(configPath, JSON.stringify({ mode: 'default' }, null, 2))

    persistPermanentAllow({
      surface: 'external_dir:bash',
      pattern: '/opt/project/**',
      isExternalDir: true,
      configPath,
    })

    const onDisk = JSON.parse(readFileSync(configPath, 'utf8'))
    expect(onDisk.permissions.external_directory['/opt/project/**']).toBe(
      'allow'
    )
  })

  it('updates both global permissions.tools and activePermissionSets tools to prevent shadowing', () => {
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          activePermissionSets: ['dev'],
          permissionSets: {
            dev: {
              permissions: {
                tools: {
                  bash: [{ pattern: '*', action: 'ask' }],
                },
              },
            },
          },
        },
        null,
        2
      )
    )

    persistPermanentAllow({
      surface: 'shell',
      pattern: 'npm test',
      toolName: 'bash',
      configPath,
    })

    const onDisk = JSON.parse(readFileSync(configPath, 'utf8'))
    expect(onDisk.permissions.tools.bash).toEqual([
      { pattern: 'npm test', action: 'allow' },
    ])
    expect(onDisk.permissionSets.dev.permissions.tools.bash).toEqual([
      { pattern: 'npm test', action: 'allow' },
      { pattern: '*', action: 'ask' },
    ])

    const evalResult = evaluatePermission(
      configState.get(),
      'tools',
      'bash',
      'npm test'
    )
    expect(evalResult.action).toBe('allow')
  })

  it('updates external_directory in activePermissionSets if existing key matches pattern', () => {
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          activePermissionSets: ['dev'],
          permissionSets: {
            dev: {
              permissions: {
                external_directory: {
                  '/opt/project/**': 'ask',
                },
              },
            },
          },
        },
        null,
        2
      )
    )

    persistPermanentAllow({
      surface: 'external_directory',
      pattern: '/opt/project/**',
      configPath,
    })

    const onDisk = JSON.parse(readFileSync(configPath, 'utf8'))
    expect(onDisk.permissions.external_directory['/opt/project/**']).toBe(
      'allow'
    )
    expect(
      onDisk.permissionSets.dev.permissions.external_directory[
        '/opt/project/**'
      ]
    ).toBe('allow')
  })
})

describe('listPermanentPermissions', () => {
  it('returns empty array when permissions are empty', () => {
    expect(listPermanentPermissions(DEFAULT_CONFIG)).toEqual([])
  })

  it('lists global tools permissions (both string action and array of pattern rules)', () => {
    const cfg = parseConfig({
      permissions: {
        tools: {
          read: 'allow',
          bash: [
            { pattern: 'npm test', action: 'allow' },
            { pattern: '*', action: 'ask' },
          ],
        },
      },
    })
    const entries = listPermanentPermissions(cfg)
    expect(entries).toEqual([
      {
        surface: 'tools',
        toolName: 'read',
        pattern: '*',
        action: 'allow',
        source: 'global',
      },
      {
        surface: 'tools',
        toolName: 'bash',
        pattern: 'npm test',
        action: 'allow',
        source: 'global',
      },
      {
        surface: 'tools',
        toolName: 'bash',
        pattern: '*',
        action: 'ask',
        source: 'global',
      },
    ])
  })

  it('lists global external_directory permissions', () => {
    const cfg = parseConfig({
      permissions: {
        external_directory: {
          '/opt/**': 'allow',
        },
      },
    })
    const entries = listPermanentPermissions(cfg)
    expect(entries).toEqual([
      {
        surface: 'external_directory',
        toolName: 'external_directory',
        pattern: '/opt/**',
        action: 'allow',
        source: 'global',
      },
    ])
  })

  it('lists permissions from activePermissionSets and tags them with setId', () => {
    const cfg = parseConfig({
      activePermissionSets: ['dev'],
      permissionSets: {
        dev: {
          permissions: {
            tools: {
              git: [{ pattern: 'git status', action: 'allow' }],
            },
            external_directory: {
              '/mnt/shared/**': 'ask',
            },
          },
        },
        inactive: {
          permissions: {
            tools: {
              docker: 'allow',
            },
          },
        },
      },
    })
    const entries = listPermanentPermissions(cfg)
    expect(entries).toEqual([
      {
        surface: 'tools',
        toolName: 'git',
        pattern: 'git status',
        action: 'allow',
        source: 'dev',
      },
      {
        surface: 'external_directory',
        toolName: 'external_directory',
        pattern: '/mnt/shared/**',
        action: 'ask',
        source: 'dev',
      },
    ])
  })

  it('deduplicates entries across global and active sets (first occurrence wins)', () => {
    const cfg = parseConfig({
      permissions: {
        tools: {
          bash: [{ pattern: 'npm test', action: 'allow' }],
        },
        external_directory: {
          '/tmp/**': 'allow',
        },
      },
      activePermissionSets: ['dev'],
      permissionSets: {
        dev: {
          permissions: {
            tools: {
              bash: [{ pattern: 'npm test', action: 'allow' }],
            },
            external_directory: {
              '/tmp/**': 'allow',
            },
          },
        },
      },
    })
    const entries = listPermanentPermissions(cfg)
    expect(entries).toHaveLength(2)
    expect(entries[0]).toEqual({
      surface: 'tools',
      toolName: 'bash',
      pattern: 'npm test',
      action: 'allow',
      source: 'global',
    })
    expect(entries[1]).toEqual({
      surface: 'external_directory',
      toolName: 'external_directory',
      pattern: '/tmp/**',
      action: 'allow',
      source: 'global',
    })
  })
})

describe('removePermanentAllow', () => {
  let tmpDir: string
  let configPath: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'pi-remove-permanent-allow-test-'))
    configPath = join(tmpDir, 'pi-auto-mode.json')
    configState.set(DEFAULT_CONFIG)
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('removes a tool pattern rule from array and writes to disk and configState', () => {
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          permissions: {
            tools: {
              bash: [
                { pattern: 'npm test', action: 'allow' },
                { pattern: 'git status', action: 'allow' },
              ],
            },
          },
        },
        null,
        2
      )
    )

    const removed = removePermanentAllow({
      surface: 'shell',
      pattern: 'npm test',
      toolName: 'bash',
      configPath,
    })
    expect(removed).toBe(true)

    const onDisk = JSON.parse(readFileSync(configPath, 'utf8'))
    expect(onDisk.permissions.tools.bash).toEqual([
      { pattern: 'git status', action: 'allow' },
    ])

    const inMemory = configState.get()
    expect(inMemory.permissions.tools?.bash).toEqual([
      { pattern: 'git status', action: 'allow' },
    ])
  })

  it('deletes the tool key when the pattern array becomes empty', () => {
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          permissions: {
            tools: {
              bash: [{ pattern: 'npm test', action: 'allow' }],
            },
          },
        },
        null,
        2
      )
    )

    const removed = removePermanentAllow({
      surface: 'shell',
      pattern: 'npm test',
      toolName: 'bash',
      configPath,
    })
    expect(removed).toBe(true)

    const onDisk = JSON.parse(readFileSync(configPath, 'utf8'))
    expect(onDisk.permissions.tools?.bash).toBeUndefined()

    const inMemory = configState.get()
    expect(inMemory.permissions.tools?.bash).toBeUndefined()
  })

  it('deletes the tool key when tool permission is a string action and pattern is *', () => {
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          permissions: {
            tools: {
              bash: 'allow',
            },
          },
        },
        null,
        2
      )
    )

    const removed = removePermanentAllow({
      surface: 'tools',
      pattern: '*',
      toolName: 'bash',
      configPath,
    })
    expect(removed).toBe(true)

    const onDisk = JSON.parse(readFileSync(configPath, 'utf8'))
    expect(onDisk.permissions.tools?.bash).toBeUndefined()

    const inMemory = configState.get()
    expect(inMemory.permissions.tools?.bash).toBeUndefined()
  })

  it('returns false when tool permission is a string action and pattern is not *', () => {
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          permissions: {
            tools: {
              bash: 'allow',
            },
          },
        },
        null,
        2
      )
    )

    const removed = removePermanentAllow({
      surface: 'tools',
      pattern: 'npm test',
      toolName: 'bash',
      configPath,
    })
    expect(removed).toBe(false)

    const onDisk = JSON.parse(readFileSync(configPath, 'utf8'))
    expect(onDisk.permissions.tools.bash).toBe('allow')
  })

  it('removes external directory permission', () => {
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          permissions: {
            external_directory: {
              '/var/log/**': 'allow',
              '/tmp/**': 'allow',
            },
          },
        },
        null,
        2
      )
    )

    const removed = removePermanentAllow({
      surface: 'external_directory',
      pattern: '/var/log/**',
      configPath,
    })
    expect(removed).toBe(true)

    const onDisk = JSON.parse(readFileSync(configPath, 'utf8'))
    expect(onDisk.permissions.external_directory['/var/log/**']).toBeUndefined()
    expect(onDisk.permissions.external_directory['/tmp/**']).toBe('allow')

    const inMemory = configState.get()
    expect(
      inMemory.permissions.external_directory?.['/var/log/**']
    ).toBeUndefined()
    expect(inMemory.permissions.external_directory?.['/tmp/**']).toBe('allow')
  })

  it('removes rule from both global and active permission sets', () => {
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          permissions: {
            tools: {
              bash: [{ pattern: 'npm test', action: 'allow' }],
            },
            external_directory: {
              '/var/log/**': 'allow',
            },
          },
          activePermissionSets: ['dev'],
          permissionSets: {
            dev: {
              permissions: {
                tools: {
                  bash: [{ pattern: 'npm test', action: 'allow' }],
                },
                external_directory: {
                  '/var/log/**': 'allow',
                },
              },
            },
          },
        },
        null,
        2
      )
    )

    expect(
      removePermanentAllow({
        surface: 'shell',
        pattern: 'npm test',
        toolName: 'bash',
        configPath,
      })
    ).toBe(true)

    expect(
      removePermanentAllow({
        surface: 'external_directory',
        pattern: '/var/log/**',
        configPath,
      })
    ).toBe(true)

    const onDisk = JSON.parse(readFileSync(configPath, 'utf8'))
    expect(onDisk.permissions.tools?.bash).toBeUndefined()
    expect(onDisk.permissionSets.dev.permissions.tools?.bash).toBeUndefined()
    expect(
      onDisk.permissions.external_directory?.['/var/log/**']
    ).toBeUndefined()
    expect(
      onDisk.permissionSets.dev.permissions.external_directory?.['/var/log/**']
    ).toBeUndefined()
  })

  it('returns false when rule does not exist', () => {
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          permissions: {
            tools: {
              bash: [{ pattern: 'npm test', action: 'allow' }],
            },
          },
        },
        null,
        2
      )
    )

    const removed = removePermanentAllow({
      surface: 'shell',
      pattern: 'different command',
      toolName: 'bash',
      configPath,
    })
    expect(removed).toBe(false)
  })

  it('falls back to configState when file does not exist on disk', () => {
    configState.set(
      parseConfig({
        permissions: {
          tools: {
            bash: [{ pattern: 'npm test', action: 'allow' }],
          },
        },
      })
    )

    const nonexistentPath = join(tmpDir, 'does-not-exist.json')
    const removed = removePermanentAllow({
      surface: 'shell',
      pattern: 'npm test',
      toolName: 'bash',
      configPath: nonexistentPath,
    })

    expect(removed).toBe(true)
    expect(existsSync(nonexistentPath)).toBe(true)
    expect(configState.get().permissions.tools?.bash).toBeUndefined()
  })

  it('supports isExternalDir flag and external_dir: prefix', () => {
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          permissions: {
            external_directory: {
              '/opt/**': 'allow',
            },
          },
        },
        null,
        2
      )
    )

    const removed = removePermanentAllow({
      surface: 'external_dir:bash',
      pattern: '/opt/**',
      isExternalDir: true,
      configPath,
    })
    expect(removed).toBe(true)

    const onDisk = JSON.parse(readFileSync(configPath, 'utf8'))
    expect(onDisk.permissions.external_directory['/opt/**']).toBeUndefined()
  })
})
