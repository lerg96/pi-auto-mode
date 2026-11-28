import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  formatTelemetryStats,
  parseTelemetryStats,
  readTelemetryStats,
} from '../../src/telemetry/stats.ts'

function decisionLine(payload: Record<string, unknown>): string {
  return JSON.stringify({
    ts: '2026-11-28T02:00:00.000Z',
    type: 'permissions:decision',
    payload,
  })
}

function debugLine(type: string, payload: Record<string, unknown>): string {
  return JSON.stringify({
    ts: '2026-11-28T02:00:00.000Z',
    type,
    payload,
  })
}

describe('telemetry stats', () => {
  it('aggregates decisions, classifier latency, cache hits, and top user prompts', () => {
    const telemetry = [
      decisionLine({
        surface: 'shell',
        value: 'git status',
        result: 'allow',
        resolution: 'allow',
        decidedBy: 'rule',
      }),
      decisionLine({
        surface: 'shell',
        value: 'python3 -c "print(1)"',
        result: 'allow',
        resolution: 'classifier_allow',
        decidedBy: 'classifier',
      }),
      decisionLine({
        surface: 'shell',
        value: 'curl https://example.com/a',
        result: 'allow',
        resolution: 'session_allow',
        decidedBy: 'session',
      }),
      decisionLine({
        surface: 'shell',
        value: 'aws s3 ls s3://bucket-a',
        result: 'allow',
        resolution: 'permission_ask',
        decidedBy: 'user',
      }),
      decisionLine({
        surface: 'shell',
        value: 'aws s3 ls s3://bucket-b',
        result: 'deny',
        resolution: 'permission_ask',
        decidedBy: 'user',
      }),
      decisionLine({
        surface: 'shell',
        value: 'python3 dangerous.py',
        result: 'allow',
        resolution: 'classifier_ask',
        decidedBy: 'user',
      }),
      'not-valid-json',
    ].join('\n')

    const debug = [
      debugLine('llm:attempt', { ok: true, elapsedMs: 200 }),
      debugLine('llm:attempt', { ok: true, elapsedMs: 400 }),
      debugLine('llm:attempt', { ok: false, elapsedMs: 5000 }),
      debugLine('classifier:cache_hit', { command: 'python3 -c "print(1)"' }),
    ].join('\n')

    const stats = parseTelemetryStats(telemetry, debug)
    expect(stats.totalDecisions).toBe(6)
    expect(stats.ruleAllow).toBe(1)
    expect(stats.classifierAllow).toBe(1)
    expect(stats.sessionAllow).toBe(1)
    expect(stats.userPrompts).toBe(3)
    expect(stats.userPromptsByRule).toBe(2)
    expect(stats.userPromptsByClassifier).toBe(1)
    expect(stats.userDenied).toBe(1)
    expect(stats.llmOk).toBe(2)
    expect(stats.llmErr).toBe(1)
    expect(stats.llmAvgMs).toBe(300)
    expect(stats.cacheHits).toBe(1)
    expect(stats.topPrompts[0]).toMatchObject({
      pattern: 'aws s3 ls *',
      count: 2,
    })

    const formatted = formatTelemetryStats(stats)
    expect(formatted).toContain('Auto-mode stats (last 6 decisions):')
    expect(formatted).toContain('2 ok, 1 err, avg 300ms, cache hits: 1 (25%)')
    expect(formatted).toContain('2x aws s3 ls *')
  })

  it('respects the limit option by reading only the tail lines', () => {
    const telemetry = [
      decisionLine({
        surface: 'shell',
        value: 'old-cmd',
        result: 'allow',
        resolution: 'permission_ask',
        decidedBy: 'user',
      }),
      decisionLine({
        surface: 'shell',
        value: 'git status',
        result: 'allow',
        resolution: 'allow',
        decidedBy: 'rule',
      }),
    ].join('\n')

    const stats = parseTelemetryStats(telemetry, '', { limit: 1 })
    expect(stats.totalDecisions).toBe(1)
    expect(stats.ruleAllow).toBe(1)
    expect(stats.userPrompts).toBe(0)
  })

  it('handles missing and empty telemetry files gracefully', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-stats-test-'))
    try {
      const missing = await readTelemetryStats(
        join(dir, 'does-not-exist.jsonl')
      )
      expect(missing.telemetryMissing).toBe(true)
      expect(formatTelemetryStats(missing)).toContain('No telemetry log found')

      const emptyFile = join(dir, 'empty.jsonl')
      writeFileSync(emptyFile, '')
      const empty = await readTelemetryStats(emptyFile)
      expect(empty.telemetryMissing).toBe(false)
      expect(empty.totalDecisions).toBe(0)
      expect(formatTelemetryStats(empty)).toContain('No permission decisions')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
