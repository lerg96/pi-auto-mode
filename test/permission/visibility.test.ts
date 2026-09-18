import {
  resolveToolVisibility,
  resolveSkillVisibility,
  splitToolKey,
  keyMatchesTool,
  evaluatePermission,
} from '../../src/permission/visibility.ts'
import { applyMode } from '../../src/permission/modes.ts'
import type { Config } from '../../src/types/config.ts'

function cfg(partial: Partial<Config>): Config {
  return {
    permissionSets: {},
    activePermissionSets: [],
    permissions: {},
    mode: 'default',
    classifier: {
      enabled: false,
      llm: {
        provider: 'anthropic',
        model: '',
        baseUrl: '',
        apiKey: '',
        timeoutMs: 5000,
        maxTokens: 1024,
        fallbackModel: '',
        systemPrompt: '',
        enabled: true,
      },
      fallback: { onTimeout: 'ask-user', onError: 'ask-user' },
      onBlock: 'deny',
      onBlockUserOverride: false,
    },
    denyStrategy: {
      mode: 'both',
      escalation: { consecutive: 3, total: 20 },
    },
    ui: {
      promptMaxRows: 8,
      promptFieldMaxWidth: 120,
      showClassifierRisk: true,
      modalTimeoutMs: 120000,
      noUiAsks: 'bubble',
      subagentModalTimeoutMs: 120000,
    },
    telemetry: { enabled: false, path: '/tmp/x.jsonl' },
    ...partial,
  }
}

describe('splitToolKey (legacy compat)', () => {
  it('returns tool-only when no colon', () => {
    expect(splitToolKey('bash')).toEqual({ tool: 'bash', arg: null })
  })
  it('splits on first colon', () => {
    expect(splitToolKey('bash:git status')).toEqual({
      tool: 'bash',
      arg: 'git status',
    })
  })
  it('splits on first colon only (mcp:server:tool)', () => {
    expect(splitToolKey('mcp:server:tool')).toEqual({
      tool: 'mcp',
      arg: 'server:tool',
    })
  })
  it('returns null for empty', () => {
    expect(splitToolKey('')).toBeNull()
  })
  it('returns null for non-string', () => {
    expect(splitToolKey(undefined as unknown as string)).toBeNull()
  })
})

describe('keyMatchesTool (legacy compat)', () => {
  it('matches a bare tool key against any args', () => {
    expect(keyMatchesTool('bash', 'bash', 'rm -rf /')).toBe(true)
    expect(keyMatchesTool('bash', 'bash', undefined)).toBe(true)
  })
  it('rejects when the tool name does not match', () => {
    expect(keyMatchesTool('bash', 'read', undefined)).toBe(false)
  })
  it('matches tool:arg only when args are present and match', () => {
    expect(keyMatchesTool('bash:git status', 'bash', 'git status')).toBe(true)
    expect(keyMatchesTool('bash:git status', 'bash', 'git push')).toBe(false)
  })
  it('does not match tool:arg when args are absent', () => {
    expect(keyMatchesTool('bash:git status', 'bash', undefined)).toBe(false)
    expect(keyMatchesTool('bash:git status', 'bash', '')).toBe(false)
  })
  it('uses wildcards in both tool and arg positions', () => {
    expect(keyMatchesTool('ba*', 'bash', undefined)).toBe(true)
    expect(keyMatchesTool('bash:git *', 'bash', 'git push origin')).toBe(true)
  })
})

describe('resolveToolVisibility / empty activeSets', () => {
  it('returns unknown when no active set is configured', () => {
    const c = cfg({
      permissionSets: {
        a: {
          permissions: { tools: { bash: 'allow' } },
        },
      },
      activePermissionSets: [],
    })
    expect(resolveToolVisibility(c, 'bash')).toBe('unknown')
  })

  it('returns unknown when the active set has no tools map', () => {
    const c = cfg({
      permissionSets: { a: { permissions: {} } },
      activePermissionSets: ['a'],
    })
    expect(resolveToolVisibility(c, 'bash')).toBe('unknown')
  })
})

describe('resolveToolVisibility / single set, exact match', () => {
  it('returns allow', () => {
    const c = cfg({
      permissionSets: {
        a: { permissions: { tools: { bash: 'allow' } } },
      },
      activePermissionSets: ['a'],
    })
    expect(resolveToolVisibility(c, 'bash')).toBe('allow')
  })
  it('returns ask', () => {
    const c = cfg({
      permissionSets: { a: { permissions: { tools: { bash: 'ask' } } } },
      activePermissionSets: ['a'],
    })
    expect(resolveToolVisibility(c, 'bash')).toBe('ask')
  })
  it('returns deny', () => {
    const c = cfg({
      permissionSets: {
        a: { permissions: { tools: { bash: 'deny' } } },
      },
      activePermissionSets: ['a'],
    })
    expect(resolveToolVisibility(c, 'bash')).toBe('deny')
  })
})

describe('resolveToolVisibility / single set, PatternRule array', () => {
  it('matches a PatternRule glob and returns its action', () => {
    const c = cfg({
      permissionSets: {
        a: {
          permissions: {
            tools: {
              bash: [
                { pattern: 'git status', action: 'allow' },
                { pattern: 'git push *', action: 'deny', reason: 'no push' },
              ],
            },
          },
        },
      },
      activePermissionSets: ['a'],
    })
    expect(resolveToolVisibility(c, 'bash', 'git status')).toBe('allow')
    expect(resolveToolVisibility(c, 'bash', 'git push origin main')).toBe(
      'deny'
    )
    expect(resolveToolVisibility(c, 'bash', 'git pull')).toBe('unknown') // no match
  })

  it('first matching PatternRule wins within the array', () => {
    const c = cfg({
      permissionSets: {
        a: {
          permissions: {
            tools: {
              bash: [
                { pattern: 'git *', action: 'deny', reason: 'all git blocked' },
                { pattern: 'git status', action: 'allow' },
              ],
            },
          },
        },
      },
      activePermissionSets: ['a'],
    })
    // first rule matches → deny
    expect(resolveToolVisibility(c, 'bash', 'git status')).toBe('deny')
  })

  it('exact SimpleAction string overrides PatternRule array in cascade', () => {
    const c = cfg({
      permissions: { tools: { bash: 'allow' } }, // global simple allow
      permissionSets: {
        a: {
          permissions: {
            tools: {
              bash: [{ pattern: 'git *', action: 'deny' }], // set has PatternRule deny
            },
          },
        },
      },
      activePermissionSets: ['a'],
    })
    // global allow (simple string) is first in cascade, then set's PatternRule deny
    // but visibility ONLY counts SimpleAction strings → global 'allow' wins
    expect(resolveToolVisibility(c, 'bash')).toBe('allow')
  })
})

describe('resolveToolVisibility / cascade order resolution', () => {
  it('later active set wins over earlier (order = precedence)', () => {
    const c = cfg({
      permissionSets: {
        low: { permissions: { tools: { bash: 'allow' } } },
        high: { permissions: { tools: { bash: 'deny' } } },
      },
      activePermissionSets: ['low', 'high'],
    })
    expect(resolveToolVisibility(c, 'bash')).toBe('deny')
  })

  it('global permissions block is lowest precedence', () => {
    const c = cfg({
      permissions: { tools: { bash: 'deny' } },
      permissionSets: {
        high: { permissions: { tools: { bash: 'allow' } } },
      },
      activePermissionSets: ['high'],
    })
    expect(resolveToolVisibility(c, 'bash')).toBe('allow')
  })
})

describe('resolveSkillVisibility', () => {
  it('returns unknown for empty active sets', () => {
    const c = cfg({
      permissionSets: {
        a: { permissions: { skills: { foo: 'allow' } } },
      },
      activePermissionSets: [],
    })
    expect(resolveSkillVisibility(c, 'foo')).toBe('unknown')
  })

  it('returns allow for a matching skill', () => {
    const c = cfg({
      permissionSets: {
        a: { permissions: { skills: { foo: 'allow' } } },
      },
      activePermissionSets: ['a'],
    })
    expect(resolveSkillVisibility(c, 'foo')).toBe('allow')
  })

  it('PatternRule array on skills works', () => {
    const c = cfg({
      permissionSets: {
        a: {
          permissions: {
            skills: {
              foo: [{ pattern: 'bar*', action: 'deny' }],
            },
          },
        },
      },
      activePermissionSets: ['a'],
    })
    expect(resolveSkillVisibility(c, 'foo')).toBe('unknown') // no match
  })

  it('cascade order dominates', () => {
    const c = cfg({
      permissionSets: {
        low: { permissions: { skills: { foo: 'allow' } } },
        high: { permissions: { skills: { foo: 'deny' } } },
      },
      activePermissionSets: ['low', 'high'],
    })
    expect(resolveSkillVisibility(c, 'foo')).toBe('deny')
  })

  it('conflicting same-order skills → last wins', () => {
    const c = cfg({
      permissionSets: {
        a: { permissions: { skills: { foo: 'allow' } } },
        b: { permissions: { skills: { foo: 'ask' } } },
      },
      activePermissionSets: ['a', 'b'],
    })
    expect(resolveSkillVisibility(c, 'foo')).toBe('ask')
  })
})

describe('applyMode × resolveToolVisibility (matrix)', () => {
  const c = cfg({
    permissionSets: {
      a: {
        permissions: {
          tools: { bash: 'ask', read: 'allow', write: 'deny', other: 'allow' },
        },
      },
    },
    activePermissionSets: ['a'],
  })

  it('default mode: ask stays ask (tool stays visible, gate decides per-call)', () => {
    expect(applyMode(resolveToolVisibility(c, 'bash'), 'default')).toBe('ask')
  })
  it('default mode: deny survives', () => {
    expect(applyMode(resolveToolVisibility(c, 'write'), 'default')).toBe('deny')
  })
  it('strict mode: ask -> deny', () => {
    const strictCfg = cfg({ ...c, mode: 'strict' })
    expect(
      applyMode(resolveToolVisibility(strictCfg, 'bash'), strictCfg.mode)
    ).toBe('deny')
  })
  it('strict mode: deny survives', () => {
    const strictCfg = cfg({ ...c, mode: 'strict' })
    expect(
      applyMode(resolveToolVisibility(strictCfg, 'write'), strictCfg.mode)
    ).toBe('deny')
  })
  it('yolo mode: ask -> allow', () => {
    const yoloCfg = cfg({ ...c, mode: 'yolo' })
    expect(
      applyMode(resolveToolVisibility(yoloCfg, 'bash'), yoloCfg.mode)
    ).toBe('allow')
  })
  it('yolo mode: deny still blocks', () => {
    const yoloCfg = cfg({ ...c, mode: 'yolo' })
    expect(
      applyMode(resolveToolVisibility(yoloCfg, 'write'), yoloCfg.mode)
    ).toBe('deny')
  })
  it('default mode: allow stays allow', () => {
    expect(applyMode(resolveToolVisibility(c, 'read'), 'default')).toBe('allow')
  })
  it('unknown is preserved across all modes (fail-closed)', () => {
    expect(applyMode(resolveToolVisibility(c, 'not-mapped'), 'default')).toBe(
      'unknown'
    )
    expect(applyMode(resolveToolVisibility(c, 'not-mapped'), 'strict')).toBe(
      'unknown'
    )
    expect(applyMode(resolveToolVisibility(c, 'not-mapped'), 'yolo')).toBe(
      'unknown'
    )
  })
})

describe('backwards compatibility', () => {
  it('a config with NO tools/skills maps still parses', () => {
    const c = cfg({
      permissionSets: { a: { permissions: {} } },
      activePermissionSets: ['a'],
    })
    expect(c.permissionSets.a.permissions.tools).toBeUndefined()
    expect(c.permissionSets.a.permissions.skills).toBeUndefined()
    expect(resolveToolVisibility(c, 'bash')).toBe('unknown')
    expect(resolveSkillVisibility(c, 'foo')).toBe('unknown')
  })

  it('a config without `mode` field defaults to "default"', () => {
    const c = cfg({})
    expect(c.mode).toBe('default')
  })
})

describe('catch-all "*" default', () => {
  it('applies to tools with no entry (unknown included)', () => {
    const c = cfg({ permissions: { tools: { '*': 'ask' } } })
    expect(evaluatePermission(c, 'tools', 'weirdtool', undefined).action).toBe(
      'ask'
    )
    expect(resolveToolVisibility(c, 'weirdtool')).toBe('ask')
  })

  it('exact entry always beats "*" (either direction)', () => {
    const c = cfg({
      permissions: { tools: { '*': 'deny', bash: 'allow' } },
    })
    expect(evaluatePermission(c, 'tools', 'bash', undefined).action).toBe(
      'allow'
    )
    expect(evaluatePermission(c, 'tools', 'other', undefined).action).toBe(
      'deny'
    )
  })

  it('"*" array form matches callValue patterns', () => {
    const c = cfg({
      permissions: {
        tools: { '*': [{ pattern: 'rm *', action: 'deny' }] },
      },
    })
    expect(evaluatePermission(c, 'tools', 'weirdtool', 'rm -rf x').action).toBe(
      'deny'
    )
    expect(evaluatePermission(c, 'tools', 'weirdtool', 'echo hi').action).toBe(
      'unknown'
    )
  })

  it('active-set exact entry beats global "*"', () => {
    const c = cfg({
      permissions: { tools: { '*': 'deny' } },
      permissionSets: { s: { permissions: { tools: { bash: 'allow' } } } },
      activePermissionSets: ['s'],
    })
    expect(evaluatePermission(c, 'tools', 'bash', undefined).action).toBe(
      'allow'
    )
    expect(evaluatePermission(c, 'tools', 'other', undefined).action).toBe(
      'deny'
    )
  })

  it('exact array with no pattern match stays silent (no star fallthrough)', () => {
    const c = cfg({
      permissions: {
        tools: { '*': 'deny', bash: [{ pattern: 'rm *', action: 'deny' }] },
      },
    })
    expect(evaluatePermission(c, 'tools', 'bash', 'echo hi').action).toBe(
      'unknown'
    )
  })
})
