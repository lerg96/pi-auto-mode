import { ruleMatches } from '../../src/permission/rule.ts'
import { safeRegexpTest } from '../../src/classifier/pattern-matcher.ts'

// NOTE: `globToRegex` is defined but NOT exported from `src/permission/rule.ts`
// (it is a module-private helper used internally by `ruleMatches`). The glob
// contract from the spec is therefore validated through the exported `ruleMatches`,
// which exercises `globToRegex` directly.

describe('ruleMatches / glob semantics', () => {
  it("glob '*' matches arbitrarily deep paths", () => {
    expect(
      ruleMatches(
        { surface: 'fs', pattern: '/tmp/*', action: 'deny' },
        'fs',
        '/tmp/secret'
      )
    ).toBe(true)
  })

  it("glob '?' is a single-char wildcard", () => {
    expect(
      ruleMatches(
        { surface: 'fs', pattern: 'a?c', action: 'deny' },
        'fs',
        'abc'
      )
    ).toBe(true)
    expect(
      ruleMatches(
        { surface: 'fs', pattern: 'a?c', action: 'deny' },
        'fs',
        'abbc'
      )
    ).toBe(false)
  })

  it('patterns require a token boundary (no match inside a word)', () => {
    // `tmp` is preceded by `y` (inside `mytmp`), not a boundary, so it must NOT match.
    // NOTE: `/` and `\\` ARE now valid boundaries per the path-separator fix
    // (L3), so a path segment like `/tmp` WOULD match — this test therefore uses
    // a mid-word prefix to assert the boundary is still required.
    expect(
      ruleMatches(
        { surface: 'fs', pattern: 'tmp', action: 'deny' },
        'fs',
        '/mytmp/x'
      )
    ).toBe(false)
  })

  it("matches a token prefix within a command (rm -rf matches 'rm -rf /tmp')", () => {
    expect(
      ruleMatches(
        { surface: 'shell', pattern: 'rm -rf', action: 'deny' },
        'shell',
        'rm -rf /tmp'
      )
    ).toBe(true)
  })

  it('matches a token prefix after a leading command (sudo rm -rf)', () => {
    expect(
      ruleMatches(
        { surface: 'shell', pattern: 'rm -rf', action: 'deny' },
        'shell',
        'sudo rm -rf'
      )
    ).toBe(true)
  })

  it('does NOT match inside a word (rm must not match format)', () => {
    expect(
      ruleMatches(
        { surface: 'shell', pattern: 'rm', action: 'deny' },
        'shell',
        'format'
      )
    ).toBe(false)
  })

  it('matches a token prefix for compound commands (git push --force)', () => {
    expect(
      ruleMatches(
        { surface: 'shell', pattern: 'git push --force', action: 'deny' },
        'shell',
        'git push --force origin main'
      )
    ).toBe(true)
  })

  it("exact surface match is required (or '*')", () => {
    expect(
      ruleMatches(
        { surface: 'fs', pattern: '/tmp/*', action: 'deny' },
        'bash',
        '/tmp/secret'
      )
    ).toBe(false)
  })

  it("pattern '*' is match-all for any surface (regression: trusted-override allow-all)", () => {
    // '*' glob compiles to (?:^|\s).* which matches any string
    expect(
      ruleMatches(
        { surface: '*', pattern: '*', action: 'allow' },
        '*',
        'rm -rf /tmp'
      )
    ).toBe(true)
    expect(
      ruleMatches(
        { surface: '*', pattern: '*', action: 'allow' },
        'bash',
        'git push --force'
      )
    ).toBe(true)
  })

  // ── NBSP / TAB / double-space bypass hardening (PUNTO #2) ──

  it('rm -rf matches TAB-separated arg (\t)', () => {
    expect(
      ruleMatches(
        { surface: 'fs', pattern: 'rm -rf', action: 'deny' },
        'fs',
        'rm\t-rf /tmp'
      )
    ).toBe(true)
  })

  it('rm -rf matches NBSP-separated arg (\\xa0)', () => {
    expect(
      ruleMatches(
        { surface: 'fs', pattern: 'rm -rf', action: 'deny' },
        'fs',
        'rm\u00a0-rf /tmp'
      )
    ).toBe(true)
  })

  it('rm -rf matches double-space-separated arg', () => {
    expect(
      ruleMatches(
        { surface: 'fs', pattern: 'rm -rf', action: 'deny' },
        'fs',
        'rm  -rf /tmp'
      )
    ).toBe(true)
  })

  it('git push --force matches TAB between flags', () => {
    expect(
      ruleMatches(
        { surface: 'bash', pattern: 'git push --force', action: 'deny' },
        'bash',
        'git push\t--force origin main'
      )
    ).toBe(true)
  })

  it('rm must not match format (token boundary)', () => {
    expect(
      ruleMatches(
        { surface: 'shell', pattern: 'rm', action: 'deny' },
        'shell',
        'format'
      )
    ).toBe(false)
  })

  it("surface '*' with non-'*' pattern matches no surface (rule.ts:37 branch)", () => {
    // A wildcard surface only matches when the pattern is also the global
    // match-all '*'. A concrete pattern under surface '*' must not match.
    expect(
      ruleMatches(
        { surface: '*', pattern: 'rm -rf', action: 'deny' },
        'bash',
        'rm -rf /tmp'
      )
    ).toBe(false)
    expect(
      ruleMatches(
        { surface: '*', pattern: 'rm -rf', action: 'deny' },
        'fs',
        'rm -rf /tmp'
      )
    ).toBe(false)
  })
})

// ── L3 (LOW): fs `deny` by substring must treat `/` and `\\` as boundaries ──

describe('ruleMatches / Windows + POSIX path boundaries (L3)', () => {
  it("secrets matches a Windows path segment (preceded by '\\')", () => {
    expect(
      ruleMatches(
        { surface: 'fs', pattern: 'secrets', action: 'deny' },
        'fs',
        'C:\\Users\\test-user\\secrets\\key.txt'
      )
    ).toBe(true)
  })

  it("secrets matches a POSIX path segment (preceded by '/')", () => {
    expect(
      ruleMatches(
        { surface: 'fs', pattern: 'secrets', action: 'deny' },
        'fs',
        '/home/test-user/secrets/key.txt'
      )
    ).toBe(true)
  })

  it('secrets does NOT match when embedded inside a word (no boundary)', () => {
    expect(
      ruleMatches(
        { surface: 'fs', pattern: 'secrets', action: 'deny' },
        'fs',
        'mysecretsfile.txt'
      )
    ).toBe(false)
  })
})

// ── M1 (MEDIUM): ReDoS guard in ruleMatches (route through safeRegexpTest) ──

describe('ruleMatches / ReDoS guard (M1)', () => {
  it('still matches normal (non-nested) patterns correctly', () => {
    expect(
      ruleMatches(
        { surface: 'fs', pattern: '/tmp/*', action: 'deny' },
        'fs',
        '/tmp/secret'
      )
    ).toBe(true)
    expect(
      ruleMatches(
        { surface: 'shell', pattern: 'rm -rf', action: 'deny' },
        'shell',
        'sudo rm -rf'
      )
    ).toBe(true)
  })

  it('nested/ReDoS-shaped globs do not cause catastrophic backtracking', () => {
    // `*.**` compiles to a regex with several `.*` quantifiers; a very long
    // adversarial string must NOT hang. `ruleMatches` now routes through the
    // ReDoS-guarded `safeRegexpTest` (wall-clock deadline + structural check),
    // so this returns a boolean quickly instead of blocking the event loop.
    const long = 'a'.repeat(20000) + '!'.repeat(20000)
    for (const pattern of ['*.**', '***', '*.*.*']) {
      const start = performance.now()
      const result = ruleMatches(
        { surface: 'fs', pattern, action: 'deny' },
        'fs',
        long
      )
      const elapsed = performance.now() - start
      expect(typeof result).toBe('boolean')
      expect(elapsed).toBeLessThan(500) // safe path: never blocks
    }
  })

  it('safeRegexpTest aborts a genuinely catastrophic regex within the timeout', () => {
    // Direct proof that the safety net `ruleMatches` now relies on works:
    // `(a+)+b` against a long run of `a`s is exponential under a naive
    // `RegExp.test`, but `safeRegexpTest` aborts it well under the deadline.
    const body = '(a+)+b'
    const text = 'a'.repeat(50000) + '!'
    const start = performance.now()
    const result = safeRegexpTest(body, text)
    const elapsed = performance.now() - start
    expect(elapsed).toBeLessThan(200)
    expect(typeof result).toBe('boolean')
  })
})
