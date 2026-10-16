import { evaluate, mostRestrictive } from '../../src/permission/evaluate.ts'
import type { Ruleset } from '../../src/permission/rule.ts'

describe('mostRestrictive', () => {
  it('deny dominates allow', () => {
    expect(mostRestrictive('allow', 'deny')).toBe('deny')
  })
  it('ask dominates allow', () => {
    expect(mostRestrictive('allow', 'ask')).toBe('ask')
  })
  it('deny dominates ask', () => {
    expect(mostRestrictive('ask', 'deny')).toBe('deny')
  })
  it('is stable for equal ranks', () => {
    expect(mostRestrictive('ask', 'allow')).toBe('ask')
    expect(mostRestrictive('deny', 'deny')).toBe('deny')
    expect(mostRestrictive('allow', 'allow')).toBe('allow')
  })
})

describe('evaluate', () => {
  it('returns the last-match action', () => {
    const rs: Ruleset = [
      { surface: 'fs', pattern: '/tmp/secret', action: 'deny' },
      { surface: 'fs', pattern: '/tmp/*', action: 'allow' },
    ]
    // both rules match "/tmp/secret"; the later (allow) wins
    expect(evaluate('fs', '/tmp/secret', rs).action).toBe('allow')
  })

  it("surface '*' is a catch-all matching any surface and value", () => {
    const rs: Ruleset = [{ surface: '*', pattern: '*', action: 'deny' }]
    expect(evaluate('fs', '/tmp/x', rs).action).toBe('deny')
    expect(evaluate('bash', 'rm -rf', rs).action).toBe('deny')
    expect(evaluate('mcp', 'anything', rs).action).toBe('deny')
  })

  it('S1/L2: a precise config deny wins over a later session allow', () => {
    const rs: Ruleset = [
      {
        surface: 'fs',
        pattern: '/etc/shadow',
        action: 'deny',
        origin: 'config',
      },
      {
        surface: 'fs',
        pattern: '/etc/shadow',
        action: 'allow',
        origin: 'session',
      },
    ]
    // The session allow would win under plain last-match-wins, but a precise
    // config/system deny for the exact (surface, value) pair is authoritative.
    const r = evaluate('fs', '/etc/shadow', rs)
    expect(r.action).toBe('deny')
    expect(r.origin).toBe('config')
  })

  it('L2: a precise config deny beats a session allow even when listed first', () => {
    const rs: Ruleset = [
      {
        surface: 'fs',
        pattern: '/etc/shadow',
        action: 'deny',
        origin: 'config',
      },
      {
        surface: 'fs',
        pattern: '/etc/shadow',
        action: 'allow',
        origin: 'session',
      },
      {
        surface: 'fs',
        pattern: '/etc/shadow',
        action: 'allow',
        origin: 'session',
      },
    ]
    expect(evaluate('fs', '/etc/shadow', rs).action).toBe('deny')
  })

  it('M7: an empty ruleset defaults to deny (fail-closed)', () => {
    const rs: Ruleset = []
    const r = evaluate('fs', '/tmp/x', rs)
    expect(r.action).toBe('deny')
    expect(r.surface).toBe('fs')
    expect(r.pattern).toBe('/tmp/x')
  })

  it('iterates within bounds and never reads past the end of the ruleset', () => {
    const rs: Ruleset = [
      { surface: 'fs', pattern: '/tmp/*', action: 'allow' },
      { surface: 'fs', pattern: '/tmp/secret', action: 'deny' },
    ]
    // A 2-element ruleset must only index [1] and [0]; an off-by-one (i++)
    // that runs past the end would read `undefined` and throw on `rule.surface`.
    expect(() => evaluate('fs', '/tmp/secret', rs)).not.toThrow()
    expect(evaluate('fs', '/tmp/secret', rs).action).toBe('deny')
  })

  it('a broad (wildcard) config deny is still relaxable by a specific session allow', () => {
    const rs: Ruleset = [
      { surface: 'shell', pattern: '*', action: 'deny', origin: 'config' },
      {
        surface: 'shell',
        pattern: 'rm -rf /tmp',
        action: 'allow',
        origin: 'session',
      },
    ]
    expect(evaluate('shell', 'rm -rf /tmp', rs).action).toBe('allow')
  })

  it('matches allow rule python * when command has env prefix PYTHONPATH=.', () => {
    const rs: Ruleset = [
      { surface: 'shell', pattern: 'python *', action: 'allow' },
    ]
    expect(evaluate('shell', 'PYTHONPATH=. python -m pytest', rs).action).toBe(
      'allow'
    )
  })

  it('catches FOO=1 rm -rf / under deny rule rm -rf *', () => {
    const rs: Ruleset = [
      { surface: 'bash', pattern: 'rm -rf *', action: 'deny' },
    ]
    expect(evaluate('bash', 'FOO=1 rm -rf /', rs).action).toBe('deny')
  })

  it('catches LD_PRELOAD=/evil.so ls under deny rule LD_PRELOAD=*', () => {
    const rs: Ruleset = [
      { surface: 'shell', pattern: 'LD_PRELOAD=*', action: 'deny' },
    ]
    expect(evaluate('shell', 'LD_PRELOAD=/evil.so ls', rs).action).toBe('deny')
  })

  it('matches multiline commands under wildcard allow rule', () => {
    const rs: Ruleset = [
      { surface: 'shell', pattern: 'python3 *', action: 'allow' },
    ]
    expect(
      evaluate('shell', 'python3 -c "import sys\nprint(1)"', rs).action
    ).toBe('allow')
  })
})
