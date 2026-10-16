import { DEFAULT_CONFIG, type Config } from '../types/config.ts'

/** Deep-clone helper to freeze config snapshots and prevent TOCTOU mutation. */
function deepCloneConfig(c: Config): Config {
  return structuredClone(c)
}

interface ConfigStore {
  current: Config
  yoloSession: boolean
}

const CONFIG_STATE_KEY = Symbol.for('pi-auto-mode:config-state')

function getStore(): ConfigStore {
  const slot = globalThis as unknown as Record<symbol, ConfigStore | undefined>
  let store = slot[CONFIG_STATE_KEY]
  if (!store) {
    store = {
      current: deepCloneConfig(DEFAULT_CONFIG as Config),
      yoloSession: false,
    }
    slot[CONFIG_STATE_KEY] = store
  } else {
    if (store.yoloSession === undefined) {
      store.yoloSession = false
    }
    if (!store.current) {
      store.current = deepCloneConfig(DEFAULT_CONFIG as Config)
    }
  }
  return store
}

export const configState = {
  get(): Config {
    // C4: deep clone to prevent TOCTOU via external mutation
    return deepCloneConfig(getStore().current)
  },
  set(c: Config): void {
    // C4: deep clone to prevent external mutation of internal state
    getStore().current = deepCloneConfig(c)
  },
  getActiveSets(): string[] {
    return [...getStore().current.activePermissionSets]
  },
  setActiveSets(names: string[]): void {
    const store = getStore()
    store.current = { ...store.current, activePermissionSets: names }
  },
  getMode(): Config['mode'] {
    return getStore().current.mode
  },
  setMode(mode: Config['mode']): void {
    const store = getStore()
    store.current = { ...store.current, mode }
  },
  isYoloSession(): boolean {
    return getStore().yoloSession
  },
  setYoloSession(enabled: boolean): void {
    getStore().yoloSession = Boolean(enabled)
  },
}
