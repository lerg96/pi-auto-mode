import type { ExtensionUI } from '../pi-sdk.ts'
import { publishUi } from './ui-registry.ts'

/**
 * Snapshot of the UI surface exposed on `ctx.ui` at the time the most recent
 * event handler bound it. The Pi runtime only puts the UI on `ExtensionContext`
 * (per-event), not on `ExtensionAPI`; this module captures the ctx-bound UI so
 * helpers outside an event handler (the modal resolver, telemetry notify, etc.)
 * can render / notify through it.
 *
 * Fail-closed: any code path that needs the UI MUST call `getUiContext()` and
 * treat `null` or `hasUI === false` as "no UI; deny / console-log instead".
 */
export interface UiContext {
  ui: ExtensionUI
  hasUI: boolean
}

let current: UiContext | null = null

/**
 * Bind the UI surface carried by the most recent event's `ctx`. Passing
 * `undefined` or `false` for `hasUI` clears the holder so callers fall back to
 * the no-UI path (fail-closed).
 */
export function setUiContext(
  ui: ExtensionUI | undefined,
  hasUI: boolean
): void {
  if (!ui || !hasUI) {
    // A session without UI (print mode, or a child session whose harness never
    // passed a `uiContext`) must not erase the parent's published UI: that
    // handle is what lets an ask raised here still reach the human.
    current = null
    return
  }
  current = { ui, hasUI }
  publishUi(ui)
}

/**
 * Read the currently-bound UI surface. Returns `null` when no UI has been
 * bound (extension not yet mounted, or last handler ran in print/RPC mode).
 */
export function getUiContext(): UiContext | null {
  return current
}

/**
 * Convenience: notify through the bound UI if available; otherwise log to the
 * console (stderr for error/warning, stdout for info). Never throws.
 */
export function notifyUi(
  message: string,
  level: 'info' | 'warning' | 'error' = 'info'
): void {
  const ctx = getUiContext()
  if (ctx) {
    try {
      ctx.ui.notify(message, level)
      return
    } catch {
      /* fall through to console */
    }
  }
  if (level === 'error') console.error(`pi-auto-mode: ${message}`)
  else if (level === 'warning') console.warn(`pi-auto-mode: ${message}`)
  else console.log(`pi-auto-mode: ${message}`)
}
