import {
  ENV_ASSIGN_RE,
  tokenizeCommandWithSpans,
  type TokenSpan,
} from '../permission/command-prefix.ts'

interface WrapperSpec {
  /** Short option chars (without `-`) that consume a separate argument token. */
  shortWithArg?: ReadonlySet<string>
  /** Long options (with `--`) that consume a separate argument token when not using `=`. */
  longWithArg?: ReadonlySet<string>
  /** Options that mean the command is NOT executing an inner command (e.g. `command -v`, `taskset -p`). */
  abortOptions?: ReadonlySet<string>
  /** Number of mandatory positional arguments before the inner command (e.g. 1 for `timeout DURATION`). */
  positionalArgs?: number
  /** Skip `NAME=VALUE` tokens after options (e.g. `env`). */
  skipEnvAssigns?: boolean
  /** Allow legacy `-N` / `--N` numeric options (e.g. `nice -10`). */
  allowNumericFlag?: boolean
  /** Allow bare `-` as a flag (e.g. `env -`). */
  allowBareDash?: boolean
}

const WRAPPER_SPECS: Readonly<Record<string, WrapperSpec>> = {
  timeout: {
    shortWithArg: new Set(['k', 's']),
    longWithArg: new Set(['--kill-after', '--signal']),
    positionalArgs: 1,
  },
  gtimeout: {
    shortWithArg: new Set(['k', 's']),
    longWithArg: new Set(['--kill-after', '--signal']),
    positionalArgs: 1,
  },
  xargs: {
    shortWithArg: new Set(['a', 'd', 'E', 'I', 'L', 'n', 'P', 's', 'R', 'J']),
    longWithArg: new Set([
      '--arg-file',
      '--delimiter',
      '--max-args',
      '--max-procs',
      '--max-chars',
      '--process-slot-var',
    ]),
  },
  nice: {
    shortWithArg: new Set(['n']),
    longWithArg: new Set(['--adjustment']),
    allowNumericFlag: true,
  },
  nohup: {},
  time: {
    shortWithArg: new Set(['f', 'o']),
    longWithArg: new Set(['--format', '--output']),
  },
  env: {
    shortWithArg: new Set(['u', 'C']),
    longWithArg: new Set(['--unset', '--chdir', '--argv0']),
    abortOptions: new Set(['-S', '--split-string']),
    skipEnvAssigns: true,
    allowBareDash: true,
  },
  stdbuf: {
    shortWithArg: new Set(['i', 'o', 'e']),
    longWithArg: new Set(['--input', '--output', '--error']),
  },
  ionice: {
    shortWithArg: new Set(['c', 'n']),
    longWithArg: new Set(['--class', '--classdata']),
    abortOptions: new Set(['-p', '--pid', '-P', '--pgid', '-u', '--uid']),
  },
  setsid: {},
  watch: {
    shortWithArg: new Set(['n', 'q']),
    longWithArg: new Set(['--interval', '--equexit']),
  },
  chrt: {
    shortWithArg: new Set(['T', 'P', 'D']),
    longWithArg: new Set([
      '--sched-runtime',
      '--sched-period',
      '--sched-deadline',
    ]),
    abortOptions: new Set(['-p', '--pid', '-m', '--max']),
    positionalArgs: 1,
  },
  taskset: {
    abortOptions: new Set(['-p', '--pid']),
    positionalArgs: 1,
  },
  unbuffer: {},
  command: {
    abortOptions: new Set(['-v', '-V']),
  },
  exec: {
    shortWithArg: new Set(['a']),
  },
}

const REDIR_TOKEN_RE = /^(?:[0-9]*(?:>{1,2}|<{1,3}|>&|<&|<>)|&>{1,2})/

const MAX_UNWRAP_DEPTH = 10

function commandBasename(token: string): string {
  const unquoted =
    (token.startsWith('"') && token.endsWith('"')) ||
    (token.startsWith("'") && token.endsWith("'"))
      ? token.slice(1, -1)
      : token
  return (
    unquoted
      .split(/[/\\]/)
      .pop()
      ?.replace(/\.exe$/i, '')
      .toLowerCase() ?? ''
  )
}

function hasAbortShortFlag(
  tok: string,
  abortOptions: ReadonlySet<string>,
  shortWithArg?: ReadonlySet<string>
): boolean {
  for (let j = 1; j < tok.length; j++) {
    const ch = tok[j]
    if (abortOptions.has(`-${ch}`)) return true
    if (shortWithArg?.has(ch)) return false
  }
  return false
}

function consumeShortFlags(
  tok: string,
  shortWithArg?: ReadonlySet<string>
): number {
  if (!shortWithArg) return 1
  for (let j = 1; j < tok.length; j++) {
    if (shortWithArg.has(tok[j])) {
      // If characters remain in this token (e.g. `-I{}`, `-n1`), they are the
      // attached argument; otherwise the next token is the argument.
      return j + 1 < tok.length ? 1 : 2
    }
  }
  return 1
}

function findInnerCommandIndex(
  tokens: TokenSpan[],
  wrapperIdx: number,
  spec: WrapperSpec
): number | null {
  let i = wrapperIdx + 1

  while (i < tokens.length) {
    const tok = tokens[i].token
    if (tok === '--') {
      i++
      break
    }
    if (tok === '-') {
      if (spec.allowBareDash) {
        i++
        continue
      }
      break
    }
    if (!tok.startsWith('-')) break

    if (spec.abortOptions) {
      if (
        spec.abortOptions.has(tok) ||
        (tok.startsWith('--') &&
          spec.abortOptions.has(tok.slice(0, tok.indexOf('='))))
      ) {
        return null
      }
      if (
        !tok.startsWith('--') &&
        hasAbortShortFlag(tok, spec.abortOptions, spec.shortWithArg)
      ) {
        return null
      }
    }

    if (spec.allowNumericFlag && /^--?\d+$/.test(tok)) {
      i++
      continue
    }

    if (tok.startsWith('--')) {
      const hasEq = tok.includes('=')
      if (!hasEq && spec.longWithArg?.has(tok)) {
        i += 2
      } else {
        i++
      }
      continue
    }

    i += consumeShortFlags(tok, spec.shortWithArg)
  }

  if (spec.skipEnvAssigns) {
    while (i < tokens.length && ENV_ASSIGN_RE.test(tokens[i].token)) {
      i++
    }
  }

  const posCount = spec.positionalArgs ?? 0
  for (let p = 0; p < posCount; p++) {
    if (i >= tokens.length) return null
    if (REDIR_TOKEN_RE.test(tokens[i].token)) return null
    i++
  }

  if (i >= tokens.length) return null
  if (REDIR_TOKEN_RE.test(tokens[i].token)) return null
  return i
}

/**
 * Splits a single shell segment if it starts with a transparent command-wrapper
 * utility (e.g. `timeout 60 aws arg1 arg2` -> `['timeout 60', 'aws arg1 arg2']`,
 * `xargs -0 rm -f` -> `['xargs -0', 'rm -f']`).
 *
 * Loops to unwrap chained wrappers (e.g. `timeout 60 env FOO=1 aws s3 ls`).
 * Returns a single-element array `[segment]` when the segment is not a wrapper
 * or has no inner command.
 */
export function splitWrapperSegments(segment: string): string[] {
  const result: string[] = []
  let current = segment

  for (let depth = 0; depth < MAX_UNWRAP_DEPTH; depth++) {
    const tokens = tokenizeCommandWithSpans(current)
    if (tokens.length < 2) break

    let wrapperIdx = 0
    while (
      wrapperIdx < tokens.length &&
      ENV_ASSIGN_RE.test(tokens[wrapperIdx].token)
    ) {
      wrapperIdx++
    }
    if (wrapperIdx >= tokens.length) break

    const base = commandBasename(tokens[wrapperIdx].token)
    const spec = WRAPPER_SPECS[base]
    if (!spec) break

    const innerIdx = findInnerCommandIndex(tokens, wrapperIdx, spec)
    if (innerIdx === null) break

    const splitOffset = tokens[innerIdx].start
    const wrapperPart = current.slice(0, splitOffset).trimEnd()
    const innerPart = current.slice(splitOffset).trim()
    if (!wrapperPart || !innerPart) break

    result.push(wrapperPart)
    current = innerPart
  }

  result.push(current)
  return result
}
