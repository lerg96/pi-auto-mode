import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import {
  loadConfig,
  watchConfig,
  ConfigLoadError,
  isSecurityWeakening,
} from '../../src/config/config-loader.ts'
import { DEFAULT_CONFIG } from '../../src/types/config.ts'
import type { Config } from '../../src/types/config.ts'

// homedir() must point at a temp dir for resolveConfigPath tests so we don't
// touch the real user home. node:os caches its result on Windows, so we
// re-mock it per-test via jest.isolateModules + jest.doMock below.
let mockHomedir: string

function tmpFile(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'pi-auto-mode-'))
  return join(dir, name)
}

function cleanup(path: string): void {
  rmSync(path, { recursive: true, force: true })
}

describe('config-loader', () => {
  it('(a) loadConfig parses a valid temp JSON file and returns a Config', () => {
    const path = tmpFile('valid.json')
    writeFileSync(
      path,
      JSON.stringify({ telemetry: { enabled: true, path: 'out.log' } }),
      'utf8'
    )
    try {
      const cfg = loadConfig(path)
      expect(cfg.telemetry.enabled).toBe(true)
      expect(cfg.telemetry.path).toBe('out.log')
    } finally {
      cleanup(path)
    }
  })

  it('(b) loadConfig throws ConfigLoadError when the file does not exist', () => {
    expect(() => loadConfig(join(tmpdir(), 'does-not-exist-xyz.json'))).toThrow(
      ConfigLoadError
    )
  })

  it('(c) loadConfig throws ConfigLoadError on invalid JSON', () => {
    const path = tmpFile('invalid.json')
    writeFileSync(path, '{ not valid json ', 'utf8')
    try {
      expect(() => loadConfig(path)).toThrow(ConfigLoadError)
    } finally {
      cleanup(path)
    }
  })

  it('(d) watchConfig calls onChange when content changes', async () => {
    const path = tmpFile('watch.json')
    writeFileSync(path, JSON.stringify({ activePermissionSets: ['a'] }), 'utf8')
    let calls = 0
    const stop = watchConfig(path, () => {
      calls++
    })
    try {
      // Let the initial signature settle.
      await new Promise((r) => setTimeout(r, 700))
      writeFileSync(
        path,
        JSON.stringify({ activePermissionSets: ['b'] }),
        'utf8'
      )
      // Wait for at least one poll cycle after the change.
      await new Promise((r) => setTimeout(r, 1300))
      expect(calls).toBeGreaterThanOrEqual(1)
    } finally {
      stop()
      cleanup(path)
    }
  })

  it('(e) watchConfig invokes onError when content changes to invalid JSON', async () => {
    const path = tmpFile('watch-invalid.json')
    writeFileSync(path, JSON.stringify({ activePermissionSets: ['a'] }), 'utf8')
    let errors = 0
    const stop = watchConfig(
      path,
      () => {
        // should not be called on invalid reload
      },
      () => {
        errors++
      }
    )
    try {
      // Let the initial signature settle.
      await new Promise((r) => setTimeout(r, 700))
      writeFileSync(path, '{ not valid json ', 'utf8')
      // Wait for at least one poll cycle after the change.
      await new Promise((r) => setTimeout(r, 1300))
      expect(errors).toBeGreaterThanOrEqual(1)
    } finally {
      stop()
      cleanup(path)
    }
  })

  it('(f) M6: watchConfig does not loop when onChange throws', () => {
    jest.useFakeTimers()
    const path = tmpFile('watch-throw.json')
    writeFileSync(path, JSON.stringify({ activePermissionSets: ['a'] }), 'utf8')
    const onChange = jest.fn(() => {
      throw new Error('apply rejected')
    })
    const onError = jest.fn()
    const stop = watchConfig(path, onChange, onError)
    try {
      // Let the initial signature settle (file unchanged -> no call).
      jest.advanceTimersByTime(700)
      writeFileSync(
        path,
        JSON.stringify({ activePermissionSets: ['b'] }),
        'utf8'
      )
      // Advance past several poll cycles after the change.
      jest.advanceTimersByTime(2000)
      // onChange must fire exactly once and then NOT retry (signature locked).
      expect(onChange).toHaveBeenCalledTimes(1)
      expect(onError).toHaveBeenCalledTimes(1)
    } finally {
      stop()
      cleanup(path)
      jest.useRealTimers()
    }
  })

  it('(g) M4: loadConfig throws ConfigLoadError (with zod cause) on schema-invalid JSON', () => {
    const path = tmpFile('bad-schema.json')
    writeFileSync(
      path,
      JSON.stringify({ permissionSets: 'not-an-object' }),
      'utf8'
    )
    try {
      expect(() => loadConfig(path)).toThrow(ConfigLoadError)
      let cause: unknown
      try {
        loadConfig(path)
      } catch (e) {
        cause = (e as { cause?: unknown }).cause
      }
      // the underlying schema failure (zod) is preserved as the cause.
      expect(cause).toBeInstanceOf(Error)
    } finally {
      cleanup(path)
    }
  })

  it('(h) watchConfig retries on parse failure and is never stuck on stale config', () => {
    jest.useFakeTimers()
    const path = tmpFile('watch-retry.json')
    writeFileSync(path, JSON.stringify({ activePermissionSets: ['a'] }), 'utf8')
    const onChange = jest.fn()
    const onError = jest.fn()
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
    const stop = watchConfig(path, onChange, onError)
    try {
      // Let the initial valid signature settle (no onChange yet).
      jest.advanceTimersByTime(700)
      expect(onChange).not.toHaveBeenCalled()
      // Now write content that fails to parse.
      writeFileSync(path, '{ not valid json ', 'utf8')
      // Two poll cycles -> each re-attempts the load (last NOT locked to bad sig).
      jest.advanceTimersByTime(1000)
      expect(onError).toHaveBeenCalledTimes(2)
      expect(onChange).not.toHaveBeenCalled()
      expect(errSpy).toHaveBeenCalled()
      // Simulate the operator fixing the file -> the next tick must recover.
      writeFileSync(
        path,
        JSON.stringify({ activePermissionSets: ['b'] }),
        'utf8'
      )
      jest.advanceTimersByTime(600)
      expect(onChange).toHaveBeenCalledTimes(1)
    } finally {
      stop()
      cleanup(path)
      errSpy.mockRestore()
      jest.useRealTimers()
    }
  })

  it('(i) Fase 4: loads a config file with mode "deny-and-continue" and normalises to "auto-retry"', () => {
    // End-to-end: the on-disk JSON may still carry the legacy alias, but the
    // in-memory config (returned from the same loading path the extension
    // uses) must have the canonical name. This guards the parse pipeline, not
    // just the schema, so a regression in the loader that re-introduces the
    // alias would be caught here.
    const path = tmpFile('alias.json')
    writeFileSync(
      path,
      JSON.stringify({ denyStrategy: { mode: 'deny-and-continue' } }),
      'utf8'
    )
    try {
      const cfg = loadConfig(path)
      expect(cfg.denyStrategy.mode).toBe('auto-retry')
      // Sanity: the other side of the schema still holds.
      expect(['auto-retry', 'ask-user', 'both']).toContain(
        cfg.denyStrategy.mode
      )
    } finally {
      cleanup(path)
    }
  })

  it('(j) Fase 4: the canonical "auto-retry" name is also accepted in JSON', () => {
    // Mirror of (i) but for the new name — ensures we did not break the
    // canonical path while adding the alias.
    const path = tmpFile('canonical.json')
    writeFileSync(
      path,
      JSON.stringify({ denyStrategy: { mode: 'auto-retry' } }),
      'utf8'
    )
    try {
      const cfg = loadConfig(path)
      expect(cfg.denyStrategy.mode).toBe('auto-retry')
    } finally {
      cleanup(path)
    }
  })

  it('(k) Fase 4: the alias is still accepted on the FULL config path (no throw)', () => {
    // Defensive: a real config file with the legacy alias must not throw at
    // any stage of loadConfig. Catches cases where the schema change is
    // applied but the loader is not exercising the new transform.
    const path = tmpFile('legacy.json')
    writeFileSync(
      path,
      JSON.stringify({
        permissions: {
          tools: { bash: [{ pattern: 'rm -rf *', action: 'deny' }] },
        },
        activePermissionSets: [],
        denyStrategy: {
          mode: 'deny-and-continue',
          escalation: { consecutive: 3, total: 10 },
        },
      }),
      'utf8'
    )
    try {
      expect(() => loadConfig(path)).not.toThrow()
      const cfg = loadConfig(path)
      expect(cfg.denyStrategy.mode).toBe('auto-retry')
      expect(cfg.denyStrategy.escalation).toEqual({ consecutive: 3, total: 10 })
    } finally {
      cleanup(path)
    }
  })
})

describe('isSecurityWeakening (S3)', () => {
  it('flags disabling the classifier as weakening, and the reverse as not', () => {
    const secure = DEFAULT_CONFIG
    const weak: typeof DEFAULT_CONFIG = {
      ...DEFAULT_CONFIG,
      classifier: { ...DEFAULT_CONFIG.classifier, enabled: false },
    }
    expect(isSecurityWeakening(secure, weak)).toBe(true)
    expect(isSecurityWeakening(weak, secure)).toBe(false)
  })

  it('flags relaxing denyStrategy.mode to ask-user as weakening', () => {
    const secure: typeof DEFAULT_CONFIG = {
      ...DEFAULT_CONFIG,
      denyStrategy: { mode: 'both', escalation: { consecutive: 3, total: 20 } },
    }
    const weak: typeof DEFAULT_CONFIG = {
      ...secure,
      denyStrategy: { ...secure.denyStrategy, mode: 'ask-user' },
    }
    expect(isSecurityWeakening(secure, weak)).toBe(true)
    expect(isSecurityWeakening(weak, secure)).toBe(false)
  })

  it('flags a fail-open fallback (allow) as weakening, but not ask-user', () => {
    const secure = DEFAULT_CONFIG
    const weak: typeof DEFAULT_CONFIG = {
      ...DEFAULT_CONFIG,
      classifier: {
        ...DEFAULT_CONFIG.classifier,
        fallback: { ...DEFAULT_CONFIG.classifier.fallback, onError: 'allow' },
      },
    }
    expect(isSecurityWeakening(secure, weak)).toBe(true)

    const ask: typeof DEFAULT_CONFIG = {
      ...DEFAULT_CONFIG,
      classifier: {
        ...DEFAULT_CONFIG.classifier,
        fallback: {
          ...DEFAULT_CONFIG.classifier.fallback,
          onError: 'ask-user',
          onTimeout: 'ask-user',
        },
      },
    }
    expect(isSecurityWeakening(secure, ask)).toBe(false)
  })

  it('flags an injected allow that overrides a prior deny', () => {
    const prev: typeof DEFAULT_CONFIG = {
      ...DEFAULT_CONFIG,
      permissionSets: {
        s: {
          permissions: {
            tools: {
              bash: [{ pattern: 'rm -rf *', action: 'deny' }],
            },
          },
        },
      },
    }
    const next: typeof DEFAULT_CONFIG = {
      ...prev,
      permissionSets: {
        s: {
          permissions: {
            tools: {
              bash: [{ pattern: 'rm -rf *', action: 'allow' }],
            },
          },
        },
      },
    }
    expect(isSecurityWeakening(prev, next)).toBe(true)

    // Adding a brand-new allow on a previously-unrestricted surface is fine.
    const added: typeof DEFAULT_CONFIG = {
      ...prev,
      permissionSets: {
        ...prev.permissionSets,
        t: {
          permissions: {
            tools: {
              read: [{ pattern: '*.md', action: 'allow' }],
            },
          },
        },
      },
    }
    expect(isSecurityWeakening(prev, added)).toBe(false)
  })

  it('does not flag an equivalent secure reload', () => {
    expect(isSecurityWeakening(DEFAULT_CONFIG, DEFAULT_CONFIG)).toBe(false)
  })

  it('(A) does not crash on a malformed next config missing classifier.fallback', () => {
    // A raw override that skipped parseConfig (and thus the fallback defaults)
    // must not throw, and must resolve fail-closed to 'deny'.
    const nextMalformed = {
      ...DEFAULT_CONFIG,
      classifier: {
        ...DEFAULT_CONFIG.classifier,
        // fallback intentionally omitted
      },
    } as unknown as Config
    expect(() =>
      isSecurityWeakening(DEFAULT_CONFIG, nextMalformed)
    ).not.toThrow()
    expect(isSecurityWeakening(DEFAULT_CONFIG, nextMalformed)).toBe(false)
  })
})

describe('resolveConfigPath', () => {
  // We re-import config-loader inside isolateModules + jest.doMock('node:os')
  // so that homedir() resolves to the per-test temp dir (node:os caches its
  // result, so the mock has to be installed before the module is loaded).
  let homeDir: string
  let extensionDir: string
  let prevEnv: string | undefined
  // Loaded inside beforeEach via isolateModules:
  let mod: typeof import('../../src/config/config-loader.ts')
  let fsMocked: typeof import('node:fs')

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'pi-am-home-'))
    extensionDir = mkdtempSync(join(tmpdir(), 'pi-am-ext-'))
    mockHomedir = homeDir
    prevEnv = process.env.PI_AUTO_MODE_CONFIG
    delete process.env.PI_AUTO_MODE_CONFIG
  })

  afterEach(() => {
    if (prevEnv === undefined) delete process.env.PI_AUTO_MODE_CONFIG
    else process.env.PI_AUTO_MODE_CONFIG = prevEnv
    rmSync(homeDir, { recursive: true, force: true })
    rmSync(extensionDir, { recursive: true, force: true })
  })

  function loadWithMock(): void {
    let isolated!: typeof import('../../src/config/config-loader.ts')
    let isolatedFs!: typeof import('node:fs')
    jest.isolateModules(() => {
      jest.doMock('node:os', () => {
        const actual = jest.requireActual('node:os')
        return { ...actual, homedir: () => mockHomedir }
      })
      isolated = require('../../src/config/config-loader.ts')
      isolatedFs = require('node:fs')
    })
    mod = isolated
    fsMocked = isolatedFs
  }

  it('(1) uses PI_AUTO_MODE_CONFIG when defined', () => {
    loadWithMock()
    const custom = join(extensionDir, 'custom.json')
    fsMocked.writeFileSync(
      custom,
      JSON.stringify({ activePermissionSets: ['a'] }),
      'utf8'
    )
    process.env.PI_AUTO_MODE_CONFIG = custom
    const notify = jest.fn()
    const res = mod.resolveConfigPath({ extensionDir, notify })
    expect(res).toEqual({ path: custom, seeded: false })
    expect(notify).not.toHaveBeenCalled()
  })

  it('(2) uses ~/.pi/pi-auto-mode.json when it exists', () => {
    loadWithMock()
    const userConfig = join(homeDir, '.pi', 'pi-auto-mode.json')
    fsMocked.mkdirSync(join(homeDir, '.pi'), { recursive: true })
    fsMocked.writeFileSync(
      userConfig,
      JSON.stringify({ activePermissionSets: ['b'] }),
      'utf8'
    )
    const notify = jest.fn()
    const res = mod.resolveConfigPath({ extensionDir, notify })
    expect(res).toEqual({ path: userConfig, seeded: false })
    expect(notify).not.toHaveBeenCalled()
  })

  it('(3) copies config.example.json to ~/.pi/pi-auto-mode.json when user config is missing', () => {
    loadWithMock()
    const examplePath = join(extensionDir, 'config.example.json')
    const exampleContent = JSON.stringify({ activePermissionSets: ['seeded'] })
    fsMocked.writeFileSync(examplePath, exampleContent, 'utf8')

    const notify = jest.fn()
    const res = mod.resolveConfigPath({ extensionDir, notify })

    const expected = join(homeDir, '.pi', 'pi-auto-mode.json')
    expect(res.path).toBe(expected)
    expect(res.seeded).toBe(true)
    expect(fsMocked.existsSync(expected)).toBe(true)
    expect(fsMocked.readFileSync(expected, 'utf8')).toBe(exampleContent)
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0][0]).toBe('info')
    expect(String(notify.mock.calls[0][1])).toMatch(/seeded/i)
  })

  it('(4) throws ConfigLoadError when no env, no user config, and no example', () => {
    loadWithMock()
    const notify = jest.fn()
    let caught: unknown
    try {
      mod.resolveConfigPath({ extensionDir, notify })
    } catch (e) {
      caught = e
    }
    // isolateModules re-evaluates config-loader.ts and produces a distinct
    // ConfigLoadError class, so cross-module `instanceof` would fail. The
    // error class sets `name = 'ConfigLoadError'` — assert on that instead.
    expect((caught as Error).name).toBe('ConfigLoadError')
    expect(caught).toBeInstanceOf(Error)
    expect(String((caught as Error).message)).toMatch(/no config found/)
    expect(String((caught as Error).message)).toMatch(/PI_AUTO_MODE_CONFIG/)
    expect(notify).not.toHaveBeenCalled()
  })

  it('does not overwrite an existing user config when an example is also present', () => {
    loadWithMock()
    const userConfig = join(homeDir, '.pi', 'pi-auto-mode.json')
    fsMocked.mkdirSync(join(homeDir, '.pi'), { recursive: true })
    const userContent = JSON.stringify({ activePermissionSets: ['user'] })
    fsMocked.writeFileSync(userConfig, userContent, 'utf8')
    fsMocked.writeFileSync(
      join(extensionDir, 'config.example.json'),
      JSON.stringify({ activePermissionSets: ['example'] }),
      'utf8'
    )

    const res = mod.resolveConfigPath({ extensionDir })
    expect(res).toEqual({ path: userConfig, seeded: false })
    expect(fsMocked.readFileSync(userConfig, 'utf8')).toBe(userContent)
  })

  it('(3b) walks up from extensionDir to find config.example.json in a parent dir', () => {
    // Real-world shape: the entry point is <repo>/src/index.ts, but the
    // shipped example lives at <repo>/config.example.json. extensionDir is
    // the src/ dir, and the seed must still find the example.
    loadWithMock()
    const userConfig = join(homeDir, '.pi', 'pi-auto-mode.json')
    // Place the example one level up from the synthetic extensionDir.
    const parentDir = dirname(extensionDir)
    const examplePath = join(parentDir, 'config.example.json')
    const exampleContent = JSON.stringify({
      activePermissionSets: ['example-from-parent'],
    })
    fsMocked.writeFileSync(examplePath, exampleContent, 'utf8')

    const res = mod.resolveConfigPath({ extensionDir })
    expect(res).toEqual({ path: userConfig, seeded: true })
    expect(fsMocked.readFileSync(userConfig, 'utf8')).toBe(exampleContent)

    // Cleanup the parent so other tests are isolated.
    fsMocked.unlinkSync(examplePath)
  })
})
