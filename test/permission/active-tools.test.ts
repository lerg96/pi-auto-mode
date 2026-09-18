import {
  computeActiveTools,
  computeToolVisibilities,
} from '../../src/permission/active-tools.ts'
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
      noUiAsks: 'bubble',
      subagentModalTimeoutMs: 120000,
    },
    telemetry: { enabled: false, path: '/tmp/x.jsonl' },
    permissions: {},
    ...partial,
  }
}

const TOOLS = [
  { name: 'bash' },
  { name: 'read' },
  { name: 'write' },
  { name: 'agent_send_message' },
]

describe('computeToolVisibilities', () => {
  it('returns unknown for every tool when activePermissionSets is empty', () => {
    const c = cfg({})
    const out = computeToolVisibilities(c, TOOLS)
    for (const v of out) expect(v.visibility).toBe('unknown')
  })

  it('returns the per-tool visibility for a configured set', () => {
    const c = cfg({
      permissionSets: {
        a: {
          permissions: {
            tools: { bash: 'allow', read: 'ask', write: 'deny' },
          },
        },
      },
      activePermissionSets: ['a'],
    })
    const map = new Map(
      computeToolVisibilities(c, TOOLS).map((v) => [v.name, v.visibility])
    )
    expect(map.get('bash')).toBe('allow')
    expect(map.get('read')).toBe('ask')
    expect(map.get('write')).toBe('deny')
    expect(map.get('agent_send_message')).toBe('unknown')
  })

  it('strict mode promotes ask → deny', () => {
    const c = cfg({
      mode: 'strict',
      permissionSets: {
        a: { permissions: { tools: { bash: 'ask' } } },
      },
      activePermissionSets: ['a'],
    })
    const out = computeToolVisibilities(c, TOOLS)
    const bash = out.find((v) => v.name === 'bash')
    expect(bash?.visibility).toBe('deny')
  })

  it('yolo mode promotes ask → allow', () => {
    const c = cfg({
      mode: 'yolo',
      permissionSets: {
        a: { permissions: { tools: { bash: 'ask' } } },
      },
      activePermissionSets: ['a'],
    })
    const out = computeToolVisibilities(c, TOOLS)
    const bash = out.find((v) => v.name === 'bash')
    expect(bash?.visibility).toBe('allow')
  })
})

describe('computeActiveTools', () => {
  it('returns all tools when activePermissionSets is empty (fallback)', () => {
    const c = cfg({})
    const out = computeActiveTools(c, TOOLS)
    expect(out).toEqual(['bash', 'read', 'write', 'agent_send_message'])
  })

  it('keeps allow/ask/unknown, drops only deny', () => {
    const c = cfg({
      permissionSets: {
        a: {
          permissions: { tools: { bash: 'allow', read: 'ask', write: 'deny' } },
        },
      },
      activePermissionSets: ['a'],
    })
    const out = computeActiveTools(c, TOOLS)
    expect(out).toContain('bash')
    expect(out).toContain('read')
    expect(out).not.toContain('write')
    expect(out).toContain('agent_send_message')
  })

  it('honours previousActiveTools when the resolved set is empty', () => {
    // SimpleAction 'deny' for all tools (not PatternRule) → all denied.
    // PatternRule arrays are ignored for visibility; only SimpleAction strings count.
    const c = cfg({
      permissions: {
        tools: {
          bash: 'deny',
          read: 'deny',
          write: 'deny',
          agent_send_message: 'deny',
        },
      },
      activePermissionSets: [],
    })
    const out = computeActiveTools(c, TOOLS, ['bash', 'read'])
    expect(out).toEqual(['bash', 'read'])
  })

  it('falls back to all-tools when resolved set AND previousActiveTools are both empty', () => {
    const c = cfg({
      permissions: {
        tools: {
          bash: 'deny',
          read: 'deny',
          write: 'deny',
          agent_send_message: 'deny',
        },
      },
      activePermissionSets: [],
    })
    const out = computeActiveTools(c, TOOLS, [])
    // When all denied and no previous, falls back to all tool names
    expect(out).toEqual(['bash', 'read', 'write', 'agent_send_message'])
  })

  it('skips tools without a name', () => {
    const c = cfg({
      permissions: {
        tools: { bash: 'allow' },
      },
      activePermissionSets: [],
    })
    const out = computeActiveTools(c, [{}, { name: '' }, { name: 'bash' }])
    expect(out).toEqual(['bash'])
  })
})
