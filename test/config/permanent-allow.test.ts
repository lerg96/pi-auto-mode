import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { persistPermanentAllow } from '../../src/config/permanent-allow.ts'
import { configState } from '../../src/state/config-state.ts'
import { DEFAULT_CONFIG } from '../../src/types/config.ts'

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
})
