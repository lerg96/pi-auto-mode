import type { AskDecision, AskRequest, AskVia } from '../gate/ask.ts'
import type { ExtensionUI } from '../pi-sdk.ts'

export interface SelectOptionEntry {
  label: string
  decision: AskDecision | 'deny_reason' | 'allow_permanent_menu'
}

export function sanitizeSelectText(text: string, maxWidth = 100): string {
  return text
    .replace(/[\n\r]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, maxWidth)
}

export function buildHerdrBlockedLabel(req: AskRequest): string {
  const tool = sanitizeSelectText(req.tool ?? req.surface, 40)
  const target = sanitizeSelectText(
    req.type === 'external-directory' && req.externalDir
      ? req.externalDir
      : req.value,
    80
  )
  return target ? `${tool}: ${target}` : tool
}

export function buildSelectTitle(
  req: AskRequest,
  via: AskVia,
  showClassifierRisk: boolean
): string {
  const prefix = via === 'parent-modal' ? '[subagent] ' : ''
  const tool = sanitizeSelectText(req.tool ?? req.surface, 40)
  const rawTarget =
    req.type === 'external-directory' && req.externalDir
      ? req.externalDir
      : (req.fullCommand ?? req.value)
  const target = sanitizeSelectText(rawTarget, 160)
  const lines = [`${prefix}Permission required: ${tool}`]
  if (target) {
    lines.push(
      req.type === 'external-directory'
        ? `Path: ${target}`
        : `Command: ${target}`
    )
  }
  if (showClassifierRisk && req.risk) {
    const reason = sanitizeSelectText(req.risk.reason, 120)
    lines.push(
      `Risk: ${req.risk.level} (${req.risk.score})${reason ? ` - ${reason}` : ''}`
    )
  }
  return lines.join('\n')
}

export function buildSelectOptions(req: AskRequest): SelectOptionEntry[] {
  const entries: SelectOptionEntry[] = []

  if (req.type === 'external-directory') {
    entries.push(
      { label: 'Allow this path once', decision: 'allow' },
      { label: 'Allow path for this tool', decision: 'allow_dir_tool' },
      { label: 'Allow path for all tools', decision: 'allow_dir_all' },
      { label: 'Deny', decision: 'deny' },
      { label: 'Deny with reason', decision: 'deny_reason' }
    )
  } else if (req.sessionPatterns && req.sessionPatterns.length > 0) {
    entries.push({ label: 'Allow once', decision: 'allow' })
    for (const pat of req.sessionPatterns) {
      const cleanPat = sanitizeSelectText(pat, 70)
      entries.push({
        label: `Allow for session: ${cleanPat}`,
        decision: { decision: 'allow_session', pattern: pat },
      })
    }
    if (req.sessionPatterns.length > 1) {
      entries.push({
        label: 'Allow permanently...',
        decision: 'allow_permanent_menu',
      })
    } else {
      const primaryPattern = req.sessionPatterns[0] ?? req.value
      entries.push({
        label: `Allow permanently: ${sanitizeSelectText(primaryPattern, 70)}`,
        decision: { decision: 'allow_permanent', pattern: primaryPattern },
      })
    }
    entries.push(
      { label: 'Deny', decision: 'deny' },
      { label: 'Deny with reason', decision: 'deny_reason' }
    )
  } else {
    entries.push(
      { label: 'Allow once', decision: 'allow' },
      { label: 'Allow for session', decision: 'allow_session' },
      {
        label: 'Allow permanently',
        decision: { decision: 'allow_permanent', pattern: req.value },
      },
      { label: 'Deny', decision: 'deny' },
      { label: 'Deny with reason', decision: 'deny_reason' }
    )
  }

  const seen = new Map<string, number>()
  return entries.map((entry) => {
    const base = sanitizeSelectText(entry.label, 100)
    const count = seen.get(base) ?? 0
    seen.set(base, count + 1)
    const label = count === 0 ? base : `${base} (${count + 1})`
    return { ...entry, label }
  })
}

export function buildPermanentPatternOptions(
  patterns: string[]
): Array<{ label: string; pattern: string | null }> {
  const seen = new Map<string, number>()
  const entries: Array<{ label: string; pattern: string | null }> =
    patterns.map((pat) => {
      const base = sanitizeSelectText(`Allow permanently: ${pat}`, 100)
      const count = seen.get(base) ?? 0
      seen.set(base, count + 1)
      const label = count === 0 ? base : `${base} (${count + 1})`
      return { label, pattern: pat }
    })
  entries.push({ label: 'Back', pattern: null })
  return entries
}

export async function runHerdrSelectPrompt(params: {
  req: AskRequest
  ui: ExtensionUI
  via: AskVia
  timeoutMs: number
  showClassifierRisk: boolean
  onClearReminder?: () => void
  inputDelayMs?: number
}): Promise<AskDecision> {
  const {
    req,
    ui,
    via,
    timeoutMs,
    showClassifierRisk,
    onClearReminder,
    inputDelayMs = 120,
  } = params
  const title = buildSelectTitle(req, via, showClassifierRisk)
  const options = buildSelectOptions(req)
  const labels = options.map((o) => o.label)

  const controller = new AbortController()
  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = timeoutMs === -1 ? -1 : Date.now() + timeoutMs

  if (timeoutMs !== -1) {
    timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
  }

  const selectWithTimeout = async (
    selectTitle: string,
    selectLabels: string[]
  ): Promise<string | undefined> => {
    const remaining = deadline === -1 ? -1 : Math.max(1, deadline - Date.now())
    const selectPromise = ui.select(
      selectTitle,
      selectLabels,
      remaining === -1
        ? { signal: controller.signal }
        : { signal: controller.signal, timeout: remaining }
    )
    if (remaining === -1) {
      return await selectPromise
    }
    return await Promise.race([
      selectPromise,
      new Promise<undefined>((resolve) => {
        if (controller.signal.aborted) {
          resolve(undefined)
          return
        }
        controller.signal.addEventListener('abort', () => resolve(undefined), {
          once: true,
        })
      }),
    ])
  }

  let match: SelectOptionEntry | undefined
  try {
    while (true) {
      const chosen = await selectWithTimeout(title, labels)
      if (timedOut) {
        return { decision: 'deny', via: 'timeout' }
      }
      if (!chosen) {
        return 'deny'
      }
      const picked = options.find((o) => o.label === chosen)
      if (!picked) {
        return 'deny'
      }
      if (picked.decision !== 'allow_permanent_menu') {
        match = picked
        break
      }

      const permOptions = buildPermanentPatternOptions(
        req.sessionPatterns ?? []
      )
      const permChosen = await selectWithTimeout(
        'Allow permanently — choose pattern',
        permOptions.map((o) => o.label)
      )
      if (timedOut) {
        return { decision: 'deny', via: 'timeout' }
      }
      if (!permChosen) {
        return 'deny'
      }
      const permPicked = permOptions.find((o) => o.label === permChosen)
      if (!permPicked) {
        return 'deny'
      }
      if (permPicked.pattern === null) {
        continue
      }
      return { decision: 'allow_permanent', pattern: permPicked.pattern }
    }
  } catch {
    return timedOut ? { decision: 'deny', via: 'timeout' } : 'deny'
  } finally {
    if (timer) clearTimeout(timer)
  }

  if (match.decision === 'deny_reason') {
    onClearReminder?.()
    if (inputDelayMs > 0) {
      await new Promise((r) => setTimeout(r, inputDelayMs))
    }
    let reason: string | undefined
    try {
      reason = await ui.input(
        'Reason for denial',
        'Why is this denied? Shown to the model.',
        timeoutMs === -1 ? {} : { timeout: timeoutMs }
      )
    } catch {
      return 'deny'
    }
    if (reason && reason.trim()) {
      return {
        decision: 'deny',
        reason: sanitizeSelectText(reason, 200),
      }
    }
    return 'deny'
  }

  return match.decision as AskDecision
}
