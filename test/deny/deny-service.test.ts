import { DenyAndContinueService } from '../../src/deny/deny-service.ts'

function makeService() {
  return new DenyAndContinueService({
    mode: 'both',
    escalation: { consecutive: 3, total: 20 },
  })
}

describe('DenyAndContinueService', () => {
  it('C2: denies-and-continues twice then escalates on the third', () => {
    const svc = makeService()
    expect(
      svc.recordDenial({
        toolName: 'bash',
        reason: 'x',
        trigger: 'permission',
      })
    ).toBe('deny-and-continue')
    expect(
      svc.recordDenial({
        toolName: 'bash',
        reason: 'x',
        trigger: 'permission',
      })
    ).toBe('deny-and-continue')
    expect(
      svc.recordDenial({
        toolName: 'bash',
        reason: 'x',
        trigger: 'permission',
      })
    ).toBe('escalate')
  })

  it('onContinueSucceeded resets consecutive only; total persists', () => {
    const svc = makeService()
    svc.recordDenial({ toolName: 'bash', reason: 'x', trigger: 'permission' })
    svc.recordDenial({ toolName: 'bash', reason: 'x', trigger: 'permission' })
    expect(svc.getStats()).toEqual({ consecutive: 2, total: 2 })

    svc.onContinueSucceeded()
    // consecutive dropped, total kept
    expect(svc.getStats()).toEqual({ consecutive: 0, total: 2 })

    // total cap (20) not reached and consecutive was reset, so still deny-and-continue.
    expect(
      svc.recordDenial({
        toolName: 'bash',
        reason: 'x',
        trigger: 'permission',
      })
    ).toBe('deny-and-continue')
  })

  it("mode 'ask-user' always returns 'ask-user'", () => {
    const svc = new DenyAndContinueService({
      mode: 'ask-user',
      escalation: { consecutive: 3, total: 20 },
    })
    expect(
      svc.recordDenial({
        toolName: 'bash',
        reason: 'x',
        trigger: 'permission',
      })
    ).toBe('ask-user')
    expect(
      svc.recordDenial({
        toolName: 'bash',
        reason: 'x',
        trigger: 'permission',
      })
    ).toBe('ask-user')
  })

  it("mode 'auto-retry' deterministically auto-allows (never escalates)", () => {
    // Opt-in auto-allow: the denial verdict executes and never asks/blocks,
    // so long as escalation limits are not reached (the escalation gate runs
    // before the mode gate). With a generous limit it stays 'deny-and-continue'
    // across repeated denials. (Fase 4: the canonical name is now
    // 'auto-retry'; 'deny-and-continue' is a backwards-compat alias accepted
    // in the on-disk JSON, but the in-memory DenyStrategyConfig is always the
    // canonical form.)
    const svc = new DenyAndContinueService({
      mode: 'auto-retry',
      escalation: { consecutive: 100, total: 100 },
    })
    for (let i = 0; i < 5; i++) {
      expect(
        svc.recordDenial({
          toolName: 'bash',
          reason: 'x',
          trigger: 'permission',
        })
      ).toBe('deny-and-continue')
    }
  })
})
