import type { ExtensionUI } from '../pi-sdk.ts'

/**
 * Process-wide UI registry.
 *
 * Why this exists: pi binds a session's extension runner to a real UI only
 * when the harness passes one (`interactive-mode` and the RPC modes do;
 * `print-mode` does not). A session created inside the process by another
 * extension — e.g. `@tintinweb/pi-subagents`, which calls
 * `session.bindExtensions({ onError })` with no `uiContext` — therefore runs
 * with `ctx.hasUI === false` for its whole life, and an ask raised there has
 * nowhere to render. Without this registry the answer is a silent deny that
 * gets audited as if a human had said no.
 *
 * Why `Symbol.for` and not module state: pi loads extensions with jiti
 * (`moduleCache: false`) and its own factory cache is keyed by cwd, so a
 * session with a different working directory (e.g. a `worktree` isolated
 * sub-agent) re-evaluates this module from scratch. A symbol-keyed slot on
 * `globalThis` is the one channel that survives re-evaluation. It is the same
 * pattern `@tintinweb/pi-subagents` uses for its manager registry.
 *
 * The registry holds the LAST UI that reported itself dialog-capable. In a
 * TUI process that is the one interactive session the user is looking at.
 */

const REGISTRY_KEY = Symbol.for('pi-auto-mode:ui-registry')

interface UiRegistry {
  /** Last dialog-capable UI published by any session in this process. */
  ui?: ExtensionUI
  /**
   * Tail of the prompt queue. Pi renders ONE extension selector per session,
   * so two prompts reaching the same UI at once would tear each other's
   * component down (and the abandoned promise would never resolve, hanging
   * the agent behind it). Every prompt runs behind this lock.
   */
  queue: Promise<unknown>
  /** Whether a prompt currently owns the selector. */
  busy: boolean
}

function registry(): UiRegistry {
  // SAFETY: the key is `Symbol.for(...)`, i.e. a process-unique symbol, and
  // `registry()` is the only writer — the value stored under it is always a
  // `UiRegistry` created below (or undefined before first use).
  const slot = globalThis as unknown as Record<symbol, UiRegistry | undefined>
  let reg = slot[REGISTRY_KEY]
  if (!reg) {
    reg = { queue: Promise.resolve(), busy: false }
    slot[REGISTRY_KEY] = reg
  }
  return reg
}

/**
 * Publish a UI as the process' prompt target. Callers MUST only publish when
 * `ctx.hasUI` was true: publishing pi's no-op context here would hand every
 * headless session a "UI" that answers `select() → undefined` and
 * `confirm() → false`, which is a fabricated human decision, not a prompt.
 */
export function publishUi(ui: ExtensionUI): void {
  registry().ui = ui
}

/**
 * The UI to prompt on when the current session has none, or `undefined` when
 * nothing in this process can show a prompt (headless `pi -p`, or a session
 * that never bound one).
 */
export function borrowUi(): ExtensionUI | undefined {
  return registry().ui
}

/**
 * Run one prompt at a time per process.
 *
 * An idle lock starts `task` synchronously: callers (and tests) drive the
 * rendered component from the same tick that opened the prompt. Rejections
 * never poison the queue. The check-and-set of `busy` is synchronous, so two
 * waiters woken by the same settling can both pass the check but only the
 * first one claims the lock.
 */
export async function withPromptLock<T>(task: () => Promise<T>): Promise<T> {
  const reg = registry()
  for (;;) {
    if (!reg.busy) {
      reg.busy = true
      // `task()` se invoca UNA sola vez; la promesa resultante es la que
      // publicamos como cola y la que esperamos.
      let run: Promise<T>
      try {
        run = Promise.resolve(task())
      } catch (err) {
        reg.busy = false
        throw err
      }
      reg.queue = run.then(
        () => undefined,
        () => undefined
      )
      try {
        return await run
      } finally {
        reg.busy = false
      }
    }
    await reg.queue.then(
      () => undefined,
      () => undefined
    )
  }
}

/** Test seam: forget the published UI and reset the queue. */
export function resetUiRegistry(): void {
  // SAFETY: same symbol-keyed slot as `registry()`; only `registry()` ever
  // wrote it, so deleting it cannot remove anything else from globalThis.
  const slot = globalThis as unknown as Record<symbol, UiRegistry | undefined>
  delete slot[REGISTRY_KEY]
}
