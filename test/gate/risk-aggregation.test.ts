import {
  classifyDecision,
  mostRestrictive,
  aggregateClassify,
} from '../../src/gate/risk-aggregation.ts'
import type { GateDeps } from '../../src/gate/gate.ts'
import type { configState } from '../../src/state/config-state.ts'
import type {
  ClassifierInput,
  ClassifierResult,
} from '../../src/classifier/llm-layer.ts'
import type { AccessIntent } from '../../src/gate/normalize.ts'

function depsWith(
  classifier: { enabled?: boolean; onBlock?: 'ask' | 'deny' },
  classify?: (input: ClassifierInput) => Promise<ClassifierResult>
): GateDeps {
  const cfg = {
    classifier: {
      enabled: classifier.enabled ?? true,
      onBlock: classifier.onBlock ?? 'deny',
    },
  }
  return {
    configState: {
      get: () => cfg,
    } as unknown as typeof configState,
    sessionRules: { snapshot: () => [] },
    hooks: {},
    classify,
  } as unknown as GateDeps
}

const intent = (surface: string, value: string): AccessIntent =>
  ({ surface, value }) as AccessIntent

describe('classifyDecision', () => {
  it('maps block to deny by default and to ask when onBlock=ask', () => {
    const blocked: ClassifierResult = { decision: 'block' } as ClassifierResult
    expect(classifyDecision(blocked)).toBe('deny')
    expect(classifyDecision(blocked, 'ask')).toBe('ask')
  })
  it('maps allow to allow and anything else to ask', () => {
    expect(classifyDecision({ decision: 'allow' } as ClassifierResult)).toBe(
      'allow'
    )
    expect(classifyDecision({ decision: 'ask' } as ClassifierResult)).toBe(
      'ask'
    )
  })
})

describe('mostRestrictive', () => {
  it('orders deny > ask > allow', () => {
    expect(mostRestrictive('allow', 'deny')).toBe('deny')
    expect(mostRestrictive('deny', 'ask')).toBe('deny')
    expect(mostRestrictive('ask', 'allow')).toBe('ask')
    expect(mostRestrictive('allow', 'allow')).toBe('allow')
  })
})

describe('aggregateClassify', () => {
  it('returns allow with the first intent when the classifier is disabled', async () => {
    const deps = depsWith({ enabled: false })
    const agg = await aggregateClassify(
      [intent('shell', 'echo hi')],
      'bash',
      {},
      deps
    )
    expect(agg).toEqual({ action: 'allow', surface: 'shell', value: 'echo hi' })
  })

  it('denies when the classifier is enabled but not injected', async () => {
    const deps = depsWith({})
    const agg = await aggregateClassify([intent('fs', 'a')], 'read', {}, deps)
    expect(agg.action).toBe('deny')
  })

  it('aggregates the most restrictive action and the highest risk', async () => {
    const classify = async (i: ClassifierInput): Promise<ClassifierResult> =>
      i.value === 'bad'
        ? {
            decision: 'block',
            risk: { score: 9, level: 'high', reason: 'r' },
          }
        : { decision: 'allow', risk: { score: 1, level: 'low', reason: 'l' } }
    const deps = depsWith({}, classify)
    const agg = await aggregateClassify(
      [intent('shell', 'ok'), intent('shell', 'bad')],
      'bash',
      {},
      deps
    )
    expect(agg.action).toBe('deny')
    expect(agg.risk?.level).toBe('high')
  })

  it('represents the first ask intent when nothing denies', async () => {
    const classify = async (i: ClassifierInput): Promise<ClassifierResult> =>
      i.value === 'askme'
        ? { decision: 'ask', risk: { score: 5, level: 'medium', reason: 'm' } }
        : { decision: 'allow' }
    const deps = depsWith({}, classify)
    const agg = await aggregateClassify(
      [intent('shell', 'ok'), intent('shell', 'askme')],
      'bash',
      {},
      deps
    )
    expect(agg.action).toBe('ask')
    expect(agg.surface).toBe('shell')
    expect(agg.value).toBe('askme')
  })
})
