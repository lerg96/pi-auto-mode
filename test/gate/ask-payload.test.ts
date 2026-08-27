import { gateToolCall } from '../../src/gate/gate.ts'
import { configState } from '../../src/state/config-state.ts'
import { SessionRules } from '../../src/permission/session-rules.ts'
import { DenyAndContinueService } from '../../src/deny/deny-service.ts'
import { setAskResolver, getAskResolver } from '../../src/gate/ask.ts'
import type { ClassifierResult } from '../../src/classifier/llm-layer.ts'
import { parseConfig } from '../../src/types/config.ts'

describe('gateToolCall ask payload (tool + fullCommand)', () => {
  afterEach(() => {
    setAskResolver(getAskResolver())
  })

  it('passes tool name and full command to the modal', async () => {
    configState.set(
      parseConfig({
        permissions: {
          tools: {
            bash: [
              { pattern: 'echo spam*', action: 'deny', reason: 'noisy_echo' },
            ],
          },
        },
        denyStrategy: {
          mode: 'ask-user',
          escalation: { consecutive: 3, total: 20 },
        },
      })
    )
    const sessionRules = new SessionRules()
    const denyService = new DenyAndContinueService({
      mode: 'ask-user',
      escalation: { consecutive: 3, total: 20 },
    })
    const classify = async (): Promise<ClassifierResult> => ({
      decision: 'allow',
    })
    const deps = { configState, sessionRules, hooks: {}, classify, denyService }

    let captured:
      | {
          tool?: string
          fullCommand?: string
          surface?: string
          value?: string
        }
      | undefined
    setAskResolver(async (req) => {
      captured = {
        tool: req.tool,
        fullCommand: req.fullCommand,
        surface: req.surface,
        value: req.value,
      }
      return 'allow'
    })

    await gateToolCall('bash', { command: 'echo spam a' }, deps)
    expect(captured).toBeDefined()
    expect(captured!.tool).toBe('bash')
    expect(captured!.fullCommand).toBe('echo spam a')
    expect(captured!.surface).toBe('shell')
    expect(captured!.value).toBe('echo spam a')
  })

  it('plain deny inherits the rule reason shown in the modal', async () => {
    configState.set(
      parseConfig({
        permissions: {
          tools: {
            bash: [
              { pattern: 'echo spam*', action: 'deny', reason: 'noisy_echo' },
            ],
          },
        },
        denyStrategy: {
          mode: 'ask-user',
          escalation: { consecutive: 3, total: 20 },
        },
      })
    )
    const sessionRules = new SessionRules()
    const denyService = new DenyAndContinueService({
      mode: 'ask-user',
      escalation: { consecutive: 3, total: 20 },
    })
    const classify = async (): Promise<ClassifierResult> => ({
      decision: 'allow',
    })
    const deps = { configState, sessionRules, hooks: {}, classify, denyService }
    setAskResolver(async () => 'deny')

    await expect(
      gateToolCall('bash', { command: 'echo spam a' }, deps)
    ).rejects.toThrow('Permission denied by user: noisy_echo')
  })
})
