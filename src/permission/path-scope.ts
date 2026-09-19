/**
 * Directory-scope helpers shared by the external-directory permission layer
 * and the process-wide external-directory allowlist.
 */
import { parse, normalize, dirname } from 'node:path'
import { statSync } from 'node:fs'
import { homedir } from 'node:os'

/** True when `dir` is a filesystem root (`/`, `C:\`, `C:/`). */
export function isPathRoot(dir: string): boolean {
  const n = normalize(dir)
  return n === parse(n).root || dirname(n) === n
}

/**
 * Resolve which directory an "allow this directory" approval should grant.
 *
 * - path exists and is a directory -> the path itself
 * - path exists and is not a directory -> its parent
 * - path does not exist (ENOENT/ENOTDIR) -> its parent (the usual
 *   "create a file in that directory" case)
 * - any other stat failure (EACCES, EPERM, EBUSY, ...) -> the path itself:
 *   never expand *upwards* on an unknown, because the parent would silently
 *   grant unrelated siblings.
 *
 * Returns undefined for a filesystem root: "allow this directory" resolving
 * to `/` or `C:\` is a footgun, so the caller must not persist it.
 * Never throws.
 */
export function grantDirFor(absPath: string): string | undefined {
  const keep = (dir: string): string | undefined =>
    isPathRoot(dir) ? undefined : dir
  try {
    if (statSync(absPath).isDirectory()) return keep(absPath)
    return keep(dirname(absPath))
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return keep(dirname(absPath))
    return keep(absPath)
  }
}

/**
 * Expands `~` / `$HOME` / `${HOME}` prefixes. Used for candidate paths
 * AND external_directory glob keys, so user-written `~/projects/**`
 * matches resolved absolute paths.
 */
export function expandHomePrefix(p: string): string {
  const trimmed = p.trim()
  if (
    trimmed === '~' ||
    trimmed.startsWith('~/') ||
    trimmed.startsWith('~\\')
  ) {
    return homedir() + trimmed.slice(1)
  }
  if (
    trimmed === '$HOME' ||
    trimmed.startsWith('$HOME/') ||
    trimmed.startsWith('$HOME\\')
  ) {
    return homedir() + trimmed.slice(5)
  }
  if (trimmed.startsWith('${HOME}')) {
    return homedir() + trimmed.slice(7)
  }
  return trimmed
}

/**
 * Rewrites MSYS2/Git-Bash drive paths (`/c/Users/...` → `C:/Users/...`).
 * Win32-only: on POSIX `/c/...` is a legitimate absolute path and must
 * NOT be rewritten. A lone `/<letter>` (no trailing slash) means the
 * drive root. Anything else (`/cmd/...`) passes through untouched.
 */
export function expandMsysDrive(p: string): string {
  if (process.platform !== 'win32') return p
  const trimmed = p.trim()
  const m = /^\/([a-zA-Z])(?:\/(.*))?$/.exec(trimmed)
  if (!m) return p
  const drive = (m[1] as string).toUpperCase()
  const rest = m[2] ?? ''
  return `${drive}:/${rest}`
}
