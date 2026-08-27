import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import type { Config } from '../types/config.ts'
import { composeActiveSets } from '../permission/compose.ts'
import { getAskResolver } from '../gate/ask.ts'
import type { configState } from '../state/config-state.ts'

// H7: changing `activePermissionSets` is a privileged, runtime elevation of privileges.
// We reuse the same ask-resolver the gate uses (getAskResolver) so the user
// must explicitly confirm before any permission set is activated/deactivated.
async function confirmActiveSetChange(
  action: 'activate' | 'deactivate',
  name: string
): Promise<boolean> {
  try {
    const decision = await getAskResolver()({
      surface: `permission-set:${action}`,
      value: name,
      risk: {
        score: 100,
        level: 'high',
        reason: `Privileged change: ${action} permission set '${name}'`,
      },
    })
    return decision === 'allow' || decision === 'allow_session'
  } catch {
    return false
  }
}

export type SetChange =
  | { ok: true; activeSets: string[]; already: boolean }
  | { ok: false; reason: string }

export function activateSet(config: Config, name: string): SetChange {
  if (!(name in config.permissionSets)) {
    return { ok: false, reason: `unknown permission set: '${name}'` }
  }
  if (config.activePermissionSets.includes(name)) {
    return { ok: true, activeSets: config.activePermissionSets, already: true }
  }
  return {
    ok: true,
    activeSets: [...new Set([...config.activePermissionSets, name])],
    already: false,
  }
}

export function deactivateSet(config: Config, name: string): SetChange {
  if (!(name in config.permissionSets)) {
    return { ok: false, reason: `unknown permission set: '${name}'` }
  }
  if (!config.activePermissionSets.includes(name)) {
    return { ok: true, activeSets: config.activePermissionSets, already: true }
  }
  return {
    ok: true,
    activeSets: config.activePermissionSets.filter((n: string) => n !== name),
    already: false,
  }
}

export function formatSets(config: Config): string {
  const composed = composeActiveSets(config.activePermissionSets, config)
  const lines = Object.keys(config.permissionSets).map((n) => {
    const mark = config.activePermissionSets.includes(n) ? '[x]' : '[ ]'
    return `  ${mark} ${n}`
  })
  lines.push(`  activeRules=${composed.length}`)
  return lines.join('\n')
}

export type Mode = 'default' | 'strict' | 'yolo'

export const MODES: readonly Mode[] = ['default', 'strict', 'yolo'] as const

export type ModeChange =
  { ok: true; mode: Mode; already: boolean } | { ok: false; reason: string }

export function setMode(config: Config, mode: string): ModeChange {
  if (!(MODES as readonly string[]).includes(mode)) {
    return {
      ok: false,
      reason: `unknown mode: '${mode}' (expected one of: ${MODES.join(', ')})`,
    }
  }
  const m = mode as Mode
  if (config.mode === m) {
    return { ok: true, mode: m, already: true }
  }
  return { ok: true, mode: m, already: false }
}

export function registerSetCommands(
  pi: ExtensionAPI,
  state: typeof configState
): void {
  pi.registerCommand('auto-mode:sets', {
    description:
      'Activate/deactivate permission sets at runtime. Usage: activate <name> | deactivate <name> | list',
    handler: async (args, ctx) => {
      const [cmd, name] = args.trim().split(/\s+/)
      if (cmd === 'activate' && name) {
        const res = activateSet(state.get(), name)
        if (!res.ok) {
          ctx.ui?.notify(res.reason, 'error')
          return
        }
        if (!res.already) {
          const ok = await confirmActiveSetChange('activate', name)
          if (!ok) {
            ctx.ui?.notify(
              `Activation of permission set '${name}' requires confirmation.`,
              'warning'
            )
            return
          }
        }
        state.setActiveSets(res.activeSets)
        ctx.ui?.notify(
          res.already
            ? `Set '${name}' already active.`
            : `Set '${name}' activated.`,
          'info'
        )
      } else if (cmd === 'deactivate' && name) {
        const res = deactivateSet(state.get(), name)
        if (!res.ok) {
          ctx.ui?.notify(res.reason, 'error')
          return
        }
        if (!res.already) {
          const ok = await confirmActiveSetChange('deactivate', name)
          if (!ok) {
            ctx.ui?.notify(
              `Deactivation of permission set '${name}' requires confirmation.`,
              'warning'
            )
            return
          }
        }
        state.setActiveSets(res.activeSets)
        ctx.ui?.notify(
          res.already
            ? `Set '${name}' not active.`
            : `Set '${name}' deactivated.`,
          'info'
        )
      } else if (cmd === 'list') {
        ctx.ui?.notify(formatSets(state.get()), 'info')
      } else {
        ctx.ui?.notify(
          'Usage: auto-mode:sets [activate|deactivate] <name> | list',
          'warning'
        )
      }
    },
    getArgumentCompletions: (prefix: string) =>
      Object.keys(state.get().permissionSets)
        .filter((n) => n.startsWith(prefix))
        .map((n) => ({ value: n, label: n, description: 'permission set' })),
  })

  // Capa 1: global visibility mode. Changing it is a privileged runtime
  // elevation, so we route the change through the same ask-resolver the gate
  // uses (mirrors the existing `activate` / `deactivate` confirmation flow).
  pi.registerCommand('auto-mode:mode', {
    description:
      'Switch visibility mode at runtime. Usage: default | strict | yolo',
    handler: async (args, ctx) => {
      const requested = args.trim()
      const res = setMode(state.get(), requested)
      if (!res.ok) {
        ctx.ui?.notify(res.reason, 'error')
        return
      }
      if (res.already) {
        ctx.ui?.notify(`Mode already '${res.mode}'.`, 'info')
        return
      }
      const ok = await confirmActiveSetChange('activate', `mode:${res.mode}`)
      if (!ok) {
        ctx.ui?.notify(
          `Mode change to '${res.mode}' requires confirmation.`,
          'warning'
        )
        return
      }
      state.setMode(res.mode)
      ctx.ui?.notify(`Mode set to '${res.mode}'.`, 'info')
    },
    getArgumentCompletions: (prefix: string) =>
      MODES.filter((m) => m.startsWith(prefix)).map((m) => ({
        value: m,
        label: m,
        description:
          m === 'default'
            ? 'honour permission sets verbatim'
            : m === 'strict'
              ? 'ask -> deny (no interactive prompts)'
              : 'ask -> allow (explicit deny still wins)',
      })),
  })
}
