import { promises as fsPromises } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  exportDatasetFromLines,
  exportDatasetFile,
} from '../../src/telemetry/dataset-exporter.ts'

describe('dataset-exporter', () => {
  describe('filtering noise and legacy records', () => {
    it('filters out timeout, no-ui, and yolo_bypass resolutions', () => {
      const lines = [
        JSON.stringify({
          ts: '2026-09-02T10:00:00.000Z',
          type: 'permissions:decision',
          payload: {
            surface: 'shell',
            value: 'ls',
            result: 'deny',
            resolution: 'ask_timeout',
            decidedBy: 'timeout',
          },
        }),
        JSON.stringify({
          ts: '2026-09-02T10:00:01.000Z',
          type: 'permissions:decision',
          payload: {
            surface: 'shell',
            value: 'pwd',
            result: 'deny',
            resolution: 'ask_no_ui',
            decidedBy: 'no-ui',
          },
        }),
        JSON.stringify({
          ts: '2026-09-02T10:00:02.000Z',
          type: 'permissions:decision',
          payload: {
            surface: 'shell',
            value: 'echo hello',
            result: 'allow',
            resolution: 'yolo_bypass',
            decidedBy: 'rule',
          },
        }),
      ]

      const { examples, stats } = exportDatasetFromLines(lines)
      expect(examples).toHaveLength(0)
      expect(stats.totalLines).toBe(3)
      expect(stats.validDecisions).toBe(0)
      expect(stats.skippedNoise).toBe(3)
      expect(stats.exported).toBe(0)
    })

    it('filters out legacy [REDACTED] commands and empty matchedValues', () => {
      const lines = [
        JSON.stringify({
          ts: '2026-09-02T10:00:00.000Z',
          type: 'permissions:decision',
          payload: {
            surface: 'shell',
            value: '[REDACTED]',
            result: 'deny',
            resolution: 'deny',
            decidedBy: 'rule',
          },
        }),
        JSON.stringify({
          ts: '2026-09-02T10:00:01.000Z',
          type: 'permissions:decision',
          payload: {
            surface: 'shell',
            value: 'curl http://example.com',
            result: 'deny',
            resolution: 'deny',
            decidedBy: 'rule',
            detail: {
              matchedValue: '[REDACTED]',
            },
          },
        }),
        JSON.stringify({
          ts: '2026-09-02T10:00:02.000Z',
          type: 'permissions:decision',
          payload: {
            surface: 'shell',
            value: '',
            result: 'allow',
            resolution: 'allow',
            decidedBy: 'rule',
          },
        }),
      ]

      const { examples, stats } = exportDatasetFromLines(lines)
      expect(examples).toHaveLength(0)
      expect(stats.skippedNoise).toBe(3)
      expect(stats.validDecisions).toBe(0)
    })

    it('filters out LLM network/timeout error fallbacks unless confirmed by user', () => {
      const lines = [
        // Classifier error fallback not confirmed by user -> noise
        JSON.stringify({
          ts: '2026-09-02T10:00:00.000Z',
          type: 'permissions:decision',
          payload: {
            surface: 'shell',
            value: 'python test.py',
            result: 'deny',
            resolution: 'classifier_block',
            decidedBy: 'classifier',
            detail: {
              risk: {
                category: 'error',
                reason: 'Classifier LLM fallback (deny): timeout',
              },
            },
          },
        }),
        // Human confirmed decision despite error fallback -> kept
        JSON.stringify({
          ts: '2026-09-02T10:00:01.000Z',
          type: 'permissions:decision',
          payload: {
            surface: 'shell',
            value: 'python safe.py',
            result: 'allow',
            resolution: 'permission_ask',
            decidedBy: 'user',
            detail: {
              risk: {
                category: 'error',
                reason: 'Classifier LLM fallback (ask-user)',
              },
            },
          },
        }),
      ]

      const { examples, stats } = exportDatasetFromLines(lines)
      expect(stats.skippedNoise).toBe(1)
      expect(stats.validDecisions).toBe(1)
      expect(examples).toHaveLength(1)
      expect(examples[0].metadata.decision).toBe('allow')
      expect(examples[0].metadata.source).toBe('user')
    })

    it('filters non-decision events and invalid JSON', () => {
      const lines = [
        'not valid json',
        JSON.stringify({
          ts: '2026-09-02T10:00:00.000Z',
          type: 'permissions:ui_prompt',
          payload: { surface: 'shell' },
        }),
        JSON.stringify({
          ts: '2026-09-02T10:00:01.000Z',
          type: 'permissions:decision',
          payload: null,
        }),
      ]

      const { examples, stats } = exportDatasetFromLines(lines)
      expect(examples).toHaveLength(0)
      expect(stats.skippedNoise).toBe(3)
    })
  })

  describe('label and source derivation', () => {
    it('derives human denial with denialReason', () => {
      const line = JSON.stringify({
        ts: '2026-09-02T10:15:00.000Z',
        type: 'permissions:decision',
        payload: {
          surface: 'shell',
          value: 'rm -rf /tmp/data',
          result: 'deny',
          resolution: 'permission_ask',
          decidedBy: 'user',
          denialReason: 'Potential dangerous command that wipes directory',
          userVerdict: 'deny',
          detail: {
            toolName: 'bash',
            cwd: '/home/user/project',
            risk: {
              score: 8,
              category: 'destructive_delete',
            },
          },
        },
      })

      const { examples, stats } = exportDatasetFromLines([line])
      expect(stats.validDecisions).toBe(1)
      expect(stats.exported).toBe(1)
      expect(stats.byDecision.block).toBe(1)
      expect(stats.bySource.user).toBe(1)

      const ex = examples[0]
      expect(ex.metadata.decision).toBe('block')
      expect(ex.metadata.source).toBe('user')
      expect(ex.metadata.userVerdict).toBe('deny')

      const assistant = JSON.parse(ex.messages[2].content)
      expect(assistant.decision).toBe('block')
      expect(assistant.riskScore).toBe(8)
      expect(assistant.riskReason).toBe(
        'Potential dangerous command that wipes directory'
      )
      expect(assistant.category).toBe('destructive_delete')

      expect(ex.messages[1].content).toContain('Tool: bash')
      expect(ex.messages[1].content).toContain('Surface: shell')
      expect(ex.messages[1].content).toContain(
        'WorkingDirectory: /home/user/project'
      )
      expect(ex.messages[1].content).toContain(
        'Arguments: {"command":"rm -rf /tmp/data"}'
      )
    })

    it('derives classifier_block_override where user approved', () => {
      const line = JSON.stringify({
        ts: '2026-09-02T10:20:00.000Z',
        type: 'permissions:decision',
        payload: {
          surface: 'shell',
          value: 'git push origin main --force',
          result: 'allow',
          resolution: 'classifier_block_override',
          decidedBy: 'user',
          requestId: 'req-12345',
          detail: {
            toolName: 'bash',
            fullCommand: 'git push origin main --force',
            risk: {
              decision: 'block',
              score: 9,
              reason: 'Force push to main branch',
              category: 'git_force_push',
            },
          },
        },
      })

      const { examples, stats } = exportDatasetFromLines([line])
      expect(stats.validDecisions).toBe(1)
      expect(stats.exported).toBe(1)
      expect(stats.byDecision.allow).toBe(1)
      expect(stats.bySource.user_override).toBe(1)

      const ex = examples[0]
      expect(ex.id).toBe('req-12345')
      expect(ex.metadata.decision).toBe('allow')
      expect(ex.metadata.source).toBe('user_override')
      expect(ex.metadata.classifierDecision).toBe('block')

      const assistant = JSON.parse(ex.messages[2].content)
      expect(assistant.decision).toBe('allow')
      expect(assistant.riskScore).toBe(1)
      expect(assistant.riskReason).toContain(
        'User overrode classifier block and approved command as safe'
      )
      expect(assistant.category).toBe('safe')
    })

    it('derives classifier block decision', () => {
      const line = JSON.stringify({
        ts: '2026-09-02T10:25:00.000Z',
        type: 'permissions:decision',
        payload: {
          surface: 'shell',
          value: 'cat /etc/shadow',
          result: 'deny',
          resolution: 'classifier_block',
          decidedBy: 'classifier',
          detail: {
            toolName: 'bash',
            risk: {
              score: 10,
              reason: 'Attempted access to shadow passwords',
              category: 'credential_access',
            },
          },
        },
      })

      const { examples, stats } = exportDatasetFromLines([line])
      expect(stats.validDecisions).toBe(1)
      expect(stats.exported).toBe(1)
      expect(stats.byDecision.block).toBe(1)
      expect(stats.bySource.classifier).toBe(1)

      const ex = examples[0]
      expect(ex.metadata.decision).toBe('block')
      expect(ex.metadata.source).toBe('classifier')
      expect(ex.metadata.classifierDecision).toBe('block')

      const assistant = JSON.parse(ex.messages[2].content)
      expect(assistant.decision).toBe('block')
      expect(assistant.riskScore).toBe(10)
      expect(assistant.riskReason).toBe('Attempted access to shadow passwords')
      expect(assistant.category).toBe('credential_access')
    })

    it('derives rule and session allow decisions', () => {
      const lines = [
        JSON.stringify({
          ts: '2026-09-02T10:30:00.000Z',
          type: 'permissions:decision',
          payload: {
            surface: 'shell',
            value: 'git status',
            result: 'allow',
            resolution: 'allow',
            decidedBy: 'rule',
            detail: {
              rule: { reason: 'Safe git command' },
            },
          },
        }),
        JSON.stringify({
          ts: '2026-09-02T10:31:00.000Z',
          type: 'permissions:decision',
          payload: {
            surface: 'fs',
            value: '/project/src/index.ts',
            result: 'allow',
            resolution: 'session_allow',
            decidedBy: 'session',
          },
        }),
      ]

      const { examples, stats } = exportDatasetFromLines(lines)
      expect(stats.validDecisions).toBe(2)
      expect(stats.exported).toBe(2)
      expect(stats.byDecision.allow).toBe(2)
      expect(stats.bySource.rule).toBe(1)
      expect(stats.bySource.session).toBe(1)

      const fsExample = examples.find((e) => e.metadata.source === 'session')
      expect(fsExample?.messages[1].content).toContain('Surface: fs')
      expect(fsExample?.messages[1].content).toContain(
        'Arguments: {"path":"/project/src/index.ts"}'
      )
    })
  })

  describe('deduplication', () => {
    it('replaces rule decision with human user decision for same command', () => {
      const lines = [
        JSON.stringify({
          ts: '2026-09-02T10:00:00.000Z',
          type: 'permissions:decision',
          payload: {
            surface: 'shell',
            value: 'curl http://internal.api',
            result: 'allow',
            resolution: 'allow',
            decidedBy: 'rule',
          },
        }),
        JSON.stringify({
          ts: '2026-09-02T10:05:00.000Z',
          type: 'permissions:decision',
          payload: {
            surface: 'shell',
            value: 'curl http://internal.api',
            result: 'deny',
            resolution: 'permission_ask',
            decidedBy: 'user',
            denialReason: 'Do not access internal API',
          },
        }),
      ]

      const { examples, stats } = exportDatasetFromLines(lines)
      expect(stats.validDecisions).toBe(2)
      expect(stats.deduplicated).toBe(1)
      expect(stats.exported).toBe(1)
      expect(examples[0].metadata.source).toBe('user')
      expect(examples[0].metadata.decision).toBe('block')
    })

    it('keeps higher priority when human decision appears before rule decision', () => {
      const lines = [
        JSON.stringify({
          ts: '2026-09-02T10:00:00.000Z',
          type: 'permissions:decision',
          payload: {
            surface: 'shell',
            value: 'curl http://internal.api',
            result: 'deny',
            resolution: 'permission_ask',
            decidedBy: 'user',
            denialReason: 'Do not access internal API',
          },
        }),
        JSON.stringify({
          ts: '2026-09-02T10:05:00.000Z',
          type: 'permissions:decision',
          payload: {
            surface: 'shell',
            value: 'curl http://internal.api',
            result: 'allow',
            resolution: 'allow',
            decidedBy: 'rule',
          },
        }),
      ]

      const { examples, stats } = exportDatasetFromLines(lines)
      expect(stats.validDecisions).toBe(2)
      expect(stats.deduplicated).toBe(1)
      expect(stats.exported).toBe(1)
      expect(examples[0].metadata.source).toBe('user')
    })

    it('resolves tie in rank by choosing newer timestamp', () => {
      const lines = [
        JSON.stringify({
          ts: '2026-09-02T10:00:00.000Z',
          type: 'permissions:decision',
          payload: {
            surface: 'shell',
            value: 'npm test',
            result: 'allow',
            resolution: 'permission_ask',
            decidedBy: 'user',
            requestId: 'old-request',
          },
        }),
        JSON.stringify({
          ts: '2026-09-02T10:10:00.000Z',
          type: 'permissions:decision',
          payload: {
            surface: 'shell',
            value: 'npm test',
            result: 'allow',
            resolution: 'permission_ask',
            decidedBy: 'user',
            requestId: 'new-request',
          },
        }),
      ]

      const { examples, stats } = exportDatasetFromLines(lines)
      expect(stats.deduplicated).toBe(1)
      expect(stats.exported).toBe(1)
      expect(examples[0].id).toBe('new-request')
    })
  })

  describe('class balancing with maxAllowRatio', () => {
    it('caps routine allows at Math.max(10, Math.floor(highValue.length * maxAllowRatio))', () => {
      // 2 high value (block) examples
      const highValueLines = [
        JSON.stringify({
          ts: '2026-09-02T10:00:00.000Z',
          type: 'permissions:decision',
          payload: {
            surface: 'shell',
            value: 'dangerous-cmd-1',
            result: 'deny',
            resolution: 'permission_ask',
            decidedBy: 'user',
          },
        }),
        JSON.stringify({
          ts: '2026-09-02T10:01:00.000Z',
          type: 'permissions:decision',
          payload: {
            surface: 'shell',
            value: 'dangerous-cmd-2',
            result: 'deny',
            resolution: 'permission_ask',
            decidedBy: 'user',
          },
        }),
      ]

      // 25 routine allow examples
      const routineLines = Array.from({ length: 25 }, (_, i) =>
        JSON.stringify({
          ts: new Date(
            Date.parse('2026-09-02T11:00:00.000Z') + i * 1000
          ).toISOString(),
          type: 'permissions:decision',
          payload: {
            surface: 'shell',
            value: `safe-cmd-${i}`,
            result: 'allow',
            resolution: 'allow',
            decidedBy: 'rule',
          },
        })
      )

      // default maxAllowRatio = 3 -> Math.max(10, Math.floor(2 * 3)) = 10
      const { examples, stats } = exportDatasetFromLines([
        ...highValueLines,
        ...routineLines,
      ])
      expect(stats.validDecisions).toBe(27)
      expect(stats.exported).toBe(12) // 2 high value + 10 routine
      expect(stats.byDecision.block).toBe(2)
      expect(stats.byDecision.allow).toBe(10)
      expect(examples).toHaveLength(12)
    })

    it('disables balancing when maxAllowRatio is Infinity', () => {
      const highValueLines = [
        JSON.stringify({
          ts: '2026-09-02T10:00:00.000Z',
          type: 'permissions:decision',
          payload: {
            surface: 'shell',
            value: 'dangerous-cmd-1',
            result: 'deny',
            resolution: 'permission_ask',
            decidedBy: 'user',
          },
        }),
      ]

      const routineLines = Array.from({ length: 25 }, (_, i) =>
        JSON.stringify({
          ts: new Date(
            Date.parse('2026-09-02T11:00:00.000Z') + i * 1000
          ).toISOString(),
          type: 'permissions:decision',
          payload: {
            surface: 'shell',
            value: `safe-cmd-${i}`,
            result: 'allow',
            resolution: 'allow',
            decidedBy: 'rule',
          },
        })
      )

      const { examples, stats } = exportDatasetFromLines(
        [...highValueLines, ...routineLines],
        { maxAllowRatio: Infinity }
      )
      expect(stats.exported).toBe(26)
      expect(stats.byDecision.allow).toBe(25)
      expect(examples).toHaveLength(26)
    })
  })

  describe('exportDatasetFile', () => {
    it('reads input jsonl and writes formatted dataset jsonl', async () => {
      const tempDir = await fsPromises.mkdtemp(join(tmpdir(), 'dataset-test-'))
      const inputPath = join(tempDir, 'telemetry.jsonl')
      const outputPath = join(tempDir, 'export.dataset.jsonl')

      const sampleEvents = [
        JSON.stringify({
          ts: '2026-09-02T12:00:00.000Z',
          type: 'permissions:decision',
          payload: {
            surface: 'shell',
            value: 'npm start',
            result: 'allow',
            resolution: 'allow',
            decidedBy: 'rule',
          },
        }),
        JSON.stringify({
          ts: '2026-09-02T12:01:00.000Z',
          type: 'permissions:decision',
          payload: {
            surface: 'shell',
            value: 'drop database',
            result: 'deny',
            resolution: 'permission_ask',
            decidedBy: 'user',
            denialReason: 'Never drop database',
          },
        }),
      ]

      await fsPromises.writeFile(
        inputPath,
        sampleEvents.join('\n') + '\n',
        'utf8'
      )

      const stats = await exportDatasetFile(inputPath, outputPath)
      expect(stats.totalLines).toBe(2)
      expect(stats.exported).toBe(2)
      expect(stats.byDecision.allow).toBe(1)
      expect(stats.byDecision.block).toBe(1)

      const writtenContent = await fsPromises.readFile(outputPath, 'utf8')
      const lines = writtenContent.trim().split('\n')
      expect(lines).toHaveLength(2)

      const ex1 = JSON.parse(lines[0])
      expect(ex1.messages).toHaveLength(3)
      expect(ex1.messages[0].role).toBe('system')
      expect(ex1.messages[1].role).toBe('user')
      expect(ex1.messages[2].role).toBe('assistant')

      await fsPromises.rm(tempDir, { recursive: true, force: true })
    })

    it('handles non-existent input gracefully with 0 records', async () => {
      const tempDir = await fsPromises.mkdtemp(
        join(tmpdir(), 'dataset-test-missing-')
      )
      const missingInput = join(tempDir, 'missing.jsonl')
      const outputPath = join(tempDir, 'empty.dataset.jsonl')

      const stats = await exportDatasetFile(missingInput, outputPath)
      expect(stats.totalLines).toBe(0)
      expect(stats.exported).toBe(0)

      const written = await fsPromises.readFile(outputPath, 'utf8')
      expect(written).toBe('')

      await fsPromises.rm(tempDir, { recursive: true, force: true })
    })
  })
})
