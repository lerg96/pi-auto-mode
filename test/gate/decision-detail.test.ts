import { buildDecisionDetail } from '../../src/gate/decision-detail.ts'
import { createHash } from 'node:crypto'

const sha1_12 = (s: string): string =>
  createHash('sha1').update(s).digest('hex').slice(0, 12)

describe('buildDecisionDetail', () => {
  const startedAt = Date.now() - 5

  it('builds the base fields and omits optional sections', () => {
    const { detail } = buildDecisionDetail({
      toolName: 'bash',
      matchedSurface: 'shell',
      matchedValue: 'echo hi',
      startedAt,
    })
    expect(detail.toolName).toBe('bash')
    expect(detail.matchedSurface).toBe('shell')
    expect(detail.matchedValue).toBe('echo hi')
    expect(detail.latencyMs).toBeGreaterThanOrEqual(0)
    expect(detail.rule).toBeUndefined()
    expect(detail.risk).toBeUndefined()
    expect(detail.strategy).toBeUndefined()
  })

  it('attaches a stable ruleId (sha1 surface|pattern, 12 hex)', () => {
    const { detail } = buildDecisionDetail({
      toolName: 'bash',
      matchedSurface: 'shell',
      matchedValue: 'rm -rf /tmp/x',
      rule: { surface: 'bash', pattern: 'rm -rf *', reason: 'destructive' },
      startedAt,
    })
    expect(detail.rule?.surface).toBe('bash')
    expect(detail.rule?.pattern).toBe('rm -rf *')
    expect(detail.rule?.reason).toBe('destructive')
    expect(detail.rule?.ruleId).toBe(sha1_12('bash|rm -rf *'))
  })

  it('omits rule.reason when the rule has none', () => {
    const { detail } = buildDecisionDetail({
      toolName: 'bash',
      matchedSurface: 'shell',
      matchedValue: 'v',
      rule: { surface: 'bash', pattern: 'p' },
      startedAt,
    })
    expect(detail.rule && 'reason' in detail.rule).toBe(false)
  })

  it('attaches risk fields and passes riskOrigin through', () => {
    const { detail } = buildDecisionDetail({
      toolName: 'bash',
      matchedSurface: 'shell',
      matchedValue: 'v',
      risk: {
        score: 7,
        level: 'high',
        category: 'destructive',
        reason: 'r',
        riskOrigin: 'llm',
      },
      startedAt,
    })
    expect(detail.risk).toEqual({
      score: 7,
      level: 'high',
      category: 'destructive',
      reason: 'r',
      riskOrigin: 'llm',
    })
  })

  it('omits risk.category/reason when absent', () => {
    const { detail } = buildDecisionDetail({
      toolName: 'bash',
      matchedSurface: 'shell',
      matchedValue: 'v',
      risk: { score: 1, level: 'low' },
      startedAt,
    })
    expect(detail.risk).toEqual({ score: 1, level: 'low' })
  })

  it('includes strategy only when provided', () => {
    const withStrategy = buildDecisionDetail({
      toolName: 'bash',
      matchedSurface: 'shell',
      matchedValue: 'v',
      startedAt,
      strategy: 'auto-retry',
    })
    expect(withStrategy.detail.strategy).toBe('auto-retry')
  })

  it('redacts secret-looking values', () => {
    const { detail } = buildDecisionDetail({
      toolName: 'bash',
      matchedSurface: 'shell',
      matchedValue: 'password=hunter2secret',
      startedAt,
    })
    expect(detail.matchedValue).toContain('[REDACTED]')
    expect(detail.matchedValue).not.toContain('hunter2secret')
  })

  it('attaches risk.decision when present', () => {
    const { detail } = buildDecisionDetail({
      toolName: 'bash',
      matchedSurface: 'shell',
      matchedValue: 'ls',
      risk: {
        score: 5,
        level: 'medium',
        decision: 'ask',
      },
      startedAt,
    })
    expect(detail.risk?.decision).toBe('ask')
  })

  it('populates cwd, fullCommand, and segments with redaction', () => {
    const { detail } = buildDecisionDetail({
      toolName: 'bash',
      matchedSurface: 'shell',
      matchedValue: 'echo 1',
      cwd: '/home/user/project',
      fullCommand: 'echo 1 && echo password=hunter2secret',
      segments: ['echo 1', 'echo password=hunter2secret'],
      startedAt,
    })
    expect(detail.cwd).toBeDefined()
    expect(detail.fullCommand).toContain('[REDACTED]')
    expect(detail.fullCommand).not.toContain('hunter2secret')
    expect(detail.segments).toHaveLength(2)
    expect(detail.segments?.[0]).toBe('echo 1')
    expect(detail.segments?.[1]).toContain('[REDACTED]')
    expect(detail.segments?.[1]).not.toContain('hunter2secret')
  })

  it('populates externalScope when provided', () => {
    const { detail } = buildDecisionDetail({
      toolName: 'read',
      matchedSurface: 'fs',
      matchedValue: '/etc/passwd',
      externalScope: {
        outsideCwd: true,
        externalDir: '/etc',
        action: 'ask',
      },
      startedAt,
    })
    expect(detail.externalScope).toEqual({
      outsideCwd: true,
      externalDir: '/etc',
      action: 'ask',
    })
  })

  it('handles externalScope without optional externalDir or action', () => {
    const { detail } = buildDecisionDetail({
      toolName: 'read',
      matchedSurface: 'fs',
      matchedValue: 'foo.txt',
      externalScope: {
        outsideCwd: false,
      },
      startedAt,
    })
    expect(detail.externalScope).toEqual({
      outsideCwd: false,
    })
  })
})
