import type {
  AskDecision,
  AskResolver,
  AskRequest,
  AskVia,
  AskType,
} from '../gate/ask.ts'
import {
  SettingsList,
  type SettingItem,
  type SettingsListTheme,
  matchesKey,
  isKeyRelease,
} from '@earendil-works/pi-tui'
import type { CustomComponent, ExtensionUI } from '../pi-sdk.ts'
import { emitUiPrompt } from './ui-prompt.ts'
import { getUiContext } from '../state/ui-context.ts'
import { borrowUi, withPromptLock } from '../state/ui-registry.ts'
import { playNotificationSound, type SoundPlayer } from './sound.ts'
import type { configState } from '../state/config-state.ts'
import type { SessionRules } from '../permission/session-rules.ts'
import type { ExtensionAPI } from '../pi-sdk.ts'
// NOTE: addExternalDirAllow is NOT imported here — the gate (gate.ts) owns
// persistence for external-directory approvals. The modal only returns the
// decision id; side effects are applied by the gate after normalisation.

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
type DecisionId =
  | 'allow'
  | 'allow_session'
  | 'allow_permanent'
  | 'allow_dir_tool'
  | 'allow_dir_all'
  | 'deny'
  | 'deny_reason'

const ALL_DECISION_IDS: readonly string[] = [
  'allow',
  'allow_session',
  'allow_permanent',
  'allow_dir_tool',
  'allow_dir_all',
  'deny',
  'deny_reason',
]

function isDecisionId(v: unknown): boolean {
  if (typeof v !== 'string') return false
  return (
    ALL_DECISION_IDS.includes(v) ||
    v.startsWith('allow_session:') ||
    v.startsWith('allow_permanent:')
  )
}

function buildSessionPatternItems(patterns: string[]): SettingItem[] {
  return patterns.map((pat, i) => {
    if (i === 0) {
      return {
        id: 'allow_session:0',
        label: `Allow for session "${pat}"`,
        description:
          'Remember for this session — identical calls skip the prompt.',
        currentValue: 'remember exact',
        values: ['❯'],
      }
    }
    return {
      id: `allow_session:${i}`,
      label: `Allow for session "${pat}"`,
      description: `Remember for this session — calls matching "${pat}" skip the prompt.`,
      currentValue: 'remember wildcard',
      values: ['❯'],
    }
  })
}

function buildExternalDirItems(): SettingItem[] {
  return [
    {
      id: 'allow',
      label: 'Allow this path once',
      description: 'Grant once — nothing is remembered.',
      currentValue: 'grant once',
      values: ['❯'],
    },
    {
      id: 'allow_dir_tool',
      label: 'Allow path for this tool',
      description: 'Remember for this tool — identical calls skip the prompt.',
      currentValue: 'remember for tool',
      values: ['❯'],
    },
    {
      id: 'allow_dir_all',
      label: 'Allow path for all tools',
      description: 'Remember for all tools — identical calls skip the prompt.',
      currentValue: 'remember for all',
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

function buildLegacyToolItems(): SettingItem[] {
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

/**
 * Build the decision list. Each row is an "action" row: a single
 * sentinel value in `values` so Enter fires `onChange(id, '❯')` exactly
 * once. We dispatch on `id`, ignoring the value.
 *
 * `currentValue` is the short right-side hint shown for the highlighted
 * row. The request context (tool/rule/command/reason) lives in the static
 * header above the list (see `buildHeader`), so each row's `description`
 * only explains what that choice does.
 */
function buildDecisionItems(
  type: AskType,
  sessionPatterns?: string[]
): SettingItem[] {
  if (type === 'external-directory') {
    return buildExternalDirItems()
  }
  if (sessionPatterns && sessionPatterns.length > 0) {
    return [
      {
        id: 'allow',
        label: 'Allow',
        description: 'Grant once — nothing is remembered.',
        currentValue: 'grant once',
        values: ['❯'],
      },
      ...buildSessionPatternItems(sessionPatterns),
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
  return buildLegacyToolItems()
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

function whyExplanation(req: AskRequest): string {
  const origin = req.askOrigin
  if (origin === 'external-directory') {
    return 'this call touches a path outside the working directory'
  }
  if (origin === 'rule') {
    return 'a permission rule requires confirmation'
  }
  if (origin === 'unknown-tool') {
    return 'no permission rule matches this tool'
  }
  if (origin === 'classifier') {
    return 'the risk classifier flagged this call'
  }
  if (origin === 'deny-override') {
    return 'a deny rule matched; you may override it'
  }
  if (origin === 'classifier-override') {
    return 'the classifier blocked this call; you may override it'
  }
  if (req.type === 'external-directory') {
    return 'this call touches a path outside the working directory'
  }
  return 'this call requires confirmation'
}

/**
 * Static header block rendered above the decision list.
 *
 * Two layouts:
 * - `tool-permission`: why / tool / rule / command / full command / reason / risk
 * - `external-directory`: why / tool / cwd / path / command (if differs) / reason / risk
 */
function buildHeader(
  req: AskRequest,
  slTheme: SettingsListTheme,
  subtitle?: string
): string[] {
  const lines: string[] = []
  const isExternalDir = req.type === 'external-directory'
  const segmentSuffix =
    req.segmentIndex && req.segmentTotal && req.segmentTotal > 1
      ? ` [${req.segmentIndex} of ${req.segmentTotal}]`
      : ''

  const isShell =
    req.surface === 'shell' || req.tool === 'bash' || req.tool === 'powershell'

  // Title
  const title = isExternalDir
    ? `Outside working directory${segmentSuffix}`
    : `${isShell ? 'Command approval' : 'Tool approval'}${segmentSuffix}`

  lines.push(slTheme.label(title, true))
  // A prompt borrowed into the parent session must say so: the user is being
  // asked about a tool call that is NOT from the session in front of them.
  if (subtitle) lines.push(slTheme.hint(subtitle))

  lines.push(headerRow(slTheme.hint, 'why', whyExplanation(req)))

  if (isExternalDir) {
    // External-directory layout: tool + cwd + path (+ optional command)
    const toolLabel = sanitizeForLabel(req.tool ?? req.surface)
    const cwd = req.cwd ?? process.cwd()
    const dirPath = req.externalDir ?? req.value
    lines.push(headerRow(slTheme.hint, 'tool', toolLabel))
    lines.push(headerRow(slTheme.hint, 'cwd', sanitizeForLabel(cwd, 160)))
    lines.push(headerRow(slTheme.hint, 'path', sanitizeForLabel(dirPath, 160)))
    if (req.value && req.value !== dirPath) {
      lines.push(...headerRows(slTheme.hint, 'command', req.value))
    }
  } else {
    // Tool-permission layout (existing)
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
function buildFooter(slTheme: SettingsListTheme, req?: AskRequest): string[] {
  const prefix =
    req?.segmentIndex && req?.segmentTotal && req?.segmentTotal > 1
      ? `[${req.segmentIndex} of ${req.segmentTotal}] · `
      : ''
  return [
    slTheme.hint(
      `${prefix}↑/↓ move · enter confirm · alt+enter permanent · esc deny`
    ),
  ]
}

function hasAltModifier(data: string): boolean {
  if (data === '\x1b\r' || data === '\x1b\n') return true
  const match = data.match(/;(\d+)(?::\d+)?[u~]/)
  if (match) {
    const mod = parseInt(match[1], 10)
    return ((mod - 1) & 2) !== 0
  }
  return false
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
  selectedIndex?: number
}

/**
 * Composite modal view: static header (tool/rule/command/reason) +
 * the navigable decision list + footer hint. Input handling is
 * delegated to the inner list, so interaction is unchanged (↑/↓ +
 * Enter, Esc deny).
 */
export class ModalView implements CustomComponent {
  private readonly inner: InnerList
  readonly wantsKeyRelease = true
  isAltActive = false
  private readonly items: SettingItem[]
  private readonly req?: AskRequest
  private readonly onDecision?: (decision: AskDecision) => void

  private readonly originalLabels = new Map<string, string>()
  private readonly originalDescriptions = new Map<string, string | undefined>()

  constructor(
    private readonly header: string[],
    private readonly footer: string[],
    list: SettingsList,
    items: SettingItem[] = [],
    req?: AskRequest,
    onDecision?: (decision: AskDecision) => void
  ) {
    // SAFETY: the compile-time stub declares only the constructor + render,
    // but the real SettingsList (and the jest.mock replacement) implements
    // the full CustomComponent surface. Every use goes through optional
    // chaining, so a missing slot degrades to a no-op instead of a crash.
    this.inner = list as unknown as InnerList
    this.items = items
    this.req = req
    this.onDecision = onDecision
  }

  setAltActive(active: boolean): void {
    if (this.isAltActive === active) return
    this.isAltActive = active
    for (const item of this.items) {
      if (item.id === 'allow_session' || item.id.startsWith('allow_session:')) {
        if (active) {
          if (!this.originalLabels.has(item.id)) {
            this.originalLabels.set(item.id, item.label)
          }
          if (!this.originalDescriptions.has(item.id)) {
            this.originalDescriptions.set(item.id, item.description)
          }
          item.label = item.label.replace(
            'Allow for session',
            'Allow permanently'
          )
          item.description = 'Save to permissions in config — permanent allow.'
        } else {
          const origLabel = this.originalLabels.get(item.id)
          const origDesc = this.originalDescriptions.get(item.id)
          if (origLabel !== undefined) item.label = origLabel
          if (origDesc !== undefined) item.description = origDesc
        }
      }
    }
    this.invalidate()
  }

  render(width: number): string[] {
    return [
      ...this.header,
      ...(this.inner.render?.(width) ?? []),
      ...this.footer,
    ]
  }

  handleInput(data: string): void {
    // Detect Alt modifier / keypress:
    // Kitty protocol left/right alt keys: codepoints 57441 / 57442
    if (data.includes('57441') || data.includes('57442')) {
      if (isKeyRelease(data)) {
        this.setAltActive(false)
      } else {
        this.setAltActive(true)
      }
      return
    }

    if (isKeyRelease(data)) {
      return
    }

    // Detect Alt + Enter:
    const isAltEnter =
      matchesKey(data, 'alt+enter') ||
      data === '\x1b\r' ||
      data === '\x1b\n' ||
      ((data.includes(';3u') || data.includes(';3~') || data.includes(';9u')) &&
        (data.includes('13') ||
          data.includes('\r') ||
          matchesKey(data, 'enter'))) ||
      (this.isAltActive && (matchesKey(data, 'enter') || data === '\r'))

    if (isAltEnter) {
      const selectedIndex =
        (this.inner as { selectedIndex?: number }).selectedIndex ?? 0
      const selected = this.items[selectedIndex]
      let pattern = this.req?.value ?? ''
      if (selected) {
        if (selected.id.startsWith('allow_session:')) {
          const idx = parseInt(selected.id.slice('allow_session:'.length), 10)
          pattern = this.req?.sessionPatterns?.[idx] ?? this.req?.value ?? ''
        } else if (selected.id === 'allow_session') {
          pattern = this.req?.sessionPatterns?.[0] ?? this.req?.value ?? ''
        } else if (selected.id.startsWith('allow_dir_')) {
          pattern = this.req?.externalDir ?? this.req?.value ?? ''
        } else if (selected.id === 'allow') {
          pattern = this.req?.sessionPatterns?.[0] ?? this.req?.value ?? ''
        }
      }
      this.onDecision?.({ decision: 'allow_permanent', pattern })
      return
    }

    if (!hasAltModifier(data) && this.isAltActive) {
      this.setAltActive(false)
    }

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
  // sessionRules is intentionally unused here — the gate (gate.ts) owns
  // session-approval persistence for all decision types. This parameter
  // exists only for backward compatibility with callers that construct the
  // resolver with an instance.
  return async (req) => {
    const bound = getUiContext()
    let ui: ExtensionUI
    let via: AskVia
    if (bound?.hasUI) {
      ui = bound.ui
      via = 'modal'
    } else {
      // This session cannot prompt. Either deny (fail-closed, the historical
      // behaviour) or borrow the UI another session in this process published
      // — see state/ui-registry.ts for why that handle exists and when it is
      // legitimately absent (headless `pi -p` never publishes).
      const borrowed =
        cfgState.get().ui.noUiAsks === 'bubble' ? borrowUi() : undefined
      if (!borrowed) {
        // Nobody was asked. Reported as `via: 'no-ui'` so telemetry and the
        // model-facing message never claim a human denial.
        return { decision: 'deny', via: 'no-ui' }
      }
      ui = borrowed
      via = 'parent-modal'
    }

    // One prompt at a time per process: pi owns a single extension selector,
    // and a second modal rendered over the first orphans the first promise.
    const verdict = await withPromptLock(() => runPrompt(req, ui, via))
    // Contrato: `via` solo se declara cuando NO es el caso normal ('modal'),
    // así que los resolvers que devuelven strings simples siguen valiendo. Un
    // veredicto que ya traiga `via` (el timeout) manda: describe mejor qué
    // pasó que el simple «se renderizó aquí».
    if (typeof verdict === 'string') {
      return via === 'modal' ? verdict : { decision: verdict, via }
    }
    if (via === 'modal' || verdict.via) return verdict
    return { ...verdict, via }
  }

  async function runPrompt(
    req: AskRequest,
    ui: ExtensionUI,
    via: AskVia
  ): Promise<AskDecision> {
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
      // Los prompts que se renderizan en la UI del padre (sub-sesión sin UI)
      // usan su propio plazo: quien espera es un agente en segundo plano, no la
      // persona que tiene la terminal delante.
      const uiCfg = cfgState.get().ui
      const ms =
        via === 'parent-modal'
          ? uiCfg.subagentModalTimeoutMs
          : uiCfg.modalTimeoutMs
      if (ms !== -1) {
        // Nadie respondió: no es una decisión del usuario, así que se marca
        // `via: 'timeout'` en lugar de dejar que se audite como un deny humano.
        timer = setTimeout(
          () => finish({ decision: 'deny', via: 'timeout' }),
          ms
        )
      }

      try {
        ui.custom<void>(
          (_tui, theme, _keybindings, closeOverlay) => {
            close = closeOverlay
            const slTheme = buildSettingsListTheme(theme as GlobalTheme)
            const items = buildDecisionItems(
              req.type ?? 'tool-permission',
              req.sessionPatterns
            )
            let modalViewRef: ModalView | undefined
            const list = new SettingsList(
              items,
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
                if (itemId.startsWith('allow_permanent:')) {
                  const idx = parseInt(
                    itemId.slice('allow_permanent:'.length),
                    10
                  )
                  const pattern = req.sessionPatterns?.[idx] ?? req.value
                  finish({ decision: 'allow_permanent', pattern })
                  return
                }
                if (itemId === 'allow_permanent') {
                  const pattern = req.sessionPatterns?.[0] ?? req.value
                  finish({ decision: 'allow_permanent', pattern })
                  return
                }
                if (itemId.startsWith('allow_session:')) {
                  const idx = parseInt(
                    itemId.slice('allow_session:'.length),
                    10
                  )
                  const pattern = req.sessionPatterns?.[idx] ?? req.value
                  if (modalViewRef?.isAltActive) {
                    finish({ decision: 'allow_permanent', pattern })
                    return
                  }
                  finish({ decision: 'allow_session', pattern })
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
                    if (modalViewRef?.isAltActive) {
                      const pattern = req.sessionPatterns?.[0] ?? req.value
                      finish({ decision: 'allow_permanent', pattern })
                      return
                    }
                    if (req.sessionPatterns && req.sessionPatterns.length > 0) {
                      finish({
                        decision: 'allow_session',
                        pattern: req.sessionPatterns[0] ?? req.value,
                      })
                    } else {
                      finish('allow_session')
                    }
                    return

                  case 'allow_dir_tool':
                    // External-directory: allow this directory for this tool.
                    // The gate (gate.ts) persists the session rule after
                    // receiving this decision id. The modal only returns it.
                    finish('allow_dir_tool')
                    return

                  case 'allow_dir_all':
                    // External-directory: allow this directory for all tools.
                    // The gate (gate.ts) adds to the global allowlist after
                    // receiving this decision id. The modal only returns it.
                    finish('allow_dir_all')
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
            const view = new ModalView(
              buildHeader(
                req,
                slTheme,
                via === 'parent-modal'
                  ? '[child session: no direct UI]'
                  : undefined
              ),
              buildFooter(slTheme, req),
              list,
              items,
              req,
              finish
            )
            modalViewRef = view
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
