import { applyDenyStrategy } from '../../src/gate/deny-strategy.ts'
import type { GateDeps } from '../../src/gate/gate.ts'
import type { DenyAndContinueService } from '../../src/deny/deny-service.ts'

describe('applyDenyStrategy', () => {
  it('returns ask when no deny service is injected', () => {
    const deps = { hooks: {} } as unknown as GateDeps
    expect(applyDenyStrategy('bash', 'r', 'permission', deps)).toBe('ask')
  })

  it('records the denial with toolName/reason/trigger', () => {
    const recordDenial = jest.fn(() => 'auto-retry' as const)
    const deps = {
      hooks: {},
      denyService: { recordDenial } as unknown as DenyAndContinueService,
    } as unknown as GateDeps
    expect(applyDenyStrategy('bash', 'boom', 'classifier', deps)).toBe(
      'auto-retry'
    )
    expect(recordDenial).toHaveBeenCalledWith({
      toolName: 'bash',
      reason: 'boom',
      trigger: 'classifier',
    })
  })
})
