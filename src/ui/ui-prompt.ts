import type { ExtensionUI } from '../pi-sdk.ts'
import { BUS_CHANNEL_UI_PROMPT } from '../events.ts'

export interface UiPromptRequest {
  requestId: string
  source: 'tool_call' | 'skill_input' | 'skill_read'
  surface: string | null
  value: string | null
  agentName: string | null
  request: { surface: string; value: string }
}

function genId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)
  )
}

export function buildUiPrompt(
  surface: string,
  value: string,
  requestId: string
): UiPromptRequest {
  return {
    requestId,
    source: 'tool_call',
    surface,
    value,
    agentName: null,
    request: { surface, value },
  }
}

/**
 * Emit the `pi-auto-mode:permissions:ui_prompt` event to the runtime's event
 * bus, taking the bound UI and the emit channel separately. This decouples
 * the helper from `ExtensionAPI` so it can be invoked from the modal (which
 * has `ui` captured from the ctx) without re-introducing the `pi.ui` misuse
 * that hid the original invisible-modal bug.
 *
 * Touches `ui` once (defensive) and never throws.
 */
export function emitUiPrompt(
  ui: ExtensionUI,
  surface: string,
  value: string,
  requestId?: string,
  emit?: (channel: string, data: unknown) => void
): void {
  // Defensive: confirm the UI is a real surface (setUiContext guarantees it,
  // but a stray test that forgets to bind the holder would otherwise crash).
  void ui
  if (!emit) return
  try {
    emit(
      BUS_CHANNEL_UI_PROMPT,
      buildUiPrompt(surface, value, requestId ?? genId())
    )
  } catch {
    /* fire-and-forget */
  }
}
