import type { AskDecision, AskResolver, AskRequest } from '../gate/ask.ts'
import {
  SettingsList,
  type SettingItem,
  type SettingsListTheme,
} from '@earendil-works/pi-tui'
import type { CustomComponent } from '../pi-sdk.ts'
import { emitUiPrompt } from './ui-prompt.ts'
import { getUiContext } from '../state/ui-context.ts'
import { playNotificationSound, type SoundPlayer } from './sound.ts'
import type { configState } from '../state/config-state.ts'
import type { SessionRules } from '../permission/session-rules.ts'
import type { ExtensionAPI } from '../pi-sdk.ts'

/**
 * Sanitize a value for TUI label display (H5).
 * Strips newlines, trims, truncates to max width to prevent UI manipulation.
 */
function sanitizeForLabel(val: string, maxWidth = 100): string {
  return val
    .replace(/[\n\r]/g, ' ')
    .trim()
    .slice(0, maxWidth)
}

/**
 * Decision ids dispatched on in `onChange`. Order matters: SettingsList
 * pre-highlights index 0, so `'allow'` is the default-on-Enter choice.
 */
type DecisionId = 'allow' | 'allow_session' | 'deny' | 'deny_reason'

const DECISION_IDS: readonly DecisionId[] = [
  'allow',
  'allow_session',
  'deny',
  'deny_reason',
]

function isDecisionId(v: unknown): v is DecisionId {
  return (
    typeof v === 'string' && (DECISION_IDS as readonly string[]).includes(v)
  )
}

/**
 * Build the 4-row decision list. Each row is an "action" row: a single
 * sentinel value in `values` so Enter fires `onChange(id, '❯')` exactly
 * once. We dispatch on `id`, ignoring the value.
 *
 * `currentValue` is the short right-side hint shown for the highlighted
 * row. The request context (tool/rule/command/reason) lives in the static
 * header above the list (see `buildHeader`), so each row's `description`
 * only explains what that choice does.
 */
function buildDecisionItems(): SettingItem[] {
  return [
    {
      id: 'allow',
      label: 'Allow',
      description: 'Grant once — nothing is remembered.',
      currentValue: 'grant once',
      values: ['❯'],
    },
    {
      id: 'allow_session',
      label: 'Allow for session',
      description:
        'Remember for this session — identical calls skip the prompt.',
      currentValue: 'remember for session',
      values: ['❯'],
    },
    {
      id: 'deny',
      label: 'Deny',
      description: 'Block once — the model sees the reason above.',
      currentValue: 'block once',
      values: ['❯'],
    },
    {
      id: 'deny_reason',
      label: 'Deny with reason',
      description: 'Block and attach your reason for the model.',
      currentValue: 'block & tell the model why',
      values: ['❯'],
    },
  ]
}

/** Field-name column width for the header block (fits 'full command'). */
const HEADER_KEY_WIDTH = 12

/** Wrap width per header line and max wrapped lines (H5 bound). */
const HEADER_WRAP_WIDTH = 160
const HEADER_MAX_LINES = 3

/**
 * Header rows for a possibly-long value: sanitize (strip newlines/trim)
 * then wrap across continuation lines instead of cutting. Indented
 * follow-ups keep the key column readable. Bounded to HEADER_MAX_LINES
 * so a hostile 100KB value cannot blow up the overlay.
 */
function headerRows(
  hint: (text: string) => string,
  key: string,
  value: string
): string[] {
  const clean = value.replace(/[\n\r]/g, ' ').trim()
  const rows = [headerRow(hint, key, clean.slice(0, HEADER_WRAP_WIDTH))]
  const pad = ' '.repeat(HEADER_KEY_WIDTH + 2)
  for (
    let i = HEADER_WRAP_WIDTH, n = 1;
    i < clean.length && n < HEADER_MAX_LINES;
    i += HEADER_WRAP_WIDTH, n += 1
  ) {
    rows.push(`${pad}${clean.slice(i, i + HEADER_WRAP_WIDTH)}`)
  }
  return rows
}

function headerRow(
  hint: (text: string) => string,
  key: string,
  value: string
): string {
  return `${hint(key.padEnd(HEADER_KEY_WIDTH))}: ${value}`
}

/**
 * Static header block rendered above the decision list, mirroring the
 * pi-permission-system prompt layout (tool / rule / command / full
 * command) plus the `reason` row: the reason the layer that produced
 * this ask gave (permission-rule reason first, classifier risk reason
 * second, '—' when neither exists). A `risk` row with score/level is
 * appended only when classifier risk is present.
 */
function buildHeader(req: AskRequest, slTheme: SettingsListTheme): string[] {
  const lines = [slTheme.label('Permission Required', true)]
  lines.push(
    headerRow(slTheme.hint, 'tool', sanitizeForLabel(req.tool ?? req.surface))
  )
  lines.push(
    headerRow(
      slTheme.hint,
      'rule',
      req.rule
        ? sanitizeForLabel(`${req.rule.surface} / ${req.rule.pattern}`)
        : '—'
    )
  )
  lines.push(...headerRows(slTheme.hint, 'command', req.value))
  const full = (req.fullCommand ?? '').trim()
  if (full.length > 0 && full !== req.value) {
    lines.push(...headerRows(slTheme.hint, 'full command', full))
  }
  const reason = req.rule?.reason ?? req.risk?.reason
  lines.push(
    headerRow(
      slTheme.hint,
      'reason',
      reason && reason.trim() ? sanitizeForLabel(reason, 160) : '—'
    )
  )
  if (req.risk) {
    const head = `[${req.risk.level} risk, ${req.risk.score}/10${req.risk.category ? `, ${req.risk.category}` : ''}]`
    lines.push(headerRow(slTheme.hint, 'risk', sanitizeForLabel(head)))
  }
  return lines
}

/** Footer hint rendered below the decision list. */
function buildFooter(slTheme: SettingsListTheme): string[] {
  return [slTheme.hint('↑/↓ move · enter confirm · esc deny')]
}

/** Inner list surface: the real SettingsList plus the optional slots of
 * `CustomComponent`. Cast at the boundary because the compile-time stub
 * only declares the constructor + `render` (the runtime class and the
 * jest.mock factory provide the rest). */
interface InnerList {
  render?(width: number): string[]
  handleInput?(data: string): void
  invalidate?(): void
  dispose?(): void
}

/**
 * Composite modal view: static header (tool/rule/command/reason) +
 * the navigable decision list + footer hint. Input handling is
 * delegated to the inner list, so interaction is unchanged (↑/↓ +
 * Enter, Esc deny).
 */
class ModalView implements CustomComponent {
  private readonly inner: InnerList
  constructor(
    private readonly header: string[],
    private readonly footer: string[],
    list: SettingsList
  ) {
    // SAFETY: the compile-time stub declares only the constructor + render,
    // but the real SettingsList (and the jest.mock replacement) implements
    // the full CustomComponent surface. Every use goes through optional
    // chaining, so a missing slot degrades to a no-op instead of a crash.
    this.inner = list as unknown as InnerList
  }
  render(width: number): string[] {
    return [
      ...this.header,
      ...(this.inner.render?.(width) ?? []),
      ...this.footer,
    ]
  }
  handleInput(data: string): void {
    this.inner.handleInput?.(data)
  }
  invalidate(): void {
    this.inner.invalidate?.()
  }
  dispose(): void {
    this.inner.dispose?.()
  }
}

/**
 * Minimal contract of the global theme Pi passes into the `ctx.ui.custom()`
 * factory. We only need `.fg(color, text)`.
 */
interface GlobalTheme {
  fg(color: string, text: string): string
}

/**
 * Adapt the global theme into a `SettingsListTheme`, mirroring Pi's own
 * `getSettingsListTheme()` recipe (see `dist/modes/interactive/theme/theme.js`).
 *
 * SettingsList does NOT receive the global theme directly — its constructor
 * signature requires these five render functions plus a `cursor` glyph.
 * Passing the global theme in (the previous, broken wiring) caused the
 * SettingsList renderer to call `theme.fg('accent', undefined)` and crash
 * with `Cannot read properties of undefined (reading 'length')`.
 */
function buildSettingsListTheme(theme: GlobalTheme): SettingsListTheme {
  return {
    label: (text, selected) => (selected ? theme.fg('accent', text) : text),
    value: (text, selected) =>
      selected ? theme.fg('accent', text) : theme.fg('muted', text),
    description: (text) => theme.fg('dim', text),
    cursor: theme.fg('accent', '→ '),
    hint: (text) => theme.fg('dim', text),
  }
}

/**
 * Build the modal ask resolver.
 *
 * The factory no longer takes `pi.ui`; the UI is read from the per-event ctx
 * via `getUiContext()`, which the `tool_call` handler populates before
 * calling `gateToolCall`. With no UI bound (or `hasUI === false`, e.g. print
 * / RPC mode) the resolver returns `'deny'` immediately — fail-closed, never
 * an empty prompt.
 *
 * The SettingsList is a settings-editor (Enter cycles through `values`). To
 * expose a 4-way decision we render one row per decision, each with a single
 * sentinel value in `values`; Enter on a row fires `onChange(id, '❯')` and we
 * dispatch on `id`. Esc fires `onCancel` → `finish('deny')` (fail-closed).
 */
export interface ModalResolverOpts {
  // Injected chime for tests; defaults to the platform player.
  soundPlayer?: SoundPlayer
}

export function createModalAskResolver(
  pi: ExtensionAPI,
  _sessionRules: SessionRules,
  cfgState: typeof configState,
  opts?: ModalResolverOpts
): AskResolver {
  return async (req) => {
    // _sessionRules is unused inside the resolver body; the gate (gate.ts)
    // is the single source of truth for session approvals and records them
    // after the user selects 'allow'. Accept the arg for symmetry / future use.

    const bound = getUiContext()
    if (!bound || !bound.hasUI) {
      // Fail-closed: there is no UI to ask the user. This branch is the
      // primary fix for the invisible-modal bug — previously it returned
      // 'deny' silently because `pi.ui` was undefined at runtime; now it
      // also returns 'deny' for legitimate no-UI runtimes (print / RPC).
      return 'deny'
    }
    const ui = bound.ui
    let remindTimer: ReturnType<typeof setInterval> | undefined

    // Sound notification (opt-in via ui.sound): chime on open + reminders
    // while the modal stays undecided. Best-effort; never blocks.
    const sound = cfgState.get().ui.sound
    const chime = (): void => {
      void playNotificationSound(sound, opts?.soundPlayer)
    }
    if (sound?.enabled === true) {
      chime()
      if (sound.remindEveryMs > 0) {
        remindTimer = setInterval(chime, sound.remindEveryMs)
      }
    }

    // Surface the prompt in the editor before blocking on the dialog so the
    // user can see the context (request id, surface, value) while deciding.
    emitUiPrompt(
      ui,
      req.surface,
      req.value,
      req.requestId ?? '',
      pi.events.emit.bind(pi.events)
    )

    return await new Promise<AskDecision>((resolve) => {
      let settled = false
      let close: (() => void) | undefined
      let timer: ReturnType<typeof setTimeout> | undefined

      const finish = (v: AskDecision): void => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        if (remindTimer) clearInterval(remindTimer)
        close?.()
        resolve(v)
      }

      // H2: fail-closed timeout driven by config. -1 = unlimited (no timeout);
      // any other value pauses and, on expiry, resolves `deny`.
      const ms = cfgState.get().ui.modalTimeoutMs
      if (ms !== -1) {
        timer = setTimeout(() => finish('deny'), ms)
      }

      try {
        ui.custom<void>(
          (_tui, theme, _keybindings, closeOverlay) => {
            close = closeOverlay
            const slTheme = buildSettingsListTheme(theme as GlobalTheme)
            const view = new ModalView(
              buildHeader(req, slTheme),
              buildFooter(slTheme),
              new SettingsList(
                buildDecisionItems(),
                8,
                slTheme,
                async (itemId, _newValue) => {
                  // _newValue is the sentinel from `values` ('❯'); we
                  // dispatch on `id`, ignoring the value.
                  if (!isDecisionId(itemId)) {
                    // Unknown row id → fail-closed.
                    finish('deny')
                    return
                  }
                  switch (itemId) {
                    case 'allow':
                      // The gate (gate.ts) treats 'allow' as grant-once and
                      // does NOT persist anything in SessionRules. The
                      // permission record lives only in the audit trail.
                      finish('allow')
                      return

                    case 'allow_session':
                      // The gate (gate.ts) records the session approval via
                      // SessionRules.approveForSession(). The modal only
                      // returns the decision; persistence is the gate's job.
                      finish('allow_session')
                      return

                    case 'deny':
                      finish('deny')
                      return

                    case 'deny_reason': {
                      // H5: capture an optional reason and return it as a
                      // structured denial. Sanitize to prevent directive
                      // injection into the message the model will see.
                      let reason: string | undefined
                      try {
                        reason = await ui.input(
                          'Reason for denial',
                          'Why is this denied? Shown to the model.',
                          ms === -1 ? {} : { timeout: ms }
                        )
                      } catch {
                        finish('deny')
                        return
                      }
                      if (reason && reason.trim()) {
                        finish({
                          decision: 'deny',
                          reason: sanitizeForLabel(reason, 200),
                        })
                      } else {
                        finish('deny')
                      }
                      return
                    }
                  }
                },
                // onCancel / Esc: Pi's own SettingsList calls onCancel on
                // Esc. The render is now visible (overlay:false + correct
                // SettingItem/theme shapes), so Esc-as-deny matches the
                // expected UX: dismissing the prompt is a deny.
                () => finish('deny')
              )
            )
            return view
          },
          // overlay:false is critical — overlay:true makes the modal close
          // on any focus loss and the user never sees it. The inline mode
          // (overlay:false) renders in the chat area, stays visible until
          // the user makes a selection, and is the proven pattern from
          // pi-permission-system/src/authority/permission-prompt-component.ts
          // (line ~147: `view.ui.custom<UnattributedDecision>(factory, { overlay: false })`).
          { overlay: false }
        ).catch(() => {
          // ui.custom() rejected (e.g. runtime crashed) → fail-closed.
          finish('deny')
        })
      } catch {
        // Synchronous throw before the promise was set up → fail-closed.
        finish('deny')
      }
    })
  }
}
