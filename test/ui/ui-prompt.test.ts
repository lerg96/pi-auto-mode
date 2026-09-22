import { buildUiPrompt, emitUiPrompt } from '../../src/ui/ui-prompt.ts'
import { BUS_CHANNEL_UI_PROMPT } from '../../src/events.ts'
import type { ExtensionUI } from '../../src/pi-sdk.ts'

// src/ui/ui-prompt.ts never imports @earendil-works/pi-tui (the ExtensionUI
// import is type-only and erased at runtime), so no TUI mock is needed here —
// `emit` is injected as a parameter, which is the whole point of the helper.

const ui = {} as unknown as ExtensionUI

describe('buildUiPrompt', () => {
  it('builds a tool_call request mirroring surface, value and requestId', () => {
    const req = buildUiPrompt('shell', 'rm -rf /tmp/x', 'req-42')
    expect(req).toEqual({
      requestId: 'req-42',
      source: 'tool_call',
      surface: 'shell',
      value: 'rm -rf /tmp/x',
      agentName: null,
      request: { surface: 'shell', value: 'rm -rf /tmp/x' },
    })
  })

  it('never invents an agentName or rewrites the source field', () => {
    const req = buildUiPrompt('fs', '/tmp/a', 'r1')
    expect(req.source).toBe('tool_call')
    expect(req.agentName).toBeNull()
  })

  it('keeps surface/value verbatim (no trimming, no sanitizing here)', () => {
    const req = buildUiPrompt('  shell\n', ' /tmp/x ', 'r2')
    expect(req.surface).toBe('  shell\n')
    expect(req.value).toBe(' /tmp/x ')
    expect(req.request).toEqual({ surface: '  shell\n', value: ' /tmp/x ' })
  })
})

describe('emitUiPrompt', () => {
  it('emits on the namespaced bus channel with the full request payload', () => {
    const emit = jest.fn()
    emitUiPrompt(ui, 'shell', 'ls -la', 'req-1', emit)
    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit).toHaveBeenCalledWith(BUS_CHANNEL_UI_PROMPT, {
      requestId: 'req-1',
      source: 'tool_call',
      surface: 'shell',
      value: 'ls -la',
      agentName: null,
      request: { surface: 'shell', value: 'ls -la' },
    })
  })

  it('returns undefined (no-op, no throw) when no emit function is bound', () => {
    expect(() => emitUiPrompt(ui, 'fs', '/tmp/x', 'req-2')).not.toThrow()
    expect(emitUiPrompt(ui, 'fs', '/tmp/x', 'req-2', undefined)).toBeUndefined()
  })

  it('swallows emit() failures (fire-and-forget: never propagates)', () => {
    const boom = jest.fn(() => {
      throw new Error('bus exploded')
    })
    expect(() => emitUiPrompt(ui, 'fs', '/tmp/x', 'req-3', boom)).not.toThrow()
    expect(boom).toHaveBeenCalledTimes(1)
  })

  it('generates a non-empty requestId when none is given', () => {
    const emit = jest.fn()
    emitUiPrompt(ui, 'fs', '/tmp/x', undefined, emit)
    const payload = emit.mock.calls[0][1] as { requestId: string }
    expect(typeof payload.requestId).toBe('string')
    expect(payload.requestId.length).toBeGreaterThan(0)
  })

  it('generates a different requestId on each call (no ID reuse)', () => {
    const emit = jest.fn()
    emitUiPrompt(ui, 'fs', '/tmp/x', undefined, emit)
    emitUiPrompt(ui, 'fs', '/tmp/x', undefined, emit)
    const [a, b] = [
      (emit.mock.calls[0][1] as { requestId: string }).requestId,
      (emit.mock.calls[1][1] as { requestId: string }).requestId,
    ]
    expect(a).not.toBe(b)
  })

  it('falls back to Math.random IDs when crypto.randomUUID is unavailable', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
    try {
      Object.defineProperty(globalThis, 'crypto', {
        value: undefined,
        configurable: true,
      })
      const emit = jest.fn()
      emitUiPrompt(ui, 'fs', '/tmp/x', undefined, emit)
      const payload = emit.mock.calls[0][1] as { requestId: string }
      expect(typeof payload.requestId).toBe('string')
      expect(payload.requestId.length).toBeGreaterThan(0)
      // Math.random().toString(36).slice(2) never contains '-' (UUID shape).
      expect(payload.requestId).not.toMatch(/-/)
    } finally {
      if (original) {
        Object.defineProperty(globalThis, 'crypto', original)
      }
    }
    // Sanity: the global was restored for the rest of the suite.
    expect(globalThis.crypto?.randomUUID?.().length).toBe(36)
  })
})
