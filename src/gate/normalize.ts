export interface AccessIntent {
  surface: string
  value: string
  /**
   * Quote-preserving twin of `value` (same segments, quotes kept). Set only
   * when it differs from `value`, so quote-free commands keep the exact
   * legacy shape. Lets the scope extractor see quoted strings atomically.
   */
  rawValue?: string
}

// L1: Explicit allow-list of known built-in tools. Tools not in this set
// are treated as custom tools and get their toolName as the surface.
// This allows custom tools (e.g. 'agent_send_message') to be permissioned
// under their own surface name without a user-configurable mapping.
const FILE_TOOLS = new Set(['read', 'write', 'edit', 'find', 'grep', 'ls'])

/**
 * Maps a tool name to the permission/deny surface used by the policy engine.
 * Built-ins: `bash`/`powershell` -> `shell`, file tools -> `fs`, `mcp` -> `mcp`.
 * Custom tools (any other name) -> their own toolName as surface.
 * This replaces the user-configurable Config.tools map (removed in Phase 1).
 */
export function surfaceForTool(toolName: string): string {
  if (toolName === 'bash') return 'shell'
  // `powershell` is Pi's built-in shell tool on Windows — same command
  // semantics as `bash`, so it shares the 'shell' surface (rm -rf deny,
  // trust boundary, and the classifier all apply to it identically).
  if (toolName === 'powershell') return 'shell'
  if (FILE_TOOLS.has(toolName)) return 'fs'
  if (toolName === 'mcp') return 'mcp'
  // Custom tool: use its own name as the surface. This allows permission
  // rules to target custom tools by their exact name (e.g. a rule for
  // surface 'agent_send_message' applies to the 'agent_send_message' tool).
  return toolName
}

export interface CommandSegment {
  value: string
  quoted: boolean
}

/**
 * Tokenize a shell command into segments, splitting on `;`, `&&`, `||`, `|`,
 * newline, backtick, and `$(`. Quote-aware: separators inside single/double
 * quotes are ignored. A segment is flagged `quoted` when it contains a literal
 * quoted string, so callers can treat it as data rather than a command.
 * Surrounding quotes are stripped from each segment value.
 */
export {
  DATA_SINK_COMMANDS,
  isDataSinkCommand,
} from '../permission/command-prefix.ts'

interface PendingHeredoc {
  target: number
  delim: string
  isQuoted: boolean
  stripTabs: boolean
}

function parseHeredocDelimiter(
  command: string,
  from: number
): {
  delim: string
  isQuoted: boolean
  stripTabs: boolean
  nextIndex: number
  rawSpec: string
} {
  let i = from + 2 // skip <<
  let stripTabs = false
  if (command[i] === '-') {
    stripTabs = true
    i++
  }
  while (i < command.length && (command[i] === ' ' || command[i] === '\t')) {
    i++
  }

  let delim = ''
  let isQuoted = false
  const startSpec = from
  while (i < command.length) {
    const c = command[i]
    if (c === "'" || c === '"') {
      isQuoted = true
      const q = c
      i++
      while (i < command.length && command[i] !== q) {
        delim += command[i]
        i++
      }
      if (i < command.length) i++ // skip closing quote
    } else if (
      c === '\\' &&
      i + 1 < command.length &&
      command[i + 1] !== '\n'
    ) {
      isQuoted = true
      i++
      delim += command[i]
      i++
    } else if (
      c === ' ' ||
      c === '\t' ||
      c === '\n' ||
      c === '\r' ||
      c === ';' ||
      c === '&' ||
      c === '|' ||
      c === '(' ||
      c === ')' ||
      c === '<' ||
      c === '>'
    ) {
      break
    } else {
      delim += c
      i++
    }
  }

  const rawSpec = command.slice(startSpec, i)
  return { delim, isQuoted, stripTabs, nextIndex: i, rawSpec }
}

export function readParenSub(command: string, from: number): [string, number] {
  let depth = 1
  let sub = ''
  let j = from
  let subQuote: "'" | '"' | null = null
  while (j < command.length && depth > 0) {
    const sc = command[j]
    if (subQuote) {
      if (subQuote === '"' && sc === '\\' && j + 1 < command.length) {
        sub += sc + command[j + 1]
        j += 2
        continue
      }
      if (sc === subQuote) {
        subQuote = null
        sub += sc
        j++
        continue
      }
      if (subQuote === '"' && sc === '$' && command[j + 1] === '(') {
        const [nested, nextJ] = readParenSub(command, j + 2)
        sub += command.slice(j, nextJ)
        j = nextJ
        continue
      }
      sub += sc
      j++
      continue
    }
    if (sc === '\\' && j + 1 < command.length) {
      sub += sc + command[j + 1]
      j += 2
      continue
    }
    if (sc === "'" || sc === '"') {
      subQuote = sc
      sub += sc
      j++
      continue
    }
    if (sc === '(') {
      depth++
      sub += sc
      j++
      continue
    }
    if (sc === ')') {
      depth--
      if (depth > 0) sub += sc
      j++
      continue
    }
    sub += sc
    j++
  }
  return [sub.trim(), j]
}

export function readBacktickSub(
  command: string,
  from: number
): [string, number] {
  let sub = ''
  let j = from
  while (j < command.length && command[j] !== '`') {
    if (command[j] === '\\' && j + 1 < command.length) {
      sub += command[j] + command[j + 1]
      j += 2
      continue
    }
    sub += command[j]
    j++
  }
  return [sub.trim(), j < command.length ? j + 1 : j]
}

export function isBareShellKeyword(s: string): boolean {
  return /^(?:do|done|then|else|fi|esac)(?:\s+\(timeout\s+[^)]*\))?$/.test(
    s.trim()
  )
}

export function stripLeadingShellKeywords(s: string): string {
  let cur = s.trim()
  if (isBareShellKeyword(cur)) return cur
  const pattern = /^(?:do|then|else|if|elif|while|until)\s+/
  while (pattern.test(cur)) {
    cur = cur.replace(pattern, '').trim()
  }
  return cur
}

export function isShellStructureSegment(s: string): boolean {
  const trimmed = s.trim()
  return (
    isBareShellKeyword(trimmed) ||
    /^(?:for|select)\s+[A-Za-z_][A-Za-z0-9_]*(?:\s+in\b[\s\S]*)?$/.test(trimmed)
  )
}

function scanSubshells(
  body: string,
  opts?: { keepQuotes?: boolean }
): CommandSegment[] {
  const extraSegments: CommandSegment[] = []
  let j = 0
  while (j < body.length) {
    if (body[j] === '$' && body[j + 1] === '(') {
      const [sub, next] = readParenSub(body, j + 2)
      if (sub.length > 0) {
        for (const seg of segmentCommand(sub, opts)) {
          extraSegments.push(seg)
        }
      }
      j = next
      continue
    }
    if (body[j] === '`') {
      const [sub, next] = readBacktickSub(body, j + 1)
      if (sub.length > 0) {
        for (const seg of segmentCommand(sub, opts)) {
          extraSegments.push(seg)
        }
      }
      j = next
      continue
    }
    j++
  }
  return extraSegments
}

export function segmentCommand(
  command: string,
  opts?: { keepQuotes?: boolean }
): CommandSegment[] {
  const keep = opts?.keepQuotes === true
  const segments: CommandSegment[] = []
  let pendingSubSegments: CommandSegment[] = []
  let buf = ''
  let quoted = false
  let quote: "'" | '"' | null = null
  let pendingHeredocs: PendingHeredoc[] = []

  const flush = () => {
    const value = stripLeadingShellKeywords(buf.trim())
    const isSingleSub =
      !quoted &&
      pendingSubSegments.length > 0 &&
      ((value.startsWith('$(') &&
        !value.startsWith('$((') &&
        value.endsWith(')') &&
        readParenSub(value, 2)[1] === value.length) ||
        (value.startsWith('`') &&
          value.endsWith('`') &&
          value.length >= 2 &&
          readBacktickSub(value, 1)[1] === value.length))

    if (!isSingleSub && value.length > 0 && !isBareShellKeyword(value)) {
      segments.push({ value, quoted })
      const segIndex = segments.length - 1
      for (const h of pendingHeredocs) {
        if (h.target === -1) {
          h.target = segIndex
        }
      }
    }
    for (const sub of pendingSubSegments) {
      segments.push(sub)
    }
    pendingSubSegments = []
    buf = ''
    quoted = false
  }

  const handleParenSub = (from: number): number => {
    const [sub, next] = readParenSub(command, from)
    if (command[from] === '(' && sub.startsWith('(') && sub.endsWith(')')) {
      buf += '$(' + (keep ? sub : stripQuotedLiterals(sub)) + ')'
      const nested = scanSubshells(sub.slice(1, -1), opts)
      for (const s of nested) {
        pendingSubSegments.push(s)
      }
      return next
    }
    buf += '$(' + (keep ? sub : stripQuotedLiterals(sub)) + ')'
    if (sub.length > 0) {
      for (const seg of segmentCommand(sub, opts)) {
        pendingSubSegments.push(seg)
      }
    }
    return next
  }

  const handleBacktickSub = (from: number): number => {
    const [sub, next] = readBacktickSub(command, from)
    buf += '`' + (keep ? sub : stripQuotedLiterals(sub)) + '`'
    if (sub.length > 0) {
      for (const seg of segmentCommand(sub, opts)) {
        pendingSubSegments.push(seg)
      }
    }
    return next
  }

  let i = 0
  while (i < command.length) {
    const c = command[i]

    // heredoc operator — look for << delimiter (not <<< herestring, and outside quotes)
    if (
      !quote &&
      (i === 0 || command[i - 1] !== '<') &&
      command[i] === '<' &&
      command[i + 1] === '<' &&
      command[i + 2] !== '<'
    ) {
      const parsed = parseHeredocDelimiter(command, i)
      buf += parsed.rawSpec
      pendingHeredocs.push({
        target: -1,
        delim: parsed.delim,
        isQuoted: parsed.isQuoted,
        stripTabs: parsed.stripTabs,
      })
      i = parsed.nextIndex
      continue
    }

    if (quote) {
      if (quote === '"' && c === '\\' && i + 1 < command.length) {
        const next = command[i + 1]
        if (next === '"' || next === '\\' || next === '$' || next === '`') {
          buf += keep ? c + next : next
        } else {
          buf += c + next
        }
        i += 2
        continue
      }
      // Inside a quote: only command substitution is active in double quotes.
      // In single quotes `$(`/`...` are literal and must not be extracted.
      if (quote === '"' && c === '$' && command[i + 1] === '(') {
        i = handleParenSub(i + 2)
        continue
      }
      if (quote === '"' && c === '`') {
        i = handleBacktickSub(i + 1)
        continue
      }
      if (c === quote) {
        if (keep) buf += c
        quote = null
        i++
        continue
      }
      buf += c
      i++
      continue
    }
    // Outside any quote.
    if (c === '\\' && i + 1 < command.length) {
      buf += c + command[i + 1]
      i += 2
      continue
    }
    if (c === "'" || c === '"') {
      if (keep) buf += c
      quote = c
      quoted = true
      i++
      continue
    }
    if (c === ';' || c === '\n') {
      if (c === '\n' && pendingHeredocs.length > 0) {
        flush()
        let curPos = i + 1
        const extraSegments: CommandSegment[] = []
        for (const h of pendingHeredocs) {
          const bodyStart = curPos
          let lineStart = curPos
          let foundDelim = false
          let delimLineEnd = curPos

          while (curPos < command.length && !foundDelim) {
            if (command[curPos] === '\n') {
              let line = command.slice(lineStart, curPos)
              if (line.endsWith('\r')) line = line.slice(0, -1)
              const lineCheck = h.stripTabs ? line.replace(/^\t+/, '') : line
              if (lineCheck.trimEnd() === h.delim) {
                foundDelim = true
                delimLineEnd = curPos + 1
                break
              }
              curPos++
              lineStart = curPos
            } else {
              curPos++
            }
          }

          if (!foundDelim) {
            let line = command.slice(lineStart, curPos)
            if (line.endsWith('\r')) line = line.slice(0, -1)
            const lineCheck = h.stripTabs ? line.replace(/^\t+/, '') : line
            if (lineCheck.trimEnd() === h.delim) {
              foundDelim = true
              delimLineEnd = curPos
            }
          }

          let heredocChunk = ''
          let bodyText = ''
          if (foundDelim) {
            heredocChunk = command.slice(bodyStart - 1, delimLineEnd)
            bodyText = command.slice(
              bodyStart,
              lineStart > bodyStart ? lineStart - 1 : bodyStart
            )
            curPos = delimLineEnd
          } else {
            heredocChunk = command.slice(bodyStart - 1)
            bodyText = command.slice(bodyStart)
            curPos = command.length
          }

          if (h.target >= 0 && h.target < segments.length) {
            segments[h.target].value += heredocChunk.trimEnd()
          }

          if (!h.isQuoted) {
            const subs = scanSubshells(bodyText, opts)
            for (const s of subs) extraSegments.push(s)
          }
        }

        for (const s of extraSegments) {
          segments.push(s)
        }

        pendingHeredocs = []
        i = curPos
        continue
      }

      flush()
      i++
      continue
    }

    if (c === '`') {
      i = handleBacktickSub(i + 1)
      continue
    }
    if (c === '|') {
      // consume ALL consecutive | chars (handles ||, |||, |&) as one separator
      while (i < command.length && command[i] === '|') i++
      // |& — pipe stderr too — consume trailing &
      if (i < command.length && command[i] === '&') i++
      flush()
      continue
    }
    if (c === '&' && command[i + 1] === '&') {
      flush()
      i += 2
      continue
    }
    // Redirections using &:
    // - &> or &>> (redirect stdout and stderr)
    // - >& or <& (duplicate or close file descriptor, e.g. 2>&1, >&2, <&0, >&-, <&-)
    if (
      (c === '&' && command[i + 1] === '>') ||
      (c === '&' && (buf.endsWith('>') || buf.endsWith('<')))
    ) {
      buf += c
      i++
      continue
    }
    if (c === '&') {
      // bare & (not &&) — background separator
      flush()
      i++
      continue
    }
    if (c === '$' && command[i + 1] === '(') {
      i = handleParenSub(i + 2)
      continue
    }
    buf += c
    i++
  }
  flush()
  return segments
}

/** Quote-aware shell segmenter shared by the gate and classifier. */
export function splitShellSegments(command: string): string[] {
  return segmentCommand(command).map((s) => s.value)
}

/**
 * Returns `command` with the quote characters removed but content kept
 * intact, so trust-boundary / block rules still see the text inside quotes.
 */
export function stripQuotedLiterals(command: string): string {
  let out = ''
  let quote: "'" | '"' | null = null
  let i = 0
  while (i < command.length) {
    const c = command[i]
    if (quote) {
      if (quote === '"' && c === '\\' && i + 1 < command.length) {
        const next = command[i + 1]
        out += next === '"' ? '"' : c + next
        i += 2
        continue
      }
      // Inside a quote: keep $(...) command substitution in double quotes so the
      // real command remains scannable; keep all other text so patterns
      // (e.g. ~/.ssh/) still see quoted content.
      if (quote === '"' && c === '$' && command[i + 1] === '(') {
        const [sub, next] = readParenSub(command, i + 2)
        out += '$(' + sub + ')'
        i = next
        continue
      }
      if (c === quote) {
        quote = null
        i++
        continue
      }
      // keep text inside quotes (only strip the quote chars)
      out += c
      i++
      continue
    }
    if (c === '\\' && i + 1 < command.length) {
      out += c + command[i + 1]
      i += 2
      continue
    }
    if (c === "'" || c === '"') {
      quote = c
      i++
      continue
    }
    out += c
    i++
  }
  return out
}

/**
 * Split a compound shell command into trimmed, non-empty segments. Delegates to
 * the shared quote-aware `splitShellSegments` so the permission gate and the
 * classifier use the same splitting rules.
 */
export function splitSegments(command: string): string[] {
  return splitShellSegments(command)
}

export function normalizeToolCall(
  toolName: string,
  input: Record<string, unknown>
): AccessIntent[] {
  const surface = surfaceForTool(toolName)
  const cmd = input.command

  if (toolName === 'bash') {
    if (typeof cmd === 'string' && cmd.length > 0) {
      const segments = segmentCommand(cmd)
      const rawSegments = segmentCommand(cmd, { keepQuotes: true })
      return segments.map((segment, i) => {
        const intent: AccessIntent = { surface, value: segment.value }
        // Zipped by index: splitting decisions are identical with or
        // without quotes, only the quote chars differ. Set only when it
        // differs so quote-free commands keep the exact legacy shape.
        const raw = rawSegments[i]?.value
        if (raw !== undefined && raw !== segment.value) intent.rawValue = raw
        return intent
      })
    }
    // 'bash' tool with no command — sentinel (never "undefined")
    return [{ surface, value: '*' }]
  }

  if (typeof cmd === 'string' && cmd.length > 0) {
    const segments = splitSegments(cmd)
    return segments.map((segment) => ({ surface, value: segment }))
  }

  if (toolName === 'mcp') {
    // H3: use `||` (not `??`) so empty strings fall back to 'mcp'
    return [{ surface, value: String(input.tool || input.server || 'mcp') }]
  }
  if (FILE_TOOLS.has(toolName) && input.path != null) {
    return [{ surface, value: String(input.path) }]
  }
  return [{ surface, value: '*' }]
}
