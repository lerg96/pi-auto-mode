// Type stub for @earendil-works/pi-coding-agent (the Pi extension runtime module).
// The real module is injected by the Pi harness at runtime and is not an npm
// dependency; this file supplies the shapes the extension needs to type-check.
// It is resolved via the `paths` mapping in tsconfig.json (a plain module with
// top-level exports — not an ambient `declare module`, which does not register
// under this project's `moduleResolution: "Bundler"` setup).
//
// IMPORTANT: this stub mirrors the real runtime shapes. In particular:
//   - `ExtensionAPI` (the `pi` object passed to the extension's default export)
//     does NOT have a `ui` field. The UI surface lives only on `ExtensionContext`
//     (the `ctx` argument of every event handler), as `ctx.ui`.
//   - When the runtime is in print / RPC mode (no UI), `runner.uiContext` is the
//     `noOpUIContext` whose `custom: async () => undefined` resolves instantly
//     and silently — the modal never renders. Code that needs the UI MUST read
//     `ctx.ui` from the per-event context and tolerate the no-op fallback.
//   - `ExtensionContext.modelRegistry` carries the model registry used to
//     resolve API keys for LLM classification; imported here as a structural
//     `ModelRegistryLike` so the classifier stays runtime-agnostic.

import type { ModelRegistryLike } from './classifier/llm-layer.ts'

// ─── Event types ───────────────────────────────────────────────
export type PiEvent =
  | 'session_start'
  | 'resources_discover'
  | 'session_shutdown'
  | 'before_agent_start'
  | 'input'
  | 'tool_call'

export interface PiEventData {
  [key: string]: unknown
}

/**
 * Result a `before_agent_start` handler can return so the extension can
 * override the assembled system prompt or inject a custom message.
 * Mirrors the upstream `BeforeAgentStartEventResult`
 * (`core/extensions/types.d.ts:768-772`).
 *
 * `message` is the upstream type `Pick<CustomMessage, 'customType' | 'content'
 * | 'display' | 'details'>` (`core/messages.d.ts:32-37`); the runtime reads
 * `result.message` in `core/extensions/runner.js:771` to push into the
 * outgoing message list. We declare the minimal structural shape inline
 * (not a `Pick`) so the stub does not need to import `CustomMessage` — the
 * `content` field is an array of `TextContent | ImageContent` blocks (per
 * the union in `CustomMessage.content`); keep both fields minimal but
 * accurate so future Pi changes surface as a TS error here rather than
 * silently dropping data.
 */
export interface BeforeAgentStartCustomMessage {
  customType: string
  content: { type: string; text?: string }[]
  display: boolean
  details?: unknown
}

export interface BeforeAgentStartEventResult {
  /** Replace the system prompt for this turn. */
  systemPrompt?: string
  /** Inject a custom message into the outgoing turn. */
  message?: BeforeAgentStartCustomMessage
}

export type PiEventHandler = (
  event: PiEventData,
  ctx: ExtensionContext
) => void | Promise<void>

/**
 * Handler signature for `before_agent_start`. The runtime type in
 * `@earendil-works/pi-coding-agent` is generic
 * (`ExtensionHandler<BeforeAgentStartEvent, BeforeAgentStartEventResult>`)
 * — the stub lets us type the result without dragging in the full event
 * union. A handler may return `undefined` (no change), a result object, or
 * a Promise resolving to either. We avoid `void` in the union because
 * TypeScript collapses `void | T` to `void`, which would erase the result.
 */
export type BeforeAgentStartHandler = (
  event: PiEventData,
  ctx: ExtensionContext
) =>
  | BeforeAgentStartEventResult
  | undefined
  | Promise<BeforeAgentStartEventResult | undefined>

// ─── UI surface ────────────────────────────────────────────────
/**
 * Minimal structural type for what `ctx.ui.custom()` factories must return.
 * Mirrors the real `Component` from `@earendil-works/pi-tui/dist/tui.d.ts:10-32`
 * (which requires `render(width)` returning `string[]` and `invalidate()`;
 * `handleInput` is optional) plus the `dispose?(): void` slot the runtime
 * accepts (`core/extensions/types.d.ts:116-118`). The stub keeps TUI / Theme
 * shapes as `unknown` (the modal renders into SettingsList, not raw TUI).
 */
export interface CustomComponent {
  render(width: number): string[]
  handleInput?(data: string): void
  invalidate?(): void
  dispose?(): void
}

/**
 * Shape of `ctx.ui` (and `cmdCtx.ui`). Only the methods the extension uses are
 * declared; the real UIContext has more (terminal input, working message, etc.)
 * and the no-op fallback returns undefined / false / no-op for every method.
 *
 * `setStatus` signature mirrors `ExtensionUIContext.setStatus` from
 * `core/extensions/types.d.ts:38-39` — `key` is required (not `| undefined`)
 * and the value is `string | undefined` (not `unknown`).
 *
 * `custom<T>` returns `Promise<T>`; the no-op context resolves to `undefined`,
 * so callers MUST check `hasUI` before awaiting a real choice. The factory
 * return type mirrors the upstream `Component & { dispose?(): void }` union
 * with `Promise<...>` (`types.d.ts:116-118`).
 */
export interface ExtensionUI {
  setStatus(key: string, text: string | undefined): void
  notify(message: string, level?: 'info' | 'warning' | 'error'): void
  custom<T = void>(
    render: (
      tui: unknown,
      theme: unknown,
      keybindings: unknown,
      done: (result: T) => void
    ) => CustomComponent | Promise<CustomComponent>,
    options?: { overlay?: boolean; overlayOptions?: { title?: string } }
  ): Promise<T>
  /** Native single-choice selector; resolves to the chosen label or undefined. */
  select(
    title: string,
    options: string[],
    opts?: { signal?: AbortSignal; timeout?: number }
  ): Promise<string | undefined>
  /** Native yes/no confirmation; resolves to `true`/`false`. */
  confirm(
    title: string,
    message: string,
    opts?: { signal?: AbortSignal; timeout?: number }
  ): Promise<boolean>
  /** Free-form text input; resolves to the entered string or undefined. */
  input(
    title: string,
    placeholder?: string,
    opts?: { signal?: AbortSignal; timeout?: number }
  ): Promise<string | undefined>
}

// ─── ExtensionContext (per-event handler context) ──────────────
/**
 * The second argument of every Pi event handler. Carries the UI surface
 * (the only place it lives in the runtime) plus session / project metadata.
 *
 * Both `ui` and `hasUI` are read-only getters on the real context
 * (`runner.js` `createContext()`); the extension reads them via plain field
 * access, which works through the prototype getter indirection.
 */
export interface ExtensionContext {
  isProjectTrusted(): boolean
  cwd: string
  /** UI surface; in print/RPC mode it is `noOpUIContext` (returns no-op values). */
  ui: ExtensionUI
  /** False when the runtime is in print/RPC mode (no UI to render into). */
  hasUI: boolean
  /** Read-only session manager; `getSessionId()` always returns a string
   * (never null) per `core/session-manager.d.ts:188`. */
  sessionManager: { getSessionId(): string }
  /**
   * Pi's model registry (see `@earendil-works/pi-coding-agent/dist/core/
   * model-registry.d.ts`). Used by the classifier to resolve LLM
   * credentials when `classifier.llm.apiKey` / `baseUrl` are empty: we
   * fall back to `ctx.modelRegistry.getApiKeyForProvider(provider)` and
   * `ctx.modelRegistry.find(provider, model)?.baseUrl` respectively.
   * Typed as the structural subset the classifier actually consumes so
   * the extension does not depend on the SDK module shape.
   */
  modelRegistry: ModelRegistryLike
}

// ─── ExtensionCommandContext (slash-command context) ───────────
/**
 * Slash-command handler context. Mirrors the real
 * `ExtensionCommandContext` from `core/extensions/types.d.ts:251-278`:
 * extends `ExtensionContext` (so `ui` / `hasUI` are inherited) and adds the
 * session-control methods that are only safe in user-initiated commands.
 *
 * Option bags are typed as `unknown` parameters (we never pass them) to
 * keep the stub minimal — the audit prohibits a catch-all index signature
 * that would hide real typed members, so each is declared explicitly.
 *
 * Return types mirror the upstream `Promise<{ cancelled: boolean }>` /
 * `Promise<void>` shapes.
 */
export interface ExtensionCommandContext extends ExtensionContext {
  getSystemPromptOptions(): unknown
  waitForIdle(): Promise<void>
  newSession(options?: unknown): Promise<{ cancelled: boolean }>
  fork(entryId: string, options?: unknown): Promise<{ cancelled: boolean }>
  navigateTree(
    targetId: string,
    options?: unknown
  ): Promise<{
    cancelled: boolean
  }>
  switchSession(
    sessionPath: string,
    options?: unknown
  ): Promise<{
    cancelled: boolean
  }>
  reload(): Promise<void>
}

// ─── ExtensionAPI ──────────────────────────────────────────────
/**
 * The `pi` object passed to the extension's default export.
 *
 * NOTE: there is intentionally NO `ui` field here. The UI surface lives on
 * `ExtensionContext.ui`. Keeping a `ui` field on this type hides a whole class
 * of bugs (the modal renderer silently no-ops because `pi.ui` is undefined).
 * Event handlers MUST capture `ctx.ui` (e.g. via `setUiContext(ctx.ui, ctx.hasUI)`)
 * before they need to render a dialog or notify the user.
 */
export interface ExtensionAPI {
  /** Register a Pi hook handler for the given event name. */
  on(event: PiEvent, handler: PiEventHandler): void
  /**
   * Overload for `before_agent_start` so handlers can return a
   * `BeforeAgentStartEventResult` (used to override the assembled system
   * prompt). Upstream declares the handler signature generically; the stub
   * mirrors the return-type widening so the extension compiles without
   * importing the full Pi SDK.
   */
  on(event: 'before_agent_start', handler: BeforeAgentStartHandler): void

  /** Register a slash-command executable via the Pi UI. */
  registerCommand(
    name: string,
    def: {
      description?: string
      handler: (
        args: string,
        ctx: ExtensionCommandContext
      ) => void | Promise<void>
      getArgumentCompletions?: (prefix: string) => Array<{
        value: string
        label: string
        description: string
      }> | null
    }
  ): void

  /** Pub/sub event bus (internal Pi channels). */
  events: {
    on(channel: string, cb: (data: unknown) => void | Promise<void>): void
    emit(channel: string, data: unknown): void
  }

  /** Return every tool registered with the Pi instance. */
  getAllTools(): unknown[]
  /** Return currently active (enabled) tools. */
  getActiveTools(): string[]
  /** Enable / disable tools by name. */
  setActiveTools(names: string[]): void
}
