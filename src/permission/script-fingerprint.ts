import { normalize, resolve, basename, extname, dirname } from 'node:path'
import { readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { splitShellSegments } from '../gate/normalize.ts'
import { extractArgv } from './command-prefix.ts'
import { expandHomePrefix, expandMsysDrive } from './path-scope.ts'

export interface ScriptFingerprint {
  path: string
  hash: string
}

const SCRIPT_EXTENSIONS: ReadonlySet<string> = new Set([
  '.sh',
  '.bash',
  '.zsh',
  '.ps1',
  '.py',
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
])

const SHELL_INTERPRETERS: ReadonlySet<string> = new Set([
  'bash',
  'sh',
  'zsh',
  'dash',
  'ksh',
  'source',
  '.',
])

const NODE_INTERPRETERS: ReadonlySet<string> = new Set([
  'node',
  'nodejs',
  'tsx',
  'ts-node',
  'bun',
  'deno',
])

const PWSH_INTERPRETERS: ReadonlySet<string> = new Set(['pwsh', 'powershell'])

function stripQuotes(token: string): string {
  if (
    (token.startsWith('"') && token.endsWith('"')) ||
    (token.startsWith("'") && token.endsWith("'"))
  ) {
    return token.slice(1, -1)
  }
  return token
}

const DANGEROUS_META_RE = /[*?[\]$`();&|<>]/

export function isScriptFile(token: string): boolean {
  const unquoted = stripQuotes(token).trim()
  if (!unquoted || DANGEROUS_META_RE.test(unquoted)) return false
  const ext = extname(unquoted).toLowerCase()
  return SCRIPT_EXTENSIONS.has(ext)
}

function resolveScriptPath(rawPath: string, currentCwd: string): string {
  const unquoted = stripQuotes(rawPath).trim()
  const expanded = expandHomePrefix(expandMsysDrive(unquoted))
  return normalize(resolve(currentCwd, expanded))
}

function isPythonInterpreter(base: string): boolean {
  return /^python(?:[23](?:\.\d+)?)?$/.test(base) || base === 'py'
}

function isKnownInterpreter(base: string): boolean {
  return (
    SHELL_INTERPRETERS.has(base) ||
    NODE_INTERPRETERS.has(base) ||
    PWSH_INTERPRETERS.has(base) ||
    isPythonInterpreter(base)
  )
}

function unwrapSudo(tokens: string[]): string[] {
  let i = 1
  while (i < tokens.length) {
    const tok = tokens[i]
    if (tok === '--') return tokens.slice(i + 1)
    if (
      ['-u', '-g', '-p', '-c', '-t', '-r', '-U', '-D', '-C', '-T'].includes(tok)
    ) {
      i += 2
    } else if (tok.startsWith('-')) {
      i += 1
    } else {
      break
    }
  }
  return tokens.slice(i)
}

function unwrapEnv(tokens: string[]): string[] {
  let i = 1
  while (i < tokens.length) {
    const tok = tokens[i]
    if (tok === '--') return tokens.slice(i + 1)
    if (['-u', '-C', '-S'].includes(tok)) {
      i += 2
    } else if (tok.startsWith('-')) {
      i += 1
    } else if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tok)) {
      i += 1
    } else {
      break
    }
  }
  return tokens.slice(i)
}

function unwrapNpx(tokens: string[]): string[] {
  let i = 1
  while (i < tokens.length) {
    const tok = tokens[i]
    if (tok === '--') return tokens.slice(i + 1)
    if (tok === '-p' || tok === '--package') {
      i += 2
    } else if (tok.startsWith('-')) {
      i += 1
    } else {
      break
    }
  }
  return tokens.slice(i)
}

function unwrapRunner(
  tokens: string[],
  flagArgs2: string[] = []
): string[] | null {
  let i = 1
  while (i < tokens.length && tokens[i].startsWith('-')) {
    if (flagArgs2.includes(tokens[i])) {
      i += 2
    } else {
      i += 1
    }
  }
  if (i >= tokens.length || tokens[i] !== 'run') return null
  i += 1
  while (i < tokens.length) {
    const tok = tokens[i]
    if (tok === '--') return tokens.slice(i + 1)
    if (flagArgs2.includes(tok)) {
      i += 2
    } else if (tok.startsWith('-')) {
      i += 1
    } else {
      break
    }
  }
  return tokens.slice(i)
}

function unwrapOnce(tokens: string[]): string[] | null {
  if (tokens.length === 0) return null
  const first = stripQuotes(tokens[0])
  const base = basename(first)
    .toLowerCase()
    .replace(/\.(exe|cmd)$/i, '')

  if (base === 'sudo') return unwrapSudo(tokens)
  if (base === 'env') return unwrapEnv(tokens)
  if (base === 'nohup') return tokens.slice(1)
  if (base === 'time') {
    let i = 1
    while (i < tokens.length && tokens[i].startsWith('-')) i++
    return tokens.slice(i)
  }
  if (base === 'nice') {
    let i = 1
    if (tokens[1] === '-n') i += 2
    else if (tokens[1]?.startsWith('-')) i += 1
    return tokens.slice(i)
  }
  if (base === 'npx' || base === 'bunx') return unwrapNpx(tokens)
  if (base === 'npm' || base === 'pnpm' || base === 'yarn') {
    if (tokens[1] === 'exec' || tokens[1] === 'dlx') return tokens.slice(2)
  }
  if (base === 'uv') {
    return unwrapRunner(tokens, [
      '--with',
      '--python',
      '--directory',
      '--project',
      '--env-file',
      '--package',
      '--extra',
    ])
  }
  if (base === 'poetry') {
    return unwrapRunner(tokens, ['-C', '--directory', '--project'])
  }
  if (base === 'pipenv') {
    return unwrapRunner(tokens, ['--site-packages', '--python'])
  }
  return null
}

export function unwrapCommandTokens(tokens: string[]): string[] {
  let current = tokens
  while (current.length > 0) {
    const next = unwrapOnce(current)
    if (!next) break
    current = next
  }
  return current
}

function isInlineCodeFlag(base: string, tok: string): boolean {
  if (
    isPythonInterpreter(base) &&
    (tok === '-c' || tok === '-m' || tok.startsWith('-c='))
  ) {
    return true
  }
  if (
    NODE_INTERPRETERS.has(base) &&
    (tok === '-e' ||
      tok === '--eval' ||
      tok === '-p' ||
      tok === '--print' ||
      tok.startsWith('-e=') ||
      tok.startsWith('--eval=') ||
      tok.startsWith('-p=') ||
      tok.startsWith('--print='))
  ) {
    return true
  }
  if (
    SHELL_INTERPRETERS.has(base) &&
    (/^-[a-zA-Z]*c$/.test(tok) ||
      tok.startsWith('-c=') ||
      tok.startsWith('--command='))
  ) {
    return true
  }
  if (
    PWSH_INTERPRETERS.has(base) &&
    /^-(?:c(?:ommand)?|encodedcommand)(?:=.*)?$/i.test(tok)
  ) {
    return true
  }
  return false
}

function extractPwshFile(base: string, tok: string): string | null {
  if (!PWSH_INTERPRETERS.has(base)) return null
  const m = /^-(?:file|f)(?:=|:)(.+)$/i.exec(tok)
  return m ? m[1] : null
}

function isPwshFileFlag(base: string, tok: string): boolean {
  return PWSH_INTERPRETERS.has(base) && /^-(?:file|f)$/i.test(tok)
}

function getFlagArgStep(base: string, tok: string): number {
  if (
    isPythonInterpreter(base) &&
    ['-W', '-X', '--check-hash-based-pycs'].includes(tok)
  ) {
    return 2
  }
  if (
    NODE_INTERPRETERS.has(base) &&
    [
      '--require',
      '-r',
      '--import',
      '--loader',
      '--tsconfig',
      '-C',
      '--conditions',
      '--env-file',
      '--experimental-loader',
    ].includes(tok)
  ) {
    return 2
  }
  if (
    PWSH_INTERPRETERS.has(base) &&
    /^-(?:executionpolicy|ep|configurationname|custompipename|windowstyle)$/i.test(
      tok
    )
  ) {
    return 2
  }
  if (
    SHELL_INTERPRETERS.has(base) &&
    (tok === '-o' || /^-[a-zA-Z]*o$/.test(tok))
  ) {
    return 2
  }
  return 0
}

function scanInterpreterScript(tokens: string[]): string | null {
  if (tokens.length < 2) return null
  const first = stripQuotes(tokens[0])
  const base = basename(first)
    .toLowerCase()
    .replace(/\.(exe|cmd)$/i, '')
  let i = 1

  if ((base === 'bun' || base === 'deno') && tokens[1] === 'run') {
    i = 2
  }

  while (i < tokens.length) {
    const tok = tokens[i]
    if (isInlineCodeFlag(base, tok)) return null
    const inlineFile = extractPwshFile(base, tok)
    if (inlineFile) {
      return inlineFile
    }
    if (isPwshFileFlag(base, tok)) {
      return i + 1 < tokens.length ? tokens[i + 1] : null
    }
    const step = getFlagArgStep(base, tok)
    if (step > 0) {
      i += step
      continue
    }
    if (tok === '--') {
      i++
      break
    }
    if (tok.startsWith('-')) {
      i++
      continue
    }
    break
  }

  if (i < tokens.length) {
    if (isScriptFile(tokens[i])) {
      return tokens[i]
    }
    if (base === 'source' || base === '.') {
      return tokens[i]
    }
  }
  return null
}

function extractScriptFromSegment(
  segment: string,
  currentCwd: string
): string | null {
  const rawArgv = extractArgv(segment)
  if (rawArgv.length === 0) return null
  const tokens = unwrapCommandTokens(rawArgv)
  if (tokens.length === 0) return null

  if (isScriptFile(tokens[0])) {
    return resolveScriptPath(tokens[0], currentCwd)
  }

  const first = stripQuotes(tokens[0])
  const base = basename(first)
    .toLowerCase()
    .replace(/\.(exe|cmd)$/i, '')
  if (isKnownInterpreter(base)) {
    const rawScript = scanInterpreterScript(tokens)
    if (rawScript) {
      return resolveScriptPath(rawScript, currentCwd)
    }
  }

  return null
}

function updateCwdForSegment(segment: string, currentCwd: string): string {
  const argv = extractArgv(segment)
  if (argv.length < 2) return currentCwd
  const first = stripQuotes(argv[0]).toLowerCase()
  if (first !== 'cd') return currentCwd
  for (let i = 1; i < argv.length; i++) {
    const tok = argv[i]
    if (!tok.startsWith('-')) {
      const unquoted = stripQuotes(tok).trim()
      const expanded = expandHomePrefix(expandMsysDrive(unquoted))
      return normalize(resolve(currentCwd, expanded))
    }
  }
  return currentCwd
}

export function detectExecutedScripts(
  command: string,
  cwd: string = process.cwd()
): string[] {
  const segments = splitShellSegments(command)
  let currentCwd = cwd
  const detected: string[] = []

  for (const segment of segments) {
    currentCwd = updateCwdForSegment(segment, currentCwd)
    const script = extractScriptFromSegment(segment, currentCwd)
    if (script) {
      detected.push(script)
    }
  }

  const seen = new Set<string>()
  const result: string[] = []
  for (const p of detected) {
    const key = process.platform === 'win32' ? p.toLowerCase() : p
    if (!seen.has(key)) {
      seen.add(key)
      result.push(p)
    }
  }
  return result
}

export function computeFileHash(filePath: string): string | null {
  try {
    const stat = statSync(filePath)
    if (!stat.isFile()) return null
    const buf = readFileSync(filePath)
    return createHash('sha256').update(buf).digest('hex')
  } catch {
    return null
  }
}

const NESTED_SCRIPT_EXTENSIONS: ReadonlySet<string> = new Set([
  '.sh',
  '.bash',
  '.zsh',
  '.ps1',
])
const MAX_NESTED_SCAN_SIZE = 64 * 1024 // 64KB

export function captureScriptFingerprints(
  command: string,
  cwd: string = process.cwd()
): ScriptFingerprint[] {
  const scripts = detectExecutedScripts(command, cwd)
  const result: ScriptFingerprint[] = []
  const seenPaths = new Set<string>()

  function addFp(filePath: string, hash: string): void {
    const key = process.platform === 'win32' ? filePath.toLowerCase() : filePath
    if (seenPaths.has(key)) return
    seenPaths.add(key)
    result.push({ path: filePath, hash })
  }

  for (const scriptPath of scripts) {
    const hash = computeFileHash(scriptPath) ?? '__MISSING__'
    addFp(scriptPath, hash)

    if (hash !== '__MISSING__') {
      try {
        const ext = extname(scriptPath).toLowerCase()
        if (NESTED_SCRIPT_EXTENSIONS.has(ext)) {
          const stat = statSync(scriptPath)
          if (stat.isFile() && stat.size <= MAX_NESTED_SCAN_SIZE) {
            const content = readFileSync(scriptPath, 'utf8')
            const nestedScripts = detectExecutedScripts(
              content,
              dirname(scriptPath)
            )
            for (const nestedPath of nestedScripts) {
              const nestedHash = computeFileHash(nestedPath)
              if (nestedHash !== null) {
                addFp(nestedPath, nestedHash)
              }
            }
          }
        }
      } catch {
        // fail safe: ignore read errors during nested scan
      }
    }
  }

  return result
}

export function areScriptFingerprintsIntact(
  fingerprints: readonly ScriptFingerprint[]
): boolean {
  for (const fp of fingerprints) {
    const currentHash = computeFileHash(fp.path) ?? '__MISSING__'
    if (currentHash !== fp.hash) {
      return false
    }
  }
  return true
}

export function verifyScriptFingerprints(
  fingerprints: readonly ScriptFingerprint[],
  command?: string,
  cwd: string = process.cwd()
): boolean {
  if (!areScriptFingerprintsIntact(fingerprints)) {
    return false
  }
  if (command !== undefined) {
    const currentScripts = detectExecutedScripts(command, cwd)
    const fpPaths = new Set(
      process.platform === 'win32'
        ? fingerprints.map((fp) => fp.path.toLowerCase())
        : fingerprints.map((fp) => fp.path)
    )
    for (const s of currentScripts) {
      const key = process.platform === 'win32' ? s.toLowerCase() : s
      if (!fpPaths.has(key)) {
        return false
      }
    }
  }
  return true
}
