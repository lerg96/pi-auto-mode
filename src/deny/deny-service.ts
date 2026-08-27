import type { DenyStrategyConfig } from '../types/config.ts'

export type DenialTrigger = 'permission' | 'classifier'

export type DenialAction =
  'deny-and-continue' | 'auto-retry' | 'ask-user' | 'escalate'

export interface DenialContext {
  toolName: string
  reason: string
  riskLevel?: 'low' | 'medium' | 'high'
  trigger: DenialTrigger
}

export class DenyAndContinueService {
  private consecutive = 0
  private total = 0
  // H7: audit trail buffer — stores recent denial records for forensic analysis.
  private auditTrail: Array<{
    time: number
    trigger: DenialTrigger
    toolName: string
    reason: string
    riskLevel?: string
  }> = []
  private readonly maxAuditTrail = 100

  constructor(private cfg: DenyStrategyConfig) {}

  updateConfig(cfg: DenyStrategyConfig): void {
    this.cfg = cfg
  }

  reset(): void {
    this.consecutive = 0
    this.total = 0
    this.auditTrail = []
  }

  private exceedsLimits(): boolean {
    const { escalation: e } = this.cfg
    return (
      (e.total > 0 && this.total >= e.total) ||
      (e.consecutive > 0 && this.consecutive >= e.consecutive)
    )
  }

  recordDenial(ctx: DenialContext): DenialAction {
    this.total++
    this.consecutive++

    // H7: record denial context for audit trail
    this.auditTrail.push({
      time: Date.now(),
      trigger: ctx.trigger,
      toolName: ctx.toolName,
      reason: ctx.reason,
      riskLevel: ctx.riskLevel,
    })
    if (this.auditTrail.length > this.maxAuditTrail) {
      this.auditTrail.shift()
    }

    if (this.exceedsLimits()) {
      return 'escalate'
    }

    const { mode } = this.cfg
    if (mode === 'ask-user') return 'ask-user'
    return 'deny-and-continue'
  }

  onContinueSucceeded(): void {
    // A genuine user allow resets only the consecutive streak; `total` stays as a
    // session-wide cap so denial escalation is not defeated by auto-continue.
    this.consecutive = 0
  }

  getStats(): { consecutive: number; total: number } {
    return { consecutive: this.consecutive, total: this.total }
  }

  /** H7: return audit trail for forensic analysis. */
  getAuditTrail(): typeof DenyAndContinueService.prototype.auditTrail {
    return [...this.auditTrail]
  }
}
