import { wildcardMatch } from '../../src/permission/wildcard-matcher.ts'

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
})
