// Tests for `src/classifier/home-path.ts`.
// The helper MUST derive the home directory dynamically from os.homedir()
// (never hardcoded), so — following the pattern in
// test/classifier/file-extraction.test.ts — `node:os` is mocked once at
// module load with a mutable target rewritten per test. The platform is
// switched per test by redefining process.platform: case folding and the
// separator spellings must follow real platform semantics (win32 folds,
// POSIX does not).

let currentHomeDir = ''
jest.mock('node:os', () => {
  const actual = jest.requireActual<typeof import('node:os')>('node:os')
  return {
    ...actual,
    homedir: () => currentHomeDir,
  }
})

import {
  homePathVariants,
  maskHomePrefix,
} from '../../src/classifier/home-path.ts'
import { isSecretSensitive } from '../../src/classifier/secret-guard.ts'

let platformRestore: (() => void) | null = null
function setPlatform(p: 'win32' | 'linux' | 'darwin'): void {
  const desc = Object.getOwnPropertyDescriptor(
    process,
    'platform'
  ) as PropertyDescriptor
  Object.defineProperty(process, 'platform', { value: p, configurable: true })
  platformRestore = () =>
    Object.defineProperty(process, 'platform', desc as PropertyDescriptor)
}

function withHome(home: string): void {
  currentHomeDir = home
}

afterEach(() => {
  if (platformRestore) {
    platformRestore()
    platformRestore = null
  }
})

describe('maskHomePrefix — POSIX', () => {
  beforeEach(() => {
    setPlatform('linux')
    withHome('/home/mockuser')
  })

  it('masks the home prefix keeping the rest of the path intact', () => {
    expect(maskHomePrefix('/home/mockuser/Downloads/x.md')).toBe(
      '/home/[REDACTED]/Downloads/x.md'
    )
  })

  it('masks a path that is the whole string (home itself)', () => {
    expect(maskHomePrefix('/home/mockuser')).toBe('/home/[REDACTED]')
  })

  it('handles paths inside quotes', () => {
    expect(maskHomePrefix('open "/home/mockuser/a b/c.md"')).toBe(
      'open "/home/[REDACTED]/a b/c.md"'
    )
  })

  it('handles multiple occurrences in one string', () => {
    expect(
      maskHomePrefix('diff /home/mockuser/a.txt /home/mockuser/b.txt')
    ).toBe('diff /home/[REDACTED]/a.txt /home/[REDACTED]/b.txt')
  })

  it('is case-SENSITIVE on POSIX (/home/MOCKUSER is another dir)', () => {
    expect(maskHomePrefix('/home/MOCKUSER/x')).toBe('/home/MOCKUSER/x')
  })

  it('does not mask a merely similar sibling directory', () => {
    // The username boundary must not be splittable: /home/mockuser2 is a
    // different directory than /home/mockuser.
    expect(maskHomePrefix('/home/mockuser2/x')).toBe('/home/mockuser2/x')
    expect(maskHomePrefix('/home/mockuser.log')).toBe('/home/mockuser.log')
  })

  it('masks the ~username form', () => {
    expect(maskHomePrefix('~mockuser/notes.txt')).toBe('~[REDACTED]/notes.txt')
  })

  it('does not over-match the ~username boundary', () => {
    expect(maskHomePrefix('~mockuseruser/x')).toBe('~mockuseruser/x')
    expect(maskHomePrefix('~other/notes.txt')).toBe('~other/notes.txt')
  })

  it('leaves non-identifying tokens untouched', () => {
    // None of these names the user; masking them would only hurt readability.
    for (const s of [
      '~/Downloads',
      '~',
      '$HOME/x',
      '${HOME}/x',
      '%USERPROFILE%\\x',
      '$env:USERPROFILE\\x',
    ]) {
      expect(maskHomePrefix(s)).toBe(s)
    }
  })

  it('is idempotent', () => {
    const once = maskHomePrefix(
      'cat /home/mockuser/a && open "/home/mockuser/b c" && ~mockuser/d'
    )
    expect(maskHomePrefix(once)).toBe(once)
  })
})

describe('maskHomePrefix — Windows (win32)', () => {
  beforeEach(() => {
    setPlatform('win32')
    withHome('C:\\Users\\WinUser')
  })

  it('masks the backslash spelling', () => {
    expect(maskHomePrefix('C:\\Users\\WinUser\\Downloads\\x.md')).toBe(
      'C:\\Users\\[REDACTED]\\Downloads\\x.md'
    )
  })

  it('masks the forward-slash spelling', () => {
    expect(maskHomePrefix('C:/Users/WinUser/Downloads/x.md')).toBe(
      'C:/Users/[REDACTED]/Downloads/x.md'
    )
  })

  it('masks the JSON-escaped spelling (literal double backslashes)', () => {
    expect(
      maskHomePrefix(String.raw`C:\\Users\\WinUser\\Downloads\\x.md`)
    ).toBe(String.raw`C:\\Users\\[REDACTED]\\Downloads\\x.md`)
  })

  it('is case-INsensitive on win32', () => {
    expect(maskHomePrefix('c:\\users\\winuser\\x')).toBe(
      'c:\\users\\[REDACTED]\\x'
    )
    expect(maskHomePrefix('C:/users/WINUSER/x')).toBe('C:/users/[REDACTED]/x')
  })

  it('masks a path that is the whole string', () => {
    expect(maskHomePrefix('C:\\Users\\WinUser')).toBe('C:\\Users\\[REDACTED]')
  })

  it('does not mask a sibling user directory (boundary)', () => {
    expect(maskHomePrefix('C:\\Users\\WinUser2\\x')).toBe(
      'C:\\Users\\WinUser2\\x'
    )
  })

  it('handles paths inside quotes and two occurrences', () => {
    expect(
      maskHomePrefix('"C:/Users/WinUser/a b/c.md" vs C:\\Users\\WinUser\\d.txt')
    ).toBe('"C:/Users/[REDACTED]/a b/c.md" vs C:\\Users\\[REDACTED]\\d.txt')
  })

  it('is idempotent across all spellings', () => {
    const once = maskHomePrefix(
      'C:\\Users\\WinUser\\a ' +
        String.raw`C:\\Users\\WinUser\\b ` +
        'c:/users/winuser/d ~winuser/e'
    )
    expect(maskHomePrefix(once)).toBe(once)
  })
})

describe('maskHomePrefix — degenerate homedir() values', () => {
  beforeEach(() => setPlatform('linux'))

  it('skips masking entirely for an empty home', () => {
    withHome('')
    expect(maskHomePrefix('/home/mockuser/x')).toBe('/home/mockuser/x')
  })

  it('skips masking for "/" (root) — otherwise every "/" would be eaten', () => {
    withHome('/')
    expect(maskHomePrefix('/etc/passwd /home/anyone')).toBe(
      '/etc/passwd /home/anyone'
    )
  })

  it('skips masking for a bare drive root', () => {
    setPlatform('win32')
    withHome('C:\\')
    expect(maskHomePrefix('C:\\Users\\x\\y')).toBe('C:\\Users\\x\\y')
    withHome('C:')
    expect(maskHomePrefix('C:\\Users\\x\\y')).toBe('C:\\Users\\x\\y')
  })

  it('skips masking for a 1-char username floor', () => {
    withHome('/a')
    expect(maskHomePrefix('/a/b/c')).toBe('/a/b/c')
  })
})

describe('homePathVariants', () => {
  it('returns the POSIX spelling plus ~username, longest first', () => {
    setPlatform('linux')
    withHome('/home/mockuser')
    const v = homePathVariants()
    expect(new Set(v)).toEqual(new Set(['/home/mockuser', '~mockuser']))
    for (let i = 1; i < v.length; i++) {
      expect(v[i - 1].length).toBeGreaterThanOrEqual(v[i].length)
    }
  })

  it('returns all Windows spellings (backslash, slash, JSON-escaped) plus ~username, longest first', () => {
    setPlatform('win32')
    withHome('C:\\Users\\WinUser')
    const v = homePathVariants()
    expect(new Set(v)).toEqual(
      new Set([
        'C:\\Users\\WinUser',
        'C:/Users/WinUser',
        String.raw`C:\\Users\\WinUser`,
        '~WinUser',
      ])
    )
    for (let i = 1; i < v.length; i++) {
      expect(v[i - 1].length).toBeGreaterThanOrEqual(v[i].length)
    }
  })

  it('returns [] for degenerate homes', () => {
    for (const h of ['', '/', 'C:\\', '/a']) {
      withHome(h)
      expect(homePathVariants()).toEqual([])
    }
  })
})

describe('non-escalation of secret classification', () => {
  it('a plain home path is NOT secret-sensitive before or after masking', () => {
    setPlatform('linux')
    withHome('/home/mockuser')
    // Home masking must stay orthogonal to isSecretSensitive: escalating
    // home paths there would blank whole commands in telemetry.
    expect(isSecretSensitive('/home/mockuser/Downloads/x.md').sensitive).toBe(
      false
    )
    const masked = maskHomePrefix('/home/mockuser/Downloads/x.md')
    expect(isSecretSensitive(masked).sensitive).toBe(false)
  })
})
