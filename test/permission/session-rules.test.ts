import { SessionRules } from '../../src/permission/session-rules.ts'
import { evaluate } from '../../src/permission/evaluate.ts'

describe('SessionRules', () => {
  let rules: SessionRules

  beforeEach(() => {
    rules = new SessionRules()
  })

  it('snapshot starts empty', () => {
    expect(rules.snapshot()).toEqual([])
    expect(rules.size()).toBe(0)
  })

  it('approveForSession adds a rule visible in snapshot and size', () => {
    rules.approveForSession('fs', '/tmp/*', 'allow')
    expect(rules.size()).toBe(1)
    const snap = rules.snapshot()
    expect(snap).toHaveLength(1)
    expect(snap[0]).toMatchObject({
      surface: 'fs',
      pattern: '/tmp/*',
      action: 'allow',
      origin: 'session',
    })
  })

  it('multiple calls accumulate entries', () => {
    rules.approveForSession('fs', '/tmp/*', 'allow')
    rules.approveForSession('shell', 'echo *', 'allow')
    expect(rules.size()).toBe(2)
    expect(rules.snapshot()).toHaveLength(2)
  })

  it('snapshot returns shallow copies (mutation does not affect internal state)', () => {
    rules.approveForSession('fs', '/tmp/*', 'allow')
    const snap = rules.snapshot()
    snap.push({ surface: 'x', pattern: 'y', action: 'deny' } as never)
    expect(rules.size()).toBe(1)
  })

  it('clear() empties all rules', () => {
    rules.approveForSession('fs', '/tmp/*', 'allow')
    rules.approveForSession('shell', 'echo *', 'allow')
    rules.clear()
    expect(rules.size()).toBe(0)
    expect(rules.snapshot()).toEqual([])
  })

  it('clear() on empty rules is a no-op', () => {
    rules.clear()
    expect(rules.size()).toBe(0)
    expect(rules.snapshot()).toEqual([])
  })

  it('L5: approveForSession deduplicates the same (surface, value) pair', () => {
    // Simulate the gate re-persisting after the modal already approved-for-session.
    rules.approveForSession('fs', '/etc/shadow', 'allow')
    rules.approveForSession('fs', '/etc/shadow', 'allow')
    expect(rules.size()).toBe(1)
    const snap = rules.snapshot()
    expect(snap).toHaveLength(1)
    expect(snap[0]).toMatchObject({
      surface: 'fs',
      pattern: '/etc/shadow',
      action: 'allow',
      origin: 'session',
    })
  })

  it('clear does not affect other instances (isolation)', () => {
    const other = new SessionRules()
    rules.approveForSession('fs', '/tmp/*', 'allow')
    rules.clear()
    // other was never touched
    expect(other.size()).toBe(0)
  })

  describe('approveForSession is bounded to the exact (surface, value) pair (L3)', () => {
    const baselineDeny = [
      { surface: 'shell', pattern: '*', action: 'deny' as const },
    ]

    it('allow for one exact pair does not bleed to a different value', () => {
      rules.approveForSession('shell', 'rm -rf /tmp', 'allow')
      const snap = [...baselineDeny, ...rules.snapshot()]
      // exact pair: session allow overrides the baseline deny.
      expect(evaluate('shell', 'rm -rf /tmp', snap).action).toBe('allow')
      expect(evaluate('shell', 'rm -rf /tmp', snap).origin).toBe('session')
      // different value on the SAME surface stays denied by the baseline.
      const other = evaluate('shell', 'rm -rf /var', snap)
      expect(other.action).toBe('deny')
      expect(other.origin).not.toBe('session')
    })

    it('allow for one exact pair does not bleed to a different surface', () => {
      rules.approveForSession('shell', 'rm -rf /tmp', 'allow')
      const snap = rules.snapshot()
      // same value on a DIFFERENT surface is NOT covered by the session allow.
      const other = evaluate('bash', 'rm -rf /tmp', snap)
      expect(other.origin).not.toBe('session')
      // and the exact pair is still the session allow.
      expect(evaluate('shell', 'rm -rf /tmp', snap).origin).toBe('session')
    })
  })

  describe('approveForSession hierarchy and deduplication', () => {
    it('narrow-then-broad keeps broad and drops narrow', () => {
      rules.approveForSession('shell', 'aws s3 ls', 'allow')
      expect(rules.size()).toBe(1)
      rules.approveForSession('shell', 'aws *', 'allow')
      expect(rules.size()).toBe(1)
      expect(rules.snapshot()).toEqual([
        {
          surface: 'shell',
          pattern: 'aws *',
          action: 'allow',
          origin: 'session',
        },
      ])
    })

    it('broad-then-narrow keeps only broad', () => {
      rules.approveForSession('shell', 'aws *', 'allow')
      expect(rules.size()).toBe(1)
      rules.approveForSession('shell', 'aws s3 ls', 'allow')
      expect(rules.size()).toBe(1)
      expect(rules.snapshot()).toEqual([
        {
          surface: 'shell',
          pattern: 'aws *',
          action: 'allow',
          origin: 'session',
        },
      ])
    })

    it('keeps different surfaces independent', () => {
      rules.approveForSession('shell', 'aws *', 'allow')
      rules.approveForSession('fs', 'aws *', 'allow')
      expect(rules.size()).toBe(2)

      rules.approveForSession('fs', 'aws', 'allow')
      expect(rules.size()).toBe(2)
      const snap = rules.snapshot()
      expect(snap.find((r) => r.surface === 'shell')?.pattern).toBe('aws *')
      expect(snap.find((r) => r.surface === 'fs')?.pattern).toBe('aws *')
    })

    it('handles aws * vs aws and awsx', () => {
      rules.approveForSession('shell', 'aws', 'allow')
      expect(rules.size()).toBe(1)

      // aws * covers aws -> drops aws and keeps aws *
      rules.approveForSession('shell', 'aws *', 'allow')
      expect(rules.size()).toBe(1)
      expect(rules.snapshot()[0]?.pattern).toBe('aws *')

      // aws * does NOT cover awsx -> both are kept
      rules.approveForSession('shell', 'awsx', 'allow')
      expect(rules.size()).toBe(2)
      const patterns = rules.snapshot().map((r) => r.pattern)
      expect(patterns).toContain('aws *')
      expect(patterns).toContain('awsx')
    })

    it('multiple narrower rules are cleaned up by a broad pattern', () => {
      rules.approveForSession('shell', 'aws s3 ls', 'allow')
      rules.approveForSession('shell', 'aws ec2 describe', 'allow')
      expect(rules.size()).toBe(2)

      rules.approveForSession('shell', 'aws *', 'allow')
      expect(rules.size()).toBe(1)
      expect(rules.snapshot()[0]?.pattern).toBe('aws *')
    })

    it('exact command with wildcards (isExact: true) does not cover other commands as glob', () => {
      rules.approveForSession('shell', 'rm *.log', 'allow', true)
      expect(rules.size()).toBe(1)
      expect(rules.snapshot()[0].isExact).toBe(true)

      // rm a.log must NOT be covered by exact 'rm *.log'
      rules.approveForSession('shell', 'rm a.log', 'allow', true)
      expect(rules.size()).toBe(2)
      const patterns = rules.snapshot().map((r) => r.pattern)
      expect(patterns).toContain('rm *.log')
      expect(patterns).toContain('rm a.log')
    })

    it('exact command deduplicates identical exact pattern', () => {
      rules.approveForSession('shell', 'rm *.log', 'allow', true)
      rules.approveForSession('shell', 'rm *.log', 'allow', true)
      expect(rules.size()).toBe(1)
    })

    it('broad wildcard pattern covers narrower exact command with wildcard chars', () => {
      rules.approveForSession('shell', 'rm *.log', 'allow', true)
      expect(rules.size()).toBe(1)
      rules.approveForSession('shell', 'rm *', 'allow')
      expect(rules.size()).toBe(1)
      expect(rules.snapshot()[0]?.pattern).toBe('rm *')
    })
  })
})
