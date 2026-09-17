// Git worktree discovery for the external_directory scope.
//
// A `git worktree` is a second checkout of the SAME repository. The flow
// "agent creates a worktree outside the working dir (`git worktree add
// ../wt -b f`), then works in it — often through a sub-agent whose cwd is
// still the original one" is legitimate work, not an escape, so worktrees of
// the current repository are treated as internal.
//
// Discovery is filesystem-only: no `git` subprocess (a spawn per tool call
// costs ~50ms on Windows and the gate must stay in-process).
//
// On-disk layout (verified against Git for Windows 2.x):
//   <main>/.git                              common dir of the repository
//   <main>/.git/worktrees/<id>/gitdir        text file: "<wt>/.git" (absolute)
//   <wt>/.git                                FILE: "gitdir: <main>/.git/worktrees/<id>"
//
// Trust model (bounded widening, never an open hole):
//   * Roots come ONLY from the repository found by walking up from the scope
//     base dir — never from a directory named inside the tool call.
//   * A registered worktree is trusted only when its back-pointer validates:
//     `<wt>/.git` must be a file whose `gitdir:` resolves exactly to
//     `<common>/worktrees/<id>`. Stale registrations (directory deleted) and
//     planted `gitdir` files pointing at e.g. `~/.ssh` fail this check.
//   * `<root>/.git/**` is never covered by worktree trust. The common dir is
//     shared by every worktree and holds hooks/config, so writing it from a
//     foreign worktree would be code execution. (Paths inside cwd are
//     unaffected: the scope never opines on them.)

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
  sep,
} from 'node:path'

/** Bound the walk-up so a deep cwd can never loop unbounded. */
const MAX_WALK_UP = 32

/** Bound the registered-worktree scan (a repo with >256 worktrees is pathological). */
const MAX_WORKTREES = 256

const GITDIR_POINTER = /^gitdir:\s*(.+)$/i

/** Case-folded, normalized key: Windows paths are case-insensitive. */
function pathKey(p: string): string {
  const n = normalize(p)
  return process.platform === 'win32' ? n.toLowerCase() : n
}

function samePath(a: string, b: string): boolean {
  return pathKey(a) === pathKey(b)
}

function readTextIfExists(path: string): string | undefined {
  try {
    const text = readFileSync(path, 'utf8')
    return text.length === 0 ? undefined : text
  } catch {
    return undefined
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * Read a `.git`/`gitdir` text pointer and return the target it names.
 * Git writes absolute paths, but relative ones are legal (`git worktree
 * repair --relative-paths`), so relatives resolve against `fromDir`.
 */
function pointerTarget(text: string, fromDir: string): string | undefined {
  const match = GITDIR_POINTER.exec(text.trim())
  const raw = match?.[1]?.trim()
  if (raw === undefined || raw.length === 0) return undefined
  const expanded = raw.startsWith('~') ? resolve(raw.replace(/^~/, '')) : raw
  return normalize(isAbsolute(expanded) ? expanded : resolve(fromDir, expanded))
}

/** Bare `gitdir` file content (no `gitdir:` prefix), resolved like above. */
function plainTarget(text: string, fromDir: string): string | undefined {
  const raw = text.trim()
  if (raw.length === 0 || raw.includes('\n')) return undefined
  return normalize(isAbsolute(raw) ? raw : resolve(fromDir, raw))
}

/** Where a checkout lives and which git dir owns its registry. */
export interface RepoContext {
  /** Dir owning `worktrees/` (git's `--git-common-dir`). */
  commonDir: string
  /**
   * The checkout directory whose `.git` (folder or file) made it a repo.
   * Always a working tree: plain checkout, linked worktree, submodule or
   * `--separate-git-dir` checkout. Absent when only a git dir was found.
   */
  checkoutRoot?: string
}

/**
 * Locate the repository that owns `startDir`: walk up to the first `.git`
 * (directory or file) and resolve the common dir behind it. Undefined when
 * there is no repository (or the `.git` found is not one).
 */
export function findRepoContext(startDir: string): RepoContext | undefined {
  try {
    let dir = resolve(startDir)
    for (let depth = 0; depth < MAX_WALK_UP; depth++) {
      const dotGit = join(dir, '.git')
      if (isDirectory(dotGit)) {
        // A real git dir needs HEAD; a stray `.git` folder is not a repo.
        if (!existsSync(join(dotGit, 'HEAD'))) return undefined
        return { commonDir: dotGit, checkoutRoot: dir }
      }
      if (isFile(dotGit)) {
        const text = readTextIfExists(dotGit)
        if (text === undefined) return undefined
        const target = pointerTarget(text, dir)
        if (target === undefined) return undefined
        const commonDir = commonDirOf(target)
        // The directory holding a `.git` FILE is by definition a checkout
        // root (linked worktree, submodule, --separate-git-dir checkout) —
        // it is not necessarily registered under `<common>/worktrees/`.
        return commonDir === undefined
          ? undefined
          : { commonDir, checkoutRoot: dir }
      }
      const parent = dirname(dir)
      if (parent === dir) return undefined
      dir = parent
    }
    return undefined
  } catch {
    return undefined
  }
}

/** Convenience wrapper over `findRepoContext`. */
export function findCommonGitDir(startDir: string): string | undefined {
  return findRepoContext(startDir)?.commonDir
}

/**
 * Common dir behind a `.git` file pointer. Shapes seen in the wild:
 *   * linked worktree  → `<common>/worktrees/<id>` + `commondir` (`../..`)
 *   * bare repo        → same, with `<common>` being e.g. `repo.git`
 *   * `--separate-git-dir` checkout → the pointer IS the common dir (no
 *     `commondir` file, no `worktrees/` parent)
 *   * submodule        → `<super>/.git/modules/<name>` (its own common dir)
 * Each candidate is only accepted when it looks like a git dir (`HEAD`).
 */
function commonDirOf(pointerTargetPath: string): string | undefined {
  const commondir = readTextIfExists(join(pointerTargetPath, 'commondir'))
  if (commondir !== undefined) {
    const raw = commondir.trim()
    const candidate = normalize(
      isAbsolute(raw) ? raw : resolve(pointerTargetPath, raw)
    )
    if (existsSync(join(candidate, 'HEAD'))) return candidate
  }
  const parent = dirname(pointerTargetPath)
  if (basename(parent) === 'worktrees') {
    const candidate = dirname(parent)
    if (existsSync(join(candidate, 'HEAD'))) return candidate
  }
  if (existsSync(join(pointerTargetPath, 'HEAD'))) return pointerTargetPath
  return undefined
}

/**
 * Every working tree of the repository that owns `startDir`: the checkout
 * `startDir` belongs to, the main checkout, and all linked worktrees
 * registered by git. Empty array when there is no repository, nothing is
 * registered, or anything fails — discovery is fail-safe: an empty list means
 * "no extra trust", i.e. the usual ask.
 *
 * A bare repository contributes only its linked worktrees: it has no working
 * tree of its own, and the common dir is not a checkout.
 */
export function discoverWorktreeRoots(startDir: string): string[] {
  try {
    const context = findRepoContext(startDir)
    if (context === undefined) return []
    const { commonDir, checkoutRoot } = context
    const roots: string[] = []
    const seen = new Set<string>()
    const push = (root: string): void => {
      const key = pathKey(root)
      if (seen.has(key)) return
      seen.add(key)
      roots.push(normalize(root))
    }

    // The checkout we came from (linked worktree, submodule, or a checkout
    // whose git dir lives elsewhere) — always a working tree.
    if (checkoutRoot !== undefined) push(checkoutRoot)

    // Main checkout: only when the common dir really is `<root>/.git`.
    if (basename(commonDir) === '.git') {
      const mainRoot = dirname(commonDir)
      if (existsSync(join(mainRoot, '.git'))) push(mainRoot)
    }

    const worktreesDir = join(commonDir, 'worktrees')
    let ids: string[] = []
    try {
      ids = readdirSync(worktreesDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
    } catch {
      ids = []
    }
    for (const id of ids.slice(0, MAX_WORKTREES)) {
      const idDir = join(worktreesDir, id)
      const gitdirFile = join(idDir, 'gitdir')
      const text = readTextIfExists(gitdirFile)
      if (text === undefined) continue
      const declared = plainTarget(text, idDir)
      if (declared === undefined) continue
      // `<id>/gitdir` names "<wt>/.git" — the root is its parent.
      const root = dirname(declared)
      if (root.length === 0 || root === declared) continue
      // Back-pointer validation: `<wt>/.git` must be a file pointing back at
      // exactly this registration. Kills stale entries and planted pointers.
      const backFile = join(root, '.git')
      if (!isFile(backFile)) continue
      const back = pointerTarget(readTextIfExists(backFile) ?? '', root)
      if (back === undefined || !samePath(back, idDir)) continue
      push(root)
    }
    return roots
  } catch {
    return []
  }
}

/**
 * True when `absPath` is `root` itself or lives under it — except when the
 * step in from `root` is `.git` (shared metadata: hooks, config, index).
 * Lexical, like the rest of the scope (no symlink resolution, no fs access).
 */
function isUnderRoot(absPath: string, root: string): boolean {
  const rel = relative(pathKey(root), pathKey(absPath))
  if (rel.length === 0) return true
  if (isAbsolute(rel)) return false
  if (rel === '..' || rel.startsWith(`..${sep}`)) return false
  const first = rel.indexOf(sep) === -1 ? rel : rel.slice(0, rel.indexOf(sep))
  if (first === '.git') return false
  return true
}

/** Convenience wrapper: does `absPath` fall under any trusted worktree root? */
export function isInsideTrustedWorktree(
  absPath: string,
  roots: string[]
): boolean {
  for (const root of roots) {
    try {
      if (isUnderRoot(absPath, root)) return true
    } catch {
      // A malformed path can never grant trust.
    }
  }
  return false
}
