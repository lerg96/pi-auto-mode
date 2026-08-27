/**
 * Namespaced bus channels for the in-process Pi event bus. The bus is a
 * single EventEmitter shared by ALL extensions loaded into Pi, so plain
 * channel names like `permissions:decision` are global and would collide
 * with any other extension that picks the same prefix. We namespace with
 * `pi-auto-mode:` so this extension owns its slice of the channel space.
 *
 * IMPORTANT: these are bus channel strings ONLY. The JSONL telemetry log
 * file keeps its own `type` schema (`permissions:decision`,
 * `permissions:ui_prompt`, `tool_call_blocked`, ...) — that is our own log
 * format, not a bus channel, so the prefix is intentionally NOT applied
 * there. See `src/telemetry/telemetry.ts`.
 */
export const BUS_CHANNEL_DECISION = 'pi-auto-mode:permissions:decision'
export const BUS_CHANNEL_UI_PROMPT = 'pi-auto-mode:permissions:ui_prompt'
