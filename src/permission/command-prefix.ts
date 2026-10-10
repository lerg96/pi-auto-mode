function tokenizeCommand(segment: string): string[] {
  const tokens: string[] = []
  let buf = ''
  let quote: "'" | '"' | null = null
  let i = 0

  while (i < segment.length) {
    const c = segment[i]
    if (quote) {
      if (quote === '"' && c === '\\' && i + 1 < segment.length) {
        buf += c + segment[++i]
      } else if (c === quote) {
        buf += c
        quote = null
      } else {
        buf += c
      }
    } else if (c === '\\' && i + 1 < segment.length) {
      buf += c + segment[++i]
    } else if (c === "'" || c === '"') {
      buf += c
      quote = c
    } else if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      if (buf.length > 0) {
        tokens.push(buf)
        buf = ''
      }
    } else {
      buf += c
    }
    i++
  }

  if (buf.length > 0) tokens.push(buf)
  return tokens
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

export function extractArgv(segment: string): string[] {
  const rawTokens = tokenizeCommand(segment)
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
  const argv = extractArgv(segment)
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
