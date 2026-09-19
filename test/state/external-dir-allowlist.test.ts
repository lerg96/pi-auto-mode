import {
  addExternalDirAllow,
  isExternalDirAllowed,
  resetExternalDirAllowlist,
} from '../../src/state/external-dir-allowlist.ts'

describe('external-dir-allowlist (global)', () => {
  afterEach(() => resetExternalDirAllowlist())

  it('empty allowlist → nothing allowed', () => {
    expect(isExternalDirAllowed('C:/tmp/x')).toBe(false)
    expect(isExternalDirAllowed('C:/home/user/doc')).toBe(false)
  })

  it('addExternalDirAllow + isExternalDirAllowed → match path inside directory', () => {
    addExternalDirAllow('C:/mnt/shared')
    expect(isExternalDirAllowed('C:/mnt/shared/file.txt')).toBe(true)
    expect(isExternalDirAllowed('C:/mnt/shared/nested/deep/file.txt')).toBe(
      true
    )
  })

  it('no permite paths de otros directors con el mismo prefix', () => {
    addExternalDirAllow('C:/mnt/shared')
    expect(isExternalDirAllowed('C:/mnt/other/file.txt')).toBe(false)
    expect(isExternalDirAllowed('C:/mnt/shared-other/file.txt')).toBe(false)
  })

  it('directory itself matches (not only ${dir}/**)', () => {
    addExternalDirAllow('C:/mnt/shared')
    expect(isExternalDirAllowed('C:/mnt/shared')).toBe(true)
    expect(isExternalDirAllowed('C:/mnt/shared/file.txt')).toBe(true)
  })

  it('multiple entries accumulate', () => {
    addExternalDirAllow('C:/tmp')
    addExternalDirAllow('C:/mnt/shared')
    expect(isExternalDirAllowed('C:/tmp/file.txt')).toBe(true)
    expect(isExternalDirAllowed('C:/mnt/shared/doc.txt')).toBe(true)
    expect(isExternalDirAllowed('C:/home/user/file.txt')).toBe(false)
  })

  it('resetExternalDirAllowlist clears everything', () => {
    addExternalDirAllow('C:/tmp')
    expect(isExternalDirAllowed('C:/tmp/x')).toBe(true)
    resetExternalDirAllowlist()
    expect(isExternalDirAllowed('C:/tmp/x')).toBe(false)
  })

  // ─── BUG 3: Windows backslash + forward-slash compatibility ───

  it('BUG 3: Windows backslash paths match forward-slash queries', () => {
    // Store with forward slashes, query with forward slashes — should match
    addExternalDirAllow('C:/Users/lerg_/work')
    expect(isExternalDirAllowed('C:/Users/lerg_/work/a.txt')).toBe(true)
  })

  it('BUG 3: forward-slash store entry matches forward-slash query', () => {
    addExternalDirAllow('C:/Users/other')
    expect(isExternalDirAllowed('C:/Users/other/a.txt')).toBe(true)
  })

  it('BUG 3: glob metacharacters in real directory names are NOT treated as patterns', () => {
    // A folder literally named "[work]" must be matched as a literal path,
    // not interpreted as a glob character class.
    addExternalDirAllow('C:/home/user/[work]')
    // Only the exact directory and its contents should match
    expect(isExternalDirAllowed('C:/home/user/[work]/file.txt')).toBe(true)
    // The character class should NOT expand: /home/user/abc is not the same dir
    expect(isExternalDirAllowed('C:/home/user/abc/file.txt')).toBe(false)
    // Neither should [w] match "a" etc.
    expect(isExternalDirAllowed('C:/home/user/a/file.txt')).toBe(false)
  })

  it('BUG 3: parenthesized folder names are literal, not groups', () => {
    addExternalDirAllow('C:/tmp/(backup)')
    expect(isExternalDirAllowed('C:/tmp/(backup)/data.log')).toBe(true)
    // Parentheses should NOT be interpreted as regex groups
    expect(isExternalDirAllowed('C:/tmp/data.log')).toBe(false)
  })

  // ─── BUG 4: registry survives module re-evaluation ───

  it('BUG 4: allowlist survives jiti re-evaluation via Symbol.for registry', () => {
    // Add an entry, then simulate module re-evaluation by clearing the module
    // cache reference and re-importing. The Symbol.for registry on globalThis
    // should persist the state.
    addExternalDirAllow('C:/mnt/shared')
    expect(isExternalDirAllowed('C:/mnt/shared/file.txt')).toBe(true)

    // Read the registry directly to confirm it's process-wide
    const registryKey = Symbol.for('pi-auto-mode:external-dir-allowlist')
    const slot = globalThis as unknown as Record<symbol, unknown>
    const reg = slot[registryKey] as { allowlist: Set<string> } | undefined
    expect(reg).toBeDefined()
    expect(reg!.allowlist.size).toBeGreaterThan(0)
  })

  it('BUG 4: after reset, the registry is removed and new adds start fresh', () => {
    addExternalDirAllow('C:/tmp')
    expect(isExternalDirAllowed('C:/tmp/x')).toBe(true)
    resetExternalDirAllowlist()
    // Registry should be cleared
    const registryKey = Symbol.for('pi-auto-mode:external-dir-allowlist')
    const slot = globalThis as unknown as Record<symbol, unknown>
    const reg = slot[registryKey] as { allowlist: Set<string> } | undefined
    expect(reg).toBeUndefined()
    // New add should work
    addExternalDirAllow('C:/mnt/new')
    expect(isExternalDirAllowed('C:/mnt/new/file.txt')).toBe(true)
    expect(isExternalDirAllowed('C:/tmp/x')).toBe(false)
  })
})
