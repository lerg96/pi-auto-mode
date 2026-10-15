import {
  AskDeniedError,
  askDeniedAudit,
  verdictExtra,
  resolveAsk,
} from '../../src/gate/ask-flow.ts'
import type { GateDeps } from '../../src/gate/gate.ts'
import { setAskResolver, defaultAskResolver } from '../../src/gate/ask.ts'
import { SessionRules } from '../../src/permission/session-rules.ts'
import type { DenyAndContinueService } from '../../src/deny/deny-service.ts'

function makeDeps(): {
  deps: GateDeps
  onContinueSucceeded: jest.Mock
} {
  const onContinueSucceeded = jest.fn()
  const deps = {
    configState: { get: () => ({}) },
    sessionRules: new SessionRules(),
    hooks: {},
    denyService: {
      onContinueSucceeded,
      recordDenial: jest.fn(),
    } as unknown as DenyAndContinueService,
  } as unknown as GateDeps
  return { deps, onContinueSucceeded }
}

beforeEach(() => {
  setAskResolver(defaultAskResolver)
})

describe('verdictExtra', () => {
  it('omits userVerdict for session (no modal shown)', () => {
    expect(verdictExtra('session')).toEqual({})
    expect(verdictExtra('allow')).toEqual({ userVerdict: 'allow' })
    expect(verdictExtra('allow_dir_all')).toEqual({
      userVerdict: 'allow_dir_all',
    })
  })
})

describe('askDeniedAudit', () => {
  it('contributes nothing for non-AskDeniedError values', () => {
    expect(askDeniedAudit(new Error('x'))).toEqual({})
    expect(askDeniedAudit(undefined)).toEqual({})
  })

  it('spreads the audit plus a deny verdict for AskDeniedError', () => {
    const err = new AskDeniedError('nope', {
      requestId: 'r1',
      decidedBy: 'user',
      via: 'modal',
    })
    expect(askDeniedAudit(err)).toEqual({
      requestId: 'r1',
      decidedBy: 'user',
      via: 'modal',
      userVerdict: 'deny',
    })
  })
})

describe('resolveAsk', () => {
  it('short-circuits on a matching session allow', async () => {
    const { deps, onContinueSucceeded } = makeDeps()
    deps.sessionRules.approveForSession('fs', 'allowed.txt', 'allow')
    const res = await resolveAsk('fs', 'allowed.txt', undefined, deps)
    expect(res.verdict).toBe('session')
    expect(res.via).toBe('session-rules')
    expect(onContinueSucceeded).toHaveBeenCalledTimes(1)
  })

  it('throws AskDeniedError (no-ui) when the default resolver denies', async () => {
    const { deps } = makeDeps()
    await expect(
      resolveAsk('fs', 'fresh-file', undefined, deps)
    ).rejects.toThrow(/without asking/)
    await expect(
      resolveAsk('fs', 'fresh-file', undefined, deps)
    ).rejects.toBeInstanceOf(AskDeniedError)
  })

  it('persists an exact-value session allow on allow_session', async () => {
    const { deps, onContinueSucceeded } = makeDeps()
    setAskResolver(async () => 'allow_session')
    const res = await resolveAsk('shell', 'echo hi', undefined, deps)
    expect(res.verdict).toBe('allow_session')
    expect(onContinueSucceeded).toHaveBeenCalledTimes(1)
    const rules = deps.sessionRules
      .snapshot()
      .filter((r) => r.origin === 'session' && r.action === 'allow')
    const rule = rules.find(
      (r) => r.surface === 'shell' && r.pattern === 'echo hi'
    )
    expect(rule).toBeDefined()
    expect(rule?.isExact).toBe(true)
  })

  it('persists chosen wildcard pattern on allow_session with isExact false', async () => {
    const { deps, onContinueSucceeded } = makeDeps()
    setAskResolver(async () => ({
      decision: 'allow_session',
      pattern: 'echo *',
    }))
    const res = await resolveAsk('shell', 'echo hi', undefined, deps)
    expect(res.verdict).toBe('allow_session')
    expect(onContinueSucceeded).toHaveBeenCalledTimes(1)
    const rules = deps.sessionRules
      .snapshot()
      .filter((r) => r.origin === 'session' && r.action === 'allow')
    const rule = rules.find(
      (r) => r.surface === 'shell' && r.pattern === 'echo *'
    )
    expect(rule).toBeDefined()
    expect(rule?.isExact).toBe(false)
  })

  it('persists chosen exact pattern on allow_session with isExact true', async () => {
    const { deps } = makeDeps()
    setAskResolver(async () => ({
      decision: 'allow_session',
      pattern: 'echo hi',
    }))
    const res = await resolveAsk('shell', 'echo hi', undefined, deps)
    expect(res.verdict).toBe('allow_session')
    const rules = deps.sessionRules
      .snapshot()
      .filter((r) => r.origin === 'session' && r.action === 'allow')
    const rule = rules.find(
      (r) => r.surface === 'shell' && r.pattern === 'echo hi'
    )
    expect(rule).toBeDefined()
    expect(rule?.isExact).toBe(true)
  })

  it('inherits a denial reason from the matched rule', async () => {
    const { deps } = makeDeps()
    setAskResolver(async () => ({ decision: 'deny', via: 'modal' }))
    await expect(
      resolveAsk('shell', 'v', undefined, deps, {
        surface: 'bash',
        pattern: 'p',
        reason: 'policy-nope',
      })
    ).rejects.toThrow('policy-nope')
  })

  it('threads askOrigin through to the resolver', async () => {
    const { deps } = makeDeps()
    let capturedOrigin: string | undefined
    setAskResolver(async (req) => {
      capturedOrigin = req.askOrigin
      return 'allow'
    })
    await resolveAsk(
      'shell',
      'echo hi',
      undefined,
      deps,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { askOrigin: 'rule' }
    )
    expect(capturedOrigin).toBe('rule')
  })

  it('defaults askOrigin to external-directory when externalDir is present and no askOrigin specified', async () => {
    const { deps } = makeDeps()
    let capturedOrigin: string | undefined
    setAskResolver(async (req) => {
      capturedOrigin = req.askOrigin
      return 'allow'
    })
    await resolveAsk(
      'fs',
      '/outside/file.txt',
      undefined,
      deps,
      undefined,
      undefined,
      undefined,
      undefined,
      { isExternalDir: true, externalDirPath: '/outside/file.txt' }
    )
    expect(capturedOrigin).toBe('external-directory')
  })
})
