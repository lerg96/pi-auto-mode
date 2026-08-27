// Tests for `src/classifier/file-extraction.ts` (Fase 3).
// Covers the happy path, every `kind` branch (ok/tooLarge/trustBoundary/
// suspicious/notFound/unsupported), the null-on-no-path contract, and the
// never-throw invariant. Tests inject a temp HOME by mocking `node:os` at
// module load time and mutating the mock between tests; the mock returns a
// per-test temp dir so trust-boundary paths resolve under our control
// (mirrors the approach in `test/config/config-loader.test.ts`).

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'

// Module-level mock: `node:os` is mocked ONCE at file load so the static
// `import { homedir } from 'node:os'` in `file-extraction.ts` resolves to our
// stub. The mutable `currentHomeDir` is rewritten by `setupHome()` per test.
let currentHomeDir = ''
jest.mock('node:os', () => {
  const actual = jest.requireActual<typeof import('node:os')>('node:os')
  return {
    ...actual,
    homedir: () => currentHomeDir,
  }
})

import {
  extractReferencedFile,
  formatFileExtraction,
  isSafeFile,
  isSuspiciousFileContent,
  SAFE_FILE_SIZE_BYTES,
  SAFE_FILE_EXTENSIONS,
  type FileExtractionResult,
} from '../../src/classifier/file-extraction.ts'

let homeDir: string
let prevHome: string | undefined
let prevUserProfile: string | undefined

function setupHome(): void {
  homeDir = mkdtempSync(join(tmpdir(), 'pi-am-fe-home-'))
  currentHomeDir = homeDir
  // Also update process.env so anything that bypasses the cache (e.g.
  // a sub-process) still resolves to our temp dir.
  prevHome = process.env.HOME
  prevUserProfile = process.env.USERPROFILE
  process.env.HOME = homeDir
  process.env.USERPROFILE = homeDir
}

function teardownHome(): void {
  if (prevHome === undefined) delete process.env.HOME
  else process.env.HOME = prevHome
  if (prevUserProfile === undefined) delete process.env.USERPROFILE
  else process.env.USERPROFILE = prevUserProfile
  rmSync(homeDir, { recursive: true, force: true })
}

beforeEach(() => setupHome())
afterEach(() => teardownHome())

describe('file-extraction: tokenization & candidate selection', () => {
  it('returns null for commands with no path-like argument (echo hello)', async () => {
    const res = await extractReferencedFile('echo hello')
    expect(res).toBeNull()
  })

  it('returns null when the only candidate has an unsafe extension', async () => {
    const res = await extractReferencedFile('cat thing.png')
    expect(res).toBeNull()
  })

  it('picks the first path-like argument after an interpreter', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pi-am-fe-'))
    const script = join(tmp, 'script.py')
    writeFileSync(script, 'print("ok")', 'utf8')
    try {
      const res = await extractReferencedFile(`python ${script}`)
      expect(res).not.toBeNull()
      expect(res?.kind).toBe('ok')
      if (res?.kind === 'ok') {
        expect(res.path).toBe(script)
        expect(res.content).toBe('print("ok")')
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('skips flag-like arguments and their value', async () => {
    // `-m` is a common flag that consumes its next token as a value
    // (npm -m "msg"). We must not treat that value as a file path.
    const tmp = mkdtempSync(join(tmpdir(), 'pi-am-fe-'))
    const script = join(tmp, 'real.py')
    writeFileSync(script, 'print(1)', 'utf8')
    try {
      const res = await extractReferencedFile(`python -m foo ${script}`)
      expect(res).not.toBeNull()
      expect(res?.kind).toBe('ok')
      if (res?.kind === 'ok') expect(res.path).toBe(script)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('skips redirect targets (`>`, `>>`, `<`) and does not read them', async () => {
    // The path-like token `out.txt` after `>` is the redirect target, not a
    // file to read. We return null to avoid surfacing a spurious
    // `[REDACTED]` marker to the LLM.
    const res = await extractReferencedFile('echo hello > out.txt')
    expect(res).toBeNull()
  })

  it('handles quoted paths with whitespace', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pi-am-fe-'))
    const dirWithSpace = join(tmp, 'with space')
    const fsMod = jest.requireActual<typeof import('node:fs')>('node:fs')
    fsMod.mkdirSync(dirWithSpace, { recursive: true })
    const script = join(dirWithSpace, 'script.py')
    writeFileSync(script, 'x=1', 'utf8')
    try {
      const res = await extractReferencedFile(`python "${script}"`)
      expect(res).not.toBeNull()
      expect(res?.kind).toBe('ok')
      if (res?.kind === 'ok') expect(res.path).toBe(script)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe('file-extraction: ok / size branches', () => {
  it('reads a small file and returns its utf8 content', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pi-am-fe-'))
    const file = join(tmp, 'small.js')
    writeFileSync(file, 'console.log("hi")', 'utf8')
    try {
      const res = await extractReferencedFile(`node ${file}`)
      expect(res?.kind).toBe('ok')
      if (res?.kind === 'ok') {
        expect(res.path).toBe(file)
        expect(res.size).toBe(Buffer.byteLength('console.log("hi")'))
        expect(res.content).toBe('console.log("hi")')
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('returns kind:tooLarge for files above SAFE_FILE_SIZE_BYTES', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pi-am-fe-'))
    const file = join(tmp, 'big.txt')
    // 8KB + 1 byte to cross the threshold deterministically.
    const big = 'a'.repeat(SAFE_FILE_SIZE_BYTES + 1)
    writeFileSync(file, big, 'utf8')
    try {
      const res = await extractReferencedFile(`cat ${file}`)
      expect(res).not.toBeNull()
      expect(res?.kind).toBe('tooLarge')
      if (res?.kind === 'tooLarge') {
        expect(res.path).toBe(file)
        expect(res.size).toBeGreaterThan(SAFE_FILE_SIZE_BYTES)
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('allows files exactly at the SAFE_FILE_SIZE_BYTES cap', async () => {
    // Cap is inclusive: a file of exactly 8KB must still be returned as ok
    // (size check is `>`, not `>=`). This guards off-by-one regressions.
    const tmp = mkdtempSync(join(tmpdir(), 'pi-am-fe-'))
    const file = join(tmp, 'exact.txt')
    const exact = 'a'.repeat(SAFE_FILE_SIZE_BYTES)
    writeFileSync(file, exact, 'utf8')
    try {
      const res = await extractReferencedFile(`cat ${file}`)
      expect(res?.kind).toBe('ok')
      if (res?.kind === 'ok') {
        expect(res.size).toBe(SAFE_FILE_SIZE_BYTES)
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe('file-extraction: trust boundary', () => {
  it('rejects ~/.ssh/id_rsa even when the file exists', async () => {
    const fsMod = jest.requireActual<typeof import('node:fs')>('node:fs')
    const sshDir = join(homeDir, '.ssh')
    fsMod.mkdirSync(sshDir, { recursive: true })
    // Use a `.txt` extension so the candidate selector accepts it (the
    // opencode-derived extractor only forwards files with a safe extension);
    // the trust-boundary check then refuses it. The point of the test is
    // that even a "looks benign" file under .ssh is blocked.
    const key = join(sshDir, 'id_rsa.txt')
    writeFileSync(key, 'PRIVATE KEY', 'utf8')
    const res = await extractReferencedFile(`cat ${key}`)
    expect(res?.kind).toBe('trustBoundary')
    if (res?.kind === 'trustBoundary') {
      // Path is normalized (resolved to absolute), so it always starts with
      // the (mocked) home dir.
      expect(res.path.startsWith(homeDir)).toBe(true)
      expect(res.path.endsWith(`${sep}.ssh${sep}id_rsa.txt`)).toBe(true)
    }
  })

  it('rejects ~/.env', async () => {
    // `~/.env` is the canonical dotfile path; the candidate selector accepts
    // any path-like token, so we feed the literal `~/.env` to the extractor.
    // The file does not need to exist — the trust boundary fires before stat.
    const res = await extractReferencedFile('cat ~/.env')
    expect(res?.kind).toBe('trustBoundary')
  })

  it('rejects /etc/passwd-style paths under the default boundary', async () => {
    // Default boundary protects `/etc/`. We can't easily create a real
    // /etc/passwd on a test runner, but `isSafeFile` is invoked BEFORE stat,
    // so the file's existence is irrelevant — the path is refused up front.
    const res = await extractReferencedFile('cat /etc/passwd')
    expect(res?.kind).toBe('trustBoundary')
    if (res?.kind === 'trustBoundary') {
      expect(res.path.replace(/\\/g, '/')).toContain('/etc/passwd')
    }
  })

  it('honors user-supplied protectedPaths', async () => {
    const fsMod = jest.requireActual<typeof import('node:fs')>('node:fs')
    const custom = join(homeDir, 'secrets')
    fsMod.mkdirSync(custom, { recursive: true })
    const token = join(custom, 'token.txt')
    writeFileSync(token, 'sk-123', 'utf8')
    const res = await extractReferencedFile(
      `cat ${token}`,
      // Mirror how `Config.classifier.ruleBased.trustBoundary` is shaped.
      {
        protectedPaths: [
          '/etc/',
          '~/.ssh/',
          '~/.env',
          // Trailing slash → directory prefix match
          `${custom}${sep}`,
        ],
      }
    )
    expect(res?.kind).toBe('trustBoundary')
  })

  it('isSafeFile accepts a benign path and rejects protected ones', () => {
    const fsMod = jest.requireActual<typeof import('node:fs')>('node:fs')
    const tmp = mkdtempSync(join(tmpdir(), 'pi-am-fe-'))
    const safeFile = join(tmp, 'safe.txt')
    writeFileSync(safeFile, 'x', 'utf8')
    try {
      expect(
        isSafeFile(safeFile, {
          protectedPaths: ['/etc/', '~/.ssh/', '~/.env'],
        })
      ).toBe(true)
      const ssh = join(homeDir, '.ssh')
      fsMod.mkdirSync(ssh, { recursive: true })
      const idRsa = join(ssh, 'id_rsa')
      writeFileSync(idRsa, 'k', 'utf8')
      expect(
        isSafeFile(idRsa, {
          protectedPaths: ['/etc/', '~/.ssh/', '~/.env'],
        })
      ).toBe(false)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('isSafeFile matches a bare protected path exactly (no trailing slash)', () => {
    // Bare paths (no trailing separator) match the file or any descendant.
    // `/etc` as a protected path must reject `/etc/passwd` (descendant).
    const fakeEtc = join(homeDir, 'etc')
    const fsMod = jest.requireActual<typeof import('node:fs')>('node:fs')
    fsMod.mkdirSync(fakeEtc, { recursive: true })
    const passwd = join(fakeEtc, 'passwd')
    writeFileSync(passwd, 'root:x:0', 'utf8')
    expect(isSafeFile(passwd, { protectedPaths: [`${fakeEtc}`] })).toBe(false)
  })
})

describe('file-extraction: suspicious content', () => {
  it('flags files containing eval( and child_process with their labels', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pi-am-fe-'))
    const file = join(tmp, 'evil.js')
    writeFileSync(
      file,
      'const cp = require("child_process");\neval("x");\n',
      'utf8'
    )
    try {
      const res = await extractReferencedFile(`node ${file}`)
      expect(res?.kind).toBe('suspicious')
      if (res?.kind === 'suspicious') {
        expect(res.matches).toEqual(
          expect.arrayContaining(['eval()', 'child_process'])
        )
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('does not flag a clean script', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pi-am-fe-'))
    const file = join(tmp, 'clean.js')
    writeFileSync(file, 'console.log("hello")\n', 'utf8')
    try {
      const res = await extractReferencedFile(`node ${file}`)
      expect(res?.kind).toBe('ok')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('isSuspiciousFileContent returns the matched labels', () => {
    expect(isSuspiciousFileContent('eval("hi")')).toContain('eval()')
    expect(isSuspiciousFileContent('subprocess.Popen(["ls"])')).toContain(
      'subprocess.*'
    )
    expect(isSuspiciousFileContent('Buffer.from("a")')).toContain(
      'Buffer.from()'
    )
    expect(isSuspiciousFileContent('safe code')).toEqual([])
  })

  it('isSuspiciousFileContent covers atob, exec, os.system and os.popen', () => {
    // One assertion per remaining pattern in the SUSPICIOUS_PATTERNS list so
    // a future edit that drops a pattern is caught immediately.
    expect(isSuspiciousFileContent('atob("eA==")')).toContain('atob()')
    expect(isSuspiciousFileContent('exec("ls")')).toContain('exec()')
    expect(isSuspiciousFileContent('os.system("rm -rf /")')).toContain(
      'os.system()'
    )
    expect(isSuspiciousFileContent('os.popen("ls")')).toContain('os.popen()')
  })

  it('isSuspiciousFileContent returns empty for non-string / empty input', () => {
    expect(isSuspiciousFileContent('')).toEqual([])
    expect(isSuspiciousFileContent(undefined as unknown as string)).toEqual([])
    expect(isSuspiciousFileContent(null as unknown as string)).toEqual([])
  })
})

describe('file-extraction: notFound / unsupported / no-throw', () => {
  it('returns kind:notFound for paths that do not exist', async () => {
    const res = await extractReferencedFile(
      `node ${join(homeDir, 'definitely-missing.js')}`
    )
    expect(res?.kind).toBe('notFound')
    if (res?.kind === 'notFound') {
      expect(res.path.endsWith('definitely-missing.js')).toBe(true)
    }
  })

  it('returns kind:unsupported (never throws) for a directory passed as a "file"', async () => {
    // The extractor only ever picks the first path-like argument, so we use
    // the same `.js` extension on a directory to force the read into stat()
    // success + isFile() === false. The result must be `unsupported`, never
    // a thrown error.
    const tmp = mkdtempSync(join(tmpdir(), 'pi-am-fe-'))
    const dirAsFile = join(tmp, 'fake.js')
    const fsMod = jest.requireActual<typeof import('node:fs')>('node:fs')
    fsMod.mkdirSync(dirAsFile, { recursive: true })
    try {
      const res = await extractReferencedFile(`node ${dirAsFile}`)
      expect(res).not.toBeNull()
      expect(res?.kind).toBe('unsupported')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('NEVER throws on garbage input — empty string, control chars, oversized', async () => {
    // Fail-closed invariant: an unexpected input shape must not crash the
    // classifier. We call with every weird value we can think of and assert
    // the call resolves (does not reject). Returns can be null or
    // `unsupported`; both are acceptable.
    const cases: unknown[] = [
      '',
      '   ',
      '/this/does/not/exist.js',
      // Very long command that could trip the token loop:
      'a'.repeat(20_000) + ' /tmp/x.js',
      // Binary-ish contents as the "command":
      '\u0000\u0001\u0002 x.js',
    ]
    for (const c of cases) {
      const res = await extractReferencedFile(c as string)
      // Either null (no candidate) or a tagged union — never a throw.
      if (res !== null) {
        expect(typeof res.kind).toBe('string')
      }
    }
  })

  it('returns null for empty/non-string command', async () => {
    expect(await extractReferencedFile('')).toBeNull()
    expect(
      await extractReferencedFile(undefined as unknown as string)
    ).toBeNull()
  })
})

describe('file-extraction: formatFileExtraction (pure formatter)', () => {
  it('renders each result kind with a stable marker', () => {
    const ok: FileExtractionResult = {
      kind: 'ok',
      path: '/x.js',
      content: 'a',
      size: 1,
    }
    expect(formatFileExtraction(ok)).toContain(
      'File referenced: /x.js (1 bytes)'
    )
    expect(formatFileExtraction(ok)).toContain('a')

    const tooLarge: FileExtractionResult = {
      kind: 'tooLarge',
      path: '/y.js',
      size: 100_000,
    }
    expect(formatFileExtraction(tooLarge)).toContain('content omitted')

    const tb: FileExtractionResult = { kind: 'trustBoundary', path: '/z' }
    expect(formatFileExtraction(tb)).toContain('[REDACTED: trust boundary]')

    const susp: FileExtractionResult = {
      kind: 'suspicious',
      path: '/w.js',
      matches: ['eval()', 'child_process'],
    }
    expect(formatFileExtraction(susp)).toContain('eval()')
    expect(formatFileExtraction(susp)).toContain('child_process')

    const nf: FileExtractionResult = { kind: 'notFound', path: '/q.js' }
    expect(formatFileExtraction(nf)).toContain('not found')

    const un: FileExtractionResult = {
      kind: 'unsupported',
      reason: 'EACCES',
    }
    expect(formatFileExtraction(un)).toContain('UNSUPPORTED')
    expect(formatFileExtraction(un)).toContain('EACCES')
  })
})

describe('file-extraction: SAFE_FILE_EXTENSIONS surface', () => {
  it('includes the common script + config extensions', () => {
    // Defensive: extensions used by tests above are in the safe set.
    for (const ext of ['js', 'ts', 'py', 'sh', 'json', 'yaml', 'txt', 'md']) {
      expect(SAFE_FILE_EXTENSIONS.has(ext)).toBe(true)
    }
  })
})

describe('file-extraction: regression — content cap safety', () => {
  // The extractor uses `info.size` to decide ok vs tooLarge, then slices the
  // content to SAFE_FILE_SIZE_BYTES defensively. These tests guard against a
  // future regression where someone reads first and trusts the actual length.
  it('ok-branch content is bounded by SAFE_FILE_SIZE_BYTES', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pi-am-fe-'))
    const file = join(tmp, 'small.txt')
    writeFileSync(file, 'a'.repeat(100), 'utf8')
    try {
      const res = await extractReferencedFile(`cat ${file}`)
      expect(res?.kind).toBe('ok')
      if (res?.kind === 'ok') {
        expect(res.content.length).toBeLessThanOrEqual(SAFE_FILE_SIZE_BYTES)
        expect(res.size).toBeLessThanOrEqual(SAFE_FILE_SIZE_BYTES)
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('tooLarge branch never reads file contents', async () => {
    // A file just over the cap must be reported as tooLarge with no content
    // field. The type system enforces it, but assert at runtime too.
    const tmp = mkdtempSync(join(tmpdir(), 'pi-am-fe-'))
    const file = join(tmp, 'big.txt')
    writeFileSync(file, 'a'.repeat(SAFE_FILE_SIZE_BYTES + 1), 'utf8')
    try {
      const res = await extractReferencedFile(`cat ${file}`)
      expect(res?.kind).toBe('tooLarge')
      if (res?.kind === 'tooLarge') {
        expect(res.size).toBeGreaterThan(SAFE_FILE_SIZE_BYTES)
        expect('content' in res).toBe(false)
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
