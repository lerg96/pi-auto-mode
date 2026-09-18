import type { Rule } from '../permission/rule.ts'

export interface ClassifierRisk {
  score: number
  level: 'low' | 'medium' | 'high'
  reason: string
  category?: string
}

export interface AskRequest {
  surface: string
  value: string
  rule?: Rule
  risk?: ClassifierRisk
  requestId?: string // NUEVO: lo genera gate.ts y se hila hasta el modal y emitUiPrompt
  /** Tool name as invoked (e.g. 'bash'); shown in the modal header. Falls back to `surface` when absent. */
  tool?: string
  /** Full original command (e.g. input.command); shown when it differs from `value`. */
  fullCommand?: string
}

// NUEVO: una negación puede llevar una razón legible (se muestra al modelo).
// Union retrocompatible: los callers que hoy devuelven 'allow'/'deny' siguen compilando.
// `allow_session` es la decisión del modal "Allow for session" — el gate la
// persiste en SessionRules; `allow` es la decisión del modal "Allow" (grant
// once, sin persistencia). El object-form equivalente lleva la misma
// semántica.
// Dónde se materializó la decisión. `parent-modal` = el modal se renderizó en
// la UI de otra sesión del proceso (sub-sesión sin UI propia); `no-ui` = no se
// mostró nada a nadie, así que NADIE decidió (no debe auditarse como usuario);
// `timeout` = el prompt se mostró pero nadie respondió antes de expirar.
export type AskVia = 'modal' | 'parent-modal' | 'no-ui' | 'timeout'

export type AskDecision =
  | 'allow'
  | 'allow_session'
  | 'deny'
  | {
      decision: 'allow' | 'allow_session' | 'deny'
      reason?: string
      via?: AskVia
    }

/**
 * Formas de respuesta de un resolver → forma canónica para el gate.
 * Un string suelto se trata como `modal` (decisión humana); el resolver por
 * defecto devuelve el objeto con `via: 'no-ui'`, que es lo que realmente pasó.
 */
export function normalizeAskDecision(res: AskDecision): {
  decision: 'allow' | 'allow_session' | 'deny'
  reason?: string
  via: AskVia
} {
  if (typeof res === 'string') return { decision: res, via: 'modal' }
  return { decision: res.decision, reason: res.reason, via: res.via ?? 'modal' }
}

export type AskResolver = (req: AskRequest) => Promise<AskDecision>

// Sin resolver instalado no hay a quién preguntar: se deniega y se dice.
export const defaultAskResolver: AskResolver = async () => ({
  decision: 'deny',
  via: 'no-ui',
})

let current: AskResolver = defaultAskResolver

export function getAskResolver(): AskResolver {
  return current
}

export function setAskResolver(r: AskResolver): void {
  current = r
}
