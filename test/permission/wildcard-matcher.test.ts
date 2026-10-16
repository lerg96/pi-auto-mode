import {
  wildcardMatch,
  sessionPatternMatches,
} from '../../src/permission/wildcard-matcher.ts'

describe('wildcardMatch / literal', () => {
  it('matches an identical string', () => {
    expect(wildcardMatch('bash', 'bash')).toBe(true)
  })

  it('does not match a different string', () => {
    expect(wildcardMatch('bash', 'read')).toBe(false)
  })

  it('returns false for an empty pattern', () => {
    expect(wildcardMatch('', 'bash')).toBe(false)
  })

  it('returns false for an empty value', () => {
    expect(wildcardMatch('bash', '')).toBe(false)
  })

  it('returns false when either side is not a string', () => {
    expect(wildcardMatch('bash', undefined as unknown as string)).toBe(false)
    expect(wildcardMatch(undefined as unknown as string, 'bash')).toBe(false)
  })
})

describe('wildcardMatch / *', () => {
  it('"*" matches any string (including empty)', () => {
    expect(wildcardMatch('*', 'bash')).toBe(true)
    expect(wildcardMatch('*', '')).toBe(true)
  })

  it('"bash*" matches strings starting with bash', () => {
    expect(wildcardMatch('bash*', 'bash')).toBe(true)
    expect(wildcardMatch('bash*', 'bash:status')).toBe(true)
    expect(wildcardMatch('bash*', 'bash_extra')).toBe(true)
    expect(wildcardMatch('bash*', 'read')).toBe(false)
  })

  it('"*git*" matches strings containing git', () => {
    expect(wildcardMatch('*git*', 'git')).toBe(true)
    expect(wildcardMatch('*git*', 'github-mcp')).toBe(true)
    expect(wildcardMatch('*git*', 'my-git-tool')).toBe(true)
    expect(wildcardMatch('*git*', 'bash')).toBe(false)
  })

  it('"**" collapses to the same as "*"', () => {
    expect(wildcardMatch('**', 'bash')).toBe(true)
    expect(wildcardMatch('a**b', 'aXYZb')).toBe(true)
    expect(wildcardMatch('a**b', 'ab')).toBe(true)
  })

  it('matches across newlines in multiline commands', () => {
    expect(
      wildcardMatch('python3 *', 'python3 -c "import sys\nprint(1)"')
    ).toBe(true)
  })
})

describe('wildcardMatch / ?', () => {
  it('"?" matches any single character', () => {
    expect(wildcardMatch('?', 'a')).toBe(true)
    expect(wildcardMatch('?', 'Z')).toBe(true)
    expect(wildcardMatch('?', '')).toBe(false)
  })

  it('"a?c" matches exactly three-char strings with a and c at the ends', () => {
    expect(wildcardMatch('a?c', 'abc')).toBe(true)
    expect(wildcardMatch('a?c', 'axc')).toBe(true)
    expect(wildcardMatch('a?c', 'ac')).toBe(false)
    expect(wildcardMatch('a?c', 'abbc')).toBe(false)
  })

  it('"???" matches any 3-character string', () => {
    expect(wildcardMatch('???', 'abc')).toBe(true)
    expect(wildcardMatch('???', 'xy')).toBe(false)
    expect(wildcardMatch('???', 'abcd')).toBe(false)
  })

  it('combined "*?" greedy-walks but always anchors', () => {
    expect(wildcardMatch('a*?z', 'abz')).toBe(true)
    expect(wildcardMatch('a*?z', 'abcxyz')).toBe(true)
    expect(wildcardMatch('a*?z', 'az')).toBe(false)
  })
})

describe('wildcardMatch / case sensitivity', () => {
  it('is case-sensitive on non-Windows platforms', () => {
    const before = process.platform
    Object.defineProperty(process, 'platform', { value: 'linux' })
    try {
      expect(wildcardMatch('Bash', 'bash')).toBe(false)
      expect(wildcardMatch('bash', 'Bash')).toBe(false)
    } finally {
      Object.defineProperty(process, 'platform', { value: before })
    }
  })

  it('is case-insensitive on Windows', () => {
    const before = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32' })
    try {
      expect(wildcardMatch('Bash', 'bash')).toBe(true)
      expect(wildcardMatch('bash', 'Bash')).toBe(true)
      // patterns with wildcards still match across case
      expect(wildcardMatch('BASH*', 'bash_status')).toBe(true)
    } finally {
      Object.defineProperty(process, 'platform', { value: before })
    }
  })
})

describe('wildcardMatch / ReDoS safety (linear scan)', () => {
  it('handles pathological * at the start quickly', () => {
    const long = 'x'.repeat(20000)
    const start = performance.now()
    const result = wildcardMatch('*' + 'x'.repeat(50), long)
    const elapsed = performance.now() - start
    expect(typeof result).toBe('boolean')
    expect(elapsed).toBeLessThan(200)
  })

  it('handles a deep ?-run quickly', () => {
    const long = 'x'.repeat(5000)
    const start = performance.now()
    const result = wildcardMatch('?'.repeat(5000), long)
    const elapsed = performance.now() - start
    expect(typeof result).toBe('boolean')
    expect(elapsed).toBeLessThan(200)
  })

  it('terminates fast on the multi-star pathological case (n=12)', () => {
    // The old recursive matcher needed >25s (killed) for n=10 here.
    const n = 12
    const pattern = '/home/user/' + '*/'.repeat(n) + 'END'
    let value = '/home/user/'
    while (value.length < 200) value += 'a/'
    value += 'other'
    const start = performance.now()
    const result = wildcardMatch(pattern, value)
    const elapsed = performance.now() - start
    expect(result).toBe(false)
    expect(elapsed).toBeLessThan(100)
  })
})

/**
 * Reference implementation: the previous recursive matcher, kept verbatim so
 * the differential fuzz below can prove the new iterative matcher is
 * behaviour-preserving. It is exponential in the number of '*' groups, so it
 * is only ever fed the short inputs generated by the fuzz loops.
 */
function referenceMatch(p: string, pi: number, v: string, vi: number): boolean {
  while (pi < p.length) {
    const pc = p.charCodeAt(pi)
    if (pc === 42 /* '*' */) {
      // collapse runs of '*'
      while (pi < p.length && p.charCodeAt(pi) === 42) pi++
      // '*' at end matches everything left
      if (pi === p.length) return true
      // try every possible position in v
      while (vi <= v.length) {
        if (referenceMatch(p, pi, v, vi)) return true
        vi++
      }
      return false
    }
    if (vi >= v.length) return false
    if (pc === 63 /* '?' */) {
      pi++
      vi++
      continue
    }
    if (pc !== v.charCodeAt(vi)) return false
    pi++
    vi++
  }
  return vi === v.length
}

/** Mirrors the guards + case folding of wildcardMatch, then runs the reference. */
function referenceFull(pattern: string, value: string): boolean {
  if (pattern.length === 0) return false
  if (pattern === '*') return true
  if (value.length === 0) return false
  const win = process.platform === 'win32'
  const p = win ? pattern.toLowerCase() : pattern
  const v = win ? value.toLowerCase() : value
  return referenceMatch(p, 0, v, 0)
}

describe('wildcardMatch / differential fuzz vs old recursive implementation', () => {
  const valueAlphabet = ['a', 'b']
  const patternAlphabet = ['a', 'b', '*', '?']

  function strings(
    alphabet: string[],
    minLen: number,
    maxLen: number
  ): string[] {
    const out: string[] = []
    const walk = (prefix: string) => {
      if (prefix.length >= minLen) out.push(prefix)
      if (prefix.length === maxLen) return
      for (const c of alphabet) walk(prefix + c)
    }
    walk('')
    return out
  }

  const patterns = strings(patternAlphabet, 1, 4)
  const extraPatterns = [
    'a*a*a',
    '*a*b*',
    '?*?*',
    '**a**',
    'a**b',
    '*',
    '*a*',
    '?????',
    'a*b*c',
    '*b',
  ]
  const values = strings(valueAlphabet, 0, 5)

  it('agrees with the reference on every (pattern, value) pair', () => {
    let pairs = 0
    for (const pattern of [...patterns, ...extraPatterns]) {
      for (const value of values) {
        // Both sides receive identical inputs; wildcardMatch applies the same
        // win32 lowercasing internally, which is a no-op on this alphabet.
        expect(wildcardMatch(pattern, value)).toBe(
          referenceFull(pattern, value)
        )
        pairs++
      }
    }
    // 340 generated patterns + 10 extra x 63 values (lengths 0..5 over {a,b})
    expect(pairs).toBe(350 * 63)
  })

  it('agrees with the reference on win32 case folding too', () => {
    const before = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32' })
    try {
      const mixed = ['A', 'B', 'a', 'b', '*', '?']
      const winPatterns = ['A*', '*b', '?A?', 'a*B*c', '**A', 'A?**b']
      const winValues = strings(mixed, 0, 4).filter((s) => s.length <= 4)
      for (const pattern of winPatterns) {
        for (const value of winValues) {
          expect(wildcardMatch(pattern, value)).toBe(
            referenceFull(pattern, value)
          )
        }
      }
    } finally {
      Object.defineProperty(process, 'platform', { value: before })
    }
  })
})

describe('sessionPatternMatches', () => {
  it('matches via standard wildcardMatch', () => {
    expect(sessionPatternMatches('*', 'anything')).toBe(true)
    expect(sessionPatternMatches('echo *', 'echo hello')).toBe(true)
    expect(sessionPatternMatches('git commit *', 'git commit -m msg')).toBe(
      true
    )
  })

  it('matches base command when pattern ends with " *"', () => {
    expect(sessionPatternMatches('aws *', 'aws')).toBe(true)
    expect(sessionPatternMatches('aws *', 'aws s3')).toBe(true)
    expect(sessionPatternMatches('aws *', 'aws s3 ls')).toBe(true)
    expect(sessionPatternMatches('echo *', 'echo')).toBe(true)
    expect(sessionPatternMatches('git commit *', 'git commit')).toBe(true)
  })

  it('does NOT match partial word prefixes like awsx or aws-cli', () => {
    expect(sessionPatternMatches('aws *', 'awsx')).toBe(false)
    expect(sessionPatternMatches('aws *', 'aws-cli')).toBe(false)
    expect(sessionPatternMatches('echo *', 'echox')).toBe(false)
  })

  it('does not collapse whitespace', () => {
    // Exact space boundary is required; no arbitrary stripping
    expect(sessionPatternMatches('aws s3 *', 'awss3')).toBe(false)
  })

  it('returns false for non-string inputs', () => {
    expect(sessionPatternMatches('aws *', undefined as unknown as string)).toBe(
      false
    )
    expect(sessionPatternMatches(undefined as unknown as string, 'aws')).toBe(
      false
    )
  })

  it('handles platform case sensitivity for exact prefix match', () => {
    const before = process.platform
    Object.defineProperty(process, 'platform', { value: 'linux' })
    try {
      expect(sessionPatternMatches('AWS *', 'aws')).toBe(false)
      expect(sessionPatternMatches('aws *', 'aws')).toBe(true)
    } finally {
      Object.defineProperty(process, 'platform', { value: before })
    }

    Object.defineProperty(process, 'platform', { value: 'win32' })
    try {
      expect(sessionPatternMatches('AWS *', 'aws')).toBe(true)
      expect(sessionPatternMatches('aws *', 'AWS')).toBe(true)
    } finally {
      Object.defineProperty(process, 'platform', { value: before })
    }
  })
})
