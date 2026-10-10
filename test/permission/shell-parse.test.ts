import { resolve } from 'node:path'
import { parseConfig } from '../../src/types/config.ts'
import { normalizeToolCall } from '../../src/gate/normalize.ts'
import { evaluateExternalDirectory } from '../../src/permission/external-directory.ts'
import {
  extractTreePaths,
  initShellParser,
  isShellParserReady,
} from '../../src/permission/shell-parse.ts'

const cwd = process.cwd()
const outside = (name: string): string => resolve(cwd, '..', name)

function cfgWith(raw: unknown): ReturnType<typeof parseConfig> {
  return parseConfig(raw)
}

function confineBash(): ReturnType<typeof parseConfig> {
  return cfgWith({
    confineToWorkingDirectory: true,
    permissions: { tools: { bash: 'allow' } },
  })
}

beforeAll(async () => {
  await initShellParser()
  expect(isShellParserReady()).toBe(true)
}, 30000)

describe('tree-sitter shell extractor', () => {
  it('sed program with spaces stays atomic (reported LOOP shape)', () => {
    expect(extractTreePaths('sed "s/^/LOOP1: /"')).toEqual(['s/^/LOOP1: /'])
  })

  it('python -c script stays atomic, no p: debris', () => {
    const got = extractTreePaths('python3 -c "for p in xs: print(p)"')
    expect(got).not.toContain('p:')
    expect(got).not.toContain('p:\\')
  })

  it('rg alternation stays atomic', () => {
    const got = extractTreePaths('rg -n "a|b" f.kt')
    expect(got).not.toContain('a')
    expect(got).not.toContain('b')
  })

  it('heredocs bypass the tree (wasm scanner crash class → heuristic)', () => {
    // `<<` constructs throw inside web-tree-sitter 0.20.x; the extractor
    // returns null and evaluateExternalDirectory falls back to heuristic.
    expect(
      extractTreePaths("python3 <<'EOF'\nfor p in xs:\nprint(p)\nEOF")
    ).toBeNull()
    // Herestrings parse fine and must not match the heredoc pre-check.
    expect(extractTreePaths('cat <<< "hello"')).toEqual([])
  })

  it('comments never contribute paths', () => {
    expect(extractTreePaths('ls # /tmp/x')).toEqual([])
  })

  it('redirect targets are detected', () => {
    const target = outside('o.log')
    expect(extractTreePaths(`cmd 2> ${target}`)).toContain(target)
  })

  it('command substitutions are descended into', () => {
    expect(extractTreePaths('echo $(cat /etc/passwd)')).toContain('/etc/passwd')
  })

  it('case statements bypass the tree (second wasm crash class)', () => {
    // `;;` terminators throw inside web-tree-sitter 0.20.x like heredocs
    // do; null → heuristic fallback, same contract as heredocs.
    expect(extractTreePaths('case $x in *.xml) echo hi;; esac')).toBeNull()
  })

  it('=~ regex right side is data', () => {
    expect(extractTreePaths('[[ $x =~ ^/tmp/ ]]')).toEqual([])
  })

  it('shell for-loop variable is not a path', () => {
    expect(extractTreePaths('for p in a b; do echo $p; done')).toEqual([])
  })

  it('arithmetic expansions are data', () => {
    expect(extractTreePaths('echo $((a/b))')).toEqual([])
  })

  it('fail-closed shapes still count: del backslash-star, root, quoted outside', () => {
    expect(extractTreePaths('del \\*')).toEqual(['\\*'])
    expect(extractTreePaths('ls /')).toEqual(['/'])
    const target = outside('x.txt')
    expect(extractTreePaths(`cat "${target}"`)).toContain(target)
  })

  it('over-cap input returns null (heuristic fallback)', () => {
    expect(extractTreePaths(`echo ${'x'.repeat(64 * 1024 + 1)}`)).toBeNull()
  })

  it('full LOOP pipeline through gate normalize has no verdict', () => {
    const cfg = confineBash()
    const intents = normalizeToolCall('bash', {
      command:
        'for i in 1 2; do ./gradlew :app:x 2>&1 | rg "BUILD (SUCCESS|FAILED)" | tail -n 1 | sed "s/^/LOOP$i: /"; done (timeout 1200s)',
    })
    expect(intents.some((x) => x.rawValue !== undefined)).toBe(true)
    expect(evaluateExternalDirectory(cfg, intents)).toBeUndefined()
  })

  it('verdicts carry the tree-sitter engine', () => {
    const cfg = confineBash()
    const target = outside('o.log')
    const verdict = evaluateExternalDirectory(cfg, [
      { surface: 'shell', value: `cmd 2> x`, rawValue: `cmd 2> ${target}` },
    ])
    expect(verdict?.action).toBe('ask')
    expect(verdict?.engine).toBe('tree-sitter')
    expect(verdict?.matchedValue).toBe(`cmd 2> ${target}`)
  })

  it('redirection descriptor duplicates and variants produce no bogus path debris', () => {
    expect(extractTreePaths('agy --help 2>&1')).toEqual([])
    expect(extractTreePaths('cmd 2>&1')).toEqual([])
    expect(extractTreePaths('cmd >&2')).toEqual([])
    expect(extractTreePaths('cmd <&0')).toEqual([])
    expect(extractTreePaths('cmd >&-')).toEqual([])
    expect(extractTreePaths('cmd <&-')).toEqual([])
    expect(extractTreePaths('cmd 1>&2')).toEqual([])
    expect(extractTreePaths('echo "---EXIT:$?---"')).toEqual([])

    const target = outside('all.log')
    expect(extractTreePaths(`cmd &> ${target}`)).toContain(target)
    expect(extractTreePaths(`cmd &>> ${target}`)).toContain(target)
    expect(extractTreePaths(`cmd >& ${target}`)).toContain(target)
  })

  it('example compound pipeline through normalizeToolCall has no verdict under tree-sitter', () => {
    const cfg = confineBash()
    const exampleCmd =
      'agy --help 2>&1 | head -n 200; echo "---EXIT:$?---"; which agy; agy models list 2>&1 | head -n 100 || agy model list 2>&1 | head -n 100'
    const intents = normalizeToolCall('bash', { command: exampleCmd })
    expect(intents).toHaveLength(8)
    expect(intents.map((i) => i.value)).not.toContain('1')
    expect(evaluateExternalDirectory(cfg, intents)).toBeUndefined()
  })
})
