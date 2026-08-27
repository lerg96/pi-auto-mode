import { existsSync, mkdirSync, readFileSync, copyFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { parseConfig, type Config } from '../types/config.ts'

export class ConfigLoadError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'ConfigLoadError'
  }
}

export function loadConfig(path: string): Config {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    throw new ConfigLoadError(`Failed to read config at ${path}`, {
      cause: err,
    })
  }
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (err) {
    throw new ConfigLoadError(`Failed to parse config at ${path}`, {
      cause: err,
    })
  }
  try {
    // M4: parseConfig (schema validation) is inside the try so a malformed
    // config surfaces as a ConfigLoadError instead of a raw ZodError — and so
    // index.ts can never silently fall back to an empty default.
    return parseConfig(json)
  } catch (err) {
    throw new ConfigLoadError(`Invalid config schema at ${path}`, {
      cause: err,
    })
  }
}

export function computeSignature(path: string): string | null {
  try {
    const buf = readFileSync(path)
    return createHash('sha1').update(buf).digest('hex')
  } catch {
    return null
  }
}

// ─── Security posture comparison (fail-closed reloads) ──────────
type RestrictiveAction = 'allow' | 'deny' | 'ask'

// Higher = more restrictive. "allow" (0) is the weakest; "deny" (2) the strongest.
function rankAction(a: RestrictiveAction): number {
  switch (a) {
    case 'deny':
      return 2
    case 'ask':
      return 1
    default:
      return 0
  }
}

// Merge every permissionSet's permissions into a single map of most restrictive
// actions per tool/skill/mcp, mirroring how the permission engine resolves conflicts.
function mergeActions(
  sets: Config['permissionSets']
): Map<string, RestrictiveAction> {
  const map = new Map<string, RestrictiveAction>()
  for (const set of Object.values(sets)) {
    const perms = set.permissions
    if (!perms) continue
    for (const namespace of ['tools', 'skills', 'mcps'] as const) {
      const entries = perms[namespace]
      if (!entries) continue
      for (const [key, value] of Object.entries(entries)) {
        const fullKey = `${namespace}|${key}`
        let action: RestrictiveAction
        if (typeof value === 'string') {
          action = value as RestrictiveAction
        } else if (Array.isArray(value) && value.length > 0) {
          // PatternRule[] - use the most restrictive action as representative
          action = value.reduce((a, r) => {
            const ra = rankAction(r.action)
            const rb = rankAction(a)
            return ra >= rb ? r.action : a
          }, 'allow' as RestrictiveAction)
        } else {
          continue
        }
        const existing = map.get(fullKey)
        if (
          existing === undefined ||
          rankAction(action) >= rankAction(existing)
        ) {
          map.set(fullKey, action)
        }
      }
    }
  }
  return map
}

// More restrictive modes rank higher. "ask-user" is the weakest (a human may
// approve), while "auto-retry" and "both" auto-enforce without a human bypass
// and therefore rank stronger. The on-disk alias `deny-and-continue` is
// normalised to `auto-retry` by the schema, so this map never sees the alias.
const MODE_RESTRICTIVENESS: Record<Config['denyStrategy']['mode'], number> = {
  'auto-retry': 2,
  both: 2,
  'ask-user': 1,
}

/**
 * Returns true when `next` is LESS restrictive (weaker) than `prev` — i.e.
 * applying it would weaken the security posture and must be rejected
 * (fail-closed). Used by the config watcher so a tampered file on disk cannot
 * disable the gate at runtime.
 */
export function isSecurityWeakening(prev: Config, next: Config): boolean {
  // 1) The classifier gate was turned off.
  if (prev.classifier.enabled && !next.classifier.enabled) return true

  // 2) The deny strategy was relaxed to a less restrictive mode.
  if (
    MODE_RESTRICTIVENESS[next.denyStrategy.mode] <
    MODE_RESTRICTIVENESS[prev.denyStrategy.mode]
  ) {
    return true
  }

  // 3) Any fail-open fallback ("allow") is a weakening. The parsed
  //    ClassifierConfig type no longer permits "allow" as default, but check
  //    defensively.
  const fb = next.classifier.fallback
  if (fb.onTimeout === 'allow') return true
  if (fb.onError === 'allow') return true

  // 4) An allow injected into permissionSets that overrides a previously
  //    restricted (deny/ask) surface weakens the policy.
  const prevActions = mergeActions(prev.permissionSets)
  for (const [key, action] of mergeActions(next.permissionSets)) {
    const pa = prevActions.get(key)
    if (pa !== undefined && rankAction(action) < rankAction(pa)) return true
  }

  // 5) onBlock downgrade from 'deny' to 'ask' weakens the gate.
  const onBlockRank: Record<string, number> = { deny: 1, ask: 0 }
  if (
    onBlockRank[next.classifier.onBlock ?? 'deny'] <
    onBlockRank[prev.classifier.onBlock ?? 'deny']
  ) {
    return true
  }

  // 6) Increasing escalation thresholds weakens denial enforcement.
  const prevEsc = prev.denyStrategy.escalation
  const nextEsc = next.denyStrategy.escalation
  if (nextEsc.consecutive > prevEsc.consecutive) return true
  if (nextEsc.total > prevEsc.total) return true

  return false
}

export function watchConfig(
  path: string,
  onChange: (cfg: Config) => void,
  onError?: (err: unknown) => void
): () => void {
  let last = computeSignature(path)
  const id = setInterval(() => {
    const sig = computeSignature(path)
    if (sig === null || sig === last) return
    try {
      const cfg = loadConfig(path)
      // H2: re-verify the signature after load to close the TOCTOU window.
      // If the file changed between our signature lock and this point,
      // discard the load (we already locked the old sig so we won't skip it next tick).
      const postSig = computeSignature(path)
      if (postSig === null || postSig !== sig) {
        // File changed during load — discard and retry next tick.
        return
      }
      // H2: lock in the signature only AFTER a successful load+verify. A
      // throwing onChange still locks (no retry loop), but a parse failure
      // below leaves `last` on the last GOOD signature so the next tick
      // re-detects the change and re-attempts the load (B: never silently
      // stuck on stale config).
      last = sig
      onChange(cfg)
    } catch (err) {
      // B) Fail-closed but observable: a parse failure does NOT update `last`,
      // so the watcher retries the next tick. Surface at least one error per
      // detected change so the operator knows why the reload stalled.
      console.error('[watchConfig] failed to load config; will retry:', err)
      onError?.(err)
    }
  }, 500)
  return () => clearInterval(id)
}

// ─── Config path resolution (M4 fail-closed) ──────────────────
export interface ResolveConfigOptions {
  /**
   * Directory where the extension entry point lives. Used as the starting
   * point to locate `config.example.json` (which typically lives at the
   * package root, possibly one or two levels above the entry point).
   */
  extensionDir: string
  /** Optional notifier (may be undefined if no UI is available). */
  notify?: (level: 'info' | 'warning' | 'error', message: string) => void
}

export interface ResolvedConfig {
  /** Final path of the config that will be loaded. */
  path: string
  /** True when the example was copied to the user path (step 3). */
  seeded: boolean
}

/**
 * Walks up from `startDir` looking for the first directory that contains
 * `config.example.json`. Bounded to 6 levels to avoid pathological walks.
 * Returns the absolute path to the example, or null if not found.
 */
function findExampleConfig(startDir: string): string | null {
  let dir = startDir
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, 'config.example.json')
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
  return null
}

/**
 * Resolves the config path in this order:
 *   1) PI_AUTO_MODE_CONFIG env var (absolute or relative to cwd)
 *   2) ~/.pi/pi-auto-mode.json (if it exists)
 *   3) copy config.example.json (shipped with the extension package) to
 *      ~/.pi/pi-auto-mode.json
 *   4) if example is also missing, throws ConfigLoadError
 *
 * The seed step (3) is non-destructive: it never overwrites an existing user
 * config. Returns `{ seeded: true }` so the caller can surface a visible
 * notification once the extension is fully mounted.
 */
export function resolveConfigPath(opts: ResolveConfigOptions): ResolvedConfig {
  const env = process.env.PI_AUTO_MODE_CONFIG
  if (env) {
    return { path: env, seeded: false }
  }
  const userConfig = join(homedir(), '.pi', 'pi-auto-mode.json')
  if (existsSync(userConfig)) {
    return { path: userConfig, seeded: false }
  }
  // Step 3: copy the example shipped with the extension package into the user dir.
  const examplePath = findExampleConfig(opts.extensionDir)
  if (!examplePath) {
    throw new ConfigLoadError(
      `pi-auto-mode: no config found. Tried PI_AUTO_MODE_CONFIG, ${userConfig}, ` +
        `and config.example.json near ${opts.extensionDir} (walked up to 6 levels). ` +
        `Set PI_AUTO_MODE_CONFIG, create ${userConfig}, or ship a config.example.json with the extension.`
    )
  }
  // Make sure ~/.pi exists (mkdirSync recursive is idempotent).
  mkdirSync(dirname(userConfig), { recursive: true })
  copyFileSync(examplePath, userConfig)
  opts.notify?.(
    'info',
    `pi-auto-mode: no config found; seeded ${userConfig} from ${examplePath}. Edit it to customize.`
  )
  return { path: userConfig, seeded: true }
}
