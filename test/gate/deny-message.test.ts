import { formatDenyMessage } from '../../src/gate/deny-message.ts'

describe('formatDenyMessage', () => {
  it('renders the unknown_tool message with the tool name', () => {
    const msg = formatDenyMessage({
      kind: 'unknown_tool',
      toolName: 'WeirdTool',
      command: 'x',
      surface: 'WeirdTool',
    })
    expect(msg).toContain('tool name was unrecognized by the gate')
    expect(msg).toContain("Tool: 'WeirdTool'")
  })

  it('falls back to "unknown" for an empty tool name', () => {
    const msg = formatDenyMessage({
      kind: 'unknown_tool',
      toolName: '',
      command: 'x',
      surface: '',
    })
    expect(msg).toContain("Tool: 'unknown'")
  })

  it('renders the classifier_block message with score/level/category', () => {
    const msg = formatDenyMessage({
      kind: 'classifier_block',
      toolName: 'bash',
      command: 'rm -rf /',
      surface: 'shell',
      risk: { score: 9, level: 'high', category: 'destructive', reason: 'rr' },
    })
    expect(msg).toContain('denied by classifier')
    expect(msg).toContain('score 9/10, level high, category destructive')
    expect(msg).toContain('reason rr')
  })

  it('adds the LLM explanation line only for llm-origin risk', () => {
    const base = {
      kind: 'classifier_block' as const,
      toolName: 'bash',
      command: 'c',
      surface: 'shell',
    }
    const llm = formatDenyMessage({
      ...base,
      risk: {
        score: 9,
        level: 'high',
        reason: 'why',
        riskOrigin: 'llm',
      },
    })
    const rule = formatDenyMessage({
      ...base,
      risk: {
        score: 9,
        level: 'high',
        reason: 'why',
        riskOrigin: 'rule',
      },
    })
    expect(llm).toContain('LLM explanation: why  (source: LLM classifier)')
    expect(rule).not.toContain('LLM explanation')
  })

  it('renders permission_deny with the rule line and reason', () => {
    const msg = formatDenyMessage({
      kind: 'permission_deny',
      toolName: 'bash',
      command: 'rm -rf /tmp/x',
      surface: 'shell',
      rulePattern: 'rm -rf *',
      ruleSurface: 'bash',
      ruleReason: 'destructive',
    })
    expect(msg).toContain('blocked by a deny rule')
    expect(msg).toContain('Rule: bash / rm -rf *  (reason: destructive)')
  })

  it('renders escalate without a reason using the * placeholder', () => {
    const msg = formatDenyMessage({
      kind: 'escalate',
      toolName: 'bash',
      command: 'c',
      surface: 'shell',
    })
    expect(msg).toContain('Rule: shell / *')
  })
})
