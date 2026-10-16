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
import { extractArgv } from '../permission/command-prefix.ts'

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

export function normalizeLineContinuations(command: string): string {
  let out = ''
  let quote: "'" | '"' | null = null
  let i = 0

  while (i < command.length) {
    const c = command[i]

    if (quote === "'") {
      out += c
      if (c === "'") quote = null
      i++
      continue
    }

    if (quote === '"') {
      if (c === '\\') {
        const rest = command.slice(i + 1)
        const m = rest.match(/^\r?\n/)
        if (m) {
          // Inside double quotes, bash removes \\\r?\n completely
          i += 1 + m[0].length
          continue
        }
        if (i + 1 < command.length) {
          out += c + command[i + 1]
          i += 2
          continue
        }
      }
      out += c
      if (c === '"') quote = null
      i++
      continue
    }

    // Outside quotes
    if (c === "'" || c === '"') {
      quote = c
      out += c
      i++
      continue
    }

    if (c === '\\') {
      const rest = command.slice(i + 1)
      const m = rest.match(/^\r?\n([ \t]*)/)
      if (m) {
        // Line continuation outside quotes
        const hadLeadingWs = /[ \t]$/.test(out)
        const trailingWs = m[1]
        if (hadLeadingWs || trailingWs.length > 0) {
          out = out.replace(/[ \t]+$/, '') + ' '
        }
        i += 1 + m[0].length
        continue
      }
      if (i + 1 < command.length) {
        out += c + command[i + 1]
        i += 2
        continue
      }
    }

    out += c
    i++
  }

  return out
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

export function readBraceExpansion(
  command: string,
  from: number
): [string, number] {
  let inner = ''
  let j = from
  let quote: "'" | '"' | null = null

  while (j < command.length) {
    const sc = command[j]

    if (quote) {
      if (quote === '"' && sc === '\\' && j + 1 < command.length) {
        inner += sc + command[j + 1]
        j += 2
        continue
      }
      if (sc === quote) {
        quote = null
        inner += sc
        j++
        continue
      }
      if (quote === '"' && sc === '$' && command[j + 1] === '{') {
        const [nested, nextJ] = readBraceExpansion(command, j + 2)
        inner += '${' + nested + '}'
        j = nextJ
        continue
      }
      if (quote === '"' && sc === '$' && command[j + 1] === '(') {
        const [nested, nextJ] = readParenSub(command, j + 2)
        inner += '$(' + nested + ')'
        j = nextJ
        continue
      }
      if (quote === '"' && sc === '`') {
        const [nested, nextJ] = readBacktickSub(command, j + 1)
        inner += '`' + nested + '`'
        j = nextJ
        continue
      }
      inner += sc
      j++
      continue
    }

    if (sc === '\\' && j + 1 < command.length) {
      inner += sc + command[j + 1]
      j += 2
      continue
    }
    if (sc === "'" || sc === '"') {
      quote = sc
      inner += sc
      j++
      continue
    }
    if (sc === '$' && command[j + 1] === '{') {
      const [nested, nextJ] = readBraceExpansion(command, j + 2)
      inner += '${' + nested + '}'
      j = nextJ
      continue
    }
    if (sc === '$' && command[j + 1] === '(') {
      const [nested, nextJ] = readParenSub(command, j + 2)
      inner += '$(' + nested + ')'
      j = nextJ
      continue
    }
    if (sc === '`') {
      const [nested, nextJ] = readBacktickSub(command, j + 1)
      inner += '`' + nested + '`'
      j = nextJ
      continue
    }
    if (sc === '}') {
      j++ // skip '}'
      break
    }
    inner += sc
    j++
  }

  return [inner, j]
}

function hasOnlyNullRedirectionsOrTimeout(rest: string): boolean {
  let cur = rest.trim()
  const allowed =
    /^(?:\s+|\(timeout\s+[^)]*\)|[0-9]*>&[0-9]+-?|[0-9]*<&[0-9]+-?|[0-9]*>&-|[0-9]*<&-|(?:[0-9]*>{1,2}|&>{1,2}|[0-9]*<)\s*(?:\/dev\/null|NUL\b))/i
  while (cur.length > 0) {
    const match = cur.match(allowed)
    if (!match) return false
    cur = cur.slice(match[0].length).trim()
  }
  return true
}

export function isBareShellKeyword(s: string): boolean {
  const trimmed = s.trim()
  if (
    trimmed === ')' ||
    trimmed === '}' ||
    trimmed === '(' ||
    trimmed === '{'
  ) {
    return true
  }
  const argv = extractArgv(trimmed)
  if (argv.length === 1 && /^(?:do|done|then|else|fi|esac)$/.test(argv[0])) {
    const rest = trimmed.replace(/^(?:do|done|then|else|fi|esac)\b/, '')
    return hasOnlyNullRedirectionsOrTimeout(rest)
  }
  return false
}

function countUnquotedParens(s: string): { open: number; close: number } {
  let open = 0
  let close = 0
  let quote: "'" | '"' | null = null
  let i = 0
  while (i < s.length) {
    const c = s[i]
    if (quote) {
      if (quote === '"' && c === '\\' && i + 1 < s.length) {
        i += 2
        continue
      }
      if (c === quote) {
        quote = null
      }
      i++
      continue
    }
    if (c === '\\' && i + 1 < s.length) {
      i += 2
      continue
    }
    if (c === "'" || c === '"') {
      quote = c
      i++
      continue
    }
    if (c === '(') open++
    else if (c === ')') close++
    i++
  }
  return { open, close }
}

function isTrailingBraceFromDollar(s: string): boolean {
  let dollarBraces = 0
  let quote: "'" | '"' | null = null
  let i = 0
  while (i < s.length - 1) {
    const c = s[i]
    if (quote) {
      if (quote === '"' && c === '\\' && i + 1 < s.length) {
        i += 2
        continue
      }
      if (c === quote) quote = null
      i++
      continue
    }
    if (c === '\\' && i + 1 < s.length) {
      i += 2
      continue
    }
    if (c === "'" || c === '"') {
      quote = c
      i++
      continue
    }
    if (c === '$' && s[i + 1] === '{') {
      dollarBraces++
      i += 2
      continue
    }
    if (c === '}') {
      if (dollarBraces > 0) dollarBraces--
    }
    i++
  }
  return dollarBraces > 0
}

export function stripLeadingShellKeywords(s: string): string {
  let cur = s.trim()
  if (isBareShellKeyword(cur)) return cur

  const kwPattern = /^(?:do|then|else|if|elif|while|until)\s+/
  while (true) {
    const prev = cur
    if (kwPattern.test(cur)) {
      cur = cur.replace(kwPattern, '').trim()
    }
    if (/^\{\s+/.test(cur)) {
      cur = cur.replace(/^\{\s+/, '').trim()
    }
    if (
      cur.startsWith('(') &&
      !cur.startsWith('$(') &&
      !cur.startsWith('<(') &&
      !cur.startsWith('>(')
    ) {
      cur = cur.slice(1).trim()
    }
    if (cur === prev) break
  }

  // Trailing unbalanced )
  const parens = countUnquotedParens(cur)
  while (cur.endsWith(')') && parens.close > parens.open) {
    cur = cur.slice(0, -1).trimEnd()
    parens.close--
  }

  // Trailing } preceded by whitespace (or s === '}') when not inside ${...}
  while (
    cur === '}' ||
    (/\s+\}$/.test(cur) && !isTrailingBraceFromDollar(cur))
  ) {
    if (cur === '}') {
      cur = ''
      break
    }
    cur = cur.replace(/\s+\}$/, '').trimEnd()
  }

  return cur
}

export function isShellStructureSegment(s: string): boolean {
  const trimmed = s.trim()
  if (isBareShellKeyword(trimmed)) return true
  const argv = extractArgv(trimmed)
  if (argv.length === 1 && /^(?:do|done|then|else|fi|esac)$/.test(argv[0])) {
    return true
  }
  return /^(?:for|select)\s+[A-Za-z_][A-Za-z0-9_]*(?:\s+in\b[\s\S]*)?$/.test(
    trimmed
  )
}

function tokenizeForFind(
  s: string,
  keepQuotes: boolean
): { text: string; quoted: boolean }[] {
  const tokens: { text: string; quoted: boolean }[] = []
  let buf = ''
  let quote: "'" | '"' | null = null
  let tokenQuoted = false
  let i = 0

  while (i < s.length) {
    const c = s[i]
    if (quote) {
      if (quote === '"' && c === '\\' && i + 1 < s.length) {
        buf += keepQuotes ? c + s[i + 1] : s[i + 1]
        i += 2
        continue
      }
      if (c === quote) {
        if (keepQuotes) buf += c
        quote = null
        i++
        continue
      }
      buf += c
      i++
      continue
    }

    if (c === '\\' && i + 1 < s.length) {
      buf += c + s[i + 1]
      i += 2
      continue
    }
    if (c === "'" || c === '"') {
      if (keepQuotes) buf += c
      quote = c
      tokenQuoted = true
      i++
      continue
    }
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      if (buf.length > 0) {
        tokens.push({ text: buf, quoted: tokenQuoted })
        buf = ''
        tokenQuoted = false
      }
      i++
      continue
    }
    buf += c
    i++
  }
  if (buf.length > 0) {
    tokens.push({ text: buf, quoted: tokenQuoted })
  }
  return tokens
}

export function extractFindExecSegments(
  segValue: string,
  opts?: { keepQuotes?: boolean }
): CommandSegment[] {
  const argv = extractArgv(segValue)
  if (argv.length === 0) return []
  if (!/(?:^|[/\\])find(?:\.exe)?$/i.test(argv[0])) return []

  const keep = opts?.keepQuotes === true
  const tokens = tokenizeForFind(segValue, keep)
  const results: CommandSegment[] = []

  let i = 0
  while (i < tokens.length) {
    if (/^-(?:exec|execdir|ok|okdir)$/.test(tokens[i].text)) {
      i++
      const execTokens: { text: string; quoted: boolean }[] = []
      while (i < tokens.length) {
        const t = tokens[i].text
        if (
          t === '\\;' ||
          t === ';' ||
          t === "';'" ||
          t === '";"' ||
          t === '+'
        ) {
          i++
          break
        }
        execTokens.push(tokens[i])
        i++
      }
      if (execTokens.length > 0 && execTokens[0].text === '{}') {
        execTokens.shift()
      }
      if (execTokens.length > 0) {
        const execCmd = execTokens.map((t) => t.text).join(' ')
        results.push({ value: execCmd, quoted: false })
      }
    } else {
      i++
    }
  }

  return results
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
  const cleanCommand = normalizeLineContinuations(command)
  const keep = opts?.keepQuotes === true
  const segments: CommandSegment[] = []
  let pendingSubSegments: CommandSegment[] = []
  let buf = ''
  let quoted = false
  let quote: "'" | '"' | null = null
  let pendingHeredocs: PendingHeredoc[] = []
  let inDoubleBracket = false

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
      const findExecSegs = extractFindExecSegments(value, opts)
      for (const fes of findExecSegs) {
        segments.push(fes)
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
    const [sub, next] = readParenSub(cleanCommand, from)
    if (
      cleanCommand[from] === '(' &&
      sub.startsWith('(') &&
      sub.endsWith(')')
    ) {
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
    const [sub, next] = readBacktickSub(cleanCommand, from)
    buf += '`' + (keep ? sub : stripQuotedLiterals(sub)) + '`'
    if (sub.length > 0) {
      for (const seg of segmentCommand(sub, opts)) {
        pendingSubSegments.push(seg)
      }
    }
    return next
  }

  let i = 0
  while (i < cleanCommand.length) {
    const c = cleanCommand[i]

    // heredoc operator — look for << delimiter (not <<< herestring, outside quotes, not in [[ ]])
    if (
      !quote &&
      !inDoubleBracket &&
      (i === 0 || cleanCommand[i - 1] !== '<') &&
      cleanCommand[i] === '<' &&
      cleanCommand[i + 1] === '<' &&
      cleanCommand[i + 2] !== '<'
    ) {
      const parsed = parseHeredocDelimiter(cleanCommand, i)
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

    // Process substitution <(...) or >(...) outside quotes and not in [[ ]]
    if (
      !quote &&
      !inDoubleBracket &&
      (c === '<' || c === '>') &&
      cleanCommand[i + 1] === '(' &&
      (c !== '<' || i === 0 || cleanCommand[i - 1] !== '<')
    ) {
      const [sub, next] = readParenSub(cleanCommand, i + 2)
      buf += `${c}(${keep ? sub : stripQuotedLiterals(sub)})`
      if (sub.length > 0) {
        for (const seg of segmentCommand(sub, opts)) {
          pendingSubSegments.push(seg)
        }
      }
      i = next
      continue
    }

    // [[ ... ]] conditional block entry
    if (
      !quote &&
      !inDoubleBracket &&
      cleanCommand[i] === '[' &&
      cleanCommand[i + 1] === '[' &&
      (i === 0 || /[\s;(&|]/.test(cleanCommand[i - 1])) &&
      (i + 2 >= cleanCommand.length || /\s/.test(cleanCommand[i + 2]))
    ) {
      inDoubleBracket = true
      buf += '[['
      i += 2
      continue
    }

    // [[ ... ]] conditional block exit
    if (
      !quote &&
      inDoubleBracket &&
      cleanCommand[i] === ']' &&
      cleanCommand[i + 1] === ']'
    ) {
      inDoubleBracket = false
      buf += ']]'
      i += 2
      continue
    }

    if (quote) {
      if (quote === '"' && c === '\\' && i + 1 < cleanCommand.length) {
        const next = cleanCommand[i + 1]
        if (next === '"' || next === '\\' || next === '$' || next === '`') {
          buf += keep ? c + next : next
        } else {
          buf += c + next
        }
        i += 2
        continue
      }
      if (quote === '"' && c === '$' && cleanCommand[i + 1] === '{') {
        const [inner, next] = readBraceExpansion(cleanCommand, i + 2)
        const subs = scanSubshells(inner, opts)
        for (const s of subs) {
          pendingSubSegments.push(s)
        }
        buf += '${' + (keep ? inner : stripQuotedLiterals(inner)) + '}'
        i = next
        continue
      }
      if (quote === '"' && c === '$' && cleanCommand[i + 1] === '(') {
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

    // Outside any quote
    if (c === '\\' && i + 1 < cleanCommand.length) {
      buf += c + cleanCommand[i + 1]
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
    if (c === '$' && cleanCommand[i + 1] === '{') {
      const [inner, next] = readBraceExpansion(cleanCommand, i + 2)
      const subs = scanSubshells(inner, opts)
      for (const s of subs) {
        pendingSubSegments.push(s)
      }
      buf += '${' + (keep ? inner : stripQuotedLiterals(inner)) + '}'
      i = next
      continue
    }
    if (c === ';' || c === '\n') {
      inDoubleBracket = false
      if (c === '\n' && pendingHeredocs.length > 0) {
        flush()
        let curPos = i + 1
        const extraSegments: CommandSegment[] = []
        for (const h of pendingHeredocs) {
          const bodyStart = curPos
          let lineStart = curPos
          let foundDelim = false
          let delimLineEnd = curPos

          while (curPos < cleanCommand.length && !foundDelim) {
            if (cleanCommand[curPos] === '\n') {
              let line = cleanCommand.slice(lineStart, curPos)
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
            let line = cleanCommand.slice(lineStart, curPos)
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
            heredocChunk = cleanCommand.slice(bodyStart - 1, delimLineEnd)
            bodyText = cleanCommand.slice(
              bodyStart,
              lineStart > bodyStart ? lineStart - 1 : bodyStart
            )
            curPos = delimLineEnd
          } else {
            heredocChunk = cleanCommand.slice(bodyStart - 1)
            bodyText = cleanCommand.slice(bodyStart)
            curPos = cleanCommand.length
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
      if (inDoubleBracket) {
        buf += c
        i++
        continue
      }
      while (i < cleanCommand.length && cleanCommand[i] === '|') i++
      if (i < cleanCommand.length && cleanCommand[i] === '&') i++
      flush()
      continue
    }
    if (c === '&' && cleanCommand[i + 1] === '&') {
      if (inDoubleBracket) {
        buf += '&&'
        i += 2
        continue
      }
      flush()
      i += 2
      continue
    }
    if (
      (c === '&' && cleanCommand[i + 1] === '>') ||
      (c === '&' && (buf.endsWith('>') || buf.endsWith('<')))
    ) {
      buf += c
      i++
      continue
    }
    if (c === '&') {
      if (inDoubleBracket) {
        buf += c
        i++
        continue
      }
      flush()
      i++
      continue
    }
    if (inDoubleBracket && (c === '<' || c === '>')) {
      buf += c
      i++
      continue
    }
    if (c === '$' && cleanCommand[i + 1] === '(') {
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
  const cleanCommand = normalizeLineContinuations(command)
  let out = ''
  let quote: "'" | '"' | null = null
  let i = 0
  while (i < cleanCommand.length) {
    const c = cleanCommand[i]
    if (quote) {
      if (quote === '"' && c === '\\' && i + 1 < cleanCommand.length) {
        const next = cleanCommand[i + 1]
        out += next === '"' ? '"' : c + next
        i += 2
        continue
      }
      if (quote === '"' && c === '$' && cleanCommand[i + 1] === '{') {
        const [inner, next] = readBraceExpansion(cleanCommand, i + 2)
        out += '${' + stripQuotedLiterals(inner) + '}'
        i = next
        continue
      }
      // Inside a quote: keep $(...) command substitution in double quotes so the
      // real command remains scannable; keep all other text so patterns
      // (e.g. ~/.ssh/) still see quoted content.
      if (quote === '"' && c === '$' && cleanCommand[i + 1] === '(') {
        const [sub, next] = readParenSub(cleanCommand, i + 2)
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
    if (c === '\\' && i + 1 < cleanCommand.length) {
      out += c + cleanCommand[i + 1]
      i += 2
      continue
    }
    if (c === "'" || c === '"') {
      quote = c
      i++
      continue
    }
    if (c === '$' && cleanCommand[i + 1] === '{') {
      const [inner, next] = readBraceExpansion(cleanCommand, i + 2)
      out += '${' + stripQuotedLiterals(inner) + '}'
      i = next
      continue
    }
    if (
      (c === '<' || c === '>') &&
      cleanCommand[i + 1] === '(' &&
      (c !== '<' || i === 0 || cleanCommand[i - 1] !== '<')
    ) {
      const [sub, next] = readParenSub(cleanCommand, i + 2)
      out += `${c}(${stripQuotedLiterals(sub)})`
      i = next
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
