import { createHash } from 'node:crypto'
import {
  captureScriptFingerprints,
  verifyScriptFingerprints,
  type ScriptFingerprint,
} from '../permission/script-fingerprint.ts'
import type { ClassifierInput, ClassifierResult } from './llm-layer.ts'

interface CacheEntry {
  result: ClassifierResult
  fingerprints: ScriptFingerprint[]
}

const MAX_CACHE_ENTRIES = 200
const cache = new Map<string, CacheEntry>()

export function buildClassifierCacheKey(
  input: ClassifierInput,
  modelId: string,
  api: string
): string {
  const restArgs: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(input.arguments ?? {})) {
    if (input.surface === 'shell' && k === 'command') continue
    restArgs[k] = v
  }
  const raw = JSON.stringify({
    api,
    modelId,
    toolName: input.toolName,
    surface: input.surface,
    cwd: input.cwd ?? '',
    value: input.value,
    restArgs,
  })
  return createHash('sha256').update(raw).digest('hex')
}

export function getCachedClassifierAllow(
  key: string,
  input: ClassifierInput
): ClassifierResult | undefined {
  const entry = cache.get(key)
  if (!entry) return undefined
  if (entry.fingerprints.length > 0) {
    const cwd = input.cwd ?? process.cwd()
    if (!verifyScriptFingerprints(entry.fingerprints, input.value, cwd)) {
      cache.delete(key)
      return undefined
    }
  }
  return entry.result
}

export function setCachedClassifierAllow(
  key: string,
  input: ClassifierInput,
  result: ClassifierResult
): void {
  if (result.decision !== 'allow' || result.risk?.riskOrigin !== 'llm') {
    return
  }
  const cwd = input.cwd ?? process.cwd()
  const fingerprints =
    input.surface === 'shell' ||
    input.toolName === 'bash' ||
    input.toolName === 'powershell'
      ? captureScriptFingerprints(input.value, cwd)
      : []

  if (cache.size >= MAX_CACHE_ENTRIES && !cache.has(key)) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(key, { result, fingerprints })
}

export function clearClassifierCache(): void {
  cache.clear()
}
