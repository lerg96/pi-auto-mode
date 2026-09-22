import * as busEvents from '../src/events.ts'

// The Pi event bus is ONE EventEmitter shared by every loaded extension.
// The only contract these constants have is: every exported bus channel
// must live under the `pi-auto-mode:` namespace and must be unique. These
// tests guard that contract for future contributors adding channels —
// a bare "constant equals literal" assertion would be tautological and is
// intentionally NOT written.

const NAMESPACE = 'pi-auto-mode:'

const channelEntries = Object.entries(busEvents).filter(
  (entry): entry is [string, string] => typeof entry[1] === 'string'
)

describe('bus channel namespace (shared-EventEmitter collision guard)', () => {
  it('exports at least the decision and ui_prompt channels', () => {
    expect(channelEntries.length).toBeGreaterThanOrEqual(2)
    const names = channelEntries.map(([name]) => name)
    expect(names).toContain('BUS_CHANNEL_DECISION')
    expect(names).toContain('BUS_CHANNEL_UI_PROMPT')
  })

  it('every exported channel is namespaced with pi-auto-mode: and a non-empty suffix', () => {
    expect(channelEntries.length).toBeGreaterThan(0)
    const unnamespaced = channelEntries
      .filter(([, value]) => !value.startsWith(NAMESPACE))
      .map(([name, value]) => `${name} = "${value}"`)
    expect(unnamespaced).toEqual([])
    // The bare prefix alone would collide with any other extension that
    // also namespaces but sends nothing after the colon.
    const tooShort = channelEntries.filter(
      ([, value]) => value.length <= NAMESPACE.length
    )
    expect(tooShort).toEqual([])
  })

  it('no two exported channels share the same value', () => {
    const values = channelEntries.map(([, value]) => value)
    expect(new Set(values).size).toBe(values.length)
  })
})
