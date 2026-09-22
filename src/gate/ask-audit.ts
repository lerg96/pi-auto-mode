import type { AskVia } from './ask.ts'
import { BUS_CHANNEL_DECISION } from '../events.ts'

export interface GateHooks {
  emit?: (channel: string, data: unknown) => void
}

export interface AskAudit {
  requestId?: string
  // 'no-ui' = no se mostró ningún modal: no hubo humano que decidiera. Darlo
  // como 'user' falsea la auditoría (y entrena al modelo con datos falsos).
  // 'timeout' = se mostró, pero nadie respondió antes de expirar.
  decidedBy: 'user' | 'session' | 'no-ui' | 'timeout'
  // 'parent-modal' = el modal se renderizó en la UI de otra sesión del
  // proceso (sub-sesión sin UI propia). Derivado de AskVia para que el gate no
  // pueda quedarse atrás cuando ask.ts añade un origen nuevo.
  via: AskVia | 'session-rules'
  matchedPattern?: string
  denialReason?: string
}

export function emit(
  hooks: GateHooks,
  surface: string,
  value: string,
  result: string,
  resolution: string,
  extra?: AskAudit | Record<string, unknown>
): void {
  try {
    hooks.emit?.(BUS_CHANNEL_DECISION, {
      surface,
      value,
      result,
      resolution,
      ...extra,
    })
  } catch {
    /* fire-and-forget */
  }
}

// Quién hay detrás de la decisión de un ask. `no-ui` nunca es un usuario: no
// se mostró ningún prompt, así que atribuirla a una persona falsea la
// auditoría y el mensaje que recibe el modelo. Lo mismo con `timeout` (nadie
// respondió) y `session-rules` (quién decidió fue una aprobación previa).
export function askActor(via: AskAudit['via']): AskAudit['decidedBy'] {
  switch (via) {
    case 'no-ui':
      return 'no-ui'
    case 'timeout':
      return 'timeout'
    case 'session-rules':
      return 'session'
    default:
      return 'user'
  }
}
