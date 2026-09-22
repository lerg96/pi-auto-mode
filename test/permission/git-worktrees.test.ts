import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import {
  discoverWorktreeRoots,
  findRepoContext,
  isInsideTrustedWorktree,
} from '../../src/permission/git-worktrees.ts'

// Layout fixtures mimic what Git for Windows writes (verified on-disk):
//   <main>/.git/HEAD, <main>/.git/worktrees/<id>/{gitdir,commondir}
//   <wt>/.git  ->  file "gitdir: <main>/.git/worktrees/<id>"
// Built by hand so the suite never shells out to git (nor signs anything).

let tmp: string

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'pi-am-wt-'))
})

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true })
})

function makeRepo(name: string): string {
  const root = join(tmp, name, '.git')
  mkdirSync(join(root, 'worktrees'), { recursive: true })
  writeFileSync(join(root, 'HEAD'), 'ref: refs/heads/main\n')
  writeFileSync(join(root, 'config'), '[core]\n\tbare = false\n')
  return dirname(root)
}

/** Register a linked worktree. `back` controls the `<wt>/.git` back-pointer. */
function addWorktree(
  root: string,
  id: string,
  wtPath: string,
  opts: {
    /** Content of `<wt>/.git`: 'valid' (default), 'missing', 'bogus', 'dir'. */
    back?: 'valid' | 'missing' | 'bogus' | 'dir'
    /** Content of `<id>/gitdir`: the worktree `.git` path (default). */
    gitdirFile?: string
    /** Skip writing `<id>/commondir` (exercises the fallback resolution). */
    noCommondir?: boolean
  } = {}
): void {
  const idDir = join(root, '.git', 'worktrees', id)
  mkdirSync(idDir, { recursive: true })
  writeFileSync(
    join(idDir, 'gitdir'),
    (opts.gitdirFile ?? `${wtPath}${sep}.git`) + '\n'
  )
  if (opts.noCommondir !== true) {
    writeFileSync(join(idDir, 'commondir'), join(root, '.git') + '\n')
  }
  mkdirSync(wtPath, { recursive: true })
  const back = opts.back ?? 'valid'
  if (back === 'valid') {
    writeFileSync(join(wtPath, '.git'), `gitdir: ${idDir}\n`)
  } else if (back === 'bogus') {
    writeFileSync(join(wtPath, '.git'), 'gitdir: /nowhere/at/all\n')
  } else if (back === 'dir') {
    mkdirSync(join(wtPath, '.git'), { recursive: true })
    writeFileSync(join(wtPath, '.git', 'HEAD'), 'ref: refs/heads/other\n')
  }
}

describe('git worktree discovery', () => {
  it('directory with no repository → no roots, no common dir', () => {
    const bare = join(tmp, 'not-a-repo')
    mkdirSync(join(bare, 'nested', 'deep'), { recursive: true })
    expect(discoverWorktreeRoots(join(bare, 'nested', 'deep'))).toEqual([])
    expect(findRepoContext(bare)?.commonDir).toBeUndefined()
  })

  it('main checkout + registered worktrees are all returned', () => {
    const root = makeRepo('multi')
    const wtA = join(tmp, 'multi-wt-a')
    const wtB = join(tmp, 'elsewhere', 'wt-b')
    addWorktree(root, 'wt-a', wtA)
    addWorktree(root, 'wt-b', wtB)

    const roots = discoverWorktreeRoots(root)
    expect(roots).toHaveLength(3)
    expect(roots).toContain(root)
    expect(roots).toContain(wtA)
    expect(roots).toContain(wtB)
  })

  it('discovery from inside a linked worktree finds the same set', () => {
    const root = makeRepo('fromlink')
    const wt = join(tmp, 'fromlink-wt')
    addWorktree(root, 'wt', wt)

    // Same set, order may differ (the caller's own checkout comes first).
    expect(discoverWorktreeRoots(wt).sort()).toEqual(
      discoverWorktreeRoots(root).sort()
    )
    expect(findRepoContext(wt)?.commonDir).toBe(
      findRepoContext(root)?.commonDir
    )
  })

  it('discovery from a subdirectory of the repo works', () => {
    const root = makeRepo('subdir')
    const wt = join(tmp, 'subdir-wt')
    addWorktree(root, 'wt', wt)
    const deep = join(root, 'packages', 'app', 'src')
    mkdirSync(deep, { recursive: true })

    expect(discoverWorktreeRoots(deep).sort()).toEqual(
      discoverWorktreeRoots(root).sort()
    )
  })

  it('a plain repo without worktrees still trusts its own root', () => {
    const root = makeRepo('lonely')
    expect(discoverWorktreeRoots(root)).toEqual([root])
  })

  it('stale registration (worktree dir deleted) is dropped', () => {
    const root = makeRepo('stale')
    const dead = join(tmp, 'stale-dead')
    addWorktree(root, 'dead', dead)
    rmSync(dead, { recursive: true, force: true })

    const roots = discoverWorktreeRoots(root)
    expect(roots).toEqual([root])
  })

  it('planted gitdir pointer without a validating back-pointer is dropped', () => {
    const root = makeRepo('poison')
    const victim = join(tmp, 'poison-victim')
    mkdirSync(victim, { recursive: true })
    addWorktree(root, 'evil', victim, { back: 'missing' })

    expect(discoverWorktreeRoots(root)).toEqual([root])
  })

  it('back-pointer naming a different registration is dropped', () => {
    const root = makeRepo('mismatch')
    const wt = join(tmp, 'mismatch-wt')
    addWorktree(root, 'wt', wt, { back: 'bogus' })
    expect(discoverWorktreeRoots(root)).toEqual([root])
  })

  it('registered path whose .git is a directory (nested repo) is dropped', () => {
    const root = makeRepo('nested')
    const wt = join(tmp, 'nested-wt')
    addWorktree(root, 'wt', wt, { back: 'dir' })
    expect(discoverWorktreeRoots(root)).toEqual([root])
  })

  it('malformed registration files never throw and grant nothing', () => {
    const root = makeRepo('malformed')
    const idDir = join(root, '.git', 'worktrees', 'junk')
    mkdirSync(idDir, { recursive: true })
    writeFileSync(join(idDir, 'gitdir'), '')
    expect(discoverWorktreeRoots(root)).toEqual([root])

    writeFileSync(join(idDir, 'gitdir'), 'two\nlines\n')
    expect(discoverWorktreeRoots(root)).toEqual([root])
  })

  it('relative gitdir file content resolves against its registration dir', () => {
    const root = makeRepo('relative')
    const wt = join(root, 'inside-wt')
    const idDir = join(root, '.git', 'worktrees', 'inside')
    addWorktree(root, 'inside', wt)
    // Relative to <root>/.git/worktrees/inside → up 3 lands on <root>.
    writeFileSync(join(idDir, 'gitdir'), `../../../inside-wt${sep}.git\n`)

    const roots = discoverWorktreeRoots(root)
    expect(roots).toContain(resolve(wt))
  })

  it('empty worktrees dir (no subfolders) is fine', () => {
    const root = makeRepo('emptywt')
    expect(existsSync(join(root, '.git', 'worktrees'))).toBe(true)
    expect(discoverWorktreeRoots(root)).toEqual([root])
  })

  it('linked worktree without a commondir file falls back to the path shape', () => {
    const root = makeRepo('nocommon')
    const wt = join(tmp, 'nocommon-wt')
    addWorktree(root, 'wt', wt, { noCommondir: true })

    expect(findRepoContext(wt)?.commonDir).toBe(join(root, '.git'))
    expect(discoverWorktreeRoots(wt).sort()).toEqual(
      discoverWorktreeRoots(root).sort()
    )
  })

  it('`.git` directory without HEAD is not a repository', () => {
    const root = join(tmp, 'nohead', 'repo')
    mkdirSync(join(root, '.git'), { recursive: true })
    expect(discoverWorktreeRoots(root)).toEqual([])
    expect(findRepoContext(root)?.commonDir).toBeUndefined()
  })

  it('`.git` file without a gitdir: pointer is not a worktree', () => {
    const dir = join(tmp, 'junkpointer')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '.git'), 'not a pointer at all')
    expect(discoverWorktreeRoots(dir)).toEqual([])
    expect(findRepoContext(dir)?.commonDir).toBeUndefined()
  })
})

describe('isInsideTrustedWorktree', () => {
  const root = process.platform === 'win32' ? 'C:/repos/app' : '/repos/app'
  const wt = process.platform === 'win32' ? 'C:/work/app-wt' : '/work/app-wt'
  const roots = [root, wt]

  it('root itself and any descendant are inside', () => {
    expect(isInsideTrustedWorktree(wt, roots)).toBe(true)
    expect(isInsideTrustedWorktree(join(wt, 'src', 'a.ts'), roots)).toBe(true)
  })

  it('siblings sharing a prefix are not inside', () => {
    expect(isInsideTrustedWorktree(`${wt}-backup`, roots)).toBe(false)
    expect(isInsideTrustedWorktree(dirname(wt), roots)).toBe(false)
  })

  it('`.git` metadata of a trusted root is NOT trusted', () => {
    expect(isInsideTrustedWorktree(join(wt, '.git', 'config'), roots)).toBe(
      false
    )
    expect(isInsideTrustedWorktree(join(wt, '.git'), roots)).toBe(false)
    expect(
      isInsideTrustedWorktree(join(wt, '.git', 'hooks', 'pre-commit'), roots)
    ).toBe(false)
  })

  it('paths deeper than .git in a nested dir are still inside', () => {
    expect(isInsideTrustedWorktree(join(wt, 'sub', '.git', 'x'), roots)).toBe(
      true
    )
  })

  it('unrelated paths and other drives are not inside', () => {
    const home = process.platform === 'win32' ? 'C:/Users/x' : '/home/x'
    expect(isInsideTrustedWorktree(home, roots)).toBe(false)
    expect(
      isInsideTrustedWorktree(
        process.platform === 'win32' ? 'D:/other/x' : '/mnt/other/x',
        roots
      )
    ).toBe(false)
  })

  it('no roots → nothing is trusted', () => {
    expect(isInsideTrustedWorktree(wt, [])).toBe(false)
  })

  it('Windows comparison is case-insensitive', () => {
    if (process.platform !== 'win32') {
      expect(isInsideTrustedWorktree('/WORK/APP-WT/x', roots)).toBe(false)
      return
    }
    expect(isInsideTrustedWorktree('C:/WORK/APP-WT/x.ts', roots)).toBe(true)
    expect(isInsideTrustedWorktree('C:/Work/App-WT/.GIT/config', roots)).toBe(
      false
    )
  })

  it('separator style is normalized on both sides', () => {
    if (process.platform !== 'win32') return
    expect(isInsideTrustedWorktree('C:\\work\\app-wt\\src\\a.ts', roots)).toBe(
      true
    )
    expect(isInsideTrustedWorktree(join(wt, 'a'), [`${wt}${sep}`])).toBe(true)
  })
})

describe('path shape edge cases', () => {
  it('discovery on an empty string and on a file path never throws', () => {
    expect(discoverWorktreeRoots('')).toEqual(
      discoverWorktreeRoots(resolve(process.cwd()))
    )
    const aFile = join(tmp, 'a-file')
    writeFileSync(aFile, 'x')
    expect(() => discoverWorktreeRoots(aFile)).not.toThrow()
  })

  it('a path that traverses above every root is not trusted', () => {
    const wt = join(tmp, 'edge-wt')
    mkdirSync(wt, { recursive: true })
    expect(isInsideTrustedWorktree(join(tmp, '..', 'x'), [wt])).toBe(false)
  })

  it('the walk-up stops at the filesystem root', () => {
    const fsRoot = resolve(sep)
    expect(() => discoverWorktreeRoots(fsRoot)).not.toThrow()
    expect(
      discoverWorktreeRoots(join(fsRoot, 'definitely-not-a-repo-9f3'))
    ).toEqual([])
  })
})

describe('other repository shapes (bare, --separate-git-dir, submodule)', () => {
  // Shapes verified against real git on disk, because the registry location
  // and the `commondir` file differ per shape.
  function bareGitDir(name: string): string {
    const dir = join(tmp, name)
    mkdirSync(join(dir, 'worktrees'), { recursive: true })
    writeFileSync(join(dir, 'HEAD'), 'ref: refs/heads/main\n')
    return dir
  }

  function register(commonDir: string, id: string, wtPath: string): void {
    const idDir = join(commonDir, 'worktrees', id)
    mkdirSync(idDir, { recursive: true })
    writeFileSync(join(idDir, 'gitdir'), `${wtPath}${sep}.git\n`)
    // Real git writes the relative path from the registration dir.
    writeFileSync(join(idDir, 'commondir'), `..${sep}..${sep}\n`)
    mkdirSync(wtPath, { recursive: true })
    writeFileSync(join(wtPath, '.git'), `gitdir: ${idDir}\n`)
  }

  it('bare repo: only its linked worktrees are roots, never the bare dir', () => {
    const common = bareGitDir('bare.git')
    const wt = join(tmp, 'bare-wt')
    register(common, 'wt', wt)

    const roots = discoverWorktreeRoots(wt)
    expect(roots).toContain(wt)
    expect(roots).not.toContain(common)
    expect(findRepoContext(wt)?.commonDir).toBe(common)
  })

  it('--separate-git-dir checkout: pointer is the common dir, checkout is a root', () => {
    const common = bareGitDir('sep-git')
    const checkout = join(tmp, 'sep-checkout')
    mkdirSync(checkout, { recursive: true })
    // git writes an absolute pointer here, and no `commondir` file exists.
    writeFileSync(join(checkout, '.git'), `gitdir: ${common}\n`)
    const wt = join(tmp, 'sep-wt')
    register(common, 'sep-wt', wt)

    const roots = discoverWorktreeRoots(checkout)
    expect(roots).toContain(checkout)
    expect(roots).toContain(wt)
    expect(roots).not.toContain(common)
    // From the linked worktree the checkout root is NOT recoverable: git
    // records no back-link from a --separate-git-dir common dir (no
    // `commondir`, no `core.worktree`), so it stays external. Fail-closed.
    const fromWt = discoverWorktreeRoots(wt)
    expect(fromWt).toContain(wt)
    expect(fromWt).not.toContain(checkout)
    expect(fromWt).not.toContain(common)
  })

  it('submodule: its checkout is a root, the superproject is not implied', () => {
    const superDir = join(tmp, 'super')
    mkdirSync(join(superDir, '.git', 'modules', 'lib'), { recursive: true })
    writeFileSync(join(superDir, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    writeFileSync(
      join(superDir, '.git', 'modules', 'lib', 'HEAD'),
      'ref: refs/heads/main\n'
    )
    const sub = join(superDir, 'lib')
    mkdirSync(sub, { recursive: true })
    // Real git writes a RELATIVE pointer for submodules.
    writeFileSync(join(sub, '.git'), 'gitdir: ../.git/modules/lib\n')

    expect(discoverWorktreeRoots(join(sub, 'src'))).toEqual([sub])
  })

  it('main checkout of a normal repo is still found from a subdir', () => {
    const root = makeRepo('shapes-normal')
    const deep = join(root, 'a', 'b', 'c')
    mkdirSync(deep, { recursive: true })
    expect(discoverWorktreeRoots(deep)).toEqual([root])
  })
})
