import {
  defaultAskResolver,
  getAskResolver,
  setAskResolver,
  normalizeAskDecision,
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
    // Sin resolver no hay nadie a quién preguntar: se deniega y así se
    // declara (`via: 'no-ui'`), nunca como decisión de un usuario.
    expect(result).toEqual({ decision: 'deny', via: 'no-ui' })
  })

  it('normalizeAskDecision canónica: string => via modal', () => {
    expect(normalizeAskDecision('allow')).toEqual({
      decision: 'allow',
      via: 'modal',
    })
    expect(normalizeAskDecision('deny')).toEqual({
      decision: 'deny',
      via: 'modal',
    })
  })

  it('normalizeAskDecision respeta el via del resolver y su reason', () => {
    expect(
      normalizeAskDecision({ decision: 'deny', reason: 'nope', via: 'no-ui' })
    ).toEqual({ decision: 'deny', reason: 'nope', via: 'no-ui' })
    expect(
      normalizeAskDecision({ decision: 'allow', via: 'parent-modal' })
    ).toEqual({ decision: 'allow', via: 'parent-modal' })
    // Object-form sin via sigue siendo una decisión humana mostrada en modal.
    expect(normalizeAskDecision({ decision: 'allow_session' })).toEqual({
      decision: 'allow_session',
      via: 'modal',
    })
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
