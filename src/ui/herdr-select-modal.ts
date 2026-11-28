import type { AskDecision, AskRequest, AskVia } from '../gate/ask.ts'
import type { ExtensionUI } from '../pi-sdk.ts'

export interface SelectOptionEntry {
  label: string
  decision:
    AskDecision | 'deny_reason' | 'allow_permanent_menu' | 'view_full_command'
}

const SELECT_TITLE_CMD_MAX = 160
const PATTERN_LABEL_MAX = 120
const OPTION_LABEL_MAX = 150
const VIEW_PAGE_LINES = 16
const VIEW_WRAP_WIDTH = 100

export function sanitizeMiddleText(
  text: string,
  maxWidth = PATTERN_LABEL_MAX
): string {
  const clean = text
    .replace(/[\n\r]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
  if (clean.length <= maxWidth) return clean
  if (maxWidth <= 3) return clean.slice(0, maxWidth)
  const tailLen = Math.min(36, Math.floor((maxWidth - 1) / 3))
  const headLen = maxWidth - 1 - tailLen
  return `${clean.slice(0, headLen)}…${clean.slice(-tailLen)}`
}

export function getFullSelectCommand(req: AskRequest): string {
  const full = (req.fullCommand ?? '').trim()
  if (full.length > 0) return full
  return (req.value ?? '').trim()
}

export function isSelectCommandTruncated(req: AskRequest): boolean {
  if (req.type === 'external-directory') return false
  const raw = getFullSelectCommand(req)
  if (!raw) return false
  const normalized = raw
    .replace(/[\n\r]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
  return normalized.length > SELECT_TITLE_CMD_MAX
}

function wrapCommandLines(text: string, width = VIEW_WRAP_WIDTH): string[] {
  const out: string[] = []
  for (const line of text.split(/\r?\n/)) {
    if (line.length === 0) {
      out.push('')
      continue
    }
    for (let i = 0; i < line.length; i += width) {
      out.push(line.slice(i, i + width))
    }
  }
  return out
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
  const target = sanitizeSelectText(rawTarget, SELECT_TITLE_CMD_MAX)
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
      const cleanPat = sanitizeMiddleText(pat, PATTERN_LABEL_MAX)
      entries.push({
        label: `Allow for session: ${cleanPat}`,
        decision: { decision: 'allow_session', pattern: pat },
      })
    }
    if (!req.suppressPermanent) {
      if (req.sessionPatterns.length > 1) {
        entries.push({
          label: 'Allow permanently...',
          decision: 'allow_permanent_menu',
        })
      } else {
        const primaryPattern = req.sessionPatterns[0] ?? req.value
        entries.push({
          label: `Allow permanently: ${sanitizeMiddleText(primaryPattern, PATTERN_LABEL_MAX)}`,
          decision: { decision: 'allow_permanent', pattern: primaryPattern },
        })
      }
    }
    if (isSelectCommandTruncated(req)) {
      entries.push({
        label: 'View full command',
        decision: 'view_full_command',
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
      }
    )
    if (isSelectCommandTruncated(req)) {
      entries.push({
        label: 'View full command',
        decision: 'view_full_command',
      })
    }
    entries.push(
      { label: 'Deny', decision: 'deny' },
      { label: 'Deny with reason', decision: 'deny_reason' }
    )
  }

  const seen = new Map<string, number>()
  return entries.map((entry) => {
    const base = sanitizeSelectText(entry.label, OPTION_LABEL_MAX)
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
      const base = sanitizeSelectText(
        `Allow permanently: ${sanitizeMiddleText(pat, PATTERN_LABEL_MAX)}`,
        OPTION_LABEL_MAX
      )
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
        ? { signal: controller.signal, blockedKind: 'permission' }
        : {
            signal: controller.signal,
            timeout: remaining,
            blockedKind: 'permission',
          }
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
      if (picked.decision === 'view_full_command') {
        const lines = wrapCommandLines(getFullSelectCommand(req))
        const totalPages = Math.max(
          1,
          Math.ceil(lines.length / VIEW_PAGE_LINES)
        )
        let page = 0
        while (true) {
          const slice = lines.slice(
            page * VIEW_PAGE_LINES,
            (page + 1) * VIEW_PAGE_LINES
          )
          const header =
            totalPages > 1
              ? `Full command (page ${page + 1}/${totalPages})`
              : 'Full command'
          const nav: string[] = []
          if (page + 1 < totalPages) nav.push('Next page')
          if (page > 0) nav.push('Previous page')
          nav.push('Back')
          const navChosen = await selectWithTimeout(
            `${header}\n\n${slice.join('\n')}`,
            nav
          )
          if (timedOut) {
            return { decision: 'deny', via: 'timeout' }
          }
          if (navChosen === 'Next page') {
            page++
            continue
          }
          if (navChosen === 'Previous page') {
            page--
            continue
          }
          break
        }
        continue
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
        timeoutMs === -1
          ? { blockedKind: 'permission' }
          : { timeout: timeoutMs, blockedKind: 'permission' }
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
