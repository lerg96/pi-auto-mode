import { promises as fsPromises } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { DEFAULT_TELEMETRY_PATH } from '../types/config.ts'

export interface DatasetMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface DatasetExample {
  id: string
  messages: [DatasetMessage, DatasetMessage, DatasetMessage]
  metadata: {
    ts: string
    toolName: string
    surface: string
    decision: 'allow' | 'block' | 'ask'
    source: 'user' | 'user_override' | 'classifier' | 'rule' | 'session'
    resolution: string
    userVerdict?: string
    classifierDecision?: string
  }
}

export interface ExportDatasetOptions {
  /** Max ratio of auto/rule 'allow' examples to non-allow/human examples. Default: 3. Set to Infinity to disable balancing. */
  maxAllowRatio?: number
  /** System prompt to include in ChatML messages[0]. */
  systemPrompt?: string
}

export interface ExportDatasetStats {
  totalLines: number
  validDecisions: number
  skippedNoise: number
  deduplicated: number
  exported: number
  byDecision: { allow: number; block: number; ask: number }
  bySource: {
    user: number
    user_override: number
    classifier: number
    rule: number
    session: number
  }
}

const DEFAULT_SYSTEM_PROMPT =
  'You are a security classifier for an AI coding agent. Decide allow/block/ask for the proposed tool call and return strict JSON: {"decision":"allow"|"block"|"ask","riskScore":0-10,"riskReason":"...","category":"..."}.'

const SOURCE_RANK: Record<DatasetExample['metadata']['source'], number> = {
  user_override: 5,
  user: 4,
  classifier: 3,
  session: 2,
  rule: 1,
}

interface RawDecisionPayload {
  surface?: unknown
  value?: unknown
  result?: unknown
  resolution?: unknown
  requestId?: unknown
  decidedBy?: unknown
  userVerdict?: unknown
  denialReason?: unknown
  detail?: {
    matchedValue?: unknown
    toolName?: unknown
    fullCommand?: unknown
    cwd?: unknown
    risk?: {
      score?: unknown
      reason?: unknown
      category?: unknown
      decision?: unknown
    }
    rule?: {
      reason?: unknown
      pattern?: unknown
    }
  }
}

interface RawTelemetryEvent {
  ts?: unknown
  type?: unknown
  payload?: unknown
}

export function exportDatasetFromLines(
  lines: string[],
  opts?: ExportDatasetOptions
): { examples: DatasetExample[]; stats: ExportDatasetStats } {
  const stats: ExportDatasetStats = {
    totalLines: lines.length,
    validDecisions: 0,
    skippedNoise: 0,
    deduplicated: 0,
    exported: 0,
    byDecision: { allow: 0, block: 0, ask: 0 },
    bySource: {
      user: 0,
      user_override: 0,
      classifier: 0,
      rule: 0,
      session: 0,
    },
  }

  const systemPrompt = opts?.systemPrompt ?? DEFAULT_SYSTEM_PROMPT
  const dedupMap = new Map<string, DatasetExample>()

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) {
      continue
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      stats.skippedNoise++
      continue
    }

    if (typeof parsed !== 'object' || parsed === null) {
      stats.skippedNoise++
      continue
    }

    const event = parsed as RawTelemetryEvent
    if (
      event.type !== 'permissions:decision' ||
      typeof event.payload !== 'object' ||
      event.payload === null
    ) {
      stats.skippedNoise++
      continue
    }

    const payload = event.payload as RawDecisionPayload
    const surface = typeof payload.surface === 'string' ? payload.surface : ''
    const value = typeof payload.value === 'string' ? payload.value : ''
    const result = typeof payload.result === 'string' ? payload.result : ''
    const resolution =
      typeof payload.resolution === 'string' ? payload.resolution : ''
    const decidedBy =
      typeof payload.decidedBy === 'string' ? payload.decidedBy : ''
    const userVerdict =
      typeof payload.userVerdict === 'string' ? payload.userVerdict : undefined
    const denialReason =
      typeof payload.denialReason === 'string'
        ? payload.denialReason
        : undefined
    const detail = payload.detail

    if (
      decidedBy === 'timeout' ||
      decidedBy === 'no-ui' ||
      resolution === 'yolo_bypass'
    ) {
      stats.skippedNoise++
      continue
    }

    const matchedValue =
      typeof detail?.matchedValue === 'string' && detail.matchedValue.length > 0
        ? detail.matchedValue
        : value
    const toolName =
      typeof detail?.toolName === 'string' && detail.toolName.length > 0
        ? detail.toolName
        : surface || 'tool'

    if (
      !matchedValue ||
      matchedValue === '[REDACTED]' ||
      value === '[REDACTED]'
    ) {
      stats.skippedNoise++
      continue
    }

    const riskCategory =
      typeof detail?.risk?.category === 'string'
        ? detail.risk.category
        : undefined
    if (riskCategory === 'error' && decidedBy !== 'user') {
      stats.skippedNoise++
      continue
    }

    let source: DatasetExample['metadata']['source']
    let decision: 'allow' | 'block' | 'ask'
    let riskScore: number
    let riskReason: string
    let category: string

    if (decidedBy === 'user') {
      source =
        resolution === 'classifier_block_override' ? 'user_override' : 'user'
      if (result === 'deny') {
        decision = 'block'
        const rawScore = detail?.risk?.score
        riskScore = typeof rawScore === 'number' && rawScore >= 7 ? rawScore : 9
        const riskReasonCandidate =
          typeof detail?.risk?.reason === 'string'
            ? detail.risk.reason
            : undefined
        const ruleReasonCandidate =
          typeof detail?.rule?.reason === 'string'
            ? detail.rule.reason
            : undefined
        riskReason =
          denialReason ||
          riskReasonCandidate ||
          ruleReasonCandidate ||
          'Denied by user in confirmation modal'
        category = riskCategory || 'user_denied'
      } else if (result === 'allow') {
        decision = 'allow'
        riskScore = 1
        riskReason =
          resolution === 'classifier_block_override'
            ? 'User overrode classifier block and approved command as safe'
            : 'User approved command as safe'
        category = 'safe'
      } else {
        stats.skippedNoise++
        continue
      }
    } else if (
      resolution === 'classifier_block' ||
      decidedBy === 'classifier'
    ) {
      source = 'classifier'
      decision = 'block'
      const rawScore = detail?.risk?.score
      riskScore = typeof rawScore === 'number' ? rawScore : 9
      riskReason =
        typeof detail?.risk?.reason === 'string' &&
        detail.risk.reason.length > 0
          ? detail.risk.reason
          : 'Blocked by security classifier'
      category = riskCategory || 'security'
    } else if (
      decidedBy === 'rule' ||
      decidedBy === 'session' ||
      resolution === 'allow' ||
      resolution === 'session_allow' ||
      resolution === 'deny_and_continue' ||
      resolution === 'escalate'
    ) {
      source =
        decidedBy === 'session' || resolution === 'session_allow'
          ? 'session'
          : 'rule'
      if (result === 'deny') {
        decision = 'block'
        riskScore = 9
        riskReason =
          typeof detail?.rule?.reason === 'string' &&
          detail.rule.reason.length > 0
            ? detail.rule.reason
            : 'Blocked by permission deny rule'
        category = 'policy_deny'
      } else if (result === 'allow') {
        decision = 'allow'
        riskScore = 1
        riskReason =
          typeof detail?.rule?.reason === 'string' &&
          detail.rule.reason.length > 0
            ? detail.rule.reason
            : 'Allowed by permission rule'
        category = 'safe'
      } else {
        stats.skippedNoise++
        continue
      }
    } else {
      stats.skippedNoise++
      continue
    }

    stats.validDecisions++

    const classifierDecision =
      typeof detail?.risk?.decision === 'string'
        ? detail.risk.decision
        : resolution === 'classifier_block_override' ||
            resolution === 'classifier_block' ||
            decidedBy === 'classifier'
          ? 'block'
          : undefined

    const fullCommand =
      typeof detail?.fullCommand === 'string' ? detail.fullCommand : undefined

    let argsObj: Record<string, unknown>
    if (
      surface === 'shell' ||
      toolName === 'bash' ||
      toolName === 'powershell'
    ) {
      argsObj = { command: fullCommand ?? matchedValue }
    } else if (surface === 'fs') {
      argsObj = { path: matchedValue }
    } else {
      argsObj = { value: matchedValue }
    }

    const promptLines = [`Tool: ${toolName}`, `Surface: ${surface}`]
    if (typeof detail?.cwd === 'string' && detail.cwd.trim().length > 0) {
      promptLines.push(`WorkingDirectory: ${detail.cwd.trim()}`)
    }
    promptLines.push(`Arguments: ${JSON.stringify(argsObj)}`)
    promptLines.push(`Value: ${matchedValue}`)
    const userPrompt = promptLines.join('\n')

    const assistantContent = JSON.stringify({
      decision,
      riskScore,
      riskReason,
      category,
    })

    const ts =
      typeof event.ts === 'string' ? event.ts : new Date().toISOString()
    const requestId =
      typeof payload.requestId === 'string' && payload.requestId.length > 0
        ? payload.requestId
        : undefined

    const exampleId =
      requestId ??
      `ex_${createHash('sha256')
        .update(`${ts}|${toolName}|${surface}|${matchedValue}`)
        .digest('hex')
        .slice(0, 16)}`

    const example: DatasetExample = {
      id: exampleId,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
        { role: 'assistant', content: assistantContent },
      ],
      metadata: {
        ts,
        toolName,
        surface,
        decision,
        source,
        resolution,
        ...(userVerdict ? { userVerdict } : {}),
        ...(classifierDecision ? { classifierDecision } : {}),
      },
    }

    const dedupKey = `${toolName}|${surface}|${matchedValue}`
    const existing = dedupMap.get(dedupKey)

    if (!existing) {
      dedupMap.set(dedupKey, example)
    } else {
      stats.deduplicated++
      const existingRank = SOURCE_RANK[existing.metadata.source]
      const newRank = SOURCE_RANK[example.metadata.source]

      if (newRank > existingRank) {
        dedupMap.set(dedupKey, example)
      } else if (newRank === existingRank) {
        const existingTs = new Date(existing.metadata.ts).getTime()
        const newTs = new Date(example.metadata.ts).getTime()
        if (newTs >= existingTs) {
          dedupMap.set(dedupKey, example)
        }
      }
    }
  }

  const maxAllowRatio = opts?.maxAllowRatio ?? 3
  const deduplicatedList = Array.from(dedupMap.values())
  const highValue: DatasetExample[] = []
  const routineAllows: DatasetExample[] = []

  for (const ex of deduplicatedList) {
    if (
      ex.metadata.decision === 'block' ||
      ex.metadata.decision === 'ask' ||
      ex.metadata.source === 'user' ||
      ex.metadata.source === 'user_override'
    ) {
      highValue.push(ex)
    } else if (
      ex.metadata.decision === 'allow' &&
      (ex.metadata.source === 'rule' || ex.metadata.source === 'session')
    ) {
      routineAllows.push(ex)
    } else {
      highValue.push(ex)
    }
  }

  let cappedRoutine = routineAllows
  if (Number.isFinite(maxAllowRatio) && highValue.length > 0) {
    const cap = Math.max(10, Math.floor(highValue.length * maxAllowRatio))
    if (routineAllows.length > cap) {
      routineAllows.sort(
        (a, b) =>
          new Date(b.metadata.ts).getTime() - new Date(a.metadata.ts).getTime()
      )
      cappedRoutine = routineAllows.slice(0, cap)
    }
  }

  const finalExamples = [...highValue, ...cappedRoutine]
  finalExamples.sort(
    (a, b) =>
      new Date(a.metadata.ts).getTime() - new Date(b.metadata.ts).getTime()
  )

  stats.exported = finalExamples.length
  for (const ex of finalExamples) {
    stats.byDecision[ex.metadata.decision]++
    stats.bySource[ex.metadata.source]++
  }

  return { examples: finalExamples, stats }
}

export async function exportDatasetFile(
  inputPath?: string,
  outputPath?: string,
  opts?: ExportDatasetOptions
): Promise<ExportDatasetStats> {
  const resolvedInput = inputPath ?? DEFAULT_TELEMETRY_PATH
  const resolvedOutput =
    outputPath ?? join(homedir(), '.pi', 'pi-auto-mode.dataset.jsonl')

  let content: string
  try {
    content = await fsPromises.readFile(resolvedInput, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      const { stats } = exportDatasetFromLines([], opts)
      await fsPromises.mkdir(dirname(resolvedOutput), { recursive: true })
      await fsPromises.writeFile(resolvedOutput, '', 'utf8')
      return stats
    }
    throw err
  }

  const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0)
  const { examples, stats } = exportDatasetFromLines(lines, opts)

  await fsPromises.mkdir(dirname(resolvedOutput), { recursive: true })
  const outputContent =
    examples.map((ex) => JSON.stringify(ex)).join('\n') +
    (examples.length > 0 ? '\n' : '')
  await fsPromises.writeFile(resolvedOutput, outputContent, 'utf8')

  return stats
}

const currentFilePath = fileURLToPath(import.meta.url)
if (
  process.argv[1] &&
  (resolve(process.argv[1]).toLowerCase() ===
    resolve(currentFilePath).toLowerCase() ||
    import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/')))
) {
  const args = process.argv.slice(2)
  let input: string | undefined
  let output: string | undefined
  let maxAllowRatio: number | undefined

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--input' && i + 1 < args.length) {
      input = args[++i]
    } else if (args[i] === '--output' && i + 1 < args.length) {
      output = args[++i]
    } else if (args[i] === '--max-allow-ratio' && i + 1 < args.length) {
      const val = parseFloat(args[++i])
      if (!Number.isNaN(val)) {
        maxAllowRatio = val
      }
    }
  }

  exportDatasetFile(input, output, {
    ...(maxAllowRatio !== undefined ? { maxAllowRatio } : {}),
  })
    .then((stats) => {
      console.log(JSON.stringify(stats, null, 2))
    })
    .catch((err: unknown) => {
      console.error('Dataset export failed:', err)
      process.exit(1)
    })
}
