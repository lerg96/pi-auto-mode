/**
 * Allowlist global de directorios externos.
 *
 * Al pulsar "Allow directory (all tools)" se añade el path a este store.
 * La capa `external_directory` lo consulta antes de aplicar su veredicto.
 *
 * Es en memoria y no se serializa: solo vive durante la sesión de pi.
 * Sin embargo, sobrevive a la re-evaluación de módulos (jiti moduleCache: false)
 * porque usa un registro `Symbol.for` en `globalThis`, siguiendo el mismo patrón
 * que `ui-registry.ts`.
 */
import { isAbsolute, normalize, resolve } from 'node:path'
import { wildcardMatch } from '../permission/wildcard-matcher.ts'
import { expandHomePrefix, expandMsysDrive } from '../permission/path-scope.ts'

/** Normalize a path string: expand home/drive prefixes and normalize separators. */
function normalizeAllowPath(p: string): string {
  const expanded = expandHomePrefix(expandMsysDrive(p))
  // Use `isAbsolute` (Node.js semantics) so Windows only treats
  // `C:\...` as absolute, not `/c/...` or `/mnt/...` (MSYS drives must
  // be rewritten via expandMsysDrive first).
  if (isAbsolute(expanded)) return normalize(expanded)
  // If it looks relative (no drive letter on win32, no leading / on posix),
  // resolve against cwd to get an absolute normalized form.
  return normalize(resolve(process.cwd(), expanded))
}

// ——————————————————— Registry (survives jiti re-evaluation) ———————

const REGISTRY_KEY = Symbol.for('pi-auto-mode:external-dir-allowlist')

interface AllowlistRegistry {
  /** Set of normalized absolute directory strings */
  allowlist: Set<string>
}

function registry(): AllowlistRegistry {
  // SAFETY: the key is `Symbol.for(...)`, i.e. a process-unique symbol, and
  // `registry()` is the only writer — the value stored under it is always an
  // `AllowlistRegistry` created below (or undefined before first use).
  const slot = globalThis as unknown as Record<
    symbol,
    AllowlistRegistry | undefined
  >
  let reg = slot[REGISTRY_KEY]
  if (!reg) {
    reg = { allowlist: new Set<string>() }
    slot[REGISTRY_KEY] = reg
  }
  return reg
}

/** Test seam: forget the registry so tests start clean. */
export function resetExternalDirAllowlist(): void {
  // SAFETY: same symbol-keyed slot as `registry()`; only `registry()` ever
  // wrote it, so deleting it cannot remove anything else from globalThis.
  const slot = globalThis as unknown as Record<
    symbol,
    AllowlistRegistry | undefined
  >
  delete slot[REGISTRY_KEY]
}

/** Añadir un directorio al allowlist global (todas las tools). */
export function addExternalDirAllow(dir: string): void {
  const normalized = normalizeAllowPath(dir)
  registry().allowlist.add(normalized)
}

/**
 * Verificar si un path está permitido por el allowlist global.
 * Compara con `${dir}/**` para cada entrada usando wildcardMatch.
 * También permite que la ruta coincida exactamente con el directorio mismo.
 */
export function isExternalDirAllowed(path: string): boolean {
  const normalizedPath = normalizeAllowPath(path)
  const { allowlist } = registry()
  for (const dir of allowlist) {
    // Match the directory itself or anything underneath (${dir}/**).
    // Use `path.normalize` on the pattern so that `/` in `/**` becomes
    // `\` on Windows, matching the backslashes stored in `dir` after
    // `normalizeAllowPath` ran `path.normalize` on the original input.
    const globPattern = normalize(`${dir}/**`)
    if (wildcardMatch(dir, normalizedPath)) return true
    if (wildcardMatch(globPattern, normalizedPath)) return true
  }
  return false
}
