import { configState } from '../../src/state/config-state.ts'
import { DEFAULT_CONFIG, type Config } from '../../src/types/config.ts'

describe('configState', () => {
  beforeEach(() => {
    configState.set(DEFAULT_CONFIG)
  })

  it('get() returns a config equal to what was set', () => {
    const cfg: Config = { ...DEFAULT_CONFIG, activePermissionSets: ['alpha'] }
    configState.set(cfg)
    expect(configState.get()).toEqual(cfg)
  })

  it('set(c) replaces the stored config', () => {
    expect(configState.get()).toEqual(DEFAULT_CONFIG)
    const cfg: Config = { ...DEFAULT_CONFIG, activePermissionSets: ['x', 'y'] }
    configState.set(cfg)
    expect(configState.get()).toEqual(cfg)
    expect(configState.getActiveSets()).toEqual(['x', 'y'])
  })

  it('getActiveSets()/setActiveSets() read and write activePermissionSets', () => {
    expect(configState.getActiveSets()).toEqual([])
    configState.setActiveSets(['a', 'b'])
    expect(configState.getActiveSets()).toEqual(['a', 'b'])
    // subsequent reads are stable
    expect(configState.getActiveSets()).toEqual(['a', 'b'])
    configState.setActiveSets([])
    expect(configState.getActiveSets()).toEqual([])
  })

  it('set does not mutate the object passed to it', () => {
    const input: Config = { ...DEFAULT_CONFIG, activePermissionSets: ['a'] }
    configState.set(input)
    // the caller's object must be untouched by set()
    expect(input.activePermissionSets).toEqual(['a'])
    expect(input).toEqual({ ...DEFAULT_CONFIG, activePermissionSets: ['a'] })
  })

  it('M2: getActiveSets() returns a defensive copy (external push does not mutate state)', () => {
    configState.setActiveSets(['a', 'b'])
    const snap = configState.getActiveSets()
    // mutating the returned copy must not change internal state
    snap.push('c')
    expect(configState.getActiveSets()).toEqual(['a', 'b'])
  })

  it('get() returns a defensive copy of the stored config', () => {
    configState.set({ ...DEFAULT_CONFIG, activePermissionSets: ['a'] })
    const snapshot = configState.get()
    // mutating the returned copy must not change internal state
    snapshot.activePermissionSets = ['changed']
    expect(configState.getActiveSets()).toEqual(['a'])
  })
})
