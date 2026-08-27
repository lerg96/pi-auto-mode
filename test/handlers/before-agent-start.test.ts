import {
  applyVisibilityToPrompt,
  computeVisibleToolList,
  createBeforeAgentStartHandler,
} from '../../src/handlers/before-agent-start.ts'
import { filterVisibleSkills } from '../../src/permission/skill-filter.ts'
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
    ...partial,
  }
}

const TOOLS = [
  { name: 'bash' },
  { name: 'read' },
  { name: 'write' },
  { name: 'grep' },
  { name: 'agent_send_message' },
]

const SAMPLE_PROMPT = `You are an expert coding assistant.

Available tools:
- read: Read a file.
- bash: Run a command.
- write: Write a file.
- grep: Search.
- agent_send_message: Send a message.

In addition to the tools above, you may have access to other custom tools.

The following skills provide specialized instructions for specific tasks.
Use the read tool to load a skill's file when the task matches its description.
When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.

<available_skills>
  <skill>
    <name>ts-language-server</name>
    <description>TypeScript LSP.</description>
    <location>/skills/ts/SKILL.md</location>
  </skill>
  <skill>
    <name>python-lsp</name>
    <description>Python LSP.</description>
    <location>/skills/py/SKILL.md</location>
  </skill>
</available_skills>

Footer.`

describe('computeVisibleToolList', () => {
  it('returns all tool names when no active set is configured', () => {
    const c = cfg({})
    const out = computeVisibleToolList({ cfg: c, allTools: TOOLS })
    expect(out.sort()).toEqual([
      'agent_send_message',
      'bash',
      'grep',
      'read',
      'write',
    ])
  })

  it('drops tools marked deny in any active set (exact match)', () => {
    const c = cfg({
      permissionSets: {
        a: {
          permissions: { tools: { write: 'deny', agent_send_message: 'deny' } },
        },
      },
      activePermissionSets: ['a'],
    })
    const out = computeVisibleToolList({ cfg: c, allTools: TOOLS })
    expect(out).toContain('bash')
    expect(out).toContain('read')
    expect(out).toContain('grep')
    expect(out).not.toContain('write')
    expect(out).not.toContain('agent_send_message')
  })

  it('mode=strict promotes ask → deny', () => {
    const c = cfg({
      mode: 'strict',
      permissionSets: {
        a: { permissions: { tools: { bash: 'ask' } } },
      },
      activePermissionSets: ['a'],
    })
    const out = computeVisibleToolList({ cfg: c, allTools: TOOLS })
    expect(out).not.toContain('bash')
  })

  it('mode=yolo promotes ask → allow (visible)', () => {
    const c = cfg({
      mode: 'yolo',
      permissionSets: {
        a: { permissions: { tools: { bash: 'ask' } } },
      },
      activePermissionSets: ['a'],
    })
    const out = computeVisibleToolList({ cfg: c, allTools: TOOLS })
    expect(out).toContain('bash')
  })

  it('honours previousActiveTools when lockdown denies everything', () => {
    const c = cfg({
      permissions: {
        tools: {
          bash: 'deny',
          read: 'deny',
          write: 'deny',
          grep: 'deny',
          agent_send_message: 'deny',
        },
      },
      activePermissionSets: [],
    })
    const out = computeVisibleToolList({
      cfg: c,
      allTools: TOOLS,
      previousActiveTools: ['bash', 'read'],
    })
    expect(out).toEqual(['bash', 'read'])
  })
})

describe('applyVisibilityToPrompt', () => {
  it('returns unchanged when every tool/skill is allowed', () => {
    const c = cfg({
      permissionSets: {
        a: {
          permissions: {
            tools: {
              bash: 'allow',
              read: 'allow',
              write: 'allow',
              grep: 'allow',
              agent_send_message: 'allow',
            },
            skills: { 'ts-language-server': 'allow', 'python-lsp': 'allow' },
          },
        },
      },
      activePermissionSets: ['a'],
    })
    const result = applyVisibilityToPrompt(
      { cfg: c, allTools: TOOLS },
      SAMPLE_PROMPT
    )
    expect(result.unchanged).toBe(true)
    expect(result.systemPrompt).toBe(SAMPLE_PROMPT)
  })

  it('scrubs denied tools and skills', () => {
    const c = cfg({
      permissionSets: {
        a: {
          permissions: {
            tools: {
              bash: 'allow',
              read: 'allow',
              write: 'deny',
              grep: 'allow',
              agent_send_message: 'deny',
            },
            skills: {
              'ts-language-server': 'allow',
              'python-lsp': 'deny',
            },
          },
        },
      },
      activePermissionSets: ['a'],
    })
    const result = applyVisibilityToPrompt(
      { cfg: c, allTools: TOOLS },
      SAMPLE_PROMPT
    )
    expect(result.unchanged).toBe(false)
    expect(result.systemPrompt).not.toContain('- write:')
    expect(result.systemPrompt).not.toContain('- agent_send_message:')
    expect(result.systemPrompt).not.toContain('python-lsp')
    expect(result.systemPrompt).toContain('- bash:')
    expect(result.systemPrompt).toContain('- read:')
    expect(result.systemPrompt).toContain('ts-language-server')
  })

  it('returns the visible tool/skill lists in the audit fields', () => {
    const c = cfg({
      permissionSets: {
        a: {
          permissions: {
            tools: { bash: 'allow', read: 'ask', write: 'deny' },
            skills: { 'ts-language-server': 'allow', 'python-lsp': 'deny' },
          },
        },
      },
      activePermissionSets: ['a'],
    })
    const result = applyVisibilityToPrompt(
      { cfg: c, allTools: TOOLS },
      SAMPLE_PROMPT
    )
    expect(result.visibleTools.sort()).toEqual([
      'agent_send_message',
      'bash',
      'grep',
      'read',
    ])
    expect(result.visibleSkills).toEqual(['ts-language-server'])
  })

  it('idempotent: running twice on the same input produces the same output', () => {
    const c = cfg({
      permissionSets: {
        a: {
          permissions: {
            tools: { write: 'deny' },
            skills: { 'python-lsp': 'deny' },
          },
        },
      },
      activePermissionSets: ['a'],
    })
    const first = applyVisibilityToPrompt(
      { cfg: c, allTools: TOOLS },
      SAMPLE_PROMPT
    )
    const second = applyVisibilityToPrompt(
      { cfg: c, allTools: TOOLS },
      first.systemPrompt
    )
    expect(second.systemPrompt).toBe(first.systemPrompt)
    expect(second.unchanged).toBe(true)
  })
})

describe('createBeforeAgentStartHandler / wire-up', () => {
  function fakePi(
    opts: {
      allTools?: unknown[]
      activeTools?: string[]
      setActiveTools?: jest.Mock
    } = {}
  ) {
    const allTools = opts.allTools ?? TOOLS
    const activeTools = opts.activeTools ?? []
    const setActiveTools = opts.setActiveTools ?? jest.fn()
    return {
      pi: {
        getAllTools: () => allTools,
        getActiveTools: () => activeTools,
        setActiveTools,
      },
      setActiveTools,
    }
  }

  it('calls setActiveTools with the visible tools', async () => {
    const c = cfg({
      permissionSets: {
        a: {
          permissions: { tools: { write: 'deny', agent_send_message: 'deny' } },
        },
      },
      activePermissionSets: ['a'],
    })
    const { pi, setActiveTools } = fakePi()
    const handler = createBeforeAgentStartHandler({ cfg: () => c, pi })
    const result = await handler({ systemPrompt: SAMPLE_PROMPT }, {} as unknown)
    const arg = setActiveTools.mock.calls[0][0] as string[]
    expect(arg).toContain('bash')
    expect(arg).toContain('read')
    expect(arg).not.toContain('write')
    expect(arg).not.toContain('agent_send_message')
    expect(result?.systemPrompt).toBeDefined()
  })

  it('returns undefined when nothing changed (idempotent wire stability)', async () => {
    const c = cfg({
      permissionSets: {
        a: {
          permissions: {
            tools: {
              bash: 'allow',
              read: 'allow',
              write: 'allow',
              grep: 'allow',
              agent_send_message: 'allow',
            },
            skills: { 'ts-language-server': 'allow', 'python-lsp': 'allow' },
          },
        },
      },
      activePermissionSets: ['a'],
    })
    const { pi } = fakePi()
    const handler = createBeforeAgentStartHandler({ cfg: () => c, pi })
    const result = await handler({ systemPrompt: SAMPLE_PROMPT }, {} as unknown)
    expect(result).toBeUndefined()
  })

  it('returns undefined when there is no systemPrompt to scrub', async () => {
    const c = cfg({})
    const { pi } = fakePi()
    const handler = createBeforeAgentStartHandler({ cfg: () => c, pi })
    const result = await handler({ systemPrompt: undefined }, {} as unknown)
    expect(result).toBeUndefined()
  })

  it('still calls setActiveTools when systemPrompt is absent', async () => {
    const c = cfg({})
    const { pi, setActiveTools } = fakePi()
    const handler = createBeforeAgentStartHandler({ cfg: () => c, pi })
    await handler({ systemPrompt: undefined }, {} as unknown)
    expect(setActiveTools).toHaveBeenCalledTimes(1)
  })
})

describe('unknown-tool visibility policy', () => {
  const TOOLS_WITH_UNKNOWN = [
    { name: 'bash' },
    { name: 'read' },
    { name: 'write' },
    { name: 'Task' }, // unknown to the extension
  ]

  it('tool NOT in any tools map stays visible when ruleset is non-empty', () => {
    const c = cfg({
      permissionSets: {
        strict: {
          permissions: {
            tools: { bash: [{ pattern: 'rm -rf *', action: 'deny' }] },
          },
        },
      },
      activePermissionSets: ['strict'],
    })
    const out = computeVisibleToolList({
      cfg: c,
      allTools: TOOLS_WITH_UNKNOWN,
    })
    expect(out).toContain('Task')
    expect(out).toContain('bash')
    expect(out).toContain('read')
    expect(out).toContain('write')
  })

  it('tool explicitly denied in a tools map stays hidden (unchanged)', () => {
    const c = cfg({
      permissionSets: {
        a: { permissions: { tools: { write: 'deny' } } },
      },
      activePermissionSets: ['a'],
    })
    const out = computeVisibleToolList({
      cfg: c,
      allTools: TOOLS_WITH_UNKNOWN,
    })
    expect(out).not.toContain('write')
    expect(out).toContain('bash')
    expect(out).toContain('read')
    expect(out).toContain('Task')
  })

  it('explicit deny on tool name hides it; PatternRule arrays are for gate not visibility', () => {
    // In the new design, PatternRule arrays only apply at the gate (per-call),
    // not for visibility (LLM tool list). Visibility only uses SimpleAction strings.
    // So a PatternRule deny on 'bash' does NOT hide the tool from the LLM.
    // Only an explicit SimpleAction 'deny' on the tool name hides it.
    const c = cfg({
      permissions: {
        tools: {
          destructive_shell: 'deny', // explicit deny by tool name
        },
      },
      activePermissionSets: [],
    })
    const out = computeVisibleToolList({
      cfg: c,
      allTools: [
        { name: 'destructive_shell', input: { command: 'rm -rf /tmp' } },
        { name: 'safe_shell', input: { command: 'echo hi' } },
        { name: 'read', input: { path: '/etc/hosts' } },
      ],
    })
    expect(out).toContain('read')
    expect(out).toContain('safe_shell')
    expect(out).not.toContain('destructive_shell')
  })

  it('unknown skill stays visible under the new visibility policy', () => {
    const c = cfg({
      permissionSets: {
        a: {
          permissions: {
            skills: { 'ts-language-server': 'allow', 'python-lsp': 'deny' },
          },
        },
      },
      activePermissionSets: ['a'],
    })
    const out = filterVisibleSkills(c, [
      'ts-language-server',
      'python-lsp',
      'mystery-skill',
    ])
    expect(out).toContain('ts-language-server')
    expect(out).not.toContain('python-lsp')
    expect(out).toContain('mystery-skill')
  })
})
