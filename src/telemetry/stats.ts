import { promises as fsPromises } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { buildSessionPatterns } from '../permission/command-prefix.ts'

export interface TopPromptEntry {
  pattern: string
  count: number
  sample: string
}

export interface TelemetryStats {
  totalDecisions: number
  ruleAllow: number
  sessionAllow: number
  classifierAllow: number
  userPrompts: number
  userPromptsByRule: number
  userPromptsByClassifier: number
  userDenied: number
  hardDenied: number
  other: number
  llmOk: number
  llmErr: number
  llmAvgMs: number
  cacheHits: number
  topPrompts: TopPromptEntry[]
  telemetryMissing: boolean
}

export interface StatsOptions {
  limit?: number
  topN?: number
}

const DEFAULT_LIMIT = 1000
const DEFAULT_TOP_N = 8

function expandHome(filePath: string): string {
  if (filePath === '~') return homedir()
  if (filePath.startsWith('~/') || filePath.startsWith('~\\')) {
    return join(homedir(), filePath.slice(2))
  }
  return filePath
}

function tailLines(content: string, limit: number): string[] {
  const trimmed = content.trim()
  if (!trimmed) return []
  const all = trimmed.split(/\r?\n/)
  return all.length > limit ? all.slice(-limit) : all
}

function summarizePromptKey(surface: string, value: string): string {
  const compact = value.replace(/\s+/g, ' ').trim()
  if (!compact) return `${surface}:*`
  if (surface === 'shell') {
    const patterns = buildSessionPatterns(compact)
    return (
      patterns.find((p) => p.endsWith(' *')) ??
      patterns[0] ??
      compact.slice(0, 60)
    )
  }
  return `${surface}:${compact.slice(0, 60)}`
}

export function parseTelemetryStats(
  telemetryContent: string,
  debugContent = '',
  opts: StatsOptions = {}
): TelemetryStats {
  const limit = Math.max(1, Math.min(50000, opts.limit ?? DEFAULT_LIMIT))
  const topN = Math.max(1, Math.min(30, opts.topN ?? DEFAULT_TOP_N))

  const stats: TelemetryStats = {
    totalDecisions: 0,
    ruleAllow: 0,
    sessionAllow: 0,
    classifierAllow: 0,
    userPrompts: 0,
    userPromptsByRule: 0,
    userPromptsByClassifier: 0,
    userDenied: 0,
    hardDenied: 0,
    other: 0,
    llmOk: 0,
    llmErr: 0,
    llmAvgMs: 0,
    cacheHits: 0,
    topPrompts: [],
    telemetryMissing: false,
  }

  const promptCounts = new Map<string, { count: number; sample: string }>()

  for (const line of tailLines(telemetryContent, limit)) {
    let parsed: { type?: string; payload?: Record<string, unknown> }
    try {
      parsed = JSON.parse(line) as {
        type?: string
        payload?: Record<string, unknown>
      }
    } catch {
      continue
    }
    if (parsed.type !== 'permissions:decision' || !parsed.payload) continue

    const p = parsed.payload
    const resolution = String(p.resolution ?? '')
    const result = String(p.result ?? '')
    const decidedBy = String(p.decidedBy ?? '')
    const surface = String(p.surface ?? 'unknown')
    const value = String(p.value ?? '')

    stats.totalDecisions++

    if (decidedBy === 'user') {
      stats.userPrompts++
      if (resolution === 'classifier_ask') stats.userPromptsByClassifier++
      else stats.userPromptsByRule++
      if (result === 'deny') stats.userDenied++

      const key = summarizePromptKey(surface, value)
      const prev = promptCounts.get(key)
      if (prev) {
        prev.count++
      } else {
        promptCounts.set(key, {
          count: 1,
          sample: value.replace(/\s+/g, ' ').trim().slice(0, 80),
        })
      }
    } else if (resolution === 'allow' && decidedBy === 'rule') {
      stats.ruleAllow++
    } else if (resolution === 'session_allow' || decidedBy === 'session') {
      stats.sessionAllow++
    } else if (
      resolution === 'classifier_allow' ||
      (decidedBy === 'classifier' && result === 'allow')
    ) {
      stats.classifierAllow++
    } else if (result === 'deny') {
      stats.hardDenied++
    } else {
      stats.other++
    }
  }

  stats.topPrompts = Array.from(promptCounts.entries())
    .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
    .slice(0, topN)
    .map(([pattern, info]) => ({
      pattern,
      count: info.count,
      sample: info.sample,
    }))

  let totalMs = 0
  for (const line of tailLines(debugContent, limit)) {
    let parsed: { type?: string; payload?: Record<string, unknown> }
    try {
      parsed = JSON.parse(line) as {
        type?: string
        payload?: Record<string, unknown>
      }
    } catch {
      continue
    }
    if (parsed.type === 'llm:attempt' && parsed.payload) {
      if (parsed.payload.ok === true) {
        stats.llmOk++
        if (typeof parsed.payload.elapsedMs === 'number') {
          totalMs += parsed.payload.elapsedMs
        }
      } else {
        stats.llmErr++
      }
    } else if (parsed.type === 'classifier:cache_hit') {
      stats.cacheHits++
    }
  }
  if (stats.llmOk > 0) {
    stats.llmAvgMs = Math.round(totalMs / stats.llmOk)
  }

  return stats
}

export async function readTelemetryStats(
  telemetryPath: string,
  debugPath?: string,
  opts: StatsOptions = {}
): Promise<TelemetryStats> {
  let telemetryContent = ''
  let telemetryMissing = false
  try {
    telemetryContent = await fsPromises.readFile(
      expandHome(telemetryPath),
      'utf8'
    )
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      telemetryMissing = true
    } else {
      throw err
    }
  }

  let debugContent = ''
  if (debugPath) {
    try {
      debugContent = await fsPromises.readFile(expandHome(debugPath), 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        throw err
      }
    }
  }

  const stats = parseTelemetryStats(telemetryContent, debugContent, opts)
  stats.telemetryMissing = telemetryMissing
  return stats
}

function pct(n: number, total: number): string {
  if (total <= 0) return '0%'
  return `${Math.round((n / total) * 100)}%`
}

export function formatTelemetryStats(stats: TelemetryStats): string {
  if (stats.telemetryMissing) {
    return 'No telemetry log found yet (enable telemetry.enabled in config).'
  }
  if (stats.totalDecisions === 0) {
    return 'No permission decisions recorded in telemetry log yet.'
  }

  const t = stats.totalDecisions
  const lines: string[] = [
    `Auto-mode stats (last ${t} decision${t === 1 ? '' : 's'}):`,
    `  allow (rule):      ${stats.ruleAllow} (${pct(stats.ruleAllow, t)})`,
    `  classifier_allow:  ${stats.classifierAllow} (${pct(stats.classifierAllow, t)})`,
    `  session_allow:     ${stats.sessionAllow} (${pct(stats.sessionAllow, t)})`,
    `  user prompts:      ${stats.userPrompts} (${pct(stats.userPrompts, t)}) [rule: ${stats.userPromptsByRule}, classifier: ${stats.userPromptsByClassifier}, denied: ${stats.userDenied}]`,
  ]
  if (stats.hardDenied > 0) {
    lines.push(
      `  hard deny:         ${stats.hardDenied} (${pct(stats.hardDenied, t)})`
    )
  }

  const llmTotal = stats.llmOk + stats.llmErr
  if (llmTotal > 0 || stats.cacheHits > 0) {
    const cacheTotal = llmTotal + stats.cacheHits
    lines.push(
      `  classifier calls:  ${stats.llmOk} ok, ${stats.llmErr} err, avg ${stats.llmAvgMs}ms, cache hits: ${stats.cacheHits} (${pct(stats.cacheHits, cacheTotal)})`
    )
  }

  if (stats.topPrompts.length > 0) {
    lines.push('Top user prompts:')
    for (const entry of stats.topPrompts) {
      lines.push(`  ${entry.count}x ${entry.pattern}`)
    }
  }

  return lines.join('\n')
}
