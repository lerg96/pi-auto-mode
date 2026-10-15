import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { parseConfig } from '../types/config.ts'
import { configState } from '../state/config-state.ts'

export interface PersistPermanentAllowArgs {
  surface: string
  pattern: string
  toolName?: string
  configPath?: string
  isExternalDir?: boolean
}

export function persistPermanentAllow(args: PersistPermanentAllowArgs): void {
  const targetPath =
    args.configPath ??
    process.env.PI_AUTO_MODE_CONFIG ??
    join(homedir(), '.pi', 'pi-auto-mode.json')

  let rawJson: Record<string, unknown> = {}
  if (existsSync(targetPath)) {
    const content = readFileSync(targetPath, 'utf8')
    rawJson = JSON.parse(content) as Record<string, unknown>
  }

  if (
    !rawJson.permissions ||
    typeof rawJson.permissions !== 'object' ||
    Array.isArray(rawJson.permissions)
  ) {
    rawJson.permissions = {}
  }
  const permissions = rawJson.permissions as Record<string, unknown>

  const isExternal =
    args.isExternalDir ||
    args.surface === 'external_directory' ||
    args.surface.startsWith('external_dir:')

  if (isExternal) {
    if (
      !permissions.external_directory ||
      typeof permissions.external_directory !== 'object' ||
      Array.isArray(permissions.external_directory)
    ) {
      permissions.external_directory = {}
    }
    const extDir = permissions.external_directory as Record<string, string>
    extDir[args.pattern] = 'allow'
  } else {
    const toolKey = args.toolName ?? args.surface
    if (
      !permissions.tools ||
      typeof permissions.tools !== 'object' ||
      Array.isArray(permissions.tools)
    ) {
      permissions.tools = {}
    }
    const tools = permissions.tools as Record<string, unknown>
    const current = tools[toolKey]

    if (Array.isArray(current)) {
      const alreadyPresent = current.some(
        (r: unknown) =>
          typeof r === 'object' &&
          r !== null &&
          (r as { pattern?: unknown; action?: unknown }).pattern ===
            args.pattern &&
          (r as { pattern?: unknown; action?: unknown }).action === 'allow'
      )
      if (!alreadyPresent) {
        tools[toolKey] = [
          { pattern: args.pattern, action: 'allow' },
          ...current,
        ]
      }
    } else if (typeof current === 'string') {
      tools[toolKey] = [
        { pattern: args.pattern, action: 'allow' },
        { pattern: '*', action: current },
      ]
    } else {
      tools[toolKey] = [{ pattern: args.pattern, action: 'allow' }]
    }
  }

  const newConfig = parseConfig(rawJson)

  mkdirSync(dirname(targetPath), { recursive: true })
  writeFileSync(targetPath, JSON.stringify(rawJson, null, 2) + '\n')

  configState.set(newConfig)
}
