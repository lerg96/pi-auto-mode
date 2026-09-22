import { homedir } from 'node:os'
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

// PIN: deny messages must NOT mask the home prefix. They travel back to the
// model that is actively trying to fix and re-run the command; a literal
// C:/Users/[REDACTED]/... invites it to reissue that string and fail again
// (functional regression, not a privacy win). Home masking lives only at the
// persistence/exfiltration boundaries (telemetry JSONL, external LLM prompt).
// If you are tempted to "be consistent" and add home masking to the shared
// model-facing redactor, these tests must fail first.
describe('formatDenyMessage — home path is deliberately NOT masked', () => {
  it('keeps the real home path intact in permission_deny messages', () => {
    const cmd = `cat ${homedir()}/notes.md`
    const msg = formatDenyMessage({
      kind: 'permission_deny',
      toolName: 'bash',
      command: cmd,
      surface: 'shell',
      rulePattern: 'cat *',
      ruleSurface: 'bash',
    })
    expect(msg).toContain(cmd)
    expect(msg).not.toContain('[REDACTED]')
  })

  it('keeps the real home path intact in classifier_block messages', () => {
    const cmd = `rm -rf ${homedir()}/tmp-dir`
    const msg = formatDenyMessage({
      kind: 'classifier_block',
      toolName: 'bash',
      command: cmd,
      surface: 'shell',
      risk: {
        score: 9,
        level: 'high',
        category: 'destructive',
        reason: `touches ${homedir()}`,
      },
    })
    expect(msg).toContain(cmd)
    expect(msg).toContain(homedir())
    expect(msg).not.toContain('[REDACTED]')
  })
})
