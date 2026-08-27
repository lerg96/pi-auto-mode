import { DEFAULT_CONFIG, type Config } from '../types/config.ts'

let current: Config = DEFAULT_CONFIG as Config

/** Deep-clone helper to freeze config snapshots and prevent TOCTOU mutation. */
function deepCloneConfig(c: Config): Config {
  return structuredClone(c)
}

export const configState = {
  get(): Config {
    // C4: deep clone to prevent TOCTOU via external mutation
    return deepCloneConfig(current)
  },
  set(c: Config): void {
    // C4: deep clone to prevent external mutation of internal state
    current = deepCloneConfig(c)
  },
  getActiveSets(): string[] {
    return [...current.activePermissionSets]
  },
  setActiveSets(names: string[]): void {
    current = { ...current, activePermissionSets: names }
  },
  getMode(): Config['mode'] {
    return current.mode
  },
  setMode(mode: Config['mode']): void {
    current = { ...current, mode }
  },
}
