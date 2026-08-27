import {
  computeSkillVisibility,
  filterVisibleSkills,
} from '../../src/permission/skill-filter.ts'
import type { Config } from '../../src/types/config.ts'

function cfg(partial: Partial<Config>): Config {
  return {
    permissionSets: {},
    activePermissionSets: [],
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
        enabled: false,
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
    },
    telemetry: { enabled: false, path: '/tmp/x.jsonl' },
    permissions: {},
    ...partial,
  }
}

describe('computeSkillVisibility', () => {
  it('returns unknown when no active set configures skills', () => {
    const c = cfg({})
    expect(computeSkillVisibility(c, 'foo')).toBe('unknown')
  })

  it('returns the configured action', () => {
    const c = cfg({
      permissionSets: {
        a: { permissions: { skills: { foo: 'allow', bar: 'deny' } } },
      },
      activePermissionSets: ['a'],
    })
    expect(computeSkillVisibility(c, 'foo')).toBe('allow')
    expect(computeSkillVisibility(c, 'bar')).toBe('deny')
  })

  it('strict mode promotes ask → deny', () => {
    const c = cfg({
      mode: 'strict',
      permissionSets: {
        a: { permissions: { skills: { foo: 'ask' } } },
      },
      activePermissionSets: ['a'],
    })
    expect(computeSkillVisibility(c, 'foo')).toBe('deny')
  })

  it('yolo mode promotes ask → allow', () => {
    const c = cfg({
      mode: 'yolo',
      permissionSets: {
        a: { permissions: { skills: { foo: 'ask' } } },
      },
      activePermissionSets: ['a'],
    })
    expect(computeSkillVisibility(c, 'foo')).toBe('allow')
  })
})

describe('filterVisibleSkills', () => {
  it('keeps allow/ask/unknown, drops only deny', () => {
    // New visibility policy: only an explicit `deny` hides a skill from
    // the LLM. `unknown` (no rule in any active set's skills map) is
    // visible by default — users get the same behaviour as before
    // Capa 1 when they haven't configured per-skill entries.
    const c = cfg({
      permissionSets: {
        a: {
          permissions: { skills: { foo: 'allow', bar: 'ask', baz: 'deny' } },
        },
      },
      activePermissionSets: ['a'],
    })
    expect(filterVisibleSkills(c, ['foo', 'bar', 'baz', 'qux'])).toEqual([
      'foo',
      'bar',
      'qux',
    ])
  })

  it('returns the input list when every entry is unknown', () => {
    // `bar` has no entry in any active set's skills map → visibility
    // is `unknown` → visible under the new policy. Only an explicit
    // `deny` hides a skill now.
    const c = cfg({
      permissionSets: {
        a: { permissions: { skills: { foo: 'deny' } } },
      },
      activePermissionSets: ['a'],
    })
    expect(filterVisibleSkills(c, ['foo', 'bar'])).toEqual(['bar'])
  })

  it('preserves input order', () => {
    const c = cfg({
      permissionSets: {
        a: { permissions: { skills: { '*': 'allow' } } },
      },
      activePermissionSets: ['a'],
    })
    expect(filterVisibleSkills(c, ['z', 'a', 'm'])).toEqual(['z', 'a', 'm'])
  })
})
