import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  parseConfig,
  DEFAULT_CONFIG,
  DEFAULT_ROTATION_MAX_BYTES,
  DEFAULT_ROTATION_MAX_FILES,
} from '../../src/types/config.ts'

const EXAMPLE_PATH = resolve(__dirname, '../../config.example.json')

describe('parseConfig defaults', () => {
  it("defaults denyStrategy.mode to 'both' (fail-closed-ish: escalates to block)", () => {
    expect(parseConfig({}).denyStrategy.mode).toBe('both')
  })

  it("defaults mode to 'default'", () => {
    expect(parseConfig({}).mode).toBe('default')
  })

  it('defaults classifier.enabled to true', () => {
    expect(parseConfig({}).classifier.enabled).toBe(true)
  })

  it('defaults classifier.onBlock to "deny"', () => {
    expect(parseConfig({}).classifier.onBlock).toBe('deny')
  })

  it('defaults classifier.onBlockUserOverride to false', () => {
    expect(parseConfig({}).classifier.onBlockUserOverride).toBe(false)
  })

  it('defaults classifier.fallback to ask-user', () => {
    expect(parseConfig({}).classifier.fallback.onTimeout).toBe('ask-user')
    expect(parseConfig({}).classifier.fallback.onError).toBe('ask-user')
  })
})

describe('log rotation config (telemetry + debug)', () => {
  it('defaults maxBytes to 5 MiB and maxFiles to 3 for BOTH blocks', () => {
    const cfg = parseConfig({})
    expect(DEFAULT_ROTATION_MAX_BYTES).toBe(5 * 1024 * 1024)
    expect(DEFAULT_ROTATION_MAX_FILES).toBe(3)
    expect(cfg.telemetry.maxBytes).toBe(DEFAULT_ROTATION_MAX_BYTES)
    expect(cfg.telemetry.maxFiles).toBe(DEFAULT_ROTATION_MAX_FILES)
    expect(cfg.debug.maxBytes).toBe(DEFAULT_ROTATION_MAX_BYTES)
    expect(cfg.debug.maxFiles).toBe(DEFAULT_ROTATION_MAX_FILES)
  })

  it('parses explicit maxBytes/maxFiles on both blocks', () => {
    const cfg = parseConfig({
      telemetry: { maxBytes: 1024, maxFiles: 1 },
      debug: { maxBytes: 2048, maxFiles: 5 },
    })
    expect(cfg.telemetry.maxBytes).toBe(1024)
    expect(cfg.telemetry.maxFiles).toBe(1)
    expect(cfg.debug.maxBytes).toBe(2048)
    expect(cfg.debug.maxFiles).toBe(5)
  })

  // Shared shape: both schemas compose the SAME rotationFields object, so
  // invalid values must be rejected identically by both blocks.
  for (const bad of [0, -1, 1.5, '1024']) {
    it(`rejects maxBytes=${JSON.stringify(bad)} on telemetry AND debug (shared schema)`, () => {
      expect(() => parseConfig({ telemetry: { maxBytes: bad } })).toThrow()
      expect(() => parseConfig({ debug: { maxBytes: bad } })).toThrow()
    })
    it(`rejects maxFiles=${JSON.stringify(bad)} on telemetry AND debug (shared schema)`, () => {
      expect(() => parseConfig({ telemetry: { maxFiles: bad } })).toThrow()
      expect(() => parseConfig({ debug: { maxFiles: bad } })).toThrow()
    })
  }

  it('config.example.json carries the rotation defaults', () => {
    const raw = JSON.parse(readFileSync(EXAMPLE_PATH, 'utf8'))
    expect(raw.telemetry.maxBytes).toBe(DEFAULT_ROTATION_MAX_BYTES)
    expect(raw.telemetry.maxFiles).toBe(DEFAULT_ROTATION_MAX_FILES)
    expect(raw.debug.maxBytes).toBe(DEFAULT_ROTATION_MAX_BYTES)
    expect(raw.debug.maxFiles).toBe(DEFAULT_ROTATION_MAX_FILES)
  })

  it('DEFAULT_CONFIG exposes the rotation fields', () => {
    expect(DEFAULT_CONFIG.telemetry.maxBytes).toBe(DEFAULT_ROTATION_MAX_BYTES)
    expect(DEFAULT_CONFIG.debug.maxFiles).toBe(DEFAULT_ROTATION_MAX_FILES)
  })
})

describe('config.example.json (no drift vs schema defaults)', () => {
  it('is parseable by the zod schema', () => {
    const raw = JSON.parse(readFileSync(EXAMPLE_PATH, 'utf8'))
    expect(() => parseConfig(raw)).not.toThrow()
    const cfg = parseConfig(raw)
    // Verify key fields are present
    expect(cfg.permissionSets).toBeDefined()
    expect(cfg.activePermissionSets).toBeDefined()
    expect(cfg.permissions).toBeDefined()
    expect(cfg.classifier).toBeDefined()
    expect(cfg.denyStrategy).toBeDefined()
    expect(cfg.ui).toBeDefined()
    expect(cfg.telemetry).toBeDefined()
  })

  it('has no root-level tools map (removed in Phase 1)', () => {
    const raw = JSON.parse(readFileSync(EXAMPLE_PATH, 'utf8'))
    expect(raw.tools).toBeUndefined()
  })

  it('permissionSets use permissions block (no priority, no rules)', () => {
    const raw = JSON.parse(readFileSync(EXAMPLE_PATH, 'utf8'))
    for (const set of Object.values(raw.permissionSets)) {
      expect((set as any).priority).toBeUndefined()
      expect((set as any).rules).toBeUndefined()
      expect((set as any).tools).toBeUndefined()
      expect((set as any).skills).toBeUndefined()
      expect((set as any).permissions).toBeDefined()
    }
  })

  it('classifier has no ruleBased (removed in Phase 1)', () => {
    const raw = JSON.parse(readFileSync(EXAMPLE_PATH, 'utf8'))
    expect(raw.classifier.ruleBased).toBeUndefined()
  })
})

describe('ui.modalTimeoutMs', () => {
  it('defaults to 120000 (2 min) when omitted', () => {
    expect(parseConfig({}).ui.modalTimeoutMs).toBe(120000)
  })

  it('accepts -1 (unlimited / no timeout)', () => {
    const cfg = parseConfig({ ui: { modalTimeoutMs: -1 } })
    expect(cfg.ui.modalTimeoutMs).toBe(-1)
  })

  it('parses correctly from a config.example.json-style input', () => {
    const raw = JSON.parse(readFileSync(EXAMPLE_PATH, 'utf8'))
    const cfg = parseConfig(raw)
    expect(cfg.ui.modalTimeoutMs).toBe(120000)
  })
})

describe('externalDirectoryTools', () => {
  it("defaults to ['*'] (todas las tools) para no perder validación al subir de versión", () => {
    expect(parseConfig({}).externalDirectoryTools).toEqual(['*'])
    expect(DEFAULT_CONFIG.externalDirectoryTools).toEqual(['*'])
  })

  it('acepta una lista de nombres y globs', () => {
    const cfg = parseConfig({
      externalDirectoryTools: ['bash', 'write', 'mcp__*'],
    })
    expect(cfg.externalDirectoryTools).toEqual(['bash', 'write', 'mcp__*'])
  })

  it('acepta [] explícito (capa apagada para todas las tools)', () => {
    expect(
      parseConfig({ externalDirectoryTools: [] }).externalDirectoryTools
    ).toEqual([])
  })

  it('rechaza strings vacíos y valores que no son strings', () => {
    expect(() => parseConfig({ externalDirectoryTools: [''] })).toThrow()
    expect(() => parseConfig({ externalDirectoryTools: [42] })).toThrow()
    expect(() => parseConfig({ externalDirectoryTools: 'bash' })).toThrow()
  })

  it('config.example.json lista bash, write, edit y read', () => {
    const raw = JSON.parse(readFileSync(EXAMPLE_PATH, 'utf8'))
    expect(parseConfig(raw).externalDirectoryTools).toEqual([
      'bash',
      'write',
      'edit',
      'read',
    ])
  })
})

describe('ui.subagentModalTimeoutMs', () => {
  it('defaults to 120000 (2 min) when omitted', () => {
    expect(parseConfig({}).ui.subagentModalTimeoutMs).toBe(120000)
  })

  it('acepta -1 (ilimitado) y valores distintos a modalTimeoutMs', () => {
    const cfg = parseConfig({
      ui: { modalTimeoutMs: -1, subagentModalTimeoutMs: 30000 },
    })
    expect(cfg.ui.modalTimeoutMs).toBe(-1)
    expect(cfg.ui.subagentModalTimeoutMs).toBe(30000)
  })

  it('rechaza no-enteros (mismo contrato que modalTimeoutMs)', () => {
    expect(() => parseConfig({ ui: { subagentModalTimeoutMs: 1.5 } })).toThrow()
  })

  it('config.example.json trae la clave explícita', () => {
    const raw = JSON.parse(readFileSync(EXAMPLE_PATH, 'utf8'))
    expect(parseConfig(raw).ui.subagentModalTimeoutMs).toBe(120000)
  })
})

describe('ui.noUiAsks', () => {
  it("defaults to 'bubble' (sub-sesiones sin UI usan la UI del padre)", () => {
    expect(parseConfig({}).ui.noUiAsks).toBe('bubble')
  })

  it("acepta 'deny' (comportamiento histórico: denegar sin preguntar)", () => {
    expect(parseConfig({ ui: { noUiAsks: 'deny' } }).ui.noUiAsks).toBe('deny')
  })

  it('rechaza valores desconocidos (fail-closed en la carga de config)', () => {
    expect(() => parseConfig({ ui: { noUiAsks: 'yolo' } })).toThrow()
  })

  it('config.example.json sigue parseando con la clave nueva', () => {
    const raw = JSON.parse(readFileSync(EXAMPLE_PATH, 'utf8'))
    expect(parseConfig(raw).ui.noUiAsks).toBe('bubble')
  })
})

describe('telemetry default path', () => {
  it('defaults telemetry.path to ~/.pi/pi-auto-mode.jsonl when the field is missing', () => {
    const cfg = parseConfig({})
    expect(cfg.telemetry.path).toMatch(/pi-auto-mode\.jsonl$/)
  })

  it('normalises an empty-string telemetry.path to the default', () => {
    const cfg = parseConfig({ telemetry: { enabled: true, path: '' } })
    expect(cfg.telemetry.path).toMatch(/pi-auto-mode\.jsonl$/)
  })

  it('normalises a whitespace-only telemetry.path to the default', () => {
    const cfg = parseConfig({ telemetry: { enabled: true, path: '   ' } })
    expect(cfg.telemetry.path).toMatch(/pi-auto-mode\.jsonl$/)
  })

  it('preserves an explicit non-empty telemetry.path', () => {
    const cfg = parseConfig({
      telemetry: { enabled: true, path: '/var/log/custom.jsonl' },
    })
    expect(cfg.telemetry.path).toBe('/var/log/custom.jsonl')
  })
})

describe('Fase 5: onFail fallback options', () => {
  it("fallback.onError 'allow' is now accepted (opt-in fail-open)", () => {
    const cfg = parseConfig({ classifier: { fallback: { onError: 'allow' } } })
    expect(cfg.classifier.fallback.onError).toBe('allow')
  })

  it("fallback.onTimeout 'allow' is now accepted (opt-in fail-open)", () => {
    const cfg = parseConfig({
      classifier: { fallback: { onTimeout: 'allow' } },
    })
    expect(cfg.classifier.fallback.onTimeout).toBe('allow')
  })

  it('valid non-allow fallback options (ask-user/deny) are accepted', () => {
    const cfg = parseConfig({
      classifier: { fallback: { onTimeout: 'deny', onError: 'ask-user' } },
    })
    expect(cfg.classifier.fallback.onTimeout).toBe('deny')
    expect(cfg.classifier.fallback.onError).toBe('ask-user')
  })

  it('fallback default is ask-user (fail-closed) when omitted', () => {
    const cfg = parseConfig({})
    expect(cfg.classifier.fallback.onTimeout).toBe('ask-user')
    expect(cfg.classifier.fallback.onError).toBe('ask-user')
  })
})

describe('permissionSets use permissions block (no priority, no rules)', () => {
  it('accepts a per-set permissions block with tools/skills/mcps', () => {
    const cfg = parseConfig({
      permissionSets: {
        a: {
          permissions: {
            tools: {
              bash: 'allow',
              'bash:git status': 'ask',
              write: 'deny',
              '*': 'allow',
            },
            skills: { 'ts-language-server': 'allow', 'python-lsp': 'ask' },
            mcps: { 'my-mcp': 'allow' },
          },
        },
      },
      activePermissionSets: ['a'],
    })
    expect(cfg.permissionSets.a.permissions.tools).toEqual({
      bash: 'allow',
      'bash:git status': 'ask',
      write: 'deny',
      '*': 'allow',
    })
    expect(cfg.permissionSets.a.permissions.skills).toEqual({
      'ts-language-server': 'allow',
      'python-lsp': 'ask',
    })
    expect(cfg.permissionSets.a.permissions.mcps).toEqual({
      'my-mcp': 'allow',
    })
  })

  it('permissions are optional in a permission set', () => {
    const cfg = parseConfig({
      permissionSets: { a: {} },
      activePermissionSets: ['a'],
    })
    expect(cfg.permissionSets.a.permissions).toEqual({})
  })

  it('rejects an invalid visibility action', () => {
    expect(() =>
      parseConfig({
        permissionSets: {
          // Rechazado en runtime (zod), no por el typechecker: invalid action
          a: { permissions: { tools: { bash: 'permit' } } },
        },
      })
    ).toThrow()
  })

  it('rejects priority field (removed in Phase 1)', () => {
    expect(() =>
      parseConfig({
        // Rechazado en runtime (zod), no por el typechecker: testing runtime rejection
        permissionSets: { a: { priority: 0, permissions: {} } },
      })
    ).toThrow()
  })

  it('rejects rules field (removed in Phase 1)', () => {
    expect(() =>
      parseConfig({
        // Rechazado en runtime (zod), no por el typechecker: testing runtime rejection
        permissionSets: { a: { rules: [], permissions: {} } },
      })
    ).toThrow()
  })
})

describe('activePermissionSets order determines precedence', () => {
  it('accepts an array of set IDs', () => {
    const cfg = parseConfig({
      permissionSets: { a: {}, b: {} },
      activePermissionSets: ['a', 'b'],
    })
    expect(cfg.activePermissionSets).toEqual(['a', 'b'])
  })

  it('defaults to empty array', () => {
    expect(parseConfig({}).activePermissionSets).toEqual([])
  })
})

describe('global permissions block (base permissions)', () => {
  it('accepts tools/skills/mcps at root permissions', () => {
    const cfg = parseConfig({
      permissions: {
        tools: { bash: 'ask', write: 'deny' },
        skills: { lsp: 'allow' },
        mcps: {},
      },
    })
    expect(cfg.permissions.tools).toEqual({ bash: 'ask', write: 'deny' })
    expect(cfg.permissions.skills).toEqual({ lsp: 'allow' })
  })

  it('defaults to empty object', () => {
    expect(parseConfig({}).permissions).toEqual({})
  })
})

describe('mode (visibility mode)', () => {
  it("defaults to 'default' when omitted", () => {
    expect(parseConfig({}).mode).toBe('default')
  })

  it('accepts strict and yolo', () => {
    expect(parseConfig({ mode: 'strict' }).mode).toBe('strict')
    expect(parseConfig({ mode: 'yolo' }).mode).toBe('yolo')
  })

  it('rejects unknown mode strings', () => {
    expect(() => parseConfig({ mode: 'nuclear' })).toThrow()
  })
})

describe('llm.provider (openai-compatible for llama.cpp / Ollama)', () => {
  it("accepts 'openai-compatible' as a provider value", () => {
    const cfg = parseConfig({
      classifier: {
        llm: {
          provider: 'openai-compatible',
          model: 'llama-3',
          baseUrl: 'http://localhost:8080/v1',
        },
      },
    })
    expect(cfg.classifier.llm.provider).toBe('openai-compatible')
    expect(cfg.classifier.llm.model).toBe('llama-3')
  })

  it('accepts any Pi-configured provider id (e.g. litellm) for registry resolution', () => {
    const cfg = parseConfig({ classifier: { llm: { provider: 'litellm' } } })
    expect(cfg.classifier.llm.provider).toBe('litellm')
    const cfg2 = parseConfig({
      classifier: { llm: { provider: 'my-custom-provider' } },
    })
    expect(cfg2.classifier.llm.provider).toBe('my-custom-provider')
  })

  it('still rejects an empty provider string', () => {
    expect(() =>
      parseConfig({
        classifier: { llm: { provider: '' } },
      })
    ).toThrow()
  })
})

describe('classifier.llm.maxTokens', () => {
  it('defaults to 1024 when omitted', () => {
    expect(parseConfig({}).classifier.llm.maxTokens).toBe(1024)
  })

  it('accepts an explicit positive integer', () => {
    const cfg = parseConfig({
      classifier: { llm: { maxTokens: 2048 } },
    })
    expect(cfg.classifier.llm.maxTokens).toBe(2048)
  })

  it('rejects non-positive values (0, negative)', () => {
    expect(() =>
      parseConfig({ classifier: { llm: { maxTokens: 0 } } })
    ).toThrow()
    expect(() =>
      parseConfig({ classifier: { llm: { maxTokens: -1 } } })
    ).toThrow()
  })

  it('rejects non-integer values', () => {
    expect(() =>
      parseConfig({ classifier: { llm: { maxTokens: 100.5 } } })
    ).toThrow()
  })

  it('config.example.json parses with maxTokens=1024 (no drift)', () => {
    const raw = JSON.parse(readFileSync(EXAMPLE_PATH, 'utf8'))
    const cfg = parseConfig(raw)
    expect(cfg.classifier.llm.maxTokens).toBe(1024)
  })
})

describe('Fase 4: denyStrategy.mode rename (deny-and-continue -> auto-retry alias)', () => {
  it("the canonical name 'auto-retry' is accepted", () => {
    const cfg = parseConfig({ denyStrategy: { mode: 'auto-retry' } })
    expect(cfg.denyStrategy.mode).toBe('auto-retry')
  })

  it("the legacy alias 'deny-and-continue' is accepted and normalised to 'auto-retry'", () => {
    const cfg = parseConfig({ denyStrategy: { mode: 'deny-and-continue' } })
    expect(cfg.denyStrategy.mode).toBe('auto-retry')
  })

  it("'ask-user' and 'both' still parse unchanged", () => {
    const cfg1 = parseConfig({ denyStrategy: { mode: 'ask-user' } })
    expect(cfg1.denyStrategy.mode).toBe('ask-user')
    const cfg2 = parseConfig({ denyStrategy: { mode: 'both' } })
    expect(cfg2.denyStrategy.mode).toBe('both')
  })

  it('unknown mode values are still rejected (alias is opt-in, not a catch-all)', () => {
    expect(() =>
      parseConfig({ denyStrategy: { mode: 'deny-and-wait' } })
    ).toThrow()
  })

  it('DEFAULT_CONFIG.denyStrategy.mode is the canonical name (never the alias)', () => {
    expect(DEFAULT_CONFIG.denyStrategy.mode).not.toBe('deny-and-continue')
    expect(['auto-retry', 'ask-user', 'both']).toContain(
      DEFAULT_CONFIG.denyStrategy.mode
    )
  })
})

describe('classifier.onBlockUserOverride', () => {
  it('defaults to false when omitted (fail-closed: classifier block is absolute)', () => {
    expect(parseConfig({}).classifier.onBlockUserOverride).toBe(false)
  })

  it('DEFAULT_CONFIG.classifier.onBlockUserOverride is false', () => {
    expect(DEFAULT_CONFIG.classifier.onBlockUserOverride).toBe(false)
  })

  it('accepts true (opt-in: classifier block is user-overridable)', () => {
    const cfg = parseConfig({ classifier: { onBlockUserOverride: true } })
    expect(cfg.classifier.onBlockUserOverride).toBe(true)
  })

  it('coexists with the other classifier fields (fallback / onBlock / llm)', () => {
    const cfg = parseConfig({
      classifier: {
        onBlock: 'ask',
        onBlockUserOverride: true,
        fallback: { onTimeout: 'deny', onError: 'ask-user' },
      },
    })
    expect(cfg.classifier.onBlock).toBe('ask')
    expect(cfg.classifier.onBlockUserOverride).toBe(true)
    expect(cfg.classifier.fallback.onTimeout).toBe('deny')
    expect(cfg.classifier.fallback.onError).toBe('ask-user')
  })

  it('rejects non-boolean values (string, number, null)', () => {
    expect(() =>
      parseConfig({
        // Rechazado en runtime (zod), no por el typechecker: invalid type
        classifier: { onBlockUserOverride: 'yes' },
      })
    ).toThrow()
    expect(() =>
      parseConfig({
        // Rechazado en runtime (zod), no por el typechecker: invalid type
        classifier: { onBlockUserOverride: 1 },
      })
    ).toThrow()
    expect(() =>
      parseConfig({
        // Rechazado en runtime (zod), no por el typechecker: invalid type
        classifier: { onBlockUserOverride: null },
      })
    ).toThrow()
  })

  it('config.example.json parses with onBlockUserOverride=false (no drift)', () => {
    const raw = JSON.parse(readFileSync(EXAMPLE_PATH, 'utf8'))
    const cfg = parseConfig(raw)
    expect(cfg.classifier.onBlockUserOverride).toBe(false)
  })
})

describe('root-level tools map (removed in Phase 1)', () => {
  it('rejects root-level tools field', () => {
    expect(() =>
      parseConfig({
        // Rechazado en runtime (zod), no por el typechecker: testing runtime rejection of removed field
        tools: { agent_send_message: 'agent' },
      })
    ).toThrow()
  })
})

describe('trustGitWorktrees (external_directory × git worktrees)', () => {
  it('defaults to true when omitted', () => {
    expect(parseConfig({}).trustGitWorktrees).toBe(true)
  })

  it('DEFAULT_CONFIG.trustGitWorktrees is true', () => {
    expect(DEFAULT_CONFIG.trustGitWorktrees).toBe(true)
  })

  it('accepts an explicit false (worktrees counted as external again)', () => {
    expect(parseConfig({ trustGitWorktrees: false }).trustGitWorktrees).toBe(
      false
    )
  })

  it('rejects non-boolean values', () => {
    for (const bad of ['true', 1, null, {}]) {
      expect(() =>
        parseConfig({
          // Rechazado en runtime (zod), no por el typechecker: testing runtime rejection of non-boolean
          trustGitWorktrees: bad,
        })
      ).toThrow()
    }
  })

  it('is an independent root key: confineToWorkingDirectory stays separate', () => {
    const cfg = parseConfig({ confineToWorkingDirectory: false })
    expect(cfg.confineToWorkingDirectory).toBe(false)
    expect(cfg.trustGitWorktrees).toBe(true)
  })

  it('config.example.json parses with trustGitWorktrees=true (no drift)', () => {
    const raw = JSON.parse(readFileSync(EXAMPLE_PATH, 'utf8'))
    const cfg = parseConfig(raw)
    expect(cfg.trustGitWorktrees).toBe(true)
  })
})
