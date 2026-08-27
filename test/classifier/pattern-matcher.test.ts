import { PatternMatcher } from '../../src/classifier/pattern-matcher.ts'
import { segmentCommand } from '../../src/gate/normalize.ts'

describe('PatternMatcher', () => {
  describe('plain substring matches', () => {
    it('matches a plain substring case-insensitively', () => {
      const pm = new PatternMatcher()
      expect(pm.match('rm -rf', 'sudo rm -rf /tmp')).toBe(true)
    })

    it('does not match when substring is absent', () => {
      const pm = new PatternMatcher()
      expect(pm.match('docker', 'rm -rf /tmp')).toBe(false)
    })
  })

  describe('glob matches', () => {
    it('matches a glob pattern with wildcard', () => {
      const pm = new PatternMatcher()
      // cat *id_rsa — glob with * expands to .*
      expect(pm.match('cat *id_rsa', 'cat /home/user/.ssh/id_rsa')).toBe(true)
    })

    it('does not match glob when pattern does not align', () => {
      const pm = new PatternMatcher()
      expect(pm.match('cat *id_rsa', 'cat report.txt')).toBe(false)
    })
  })

  describe('regex: prefixed matches', () => {
    it('matches a valid regex: pattern', () => {
      const pm = new PatternMatcher()
      expect(pm.match('regex:rm\\s+-rf', 'sudo rm -rf /tmp')).toBe(true)
    })

    it('falls back to substring when regex: body does not match but appears as text', () => {
      const pm = new PatternMatcher()
      // The regex \bfoo\b won't match "foo bar" as a whole-word match unless word boundary works — but safeRegexpTest runs it.
      expect(pm.match('regex:foo', 'foo bar')).toBe(true)
    })
  })

  describe('splitSegments', () => {
    it('splits on semicolons', () => {
      const pm = new PatternMatcher()
      expect(pm.splitSegments('cmd1; cmd2')).toEqual(['cmd1', 'cmd2'])
    })

    it('splits on pipes', () => {
      const pm = new PatternMatcher()
      expect(pm.splitSegments('ls | grep foo')).toEqual(['ls', 'grep foo'])
    })

    it('filters empty segments', () => {
      const pm = new PatternMatcher()
      expect(pm.splitSegments('cmd1;; cmd2')).toEqual(['cmd1', 'cmd2'])
    })
  })

  // ── H6: splitSegments must agree with the gate's quote-aware segmentCommand ──
  describe('splitSegments parity with segmentCommand (H6)', () => {
    const cases = ['a && b', 'a | b', 'sh -c "x; y"', 'echo "a;b"', 'a || b']
    for (const cmd of cases) {
      it(
        'produces the same segments as segmentCommand for ' +
          JSON.stringify(cmd),
        () => {
          const pm = new PatternMatcher()
          expect(pm.splitSegments(cmd)).toEqual(
            segmentCommand(cmd).map((s) => s.value)
          )
        }
      )
    }

    it('is quote-aware: a semicolon inside a quoted literal is not a separator', () => {
      const pm = new PatternMatcher()
      expect(pm.splitSegments('echo "a;b" | cat')).toEqual(
        segmentCommand('echo "a;b" | cat').map((s) => s.value)
      )
    })
  })

  // ── C3 regression: ReDoS safety ──────────────────────────────
  describe('ReDoS safety (C3)', () => {
    it('does not hang on nested-quantifier pattern (a+)+$', () => {
      const pm = new PatternMatcher()
      const input = 'a'.repeat(50) + '!'
      const start = performance.now()
      const result = pm.match('regex:(a+)+$', input)
      const elapsed = performance.now() - start
      expect(elapsed).toBeLessThan(100)
      // Should return false (safe fallback) or at least not hang
      expect(result).toBeFalsy()
    })

    it('does not hang on ([a-z]+)*$ pattern', () => {
      const pm = new PatternMatcher()
      const input = 'a'.repeat(50) + '!'
      const start = performance.now()
      const result = pm.match('regex:([a-z]+)*$', input)
      const elapsed = performance.now() - start
      expect(elapsed).toBeLessThan(100)
      expect(result).toBeFalsy()
    })

    it('does not hang on (a|a?)+ pattern', () => {
      const pm = new PatternMatcher()
      const input = 'a'.repeat(50) + '!'
      const start = performance.now()
      const _result = pm.match('regex:(a|a?)+', input)
      const elapsed = performance.now() - start
      expect(elapsed).toBeLessThan(100)
    })

    it('match() NEVER throws, even for pathological input', () => {
      const pm = new PatternMatcher()
      const patterns = [
        'regex:(a+)+$',
        'regex:([a-z]+)*$',
        'regex:(a|a?)+',
        'regex:(a*)*$',
        'regex:(a+){2,}$',
        'regex:.*.*.*.*.*',
        'regex:((a)+)+',
      ]
      const input = 'a'.repeat(100) + '!'
      for (const pattern of patterns) {
        expect(() => pm.match(pattern, input)).not.toThrow()
      }
    })
  })
})
