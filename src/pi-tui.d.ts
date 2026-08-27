// Type stub for @earendil-works/pi-tui (injected by Pi at runtime).
// Mirrors the runtime shape needed by the extension for local type-checking.
// The shape matches the installed @earendil-works/pi-tui (SettingsList is a
// settings-editor: Enter on a row cycles through `values`, calling onChange;
// `currentValue` is REQUIRED and rendered on the right side of the row).

declare module '@earendil-works/pi-tui' {
  /**
   * Theme required by SettingsList. Distinct from Pi's global theme (which
   * exposes `.fg(color, text)` and is passed as `theme` into the
   * `ctx.ui.custom()` factory) — SettingsList expects these five render
   * functions plus a `cursor` glyph. Built from the global theme with the
   * recipe in `dist/modes/interactive/theme/theme.js` (`getSettingsListTheme`).
   */
  export interface SettingsListTheme {
    label: (text: string, selected: boolean) => string
    value: (text: string, selected: boolean) => string
    description: (text: string) => string
    cursor: string
    hint: (text: string) => string
  }

  export interface SettingItem {
    id: string
    label: string
    description?: string
    /** REQUIRED — rendered on the right side of the row. */
    currentValue: string
    /**
     * Values Enter cycles through. Each cycle fires onChange(id, newValue).
     * A single-element array makes Enter on the row fire onChange(id, value)
     * — the editor pattern for "action" rows.
     */
    values?: string[]
    /** Optional submenu component rendered on Enter when provided. */
    submenu?: (
      currentValue: string,
      done: (selectedValue?: string) => void
    ) => unknown
  }

  /**
   * The real `SettingsList` (in `dist/components/settings-list.js`) implements
   * the `Component` interface from `@earendil-works/pi-tui/dist/tui.d.ts`
   * (`render(width): string[]`, `handleInput?`, `invalidate()`). We declare
   * `render` here so the structural `CustomComponent` contract required by
   * `ctx.ui.custom()` in `src/pi-sdk.d.ts` is satisfied at type-check time.
   * The actual `render` body is supplied by the runtime; only the signature
   * matters for the stub.
   */
  export class SettingsList {
    constructor(
      items: SettingItem[],
      pageLength: number,
      theme: SettingsListTheme,
      onChange: (id: string, newValue: string) => void | Promise<void>,
      onCancel: () => void
    )
    render(width: number): string[]
  }
}
