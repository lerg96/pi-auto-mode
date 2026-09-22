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
    expect(detail.matchedValue).toBe('[REDACTED]')
  })
})
