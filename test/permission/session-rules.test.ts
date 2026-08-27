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
})
