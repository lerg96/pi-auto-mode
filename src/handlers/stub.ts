import type {
  PiEventData,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent'

// Lifecycle no-op bases wrapped by beginSession/endSession in src/index.ts.
// They exist so the session wrappers have a stable call target; the wrappers
// (sessionRules.clear + denyService.reset) carry the real behavior.
// IMPORTANT: no console.log here — writing to stdout from an event handler
// corrupts the Pi TUI render (this is the "input STUB" ghost text bug).

// ─── session_start ──────────────────────────────────────────────
export async function handleSessionStart(
  _event: PiEventData,
  _ctx: ExtensionContext
): Promise<void> {
  // no-op: session state reset lives in beginSession (src/index.ts)
}

// ─── session_shutdown ───────────────────────────────────────────
export async function handleSessionShutdown(
  _event: PiEventData,
  _ctx: ExtensionContext
): Promise<void> {
  // no-op: session state reset lives in endSession (src/index.ts)
}
