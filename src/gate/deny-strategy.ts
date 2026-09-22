import type { DenialAction } from '../deny/deny-service.ts'
import type { GateDeps } from './gate.ts'

export function applyDenyStrategy(
  toolName: string,
  reason: string,
  trigger: 'permission' | 'classifier',
  deps: GateDeps
): DenialAction | 'ask' {
  if (!deps.denyService) return 'ask'
  return deps.denyService.recordDenial({ toolName, reason, trigger })
}
