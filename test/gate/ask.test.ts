import {
  defaultAskResolver,
  getAskResolver,
  setAskResolver,
  type AskDecision,
  type AskRequest,
} from '../../src/gate/ask.ts'

function isAskDecision(value: unknown): value is AskDecision {
  if (value === 'allow' || value === 'deny') return true
  if (
    (typeof value === 'object' &&
      value !== null &&
      'decision' in value &&
      (value as { decision: unknown }).decision === 'allow') ||
    (value as { decision: unknown }).decision === 'deny'
  ) {
    return true
  }
  return false
}

describe('ask', () => {
  it('defaultAskResolver resuelve a una AskDecision valida', async () => {
    const result = await defaultAskResolver({
      surface: 'shell',
      value: 'rm -rf /',
    })
    expect(isAskDecision(result)).toBe(true)
    expect(result).toBe('deny')
  })

  it('setAskResolver/getAskResolver permiten inyectar un resolver', async () => {
    const request: AskRequest = { surface: 'fs', value: '/etc/passwd' }
    const custom: typeof defaultAskResolver = async () => ({
      decision: 'allow',
      reason: 'trusted',
    })
    setAskResolver(custom)
    try {
      const resolver = getAskResolver()
      const result = await resolver(request)
      expect(isAskDecision(result)).toBe(true)
      expect(result).toEqual({ decision: 'allow', reason: 'trusted' })
    } finally {
      setAskResolver(defaultAskResolver)
    }
  })
})
