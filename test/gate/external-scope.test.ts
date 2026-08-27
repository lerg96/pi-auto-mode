import { resolve } from 'node:path'
import { gateToolCall } from '../../src/gate/gate.ts'
import { configState } from '../../src/state/config-state.ts'
import { SessionRules } from '../../src/permission/session-rules.ts'
import { DenyAndContinueService } from '../../src/deny/deny-service.ts'
import { setAskResolver, getAskResolver } from '../../src/gate/ask.ts'
import type { ClassifierResult } from '../../src/classifier/llm-layer.ts'
import { parseConfig } from '../../src/types/config.ts'

const cwd = process.cwd()
const outsideAbs = resolve(cwd, '..', 'external-scope-probe.txt')

function makeDeps(mode: 'auto-retry' | 'ask-user') {
  const sessionRules = new SessionRules()
  const denyService = new DenyAndContinueService({
    mode,
    escalation: { consecutive: 3, total: 20 },
  })
  const classify = async (): Promise<ClassifierResult> => ({
    decision: 'allow',
  })
  return { configState, sessionRules, hooks: {}, classify, denyService }
}

describe('gateToolCall external_directory scope', () => {
  afterEach(() => {
    setAskResolver(getAskResolver())
  })

  it('(a) allow + external-ask → resolver IS called', async () => {
    configState.set(
      parseConfig({
        confineToWorkingDirectory: true,
        permissions: { tools: { read: 'allow' } },
        denyStrategy: {
          mode: 'ask-user',
          escalation: { consecutive: 3, total: 20 },
        },
      })
    )
    const deps = makeDeps('ask-user')
    let called = false
    setAskResolver(async () => {
      called = true
      return 'allow'
    })
    await gateToolCall('read', { path: outsideAbs }, deps)
    expect(called).toBe(true)
  })

  it('(b) deny + external-allow → throws deny', async () => {
    configState.set(
      parseConfig({
        confineToWorkingDirectory: true,
        permissions: {
          tools: { read: 'deny' },
          external_directory: { '*': 'allow' },
        },
        denyStrategy: {
          mode: 'auto-retry',
          escalation: { consecutive: 3, total: 20 },
        },
      })
    )
    const deps = makeDeps('auto-retry')
    let called = false
    setAskResolver(async () => {
      called = true
      return 'allow'
    })
    await expect(
      gateToolCall('read', { path: outsideAbs }, deps)
    ).rejects.toThrow(/blocked by a deny rule/)
    expect(called).toBe(false)
  })

  it('(c) explicit external deny → throws with the path in the message', async () => {
    configState.set(
      parseConfig({
        confineToWorkingDirectory: true,
        permissions: {
          tools: { read: 'allow' },
          external_directory: { '*': 'deny' },
        },
        denyStrategy: {
          mode: 'auto-retry',
          escalation: { consecutive: 3, total: 20 },
        },
      })
    )
    const deps = makeDeps('auto-retry')
    setAskResolver(async () => 'allow')
    await expect(
      gateToolCall('read', { path: outsideAbs }, deps)
    ).rejects.toThrow(outsideAbs)
  })

  it('(e) ask reports the triggering intent, not the first', async () => {
    configState.set(
      parseConfig({
        confineToWorkingDirectory: true,
        permissions: { tools: { bash: 'allow' } },
        denyStrategy: {
          mode: 'ask-user',
          escalation: { consecutive: 3, total: 20 },
        },
      })
    )
    const deps = makeDeps('ask-user')
    let seen: string | undefined
    setAskResolver(async (req) => {
      seen = req.value
      return 'allow'
    })
    await gateToolCall(
      'bash',
      { command: 'git add a.txt && cd /tmp/uicheck' },
      deps
    )
    expect(seen).toBe('cd /tmp/uicheck')
  })

  it('(d) flag off → direct allow, resolver NOT called', async () => {
    configState.set(
      parseConfig({
        permissions: { tools: { read: 'allow' } },
        denyStrategy: {
          mode: 'ask-user',
          escalation: { consecutive: 3, total: 20 },
        },
      })
    )
    const deps = makeDeps('ask-user')
    let called = false
    setAskResolver(async () => {
      called = true
      return 'allow'
    })
    await gateToolCall('read', { path: outsideAbs }, deps)
    expect(called).toBe(false)
  })
})
