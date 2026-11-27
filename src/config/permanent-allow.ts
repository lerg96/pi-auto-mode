import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import {
  parseConfig,
  type Config,
  type PermissionsBlock,
  type SimpleAction,
} from '../types/config.ts'
import { configState } from '../state/config-state.ts'

export interface PermanentPermissionEntry {
  surface: 'tools' | 'external_directory'
  toolName: string
  pattern: string
  action: SimpleAction
  source: string
}

export interface PersistPermanentAllowArgs {
  surface: string
  pattern: string
  toolName?: string
  configPath?: string
  isExternalDir?: boolean
}

function isPlainObject(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val)
}

export function listPermanentPermissions(
  cfg: Config
): PermanentPermissionEntry[] {
  const result: PermanentPermissionEntry[] = []
  const seen = new Set<string>()

  const sources: Array<{ source: string; permissions?: PermissionsBlock }> = [
    { source: 'global', permissions: cfg.permissions },
  ]

  if (Array.isArray(cfg.activePermissionSets)) {
    for (const setId of cfg.activePermissionSets) {
      if (cfg.permissionSets && cfg.permissionSets[setId]) {
        sources.push({
          source: setId,
          permissions: cfg.permissionSets[setId].permissions,
        })
      }
    }
  }

  for (const { source, permissions } of sources) {
    if (!permissions) continue

    const tools = permissions.tools ?? {}
    for (const [toolName, val] of Object.entries(tools)) {
      if (typeof val === 'string') {
        const key = `tools::${toolName}::*::${val}`
        if (!seen.has(key)) {
          seen.add(key)
          result.push({
            surface: 'tools',
            toolName,
            pattern: '*',
            action: val,
            source,
          })
        }
      } else if (Array.isArray(val)) {
        for (const r of val) {
          const key = `tools::${toolName}::${r.pattern}::${r.action}`
          if (!seen.has(key)) {
            seen.add(key)
            result.push({
              surface: 'tools',
              toolName,
              pattern: r.pattern,
              action: r.action,
              source,
            })
          }
        }
      }
    }

    const extDir = permissions.external_directory ?? {}
    for (const [pattern, action] of Object.entries(extDir)) {
      const key = `external_directory::external_directory::${pattern}::${action}`
      if (!seen.has(key)) {
        seen.add(key)
        result.push({
          surface: 'external_directory',
          toolName: 'external_directory',
          pattern,
          action,
          source,
        })
      }
    }
  }

  return result
}

function prependToolAllowRule(
  tools: Record<string, unknown>,
  toolKey: string,
  pattern: string
): void {
  const current = tools[toolKey]

  if (Array.isArray(current)) {
    const alreadyPresent = current.some(
      (r: unknown) =>
        typeof r === 'object' &&
        r !== null &&
        (r as { pattern?: unknown; action?: unknown }).pattern === pattern &&
        (r as { pattern?: unknown; action?: unknown }).action === 'allow'
    )
    if (!alreadyPresent) {
      tools[toolKey] = [{ pattern, action: 'allow' }, ...current]
    }
  } else if (typeof current === 'string') {
    tools[toolKey] = [
      { pattern, action: 'allow' },
      { pattern: '*', action: current },
    ]
  } else {
    tools[toolKey] = [{ pattern, action: 'allow' }]
  }
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

    if (
      Array.isArray(rawJson.activePermissionSets) &&
      isPlainObject(rawJson.permissionSets)
    ) {
      const pSets = rawJson.permissionSets
      for (const setId of rawJson.activePermissionSets) {
        if (typeof setId === 'string') {
          const setObj = pSets[setId]
          if (isPlainObject(setObj) && isPlainObject(setObj.permissions)) {
            const setExtDir = setObj.permissions.external_directory
            if (
              isPlainObject(setExtDir) &&
              setExtDir[args.pattern] !== undefined
            ) {
              setExtDir[args.pattern] = 'allow'
            }
          }
        }
      }
    }
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
    prependToolAllowRule(tools, toolKey, args.pattern)

    if (
      Array.isArray(rawJson.activePermissionSets) &&
      isPlainObject(rawJson.permissionSets)
    ) {
      const pSets = rawJson.permissionSets
      for (const setId of rawJson.activePermissionSets) {
        if (typeof setId === 'string') {
          const setObj = pSets[setId]
          if (isPlainObject(setObj) && isPlainObject(setObj.permissions)) {
            const setTools = setObj.permissions.tools
            if (isPlainObject(setTools) && setTools[toolKey] !== undefined) {
              prependToolAllowRule(setTools, toolKey, args.pattern)
            }
          }
        }
      }
    }
  }

  const newConfig = parseConfig(rawJson)

  mkdirSync(dirname(targetPath), { recursive: true })
  writeFileSync(targetPath, JSON.stringify(rawJson, null, 2) + '\n')

  configState.set(newConfig)
}

export function removePermanentAllow(args: PersistPermanentAllowArgs): boolean {
  const targetPath =
    args.configPath ??
    process.env.PI_AUTO_MODE_CONFIG ??
    join(homedir(), '.pi', 'pi-auto-mode.json')

  let rawJson: Record<string, unknown>
  if (existsSync(targetPath)) {
    const content = readFileSync(targetPath, 'utf8')
    rawJson = JSON.parse(content) as Record<string, unknown>
  } else {
    rawJson = structuredClone(configState.get()) as unknown as Record<
      string,
      unknown
    >
  }

  let removed = false

  const isExternal =
    args.isExternalDir ||
    args.surface === 'external_directory' ||
    args.surface.startsWith('external_dir:')

  const targetSets: Array<Record<string, unknown>> = []
  if (isPlainObject(rawJson.permissionSets)) {
    const pSets = rawJson.permissionSets
    if (Array.isArray(rawJson.activePermissionSets)) {
      for (const setId of rawJson.activePermissionSets) {
        if (typeof setId === 'string' && isPlainObject(pSets[setId])) {
          targetSets.push(pSets[setId] as Record<string, unknown>)
        }
      }
    }
    for (const setObj of Object.values(pSets)) {
      if (
        isPlainObject(setObj) &&
        !targetSets.includes(setObj as Record<string, unknown>)
      ) {
        targetSets.push(setObj as Record<string, unknown>)
      }
    }
  }

  if (isExternal) {
    if (
      isPlainObject(rawJson.permissions) &&
      isPlainObject(rawJson.permissions.external_directory)
    ) {
      const extDir = rawJson.permissions.external_directory as Record<
        string,
        unknown
      >
      if (args.pattern in extDir) {
        delete extDir[args.pattern]
        removed = true
      }
    }

    for (const setObj of targetSets) {
      if (isPlainObject(setObj.permissions)) {
        const setExtDir = (setObj.permissions as Record<string, unknown>)
          .external_directory
        if (isPlainObject(setExtDir) && args.pattern in setExtDir) {
          delete (setExtDir as Record<string, unknown>)[args.pattern]
          removed = true
        }
      }
    }
  } else {
    const toolKey = args.toolName ?? args.surface

    const removeToolRuleFrom = (
      toolsObj: Record<string, unknown>,
      key: string,
      pattern: string
    ): void => {
      const current = toolsObj[key]
      if (Array.isArray(current)) {
        const beforeLen = current.length
        const filtered = current.filter(
          (r: unknown) =>
            !(
              isPlainObject(r) &&
              (r as { pattern?: unknown }).pattern === pattern
            )
        )
        if (filtered.length < beforeLen) {
          removed = true
          if (filtered.length === 0) {
            delete toolsObj[key]
          } else {
            toolsObj[key] = filtered
          }
        }
      } else if (typeof current === 'string' && pattern === '*') {
        delete toolsObj[key]
        removed = true
      }
    }

    if (
      isPlainObject(rawJson.permissions) &&
      isPlainObject(rawJson.permissions.tools)
    ) {
      removeToolRuleFrom(
        rawJson.permissions.tools as Record<string, unknown>,
        toolKey,
        args.pattern
      )
    }

    for (const setObj of targetSets) {
      if (isPlainObject(setObj.permissions)) {
        const setTools = (setObj.permissions as Record<string, unknown>).tools
        if (isPlainObject(setTools)) {
          removeToolRuleFrom(
            setTools as Record<string, unknown>,
            toolKey,
            args.pattern
          )
        }
      }
    }
  }

  if (!removed) {
    return false
  }

  const newConfig = parseConfig(rawJson)

  if (existsSync(targetPath) || args.configPath !== undefined) {
    mkdirSync(dirname(targetPath), { recursive: true })
    writeFileSync(targetPath, JSON.stringify(rawJson, null, 2) + '\n')
  }

  configState.set(newConfig)
  return true
}
