import {
  safeRegexpTest,
  collapseWhitespaceForMatching,
} from '../../src/classifier/pattern-matcher.ts'

// The rule-based engine (PatternMatcher / rule-evaluator / block-rules) has
// been retired — see the history note in src/classifier/pattern-matcher.ts.
// These suites cover the two primitives the live permission path keeps using.

describe('collapseWhitespaceForMatching', () => {
  it('collapses runs of spaces/tabs/newlines to one space and trims', () => {
    expect(collapseWhitespaceForMatching('  rm \t-rf\n/tmp  ')).toBe(
      'rm -rf /tmp'
    )
    expect(collapseWhitespaceForMatching('single  spaces')).toBe(
      'single spaces'
    )
    expect(collapseWhitespaceForMatching('as-is')).toBe('as-is')
    expect(collapseWhitespaceForMatching('   ')).toBe('')
  })

  it('is idempotent', () => {
    const once = collapseWhitespaceForMatching('rm   -rf\t/')
    expect(collapseWhitespaceForMatching(once)).toBe(once)
  })

  it('never invents text: distinct literals stay distinct after collapsing', () => {
    // Collapsing must not turn a non-match into a match for different literals.
    expect(collapseWhitespaceForMatching('rm  - r f')).toBe('rm - r f')
    expect(collapseWhitespaceForMatching('rm -rf /tmp')).not.toBe('rm -r /tmp')
    expect(collapseWhitespaceForMatching('echo   world')).toBe('echo world')
  })
})

describe('safeRegexpTest', () => {
  describe('correctness on legitimate patterns', () => {
    it('matches and does not match as a plain RegExp would', () => {
      expect(safeRegexpTest('rm -rf', 'sudo rm -rf /tmp')).toBe(true)
      expect(safeRegexpTest('docker', 'rm -rf /tmp')).toBe(false)
      expect(safeRegexpTest('^cat .*\\.env$', 'cat .env')).toBe(true)
    })

    it('is case-insensitive', () => {
      expect(safeRegexpTest('RM -RF', 'rm -rf /')).toBe(true)
    })

    it('handles glob-converted patterns (anchored .* bodies)', () => {
      expect(safeRegexpTest('^cat.*id_rsa$', 'cat ~/.ssh/id_rsa')).toBe(true)
      expect(safeRegexpTest('^cat.*id_rsa$', 'cat /etc/passwd')).toBe(false)
    })
  })

  // ── C3 regression: ReDoS safety ──────────────────────────────
  describe('ReDoS safety (C3)', () => {
    // Structurally catastrophic shapes: rejected by `looksReDoSy` before the
    // RegExp ever runs, so the verdict is a clean false.
    const catastrophic = [
      '(a+)+$',
      '([a-z]+)*$',
      '(a|a?)+',
      '(a*)*$',
      '(a+){2,}$',
      '((a)+)+',
      'a**',
    ]
    // Not catastrophic — simply uncompilable: they throw at compile time, and
    // that path fails closed (true), the opposite verdict from the above.
    const MALFORMED = ['(unclosed', 'a[a-z]+)+', '(?<)', 'a{2,1}', '*leading']

    it.each(catastrophic)(
      'does not hang on catastrophic pattern %s',
      (body) => {
        const input = 'a'.repeat(60) + '!'
        const start = performance.now()
        const result = safeRegexpTest(body, input)
        const elapsed = performance.now() - start
        expect(elapsed).toBeLessThan(100)
        // Structurally unsafe patterns are rejected outright, not executed.
        expect(result).toBeFalsy()
      }
    )

    it('never throws, even for pathological input', () => {
      const input = 'a'.repeat(120) + '!'
      for (const body of catastrophic.concat(MALFORMED, ['.*.*.*.*.*'])) {
        expect(() => safeRegexpTest(body, input)).not.toThrow()
      }
    })

    it.each(MALFORMED)(
      'fails closed on a pattern that cannot compile: %s',
      (body) => {
        // A broken pattern must not become a silent miss.
        expect(safeRegexpTest(body, 'anything')).toBe(true)
      }
    )

    it('aborts a runaway match within the wall-clock budget', () => {
      // Nested quantifiers written to dodge the structural check's shape by
      // keeping depth low: the timeout is the backstop being exercised here.
      const body = '(a+)+b'
      const input = 'a'.repeat(50)
      const start = performance.now()
      safeRegexpTest(body, input, 5)
      expect(performance.now() - start).toBeLessThan(200)
    })
  })
})
