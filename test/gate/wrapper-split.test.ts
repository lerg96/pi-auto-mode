import { splitWrapperSegments } from '../../src/gate/wrapper-split.ts'
import {
  normalizeToolCall,
  segmentCommand,
  splitShellSegments,
} from '../../src/gate/normalize.ts'
import { gateToolCall, type GateDeps } from '../../src/gate/gate.ts'
import { configState } from '../../src/state/config-state.ts'
import {
  SessionRules,
  resetSessionRulesRegistry,
} from '../../src/permission/session-rules.ts'
import {
  setAskResolver,
  defaultAskResolver,
  type AskRequest,
} from '../../src/gate/ask.ts'
import type { Config } from '../../src/types/config.ts'

describe('splitWrapperSegments', () => {
  describe('timeout / gtimeout', () => {
    it('splits basic timeout with duration and inner command', () => {
      expect(splitWrapperSegments('timeout 60 aws arg1 arg2')).toEqual([
        'timeout 60',
        'aws arg1 arg2',
      ])
    })

    it('handles timeout flags with and without arguments', () => {
      expect(
        splitWrapperSegments('timeout -k 5 -s TERM 60s aws s3 ls')
      ).toEqual(['timeout -k 5 -s TERM 60s', 'aws s3 ls'])
      expect(
        splitWrapperSegments(
          'timeout --foreground --kill-after=10 --signal=KILL 30m npm test'
        )
      ).toEqual([
        'timeout --foreground --kill-after=10 --signal=KILL 30m',
        'npm test',
      ])
      expect(splitWrapperSegments('timeout -k5 -s9 15 python3 app.py')).toEqual(
        ['timeout -k5 -s9 15', 'python3 app.py']
      )
    })

    it('handles -- option terminator and gtimeout / path-qualified binaries', () => {
      expect(splitWrapperSegments('timeout -- 60 aws s3 ls')).toEqual([
        'timeout -- 60',
        'aws s3 ls',
      ])
      expect(
        splitWrapperSegments('gtimeout 10s curl https://example.com')
      ).toEqual(['gtimeout 10s', 'curl https://example.com'])
      expect(splitWrapperSegments('/usr/bin/timeout 60 aws s3 ls')).toEqual([
        '/usr/bin/timeout 60',
        'aws s3 ls',
      ])
    })

    it('leaves timeout without inner command intact', () => {
      expect(splitWrapperSegments('timeout 60')).toEqual(['timeout 60'])
      expect(splitWrapperSegments('timeout --help')).toEqual(['timeout --help'])
      expect(splitWrapperSegments('timeout 60 > /tmp/out')).toEqual([
        'timeout 60 > /tmp/out',
      ])
    })
  })

  describe('xargs', () => {
    it('splits bare xargs with inner command', () => {
      expect(splitWrapperSegments('xargs rm -f')).toEqual(['xargs', 'rm -f'])
    })

    it('handles short, combined, attached, and long xargs options', () => {
      expect(
        splitWrapperSegments('xargs -0 -P 4 -I {} aws s3 cp {} s3://bucket/')
      ).toEqual(['xargs -0 -P 4 -I {}', 'aws s3 cp {} s3://bucket/'])
      expect(splitWrapperSegments('xargs -0r -n1 -I{} rm -rf {}')).toEqual([
        'xargs -0r -n1 -I{}',
        'rm -rf {}',
      ])
      expect(splitWrapperSegments('xargs -0I {} aws s3 rm {}')).toEqual([
        'xargs -0I {}',
        'aws s3 rm {}',
      ])
      expect(
        splitWrapperSegments('xargs --null --max-args=1 --max-procs 4 git add')
      ).toEqual(['xargs --null --max-args=1 --max-procs 4', 'git add'])
    })

    it('leaves xargs without inner command intact', () => {
      expect(splitWrapperSegments('xargs')).toEqual(['xargs'])
      expect(splitWrapperSegments('xargs -0 -n 1')).toEqual(['xargs -0 -n 1'])
    })
  })

  describe('other command wrappers', () => {
    it('splits nice, nohup, time, env, stdbuf, ionice, setsid, watch, chrt, taskset, unbuffer, command, exec', () => {
      expect(splitWrapperSegments('nice -n 10 aws s3 sync . s3://b')).toEqual([
        'nice -n 10',
        'aws s3 sync . s3://b',
      ])
      expect(splitWrapperSegments('nice -10 make -j4')).toEqual([
        'nice -10',
        'make -j4',
      ])
      expect(splitWrapperSegments('nohup python3 server.py')).toEqual([
        'nohup',
        'python3 server.py',
      ])
      expect(splitWrapperSegments('time -p npm test')).toEqual([
        'time -p',
        'npm test',
      ])
      expect(splitWrapperSegments('env FOO=1 BAR=2 aws s3 ls')).toEqual([
        'env FOO=1 BAR=2',
        'aws s3 ls',
      ])
      expect(splitWrapperSegments('env -i -u HOME FOO=1 node app.js')).toEqual([
        'env -i -u HOME FOO=1',
        'node app.js',
      ])
      expect(splitWrapperSegments('stdbuf -oL -eL python3 app.py')).toEqual([
        'stdbuf -oL -eL',
        'python3 app.py',
      ])
      expect(splitWrapperSegments('ionice -c 3 tar -czf a.tar.gz dir')).toEqual(
        ['ionice -c 3', 'tar -czf a.tar.gz dir']
      )
      expect(splitWrapperSegments('setsid -f python3 worker.py')).toEqual([
        'setsid -f',
        'python3 worker.py',
      ])
      expect(splitWrapperSegments('watch -n 2 aws s3 ls')).toEqual([
        'watch -n 2',
        'aws s3 ls',
      ])
      expect(splitWrapperSegments('chrt -r 10 ./daemon')).toEqual([
        'chrt -r 10',
        './daemon',
      ])
      expect(splitWrapperSegments('taskset -c 0-3 ./worker')).toEqual([
        'taskset -c 0-3',
        './worker',
      ])
      expect(splitWrapperSegments('unbuffer make test')).toEqual([
        'unbuffer',
        'make test',
      ])
      expect(splitWrapperSegments('command -p aws s3 ls')).toEqual([
        'command -p',
        'aws s3 ls',
      ])
      expect(splitWrapperSegments('exec -a custom aws s3 ls')).toEqual([
        'exec -a custom',
        'aws s3 ls',
      ])
    })

    it('does not split non-executing invocations of command, taskset, ionice, chrt, env, exec', () => {
      expect(splitWrapperSegments('command -v aws')).toEqual(['command -v aws'])
      expect(splitWrapperSegments('command -V aws')).toEqual(['command -V aws'])
      expect(splitWrapperSegments('taskset -p 1234')).toEqual([
        'taskset -p 1234',
      ])
      expect(splitWrapperSegments('ionice -c 3 -p 1234')).toEqual([
        'ionice -c 3 -p 1234',
      ])
      expect(splitWrapperSegments('chrt -p 1234')).toEqual(['chrt -p 1234'])
      expect(splitWrapperSegments('env')).toEqual(['env'])
      expect(splitWrapperSegments('env FOO=1')).toEqual(['env FOO=1'])
      expect(splitWrapperSegments('env -S "aws s3 ls"')).toEqual([
        'env -S "aws s3 ls"',
      ])
      expect(splitWrapperSegments('exec > /tmp/out.log')).toEqual([
        'exec > /tmp/out.log',
      ])
      expect(splitWrapperSegments('exec 2>&1')).toEqual(['exec 2>&1'])
    })

    it('does not split sudo or bash -c', () => {
      expect(splitWrapperSegments('sudo apt install nginx')).toEqual([
        'sudo apt install nginx',
      ])
      expect(splitWrapperSegments('bash -c "aws s3 ls"')).toEqual([
        'bash -c "aws s3 ls"',
      ])
    })
  })

  describe('chaining, env prefixes, and integration with segmentCommand', () => {
    it('unwraps chained wrappers recursively', () => {
      expect(
        splitWrapperSegments('timeout 60 env FOO=1 nice -n 10 aws s3 ls')
      ).toEqual(['timeout 60', 'env FOO=1', 'nice -n 10', 'aws s3 ls'])
      expect(splitWrapperSegments('timeout 60 xargs -0 rm -rf /tmp/x')).toEqual(
        ['timeout 60', 'xargs -0', 'rm -rf /tmp/x']
      )
    })

    it('handles leading shell env assignment before wrapper', () => {
      expect(
        splitWrapperSegments('AWS_PROFILE=prod timeout 60 aws s3 ls')
      ).toEqual(['AWS_PROFILE=prod timeout 60', 'aws s3 ls'])
    })

    it('integrates with pipes, find -exec, heredocs, and preserves plain/raw 1:1 parity', () => {
      expect(
        splitShellSegments('find . -name "*.log" | xargs -0 -P 4 aws s3 rm')
      ).toEqual(['find . -name *.log', 'xargs -0 -P 4', 'aws s3 rm'])

      expect(
        splitShellSegments('timeout 60 find . -exec rm -f {} \\;')
      ).toEqual(['timeout 60', 'find . -exec rm -f {} \\;', 'rm -f {}'])

      const heredocCmd = 'timeout 60 cat <<EOF\nhello\nEOF'
      expect(splitShellSegments(heredocCmd)).toEqual([
        'timeout 60',
        'cat <<EOF\nhello\nEOF',
      ])

      const quotedCmd =
        'timeout 60 aws s3 ls "my bucket" | xargs -I {} echo "{}"'
      const plain = segmentCommand(quotedCmd)
      const raw = segmentCommand(quotedCmd, { keepQuotes: true })
      expect(raw).toHaveLength(plain.length)
      expect(raw.map((s) => s.quoted)).toEqual(plain.map((s) => s.quoted))
      expect(plain.map((s) => s.value)).toEqual([
        'timeout 60',
        'aws s3 ls my bucket',
        'xargs -I {}',
        'echo {}',
      ])
      expect(raw.map((s) => s.value)).toEqual([
        'timeout 60',
        'aws s3 ls "my bucket"',
        'xargs -I {}',
        'echo "{}"',
      ])

      const intents = normalizeToolCall('bash', { command: quotedCmd })
      expect(intents.map((i) => i.value)).toEqual([
        'timeout 60',
        'aws s3 ls my bucket',
        'xargs -I {}',
        'echo {}',
      ])
      expect(intents[1].rawValue).toBe('aws s3 ls "my bucket"')
    })
  })
})

describe('gateToolCall with wrapper commands', () => {
  const baseConfig: Config = {
    permissions: {
      tools: {
        '*': 'ask',
        bash: [{ pattern: '*', action: 'ask' }],
      },
      skills: {},
      mcps: {},
    },
    permissionSets: {},
    activePermissionSets: [],
    mode: 'default',
    confineToWorkingDirectory: false,
    trustGitWorktrees: true,
    externalDirectoryTools: ['bash', 'write', 'edit', 'read'],
    classifier: {
      enabled: false,
      llm: {
        provider: 'anthropic',
        model: 'claude-opus-4',
        baseUrl: '',
        apiKey: '',
        timeoutMs: 5000,
        maxTokens: 256,
        fallbackModel: '',
        systemPrompt: '',
        enabled: false,
      },
      fallback: { onTimeout: 'ask-user', onError: 'ask-user' },
      onBlock: 'deny',
      onBlockUserOverride: false,
    },
    denyStrategy: {
      mode: 'auto-retry',
      escalation: { consecutive: 3, total: 10 },
    },
    ui: {
      promptMaxRows: 10,
      promptFieldMaxWidth: 80,
      showClassifierRisk: true,
      modalTimeoutMs: 120000,
      subagentModalTimeoutMs: 120000,
      noUiAsks: 'bubble',
    },
    telemetry: {
      enabled: false,
      path: '',
      rotationEnabled: true,
      maxBytes: 5242880,
      maxFiles: 3,
    },
    debug: {
      enabled: false,
      path: '',
      rotationEnabled: true,
      maxBytes: 5242880,
      maxFiles: 3,
    },
  }

  afterEach(() => {
    setAskResolver(defaultAskResolver)
    resetSessionRulesRegistry()
  })

  function makeDeps(): GateDeps {
    return {
      configState,
      sessionRules: new SessionRules(),
      hooks: {},
    }
  }

  it('asks for timeout and aws separately when both are in ask', async () => {
    configState.set(baseConfig)
    const asked: AskRequest[] = []
    setAskResolver(async (req) => {
      asked.push(req)
      return { decision: 'allow_once', via: 'modal' }
    })

    await gateToolCall(
      'bash',
      { command: 'timeout 60 aws arg1 arg2' },
      makeDeps()
    )

    expect(asked.map((r) => r.value)).toEqual(['timeout 60', 'aws arg1 arg2'])
    expect(asked[0].segmentIndex).toBe(1)
    expect(asked[0].segmentTotal).toBe(2)
    expect(asked[1].segmentIndex).toBe(2)
    expect(asked[1].segmentTotal).toBe(2)
  })

  it('skips timeout modal and asks only for aws when timeout * is allowed', async () => {
    configState.set({
      ...baseConfig,
      permissions: {
        ...baseConfig.permissions,
        tools: {
          '*': 'ask',
          bash: [
            { pattern: 'timeout *', action: 'allow' },
            { pattern: '*', action: 'ask' },
          ],
        },
      },
    })
    const asked: AskRequest[] = []
    setAskResolver(async (req) => {
      asked.push(req)
      return { decision: 'allow_once', via: 'modal' }
    })

    await gateToolCall(
      'bash',
      { command: 'timeout 60 aws arg1 arg2' },
      makeDeps()
    )

    expect(asked.map((r) => r.value)).toEqual(['aws arg1 arg2'])
    expect(asked[0].segmentIndex).toBe(1)
    expect(asked[0].segmentTotal).toBe(1)
  })

  it('denies inner command matching deny rule even when timeout * or xargs * is allowed', async () => {
    configState.set({
      ...baseConfig,
      permissions: {
        ...baseConfig.permissions,
        tools: {
          '*': 'ask',
          bash: [
            { pattern: 'timeout *', action: 'allow' },
            { pattern: 'xargs *', action: 'allow' },
            { pattern: 'ls *', action: 'allow' },
            { pattern: 'ls', action: 'allow' },
            { pattern: 'rm -rf *', action: 'deny', reason: 'destructive' },
            { pattern: '*', action: 'ask' },
          ],
        },
      },
    })

    await expect(
      gateToolCall(
        'bash',
        { command: 'timeout 60 rm -rf /tmp/foo' },
        makeDeps()
      )
    ).rejects.toThrow()

    await expect(
      gateToolCall(
        'bash',
        { command: 'ls | xargs -0 rm -rf /tmp/foo' },
        makeDeps()
      )
    ).rejects.toThrow()
  })

  it('allows without modal when both wrapper and inner command are allowed', async () => {
    configState.set({
      ...baseConfig,
      permissions: {
        ...baseConfig.permissions,
        tools: {
          '*': 'ask',
          bash: [
            { pattern: 'timeout *', action: 'allow' },
            { pattern: 'aws get_*', action: 'allow' },
            { pattern: '*', action: 'ask' },
          ],
        },
      },
    })
    const asked: AskRequest[] = []
    setAskResolver(async (req) => {
      asked.push(req)
      return { decision: 'allow_once', via: 'modal' }
    })

    await gateToolCall(
      'bash',
      { command: 'timeout 60 aws get_caller_identity' },
      makeDeps()
    )

    expect(asked).toHaveLength(0)
  })
})
