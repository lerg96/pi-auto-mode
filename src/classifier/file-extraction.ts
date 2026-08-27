// File extraction for LLM classifier context (Fase 3).
// Mirrors opencode-auto-mode's FileExtraction, scoped down to our needs: pick
// the first path-like argument from a shell command, read it (≤8KB), and apply
// a trust-boundary check + suspicious-content heuristic before forwarding the
// contents to the LLM. Any error becomes `{ kind: 'unsupported', reason }`
// instead of throwing — the classifier wraps this in try/catch but defense in
// depth is mandatory (fail-closed invariant).

import { stat, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { homedir } from 'node:os'

/** Hard cap on bytes we'll read from a referenced file. */
export const SAFE_FILE_SIZE_BYTES = 8_000

/**
 * Tagged union returned by `extractReferencedFile`. Each `kind` carries the
 * minimum context the LLM prompt needs (path + size, where relevant) and is
 * the only contract `llm-layer` consumes.
 */
export type FileExtractionResult =
  | { kind: 'ok'; path: string; content: string; size: number }
  | { kind: 'tooLarge'; path: string; size: number }
  | { kind: 'trustBoundary'; path: string }
  | { kind: 'suspicious'; path: string; matches: string[] }
  | { kind: 'notFound'; path: string }
  | { kind: 'unsupported'; reason: string }

/**
 * Default safe-extension list, adapted from opencode-auto-mode. Anything not
 * in this set is treated as `unsupported` — we do NOT want to forward the
 * contents of `something.png` or `data.zip` to the LLM. The list is a
 * permissive-ish set covering scripts, configs, prose and small data files.
 */
export const SAFE_FILE_EXTENSIONS: ReadonlySet<string> = new Set([
  'js',
  'mjs',
  'cjs',
  'ts',
  'tsx',
  'jsx',
  'py',
  'rb',
  'sh',
  'bash',
  'zsh',
  'ps1',
  'json',
  'yaml',
  'yml',
  'toml',
  'ini',
  'cfg',
  'conf',
  'env',
  'md',
  'txt',
  'log',
  'xml',
  'html',
  'css',
  'scss',
  'sql',
  'csv',
])

/**
 * Patterns that strongly suggest the file is going to do something risky if
 * executed. Linear / non-catastrophic; the labels are stable strings the LLM
 * prompt surfaces verbatim. Keeping them tight avoids drowning the prompt
 * with noise on every script.
 */
const SUSPICIOUS_PATTERNS: ReadonlyArray<{
  label: string
  re: RegExp
}> = [
  { label: 'eval()', re: /\beval\s*\(/ },
  { label: 'child_process', re: /\bchild_process\b/ },
  { label: 'atob()', re: /\batob\s*\(/ },
  { label: 'Buffer.from()', re: /\bBuffer\.from\s*\(/ },
  { label: 'exec()', re: /\bexec\s*\(/ },
  { label: 'subprocess.*', re: /subprocess\.\w+/ },
  { label: 'os.system()', re: /\bos\.system\s*\(/ },
  { label: 'os.popen()', re: /\bos\.popen\s*\(/ },
]

/**
 * Tokens that mark a path-like candidate as NOT a file. We only consume the
 * first path-looking argument; these tokens either take a following value
 * (`-m`, `-c`, `--message`, `--eval`) or are themselves a redirect.
 */
const REDIRECT_RE = /^(?:\d*>+>?|\d*<+)$/

function expandHome(p: string): string {
  // Use homedir() (mockable via jest.doMock('node:os')) so tests can point HOME
  // at a temp dir. We deliberately do NOT read process.env.USERPROFILE/HOME
  // directly because opencode-auto-mode's approach bit us on Windows where
  // `process.env.HOME` is often unset while `homedir()` resolves correctly via
  // USERPROFILE. A single source of truth for home avoids drift.
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return homedir() + p.slice(1)
  }
  return p
}

function normalizeExt(p: string): string {
  const dot = p.lastIndexOf('.')
  if (dot <= 0 || dot === p.length - 1) return ''
  return p.slice(dot + 1).toLowerCase()
}

/**
 * Tokenize a command into whitespace-separated tokens, respecting single and
 * double quotes so we don't capture the inside of `"foo bar"` as two tokens.
 * Intentionally simpler than opencode-auto-mode's full shell tokenizer: the
 * task says `command.split(/\s+/)` is enough. We only refine to skip the case
 * where the user wrote `python "/some path/with space.py"` — quotes should
 * not produce a literal token with quotes still attached.
 */
function tokenize(command: string): string[] {
  const tokens: string[] = []
  let buf = ''
  let quote: '"' | "'" | null = null
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    if (quote) {
      if (ch === quote) {
        quote = null
        if (buf.length > 0) {
          tokens.push(buf)
          buf = ''
        }
      } else {
        buf += ch
      }
      continue
    }
    if (ch === '"' || ch === "'") {
      if (buf.length > 0) {
        tokens.push(buf)
        buf = ''
      }
      quote = ch
      continue
    }
    if (/\s/.test(ch)) {
      if (buf.length > 0) {
        tokens.push(buf)
        buf = ''
      }
      continue
    }
    buf += ch
  }
  if (buf.length > 0) tokens.push(buf)
  return tokens
}

function isPathLike(token: string): boolean {
  if (!token) return false
  if (REDIRECT_RE.test(token)) return false
  // Flag-like arguments: skip anything that starts with a single dash.
  if (token.startsWith('-') && !token.startsWith('-/')) return false
  if (token.startsWith('~/') || token.startsWith('~\\')) return true
  if (token.startsWith('./') || token.startsWith('../')) return true
  if (token.startsWith('/')) return true
  // Windows-style absolute path: "C:\" or "C:/" with at least one more segment.
  if (/^[A-Za-z]:[\\/]/.test(token)) return true
  return false
}

/** Strip surrounding double/single quotes that survived tokenization. */
function stripQuotes(token: string): string {
  return token.replace(/^["']+|["']+$/g, '')
}

/**
 * Pick the first path-like argument from a tokenized command. Honors redirects
 * (the next token after `>` / `>>` / `<` is the target, not a file we want to
 * read) and skips flag arguments that take a value (e.g. `-m`). Returns null
 * when no path-like argument is found OR the candidate has no safe extension.
 *
 * The extension check is the gate: we only forward source/config files to the
 * LLM. Binary or unknown extensions fall through to `unsupported` so the LLM
 * never sees their contents — a malformed regex in a `.log` file would still
 * be picked up by the suspicious scanner, but we don't want to surface
 * arbitrary binary blobs into the prompt.
 */
function findCandidate(command: string): string | null {
  const tokens = tokenize(command)
  let skipNext = false
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (skipNext) {
      skipNext = false
      continue
    }
    // Common shell flags that consume the next argument as their value.
    if (
      token === '-m' ||
      token === '--message' ||
      token === '-c' ||
      token === '-e' ||
      token === '--eval'
    ) {
      skipNext = true
      continue
    }
    if (REDIRECT_RE.test(token)) {
      // Redirect target is the NEXT token; skip it.
      skipNext = true
      continue
    }
    // If the token itself contains `>`, treat it as a redirect (e.g. `>foo`).
    if (token.includes('>')) continue
    if (!isPathLike(token)) continue
    return stripQuotes(token)
  }
  return null
}

/**
 * Decide whether a path is safe to read given the trust boundary. A file
 * matching one of the protected patterns (e.g. `~/.ssh/id_rsa`,
 * `~/.env`, `/etc/passwd`) is rejected with `kind: 'trustBoundary'`. The
 * caller is responsible for surfacing a `[REDACTED: trust boundary]`
 * marker to the LLM.
 *
 * Mirrors opencode-auto-mode's logic for the default boundary and merges any
 * user-defined `protectedPaths` from `Config.classifier.ruleBased.trustBoundary`.
 * When `trustBoundary` is omitted, we apply the same defaults the classifier
 * config uses (`/etc/`, `~/.ssh/`, `~/.env`) so the file extractor is safe
 * even when called directly (e.g. from tests) without a full Config object.
 */
const DEFAULT_PROTECTED_PATHS = ['/etc/', '~/.ssh/', '~/.env']

export function isSafeFile(
  filepath: string,
  trustBoundary?: { protectedPaths: string[] }
): boolean {
  if (!filepath) return false
  const resolved = resolve(expandHome(filepath))
  const normalized = resolved.toLowerCase()
  const protectedPaths =
    trustBoundary && trustBoundary.protectedPaths.length > 0
      ? trustBoundary.protectedPaths
      : DEFAULT_PROTECTED_PATHS
  for (const raw of protectedPaths) {
    if (typeof raw !== 'string' || raw.length === 0) continue
    const expanded = resolve(expandHome(raw)).toLowerCase()
    const isDirPattern = /[\\/]$/.test(expanded)
    if (isDirPattern) {
      if (normalized.startsWith(expanded)) return false
    } else {
      if (
        normalized === expanded ||
        normalized.startsWith(expanded + '\\') ||
        normalized.startsWith(expanded + '/')
      ) {
        return false
      }
    }
  }
  return true
}

/**
 * Scan a file's contents for suspicious markers. Returns the list of labels
 * for patterns that matched (e.g. `["eval()", "child_process"]`). An empty
 * array means the content looks clean. The caller should redact the contents
 * from the LLM prompt if the list is non-empty — leaking raw malicious code
 * is exactly the scenario this guard exists to prevent.
 */
export function isSuspiciousFileContent(text: string): string[] {
  if (!text || typeof text !== 'string') return []
  const matches: string[] = []
  for (const { label, re } of SUSPICIOUS_PATTERNS) {
    if (re.test(text)) matches.push(label)
  }
  return matches
}

/**
 * Async wrapper around `fs.stat` + `fs.readFile`. Any unexpected error
 * becomes `{ kind: 'unsupported', reason }`. NEVER throws.
 *
 * Resolves:
 *   - `null` if the command has no path-like argument
 *   - `kind: 'unsupported'` for unsafe extensions or read errors
 *   - `kind: 'notFound'` for ENOENT
 *   - `kind: 'trustBoundary'` for paths under protected locations
 *   - `kind: 'suspicious'` for files whose contents tripped a pattern
 *   - `kind: 'tooLarge'` for files above SAFE_FILE_SIZE_BYTES
 *   - `kind: 'ok'` otherwise
 */
export async function extractReferencedFile(
  command: string,
  trustBoundary?: { protectedPaths: string[] }
): Promise<FileExtractionResult | null> {
  if (!command || typeof command !== 'string') return null
  let raw: string
  try {
    const candidate = findCandidate(command)
    if (!candidate) return null
    raw = candidate
  } catch (e) {
    return { kind: 'unsupported', reason: errorMessage(e) }
  }

  // Resolve BEFORE the trust-boundary check so `~/foo` and `./foo` are
  // normalized the same way; otherwise we'd miss e.g. `./.ssh/id_rsa` because
  // its dirname (`.ssh`) is benign-looking until resolved.
  let abs: string
  try {
    abs = resolve(expandHome(raw))
  } catch (e) {
    return { kind: 'unsupported', reason: errorMessage(e) }
  }

  // Trust boundary first: even files with an "unsafe" extension (e.g. a
  // user-named `~/.env` without a `.txt` suffix) must be refused BEFORE we
  // fall through to the extension whitelist. Otherwise the user could trick
  // the LLM into "we don't know what to do with that, skipping" rather than
  // a clean refusal.
  if (!isSafeFile(abs, trustBoundary)) {
    return { kind: 'trustBoundary', path: abs }
  }

  // Extension whitelist: after the trust check has had its say, refuse files
  // we don't want to forward to the LLM (binary blobs, archives, images).
  // We return `null` (not `unsupported`) for these because there is nothing
  // interesting to report to the LLM — the file simply isn't a candidate.
  const ext = normalizeExt(abs)
  if (!ext || !SAFE_FILE_EXTENSIONS.has(ext)) return null

  let info
  try {
    info = await stat(abs)
  } catch (e) {
    const code = (e as { code?: string }).code
    if (code === 'ENOENT') return { kind: 'notFound', path: abs }
    return { kind: 'unsupported', reason: errorMessage(e) }
  }
  if (!info.isFile()) {
    return { kind: 'unsupported', reason: 'not a regular file' }
  }
  if (info.size > SAFE_FILE_SIZE_BYTES) {
    return { kind: 'tooLarge', path: abs, size: info.size }
  }

  let content: string
  try {
    content = await readFile(abs, 'utf8')
  } catch (e) {
    return { kind: 'unsupported', reason: errorMessage(e) }
  }
  // Guard against trailing NUL or control chars messing with the LLM's JSON
  // parsing; truncate to the cap (stat size is the source of truth).
  if (content.length > SAFE_FILE_SIZE_BYTES) {
    content = content.slice(0, SAFE_FILE_SIZE_BYTES)
  }

  const matches = isSuspiciousFileContent(content)
  if (matches.length > 0) {
    return { kind: 'suspicious', path: abs, matches }
  }
  return { kind: 'ok', path: abs, content, size: info.size }
}

/**
 * Build the prompt fragment that {@link extractReferencedFile} produces. Pure
 * formatter — no I/O. Exposed for tests and for `llm-layer` to compose into
 * the larger prompt. The branch labels here are stable: the LLM uses them
 * to know when a file was redacted vs. simply absent.
 */
export function formatFileExtraction(result: FileExtractionResult): string {
  switch (result.kind) {
    case 'ok':
      return `File referenced: ${result.path} (${result.size} bytes)\n${result.content}`
    case 'tooLarge':
      return `File referenced: ${result.path} (>${SAFE_FILE_SIZE_BYTES} bytes — content omitted)`
    case 'trustBoundary':
      return `File referenced: ${result.path}\n[REDACTED: trust boundary]`
    case 'suspicious':
      return `File referenced: ${result.path}\n[REDACTED: suspicious content: ${result.matches.join(', ')}]`
    case 'notFound':
      return `File referenced: ${result.path}\n[REDACTED: file not found]`
    case 'unsupported':
      return `File referenced: [UNSUPPORTED: ${result.reason}]`
  }
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message
  return String(e)
}
