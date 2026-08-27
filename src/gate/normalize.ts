export interface AccessIntent {
  surface: string
  value: string
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
export function segmentCommand(command: string): CommandSegment[] {
  const segments: CommandSegment[] = []
  let buf = ''
  let quoted = false
  let quote: "'" | '"' | null = null
  const flush = () => {
    const value = buf.trim()
    if (value.length > 0) segments.push({ value, quoted })
    buf = ''
    quoted = false
  }

  // Read a $(...) command substitution, starting just after the opening "$(".
  // Returns the inner command text (trimmed) and the index just past ")".
  const readParenSub = (from: number): [string, number] => {
    let depth = 1
    let sub = ''
    let j = from
    while (j < command.length && depth > 0) {
      const sc = command[j]
      if (sc === '(') depth++
      else if (sc === ')') depth--
      if (depth > 0) sub += sc
      j++
    }
    return [sub.trim(), j]
  }

  // Read a `...` command substitution, starting just after the opening backtick.
  // Returns the inner command text (trimmed) and the index just past the
  // closing backtick.
  const readBacktickSub = (from: number): [string, number] => {
    let sub = ''
    let j = from
    while (j < command.length && command[j] !== '`') {
      sub += command[j]
      j++
    }
    return [sub.trim(), j + 1]
  }

  // heredoc state: body text waiting to be flushed as a scannable segment
  let heredocBody = ''
  const flushHeredoc = () => {
    const trimmed = heredocBody.trim()
    if (trimmed.length > 0) {
      segments.push({ value: trimmed, quoted: false })
      heredocBody = ''
    }
  }

  let i = 0
  while (i < command.length) {
    const c = command[i]

    // heredoc handling — look for << delimiter
    if (command[i] === '<' && command[i + 1] === '<') {
      // flush current buffer
      flush()
      // skip <<
      i += 2
      // skip optional - for <<- (strip leading tabs)
      if (command[i] === '-') i++
      // read delimiter word
      let delim = ''
      while (
        i < command.length &&
        command[i] !== ' ' &&
        command[i] !== '\t' &&
        command[i] !== '\n'
      ) {
        if (command[i] === "'" || command[i] === '"') {
          // quoted delimiter — read until closing quote, skip quotes
          const q = command[i]
          i++
          while (i < command.length && command[i] !== q) {
            delim += command[i]
            i++
          }
          if (i < command.length) i++ // skip closing quote
        } else {
          delim += command[i]
          i++
        }
      }
      // skip whitespace after delimiter (may span newline)
      while (i < command.length && (command[i] === ' ' || command[i] === '\t'))
        i++
      // consume trailing newline so heredoc body starts on next line
      if (i < command.length && command[i] === '\n') i++
      // read heredoc body until delimiter on its own line
      heredocBody = ''
      let heredocDone = false
      let line = ''
      while (i < command.length && !heredocDone) {
        if (command[i] === '\n') {
          if (line.trimEnd() === delim) {
            heredocDone = true
          } else {
            if (heredocBody.length > 0) heredocBody += '\n'
            heredocBody += line
          }
          line = ''
          i++
        } else {
          line += command[i]
          i++
        }
      }
      // handle EOF without trailing newline after delimiter
      if (!heredocDone && line.trimEnd() !== delim) {
        if (heredocBody.length > 0) heredocBody += '\n'
        heredocBody += line
      }
      flushHeredoc()
      continue
    }

    if (quote) {
      // Inside a quote: only command substitution is active in double quotes.
      // In single quotes `$(`/`...` are literal and must not be extracted.
      if (quote === '"' && c === '$' && command[i + 1] === '(') {
        flush()
        const [sub, next] = readParenSub(i + 2)
        if (sub.length > 0) segments.push({ value: sub, quoted: false })
        i = next
        continue
      }
      if (quote === '"' && c === '`') {
        flush()
        const [sub, next] = readBacktickSub(i + 1)
        if (sub.length > 0) segments.push({ value: sub, quoted: false })
        i = next
        continue
      }
      if (c === quote) {
        quote = null
        i++
        continue
      }
      buf += c
      i++
      continue
    }
    // Outside any quote.
    if (c === "'" || c === '"') {
      quote = c
      quoted = true
      i++
      continue
    }
    if (c === ';' || c === '\n') {
      flush()
      i++
      continue
    }
    if (c === '`') {
      flush()
      const [sub, next] = readBacktickSub(i + 1)
      if (sub.length > 0) segments.push({ value: sub, quoted: false })
      i = next
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
    if (c === '&') {
      // bare & (not &&) — background separator
      flush()
      i++
      continue
    }
    if (c === '$' && command[i + 1] === '(') {
      flush()
      const [sub, next] = readParenSub(i + 2)
      if (sub.length > 0) segments.push({ value: sub, quoted: false })
      i = next
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
      // Inside a quote: keep $(...) command substitution in double quotes so the
      // real command remains scannable; keep all other text so patterns
      // (e.g. ~/.ssh/) still see quoted content.
      if (quote === '"' && c === '$' && command[i + 1] === '(') {
        let depth = 1
        let j = i + 2
        out += '$('
        while (j < command.length && depth > 0) {
          const sc = command[j]
          if (sc === '(') depth++
          else if (sc === ')') depth--
          if (depth > 0) out += sc
          j++
        }
        i = j
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
      const segments = splitSegments(cmd)
      return segments.map((segment) => ({ surface, value: segment }))
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
