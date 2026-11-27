import { matchesKey, isKeyRelease } from '@earendil-works/pi-tui'
import type { CustomComponent, ExtensionUI } from '../pi-sdk.ts'
import { getUiContext } from '../state/ui-context.ts'
import { borrowUi, withPromptLock } from '../state/ui-registry.ts'
import type { configState } from '../state/config-state.ts'
import type { SessionRules } from '../permission/session-rules.ts'
import {
  listPermanentPermissions,
  persistPermanentAllow,
  removePermanentAllow,
  type PermanentPermissionEntry,
} from '../config/permanent-allow.ts'
import {
  addExternalDirAllow,
  getExternalDirAllowlist,
  removeExternalDirAllow,
} from '../state/external-dir-allowlist.ts'

export type PermissionsColumn = 'permanent' | 'session'

export interface SessionPermissionEntry {
  kind: 'rule' | 'external_dir'
  surface: string
  pattern: string
  action: 'allow' | 'deny' | 'ask'
}

export interface GlobalTheme {
  fg(color: string, text: string): string
}

export interface PermissionsListModalDeps {
  configState: typeof configState
  sessionRules: SessionRules
  configPath?: string
  onClose: () => void
  theme?: GlobalTheme
  requestRender?: () => void
}

export interface OpenPermissionsModalOptions {
  configState: typeof configState
  sessionRules: SessionRules
  ui?: ExtensionUI
  hasUI?: boolean
  configPath?: string
}

export function parseAddPermissionInput(
  raw: string,
  column: PermissionsColumn
): { target: string; pattern: string; isExternalDir: boolean } | null {
  const trimmed = raw.trim()
  if (!trimmed || trimmed === ':') return null

  if (
    trimmed.startsWith('/') ||
    trimmed.startsWith('~') ||
    /^[a-zA-Z]:[/\\]/.test(trimmed)
  ) {
    return {
      target: 'external_directory',
      pattern: trimmed,
      isExternalDir: true,
    }
  }

  const colonIdx = trimmed.indexOf(':')
  if (colonIdx !== -1) {
    const target = trimmed.slice(0, colonIdx).trim()
    const pattern = trimmed.slice(colonIdx + 1).trim()
    if (!target || !pattern) return null
    if (!target.includes('/') && !target.includes('\\')) {
      const isExternalDir =
        target === 'external_directory' ||
        target === 'external_dir' ||
        target.startsWith('external_dir:')
      return { target, pattern, isExternalDir }
    }
  }

  return {
    target: column === 'permanent' ? 'bash' : 'shell',
    pattern: trimmed,
    isExternalDir: false,
  }
}

function padEndVisible(str: string, width: number): string {
  const visibleLen = str.replace(/\x1b\[[0-9;]*m/g, '').length
  return str + ' '.repeat(Math.max(0, width - visibleLen))
}

export class PermissionsListModalView implements CustomComponent {
  activeColumn: PermissionsColumn = 'permanent'
  permanentIndex = 0
  sessionIndex = 0
  isAdding = false
  addBuffer = ''
  statusMessage = ''

  constructor(private readonly deps: PermissionsListModalDeps) {}

  getPermanentItems(): PermanentPermissionEntry[] {
    return listPermanentPermissions(this.deps.configState.get())
  }

  getSessionItems(): SessionPermissionEntry[] {
    const rules = this.deps.sessionRules.snapshot()
    const rulePatterns = new Set(rules.map((r) => r.pattern))
    const items: SessionPermissionEntry[] = rules.map((r) => ({
      kind: 'rule',
      surface: r.surface,
      pattern: r.pattern,
      action: r.action,
    }))
    for (const dir of getExternalDirAllowlist()) {
      if (!rulePatterns.has(dir)) {
        items.push({
          kind: 'external_dir',
          surface: 'external_directory',
          pattern: dir,
          action: 'allow',
        })
      }
    }
    return items
  }

  private formatSectionHeader(title: string, isActive: boolean): string {
    return isActive && this.deps.theme
      ? this.deps.theme.fg('accent', title)
      : title
  }

  private buildColumnLines(
    column: PermissionsColumn,
    permItems: PermanentPermissionEntry[],
    sessItems: SessionPermissionEntry[]
  ): string[] {
    const isPerm = column === 'permanent'
    const items = isPerm ? permItems : sessItems
    const count = items.length
    const title = `${isPerm ? 'Permanent' : 'Session'} Permissions (${count})`
    const lines = [
      this.formatSectionHeader(title, this.activeColumn === column),
    ]
    if (count === 0) return [...lines, '  (none)']

    const selectedIdx = isPerm ? this.permanentIndex : this.sessionIndex
    for (let i = 0; i < count; i++) {
      const it = items[i]!
      const cursor =
        this.activeColumn === column && i === selectedIdx ? '→ ' : '  '
      const label = isPerm
        ? (it as PermanentPermissionEntry).toolName || it.surface
        : it.surface
      lines.push(`${cursor}[${it.action}] ${label}: ${it.pattern}`)
    }
    return lines
  }

  private buildFooterLines(): string[] {
    if (this.isAdding) {
      return [
        `Add to ${this.activeColumn} (e.g. "bash: git status *" or "/path/**", Enter=save, Esc=cancel): > ${this.addBuffer}█`,
      ]
    }
    const lines = ['←/→/tab column · ↑/↓ move · a add · d delete · esc/q close']
    if (this.statusMessage) lines.push(this.statusMessage)
    return lines
  }

  render(width: number): string[] {
    const permItems = this.getPermanentItems()
    const sessItems = this.getSessionItems()
    const leftCol = this.buildColumnLines('permanent', permItems, sessItems)
    const rightCol = this.buildColumnLines('session', permItems, sessItems)
    const lines: string[] = ['Permissions Manager', '']

    if (width >= 70) {
      const colWidth = Math.floor(width / 2)
      const maxRows = Math.max(leftCol.length, rightCol.length)
      for (let i = 0; i < maxRows; i++) {
        lines.push(
          padEndVisible(leftCol[i] ?? '', colWidth) + (rightCol[i] ?? '')
        )
      }
    } else {
      lines.push(...leftCol, '', ...rightCol)
    }

    return [...lines, '', ...this.buildFooterLines()]
  }

  handleInput(data: string): void {
    if (isKeyRelease(data)) return
    if (this.isAdding) {
      this.handleAddInput(data)
    } else {
      this.handleBrowseInput(data)
    }
    this.invalidate()
  }

  invalidate(): void {
    this.deps.requestRender?.()
  }

  private handleBrowseInput(data: string): void {
    if (matchesKey(data, 'escape') || data === 'q' || data === 'Q') {
      this.deps.onClose()
    } else if (matchesKey(data, 'left')) {
      this.activeColumn =
        this.activeColumn === 'permanent' ? 'session' : 'permanent'
    } else if (matchesKey(data, 'right')) {
      this.activeColumn =
        this.activeColumn === 'session' ? 'permanent' : 'session'
    } else if (matchesKey(data, 'tab')) {
      this.activeColumn =
        this.activeColumn === 'permanent' ? 'session' : 'permanent'
    } else if (matchesKey(data, 'up')) {
      this.moveSelection(-1)
    } else if (matchesKey(data, 'down')) {
      this.moveSelection(1)
    } else if (data === 'd' || data === 'D') {
      this.deleteCurrentItem()
    } else if (data === 'a' || data === 'A') {
      this.isAdding = true
      this.addBuffer = ''
      this.statusMessage = ''
    }
  }

  private moveSelection(delta: number): void {
    const isP = this.activeColumn === 'permanent'
    const len = isP
      ? this.getPermanentItems().length
      : this.getSessionItems().length
    const maxIdx = Math.max(0, len - 1)
    const cur = isP ? this.permanentIndex : this.sessionIndex
    const next = Math.min(maxIdx, Math.max(0, delta < 0 ? cur - 1 : cur + 1))
    if (isP) this.permanentIndex = next
    else this.sessionIndex = next
  }

  private clampIndex(): void {
    this.permanentIndex = Math.min(
      this.permanentIndex,
      Math.max(0, this.getPermanentItems().length - 1)
    )
    this.sessionIndex = Math.min(
      this.sessionIndex,
      Math.max(0, this.getSessionItems().length - 1)
    )
  }

  private deleteCurrentItem(): void {
    if (this.activeColumn === 'permanent') {
      const item = this.getPermanentItems()[this.permanentIndex]
      if (!item) return
      const removed = removePermanentAllow({
        surface: item.surface,
        toolName: item.toolName,
        pattern: item.pattern,
        isExternalDir: item.surface === 'external_directory',
        configPath: this.deps.configPath,
      })
      this.clampIndex()
      this.statusMessage = removed
        ? `Deleted permanent: ${item.pattern}`
        : `Failed to delete permanent: ${item.pattern}`
    } else {
      const item = this.getSessionItems()[this.sessionIndex]
      if (!item) return
      if (item.kind === 'external_dir') {
        removeExternalDirAllow(item.pattern)
        this.deps.sessionRules.remove(item.surface, item.pattern)
      } else {
        this.deps.sessionRules.remove(item.surface, item.pattern, item.action)
      }
      this.clampIndex()
      this.statusMessage = `Deleted session: ${item.pattern}`
    }
  }

  private handleAddInput(data: string): void {
    if (matchesKey(data, 'escape')) {
      this.isAdding = false
      this.addBuffer = ''
    } else if (matchesKey(data, 'enter')) {
      this.saveAddPermission()
      this.isAdding = false
      this.addBuffer = ''
    } else if (matchesKey(data, 'backspace')) {
      this.addBuffer = this.addBuffer.slice(0, -1)
    } else if (
      data.length >= 1 &&
      !data.startsWith('\x1b') &&
      !/[\r\n\t\x00-\x1f\x7f]/.test(data)
    ) {
      this.addBuffer += data
    }
  }

  private saveAddPermission(): void {
    const parsed = parseAddPermissionInput(this.addBuffer, this.activeColumn)
    if (!parsed) {
      this.statusMessage = 'Invalid permission input.'
      return
    }
    if (this.activeColumn === 'permanent') {
      persistPermanentAllow({
        surface: parsed.isExternalDir ? 'external_directory' : 'shell',
        toolName: parsed.target,
        pattern: parsed.pattern,
        isExternalDir: parsed.isExternalDir,
        configPath: this.deps.configPath,
      })
    } else if (parsed.isExternalDir && parsed.target === 'external_directory') {
      addExternalDirAllow(parsed.pattern)
    } else {
      this.deps.sessionRules.approveForSession(
        parsed.target,
        parsed.pattern,
        'allow'
      )
    }
    this.statusMessage = `Added ${this.activeColumn}: ${parsed.pattern}`
  }
}

function resolveModalUi(
  opts: OpenPermissionsModalOptions
): ExtensionUI | undefined {
  if (opts.ui && opts.hasUI !== false) return opts.ui
  const bound = getUiContext()
  if (bound?.hasUI && bound.ui) return bound.ui
  return opts.configState.get().ui.noUiAsks === 'bubble'
    ? borrowUi()
    : undefined
}

export async function openPermissionsListModal(
  opts: OpenPermissionsModalOptions
): Promise<boolean> {
  const ui = resolveModalUi(opts)
  if (!ui) return false

  return await withPromptLock(
    () =>
      new Promise<boolean>((resolve) => {
        let settled = false
        const finish = (): void => {
          if (!settled) {
            settled = true
            resolve(true)
          }
        }
        try {
          ui.custom<void>(
            (_tui, theme, _kb, closeOverlay) =>
              new PermissionsListModalView({
                configState: opts.configState,
                sessionRules: opts.sessionRules,
                configPath: opts.configPath,
                theme: theme as GlobalTheme | undefined,
                onClose: () => {
                  closeOverlay()
                  finish()
                },
              }),
            { overlay: false }
          ).catch(finish)
        } catch {
          finish()
        }
      })
  )
}
