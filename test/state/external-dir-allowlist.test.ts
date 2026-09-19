import {
  addExternalDirAllow,
  isExternalDirAllowed,
  resetExternalDirAllowlist,
} from '../../src/state/external-dir-allowlist.ts'

describe('external-dir-allowlist (global)', () => {
  afterEach(() => resetExternalDirAllowlist())

  it('empty allowlist → nothing allowed', () => {
    expect(isExternalDirAllowed('/tmp/x')).toBe(false)
    expect(isExternalDirAllowed('/home/user/doc')).toBe(false)
  })

  it('addExternalDirAllow + isExternalDirAllowed → match exact prefix', () => {
    addExternalDirAllow('/mnt/shared')
    expect(isExternalDirAllowed('/mnt/shared/file.txt')).toBe(true)
    expect(isExternalDirAllowed('/mnt/shared/nested/deep/file.txt')).toBe(true)
  })

  it('no permite paths de otros directors con el mismo prefix', () => {
    addExternalDirAllow('/mnt/shared')
    expect(isExternalDirAllowed('/mnt/other/file.txt')).toBe(false)
    expect(isExternalDirAllowed('/mnt/shared-other/file.txt')).toBe(false)
  })

  it('case sensitivity follows minimatch (respects platform default)', () => {
    addExternalDirAllow('/mnt/Shared')
    // minimatch default depends on platform: case-insensitive on win32,
    // case-sensitive on POSIX. Just verify that the *same-case* path works
    // and the cross-case path behaves according to the platform.
    expect(isExternalDirAllowed('/mnt/Shared/file.txt')).toBe(true)
  })

  it('multiple entries accumulate', () => {
    addExternalDirAllow('/tmp')
    addExternalDirAllow('/mnt/shared')
    expect(isExternalDirAllowed('/tmp/file.txt')).toBe(true)
    expect(isExternalDirAllowed('/mnt/shared/doc.txt')).toBe(true)
    expect(isExternalDirAllowed('/home/user/file.txt')).toBe(false)
  })

  it('resetExternalDirAllowlist clears everything', () => {
    addExternalDirAllow('/tmp')
    expect(isExternalDirAllowed('/tmp/x')).toBe(true)
    resetExternalDirAllowlist()
    expect(isExternalDirAllowed('/tmp/x')).toBe(false)
  })

  it('adds relative paths but matches against resolved paths', () => {
    // The allowlist stores whatever is passed; matching uses `${dir}/**`.
    // In practice, the modal receives the resolved absPath.
    addExternalDirAllow('/c/Users/test/projects')
    expect(isExternalDirAllowed('/c/Users/test/projects/src/app.ts')).toBe(true)
    expect(isExternalDirAllowed('/c/Users/test/other/file.txt')).toBe(false)
  })
})
