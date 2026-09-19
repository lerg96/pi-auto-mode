/**
 * Allowlist global de directorios externos.
 *
 * Al pulsar "Allow directory (all tools)" se añade el path a este store.
 * La capa `external_directory` lo consulta antes de aplicar su veredicto.
 *
 * Es en memoria y no se serializa: solo vive durante la sesión de pi.
 */
import { minimatch } from 'minimatch'

const allowlist = new Set<string>()

/** Añadir un directorio al allowlist global (todas las tools). */
export function addExternalDirAllow(dir: string): void {
  allowlist.add(dir)
}

/**
 * Verificar si un path está permitido por el allowlist global.
 * Compara con `${dir}/**` para cada entrada.
 */
export function isExternalDirAllowed(path: string): boolean {
  for (const dir of allowlist) {
    if (minimatch(path, `${dir}/**`)) return true
  }
  return false
}

/** Limpiar el allowlist (útil para tests). */
export function resetExternalDirAllowlist(): void {
  allowlist.clear()
}
