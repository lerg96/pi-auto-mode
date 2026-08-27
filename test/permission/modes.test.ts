import { applyMode, isVisible } from '../../src/permission/modes.ts'

describe('applyMode / default', () => {
  it('passes allow through unchanged', () => {
    expect(applyMode('allow', 'default')).toBe('allow')
  })
  it('passes ask through unchanged', () => {
    expect(applyMode('ask', 'default')).toBe('ask')
  })
  it('passes deny through unchanged', () => {
    expect(applyMode('deny', 'default')).toBe('deny')
  })
  it('passes unknown through unchanged', () => {
    expect(applyMode('unknown', 'default')).toBe('unknown')
  })
})

describe('applyMode / strict', () => {
  it('promotes ask -> deny (no interactive prompts at visibility layer)', () => {
    expect(applyMode('ask', 'strict')).toBe('deny')
  })
  it('keeps allow', () => {
    expect(applyMode('allow', 'strict')).toBe('allow')
  })
  it('keeps deny', () => {
    expect(applyMode('deny', 'strict')).toBe('deny')
  })
  it('keeps unknown (no implicit allow via mode)', () => {
    expect(applyMode('unknown', 'strict')).toBe('unknown')
  })
})

describe('applyMode / yolo', () => {
  it('promotes ask -> allow (auto-allow)', () => {
    expect(applyMode('ask', 'yolo')).toBe('allow')
  })
  it('keeps allow', () => {
    expect(applyMode('allow', 'yolo')).toBe('allow')
  })
  it('keeps deny (yolo never overrides explicit deny)', () => {
    expect(applyMode('deny', 'yolo')).toBe('deny')
  })
  it('keeps unknown', () => {
    expect(applyMode('unknown', 'yolo')).toBe('unknown')
  })
})

describe('isVisible', () => {
  it('true for allow', () => {
    expect(isVisible('allow')).toBe(true)
  })
  it('true for ask (visible, will gate per-call)', () => {
    expect(isVisible('ask')).toBe(true)
  })
  it('false for deny', () => {
    expect(isVisible('deny')).toBe(false)
  })
  it('true for unknown (no entry in any active set — visible by default)', () => {
    // New policy: "everything visible unless explicitly denied". `unknown`
    // represents "no rule in any active set's tools/skills map" — not an
    // implicit deny, so it stays visible. The gate at execution time
    // still hard-denies unknown tools via the AskDeniedError fail-closed
    // path if the user declines the prompt.
    expect(isVisible('unknown')).toBe(true)
  })
})
