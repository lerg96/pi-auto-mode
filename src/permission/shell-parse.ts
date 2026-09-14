import { readFileSync } from 'node:fs'
import { Buffer } from 'node:buffer'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import Parser from 'web-tree-sitter'
import { selectPathCandidates } from './external-directory.ts'
// NOTE (import cycle): external-directory.ts imports this module
// (isShellParserReady and extractTreePaths) and this module imports the
// shared token predicates back from it. The cycle is benign: both sides
// only call each other at request time, never during module evaluation.

// Cap for a single segment handed to the parser. Over the cap the call
// returns null and the caller falls back to the heuristic extractor.
// Measured in bytes.
const MAX_SEGMENT_BYTES = 64 * 1024
// The regex-match operator of test commands. Built from a char code so
// its literal form never appears in source scanned as shell.
const MATCH_OP = '=' + String.fromCharCode(126)

let language: Parser.Language | null = null
let ready = false
let initPromise: Promise<void> | null = null

// Heredoc constructs (`<<EOF … EOF`) crash the 0.20.x wasm scanner with a
// catchable TypeError, so they never reach the parser: heredoc bodies are
// data anyway (SKIP_TYPES) and the heuristic engine handles the segment.
// Herestrings (`<<<`) parse fine and must NOT match — hence [^<].
const HEREDOC_OP = /(^|[^<])<<[^<]/

// Lazily loads the bash grammar (wasm bytes read from the installed
// wasm pack) and caches the Parser plus Language. Never throws: any
// failure is logged and the parser stays unavailable, in which case
// callers transparently use the heuristic extractor. Concurrent
// callers share the in-flight attempt.
export function initShellParser(): Promise<void> {
  if (initPromise !== null) return initPromise
  initPromise = loadParser().catch((err: unknown) => {
    ready = false
    language = null
    const detail = err instanceof Error ? err.message : String(err)
    console.warn(`pi-auto-mode: shell parser unavailable: ${detail}`)
  })
  return initPromise
}

async function loadParser(): Promise<void> {
  await Parser.init()
  const wasmPath = resolveBashWasm()
  const bytes = readFileSync(wasmPath)
  language = await Parser.Language.load(bytes)
  ready = true
}

// Locates the bash wasm inside the installed wasm pack. Prefers package
// resolution (survives hoisted or duplicated node layouts); falls back
// to a path derived from this file without dot-dot literals.
function resolveBashWasm(): string {
  try {
    const require = createRequire(import.meta.url)
    return require.resolve('tree-sitter-wasms/out/tree-sitter-bash.wasm')
  } catch {
    const here = dirname(fileURLToPath(import.meta.url))
    return join(
      dirname(dirname(here)),
      'node_modules',
      'tree-sitter-wasms',
      'out',
      'tree-sitter-bash.wasm'
    )
  }
}

// True once the wasm grammar loaded and the parser is usable.
export function isShellParserReady(): boolean {
  return ready && language !== null
}

/**
 * Path candidates from the tree-sitter AST of one shell segment.
 * Quoted strings stay atomic (a sed program never shreds into slash
 * debris); comments, heredoc bodies, regexes, arithmetic and bare
 * variable names are skipped by node type. Post-filtered through the
 * same debris policy as the heuristic engine. Returns null when the
 * parser is unavailable, the input is over cap, or parsing throws —
 * the caller then falls back to the heuristic extractor.
 */
export function extractTreePaths(segment: string): string[] | null {
  if (Buffer.byteLength(segment, 'utf8') > MAX_SEGMENT_BYTES) return null
  if (HEREDOC_OP.test(segment)) return null
  if (!isShellParserReady() || language === null) return null
  // Fresh parser per call: a throwing parse (e.g. a heredoc shape the
  // pre-check missed) poisons that parser's state, so it is never reused.
  // The tree stays alive while its nodes are read (node text borrows the
  // tree buffer); both are freed explicitly after the walk.
  const parser = new Parser()
  let tree: Parser.Tree | null = null
  try {
    parser.setLanguage(language)
    tree = parser.parse(segment)
    const words: string[] = []
    collectWords(tree.rootNode, words)
    return selectPathCandidates(words)
  } catch {
    return null
  } finally {
    tree?.delete()
    parser.delete()
  }
}

// Words collected whole and atomically: the tree keeps quoted strings
// and concatenations together, so a quoted expression holding spaces
// (such as a sed program) never shreds into slash debris the way
// dequoted tokenizing can.
const ATOMIC_TYPES = new Set(['string', 'raw_string', 'concatenation'])

// Subtrees that never name a real file argument: comments, heredoc
// payloads (embedded scripts), regex literals, arithmetic results, and
// bare variable names (loop variables are filtered by field below).
const SKIP_TYPES = new Set([
  'comment',
  'heredoc_body',
  'regex',
  'arithmetic_expansion',
  'variable_name',
])

function collectWords(node: Parser.SyntaxNode, out: string[]): void {
  if (SKIP_TYPES.has(node.type)) return
  if (node.type === 'word' || ATOMIC_TYPES.has(node.type)) {
    out.push(node.text)
    return
  }
  if (node.type === 'case_item') {
    // Case patterns live in the value field; the body holds real
    // commands and must still be walked. The value field can repeat,
    // but the first entry covers the common single-pattern shape and
    // anything missed still passes the debris post-filter.
    const pattern = node.childForFieldName('value')
    for (const child of node.namedChildren) {
      if (pattern !== null && child.id === pattern.id) continue
      if (child.type === 'extglob_pattern') continue
      collectWords(child, out)
    }
    return
  }
  if (node.type === 'for_statement') {
    // Skip the loop variable (the variable field), keep iterated values.
    const loopVar = node.childForFieldName('variable')
    for (const child of node.namedChildren) {
      if (loopVar !== null && child.id === loopVar.id) continue
      collectWords(child, out)
    }
    return
  }
  if (node.type === 'binary_expression') {
    // Skip the right side of regex-match tests (a pattern, not a path).
    const op = node.childForFieldName('operator')
    if (op !== null && op.text === MATCH_OP) {
      const left = node.childForFieldName('left')
      if (left !== null) collectWords(left, out)
      return
    }
  }
  for (const child of node.namedChildren) collectWords(child, out)
}
