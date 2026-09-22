import { emit, askActor } from '../../src/gate/ask-audit.ts'
import { BUS_CHANNEL_DECISION } from '../../src/events.ts'

describe('emit', () => {
  it('publishes on the decision bus with merged extras', () => {
    const events: Array<{ channel: string; data: unknown }> = []
    emit(
      { emit: (channel, data) => events.push({ channel, data }) },
      'shell',
      'ls',
      'allow',
      'allow',
      { requestId: 'r1' }
    )
    expect(events).toHaveLength(1)
    expect(events[0].channel).toBe(BUS_CHANNEL_DECISION)
    expect(events[0].data).toEqual({
      surface: 'shell',
      value: 'ls',
      result: 'allow',
      resolution: 'allow',
      requestId: 'r1',
    })
  })

  it('swallows emitter failures (fire-and-forget)', () => {
    expect(() =>
      emit(
        {
          emit: () => {
            throw new Error('bus down')
          },
        },
        'shell',
        'ls',
        'allow',
        'allow'
      )
    ).not.toThrow()
  })

  it('tolerates a hooks object without emit', () => {
    expect(() => emit({}, 's', 'v', 'deny', 'x')).not.toThrow()
  })
})

describe('askActor', () => {
  it('never attributes no-ui/timeout asks to a user', () => {
    expect(askActor('no-ui')).toBe('no-ui')
    expect(askActor('timeout')).toBe('timeout')
    expect(askActor('session-rules')).toBe('session')
    expect(askActor('modal')).toBe('user')
    expect(askActor('parent-modal')).toBe('user')
  })
})
