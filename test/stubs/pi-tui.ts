// Mirrors the real @earendil-works/pi-tui SettingsList shapes so tests can
// type-check SettingItem values without dragging in the runtime module. The
// real `SettingsList` class is always replaced by a jest.mock factory.

import type { CustomComponent } from '../../src/pi-sdk.d.ts'

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
  /** Values Enter cycles through, calling onChange(id, newValue). */
  values?: string[]
  /** Optional submenu component rendered on Enter when provided. */
  submenu?: (
    currentValue: string,
    done: (selectedValue?: string) => void
  ) => unknown
}

export function matchesKey(data: string, keyId: string): boolean {
  if (keyId === 'alt+enter') {
    return (
      data === '\x1b\r' ||
      data === '\x1b\n' ||
      data.includes(';3u') ||
      data.includes(';3~') ||
      data.includes(';9u')
    )
  }
  return false
}

export function isKeyRelease(data: string): boolean {
  return (
    data.includes(':3u') ||
    data.includes(':3~') ||
    data.includes(':3A') ||
    data.includes(':3B') ||
    data.includes(':3C') ||
    data.includes(':3D') ||
    data.includes(':3H') ||
    data.includes(':3F')
  )
}

/**
 * Stub of `SettingsList` that satisfies the `CustomComponent` contract the
 * `ctx.ui.custom()` factory must return (see `src/pi-sdk.d.ts`). The real
 * `SettingsList` implements `@earendil-works/pi-tui`'s `Component` interface
 * (`render(width): string[]`, `handleInput?(data)`, `invalidate()`); we only
 * need the `render` method to satisfy the structural type at compile time —
 * the jest.mock factory replaces the class entirely at runtime, so these
 * methods are never invoked.
 */
export class SettingsList implements CustomComponent {
  selectedIndex = 0
  items: SettingItem[]
  constructor(
    items: SettingItem[],
    _pageLength: number,
    _theme: SettingsListTheme,
    _onChange: (id: string, newValue: string) => void | Promise<void>,
    _onCancel: () => void
  ) {
    this.items = items
  }
  render(_width: number): string[] {
    return []
  }
  handleInput?(_data: string): void {}
}
