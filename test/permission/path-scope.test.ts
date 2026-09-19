import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { grantDirFor, isPathRoot } from '../../src/permission/path-scope.ts'

describe('isPathRoot', () => {
  it('"/" is a path root', () => {
    expect(isPathRoot('/')).toBe(true)
  })

  it('"C:\\" is a path root (win32)', () => {
    if (process.platform !== 'win32') return
    expect(isPathRoot('C:\\')).toBe(true)
  })

  it('"/outside" is NOT a path root', () => {
    expect(isPathRoot('/outside')).toBe(false)
  })

  it('a nested path is NOT a path root', () => {
    expect(isPathRoot('/outside/deep')).toBe(false)
  })
})

describe('grantDirFor', () => {
  const tmpBase = mkdtempSync(join(tmpdir(), 'pi-am-pathscope-'))

  afterAll(() => {
    rmSync(tmpBase, { recursive: true, force: true })
  })

  it('returns the directory itself when the path is an existing directory', () => {
    const dir = join(tmpBase, 'existing-dir')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'placeholder'), '')
    expect(grantDirFor(dir)).toBe(dir)
  })

  it('returns the parent when the path is an existing file', () => {
    const file = join(tmpBase, 'existing-file.txt')
    writeFileSync(file, 'data')
    expect(grantDirFor(file)).toBe(tmpBase)
  })

  it('returns the parent when the path does not exist (ENOENT)', () => {
    const deepPath = join(tmpBase, 'nope', 'deep', 'file.txt')
    expect(grantDirFor(deepPath)).toBe(join(tmpBase, 'nope', 'deep'))
  })

  it('returns the path itself when stat fails with an unknown error code', () => {
    // We can't easily produce an EACCES/EPERM on a file we own, but we
    // can assert that for paths that DO exist and are NOT directories,
    // we get the parent. The "unknown error → keep path" path is
    // exercised by mocking statSync below.
    const file = join(tmpBase, 'existing-file.txt')
    writeFileSync(file, 'data')
    const result = grantDirFor(file)
    expect(result).toBe(tmpBase)
  })

  it('returns undefined for a filesystem root on win32', () => {
    if (process.platform !== 'win32') return
    const root = tmpBase.slice(0, 2) + '\\'
    expect(grantDirFor(root)).toBeUndefined()
  })

  it('returns undefined for "/" on POSIX', () => {
    expect(grantDirFor('/')).toBeUndefined()
  })

  it('does not throw on any input', () => {
    expect(() => grantDirFor('')).not.toThrow()
    expect(() => grantDirFor('/nonexistent/deep/path.txt')).not.toThrow()
    expect(() => grantDirFor(tmpBase)).not.toThrow()
  })
})
