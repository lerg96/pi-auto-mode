interface TokenSpan {
  token: string
  start: number
  end: number
}

function tokenizeCommandWithSpans(segment: string): TokenSpan[] {
  const tokens: TokenSpan[] = []
  let buf = ''
  let tokenStart = -1
  let quote: "'" | '"' | null = null
  let i = 0

  while (i < segment.length) {
    const c = segment[i]
    if (quote) {
      if (quote === '"' && c === '\\' && i + 1 < segment.length) {
        if (tokenStart === -1) tokenStart = i
        buf += c + segment[++i]
      } else if (c === quote) {
        if (tokenStart === -1) tokenStart = i
        buf += c
        quote = null
      } else {
        if (tokenStart === -1) tokenStart = i
        buf += c
      }
    } else if (c === '\\' && i + 1 < segment.length) {
      if (tokenStart === -1) tokenStart = i
      buf += c + segment[++i]
    } else if (c === "'" || c === '"') {
      if (tokenStart === -1) tokenStart = i
      buf += c
      quote = c
    } else if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      if (buf.length > 0) {
        tokens.push({ token: buf, start: tokenStart, end: i })
        buf = ''
        tokenStart = -1
      }
    } else {
      if (tokenStart === -1) tokenStart = i
      buf += c
    }
    i++
  }

  if (buf.length > 0) {
    tokens.push({ token: buf, start: tokenStart, end: segment.length })
  }
  return tokens
}

function tokenizeCommand(segment: string): string[] {
  return tokenizeCommandWithSpans(segment).map((t) => t.token)
}

const REDIR_TARGET_RE =
  /^(?:>{1,2}|<{1,3}|&>{1,2}|>&|<&|<>|[0-9]+>{1,2}|[0-9]+<{1,3}|[0-9]+>&|[0-9]+<&|[0-9]+<>)$/
const REDIR_STANDALONE_RE =
  /^(?:[0-9]*>&[0-9]+-?|[0-9]*<&[0-9]+-?|[0-9]*>&-|[0-9]*<&-)$/
const REDIR_ATTACHED_RE =
  /^(?:>{1,2}|<{1,3}|&>{1,2}|>&|<&|<>|[0-9]+>{1,2}|[0-9]+<{1,3}|[0-9]+>&|[0-9]+<&|[0-9]+<>)\S+$/

function filterRedirections(tokens: string[]): string[] {
  const filtered: string[] = []
  let i = 0
  while (i < tokens.length) {
    const t = tokens[i]
    if (t.startsWith("'") || t.startsWith('"')) {
      filtered.push(t)
      i++
      continue
    }
    if (REDIR_TARGET_RE.test(t)) {
      i += 2
      continue
    }
    if (REDIR_STANDALONE_RE.test(t) || REDIR_ATTACHED_RE.test(t)) {
      i++
      continue
    }
    filtered.push(t)
    i++
  }
  return filtered
}

const ENV_ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/

export function stripEnvPrefix(command: string): string {
  const trimmed = command.trim()
  if (!trimmed) return trimmed
  const tokens = tokenizeCommandWithSpans(command)
  if (tokens.length === 0) return trimmed
  if (!ENV_ASSIGN_RE.test(tokens[0].token)) return trimmed

  let firstNonEnvIndex = -1
  for (let i = 1; i < tokens.length; i++) {
    if (!ENV_ASSIGN_RE.test(tokens[i].token)) {
      firstNonEnvIndex = i
      break
    }
  }

  if (firstNonEnvIndex === -1) {
    return trimmed
  }

  return command.slice(tokens[firstNonEnvIndex].start).trim()
}

export const HEREDOC_OP = /(^|[^<])<<[^<]/

export const DATA_SINK_COMMANDS: ReadonlySet<string> = new Set(['cat', 'tee'])

export function isDataSinkCommand(segment: string): boolean {
  const firstLine = segment.split('\n')[0].trim()
  const argv = extractArgv(firstLine)
  if (argv.length === 0) return false
  const base = argv[0]
    .split(/[/\\]/)
    .pop()
    ?.replace(/\.exe$/i, '')
    .toLowerCase()
  if (!base || !DATA_SINK_COMMANDS.has(base)) return false
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]
    if (
      arg === '-c' ||
      arg === '-e' ||
      arg.startsWith('--exec') ||
      arg.startsWith('--eval') ||
      arg.startsWith('--command')
    ) {
      return false
    }
  }
  return true
}

export function extractArgv(segment: string): string[] {
  const target = HEREDOC_OP.test(segment) ? segment.split('\n')[0] : segment
  const rawTokens = tokenizeCommand(target)
  const nonRedir = filterRedirections(rawTokens)
  let start = 0
  while (start < nonRedir.length && ENV_ASSIGN_RE.test(nonRedir[start])) {
    start++
  }
  return nonRedir.slice(start)
}

const WORD_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._:@+-]*$/

function isPrivileged(cmd: string): boolean {
  const base = cmd
    .split(/[/\\]/)
    .pop()
    ?.replace(/\.exe$/i, '')
    .toLowerCase()
  return base === 'sudo' || base === 'env'
}

export function buildSessionPatterns(segment: string): string[] {
  const exact = segment.trim()
  const hasHeredoc = HEREDOC_OP.test(segment)
  if (hasHeredoc && !isDataSinkCommand(segment)) {
    return [exact]
  }

  const firstLine = hasHeredoc ? segment.split('\n')[0] : segment
  const argv = extractArgv(firstLine)
  if (argv.length === 0) {
    return [exact]
  }

  let prefixLen = 1
  for (let i = 1; i < argv.length; i++) {
    if (WORD_TOKEN_RE.test(argv[i])) {
      prefixLen++
    } else {
      break
    }
  }

  const privileged = isPrivileged(argv[0])
  const wildcards: string[] = []
  const maxK = Math.min(prefixLen, argv.length - 1)

  for (let k = maxK; k >= 1; k--) {
    if (privileged && k === 1) {
      continue
    }
    const pattern = `${argv.slice(0, k).join(' ')} *`
    if (pattern !== exact) {
      wildcards.push(pattern)
      if (wildcards.length === 3) {
        break
      }
    }
  }

  const result: string[] = [exact]
  const seen = new Set<string>([exact])
  for (const pat of wildcards) {
    if (!seen.has(pat)) {
      seen.add(pat)
      result.push(pat)
    }
  }

  return result
}
