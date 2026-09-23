import { z } from 'zod'
import { join } from 'node:path'
import { homedir } from 'node:os'

// ──────────────────────────────────────────────────────────────────────────────
// CONSTANTES Y ENUMS BÁSICOS
// ──────────────────────────────────────────────────────────────────────────────

// Acción simple usada en permisos (string) y en pattern rules (objeto)
const simpleAction = z.enum(['allow', 'deny', 'ask']) as z.ZodEnum<
  ['allow', 'deny', 'ask']
>

// Modo global de comportamiento para 'ask'
const mode = z.enum(['default', 'strict', 'yolo']) as z.ZodEnum<
  ['default', 'strict', 'yolo']
>

// Qué hacer cuando el clasificador LLM falla (timeout / error HTTP / parse error)
// 'allow' es OPT-IN fail-open. 'deny' y 'ask-user' son fail-closed.
// Valores desconocidos → 'ask-user' defensivamente (nunca 'allow' silencioso).
const onFail = z.enum(['ask-user', 'deny', 'allow']) as z.ZodEnum<
  ['ask-user', 'deny', 'allow']
>

// Modo de denyStrategy (canonical: 'auto-retry' | 'ask-user' | 'both')
// 'deny-and-continue' alias legacy se normaliza a 'auto-retry' en el schema.
const denyMode = z
  .enum(['auto-retry', 'ask-user', 'both', 'deny-and-continue'])
  .transform((m) => (m === 'deny-and-continue' ? 'auto-retry' : m))

// Default path para telemetry: <HOME>/.pi/pi-auto-mode.jsonl
// Resuelto en parse time (no module load) para permitir mock de HOME en tests.
export const DEFAULT_TELEMETRY_PATH = join(
  homedir(),
  '.pi',
  'pi-auto-mode.jsonl'
)

// Default path para debug: <HOME>/.pi/pi-auto-mode.debug.jsonl
// Mismo criterio que telemetry: resuelto en parse time.
export const DEFAULT_DEBUG_PATH = join(
  homedir(),
  '.pi',
  'pi-auto-mode.debug.jsonl'
)

// ──────────────────────────────────────────────────────────────────────────────
// SCHEMAS ANIDADOS (cada campo con default)
// ──────────────────────────────────────────────────────────────────────────────

// Una regla de patrón: glob simple contra el string completo del tool call
// (ej. comando bash, path, args del mcp). Primer match del array gana.
const patternRule = z.object({
  pattern: z.string(),
  action: simpleAction,
  reason: z.string().optional(),
}) satisfies z.ZodType<{
  pattern: string
  action: 'allow' | 'deny' | 'ask'
  reason?: string
}>

// Permiso por tool: puede ser acción simple (string) O array de PatternRule[]
// Caso simple:  "read": "allow"
// Caso granular: "bash": [{ pattern: "aws delete_*", action: "deny", reason: "..." }, ...]
const toolPermission: z.ZodUnion<
  [z.ZodEnum<['allow', 'deny', 'ask']>, z.ZodArray<typeof patternRule>]
> = z.union([simpleAction, z.array(patternRule)])

const permissionsBlock = z.object({
  tools: z.record(z.string(), toolPermission).optional(),
  skills: z.record(z.string(), toolPermission).optional(),
  mcps: z.record(z.string(), toolPermission).optional(),
  external_directory: z.record(z.string(), simpleAction).optional(),
})

const permissionSet = z
  .object({
    permissions: permissionsBlock.default({}),
  })
  .strict()

// ─── LLM Config ──────────────────────────────────────────────────────────────
const llmConfig = z
  .object({
    // Provider ID — SOLO para buscar credenciales en Pi's modelRegistry:
    //   find(provider, model)?.baseUrl   y   getApiKeyForProvider(provider)
    // Cualquier ID configurado en Pi (ej. 'litellm', 'anthropic', 'ollama') es válido.
    provider: z.string().min(1).default('anthropic'),
    model: z.string().default(''),
    // '' (vacío) → resuelve lazy desde modelRegistry de Pi por call.
    baseUrl: z.string().default(''),
    apiKey: z.string().default(''),
    // NUNCA se loguea, NUNCA en telemetry, NUNCA en deny messages.
    timeoutMs: z.number().int().positive().default(5000),
    // max_tokens en request body. Modelos THINKING (Kimi, DeepSeek-R1, MiniMax via LiteLLM)
    // consumen tokens en reasoning ANTES de emitir JSON. Default 1024 da margen.
    maxTokens: z.number().int().positive().default(1024),
    // Extra params merged into the chat-completions request body (opt-in).
    // Spread LAST so explicit extras win on collision. Values must be
    // JSON-serializable. e.g. thinking-model reasoning effort:
    //   extraBody: { reasoning_effort: 'low' }
    extraBody: z.record(z.string(), z.unknown()).optional(),
    // Extra HTTP headers merged into the request (opt-in). Authorization is
    // ALWAYS set from the resolved apiKey AFTER extras (credential
    // protection: extras cannot override or drop the auth header).
    extraHeaders: z.record(z.string(), z.string()).optional(),
    // Same-model retry policy (opt-in). Absent = fail fast to the
    // fallback-model path, exactly as before (zero behavior change).
    // `statuses` maps HTTP status → extra retries of the SAME model
    // (e.g. { "429": 3, "500": 2 }); unlisted statuses never retry
    // (notably 400). `backoffMs` sleeps between retries, indexed by
    // retry number with the last entry repeating.
    retries: z
      .object({
        statuses: z
          .record(z.string(), z.number().int().min(0).max(5))
          .default({}),
        backoffMs: z
          .array(z.number().int().min(0).max(30000))
          .default([500, 5000, 15000]),
      })
      .optional(),
    fallbackModel: z.string().default(''),
    systemPrompt: z.string().default(''),
    enabled: z.boolean().default(true),
  })
  .default({
    provider: 'anthropic',
    model: '',
    baseUrl: '',
    apiKey: '',
    timeoutMs: 5000,
    maxTokens: 1024,
    fallbackModel: '',
    systemPrompt: '',
    enabled: true,
  })

// ─── Classifier Config ───────────────────────────────────────────────────────
const fallbackConfig = z
  .object({
    onTimeout: onFail.default('ask-user'),
    onError: onFail.default('ask-user'),
  })
  .default({ onTimeout: 'ask-user', onError: 'ask-user' })

const classifierConfig = z
  .object({
    enabled: z.boolean().default(true),
    llm: llmConfig,
    fallback: fallbackConfig,
    // 'deny' (default) → muro absoluto; 'ask' → pasa a denyStrategy
    onBlock: z.enum(['ask', 'deny']).default('deny'),
    // true → classifier block rutea a denyStrategy (humano decide bajo ask-user,
    // LLM reintenta bajo auto-retry/both). Default false = muro final.
    onBlockUserOverride: z.boolean().default(false),
  })
  .default({
    enabled: true,
    llm: {
      provider: 'anthropic',
      model: '',
      baseUrl: '',
      apiKey: '',
      timeoutMs: 5000,
      maxTokens: 1024,
      fallbackModel: '',
      systemPrompt: '',
      enabled: true,
    },
    fallback: { onTimeout: 'ask-user', onError: 'ask-user' },
    onBlock: 'deny',
    onBlockUserOverride: false,
  })

// ─── DenyStrategy (SIN CAMBIOS respecto al schema actual) ────────────────────
const escalationConfig = z
  .object({
    consecutive: z.number().int().positive().default(3),
    total: z.number().int().positive().default(20),
  })
  .default({ consecutive: 3, total: 20 })

const denyStrategyConfig = z
  .object({
    mode: denyMode.default('both'),
    escalation: escalationConfig,
  })
  .default({
    mode: 'both',
    escalation: { consecutive: 3, total: 20 },
  })

// ─── UI Config (SIN CAMBIOS salvo quitar doublePressToConfirm) ───────────────
const uiConfig = z
  .object({
    // DEPRECADO/IGNORADO — mantenido por compat con configs viejas.
    // El modal usa Pi's native `select()` (un solo Enter). Este campo no hace nada.
    doublePressToConfirm: z.boolean().default(true),
    promptMaxRows: z.number().int().positive().default(8),
    promptFieldMaxWidth: z.number().int().positive().default(120),
    showClassifierRisk: z.boolean().default(true),
    // -1 = sin timeout (ilimitado). Default 120000 = 2 min.
    modalTimeoutMs: z.number().int().default(120000),
    // Timeout de los prompts que se renderizan en la UI del padre porque la
    // sub-sesión no tiene UI propia (ver `noUiAsks`). INDEPENDIENTE de
    // `modalTimeoutMs`: un sub-agente en background puede dejar el modal
    // abierto indefinidamente y, mientras tanto, sostiene el lock de prompts
    // del proceso. -1 = ilimitado.
    subagentModalTimeoutMs: z.number().int().default(120000),
    // Qué hacer con un ask cuando ESTA sesión no tiene UI (p. ej. una
    // sub-sesión creada por pi-subagents, que nunca recibe `uiContext`).
    //   'bubble' (default): renderizar el modal en la UI de la sesión padre
    //     del proceso, si alguna vez publicó una (nunca en `pi -p`).
    //   'deny': denegar sin preguntar (comportamiento histórico).
    noUiAsks: z.enum(['bubble', 'deny']).default('bubble'),
    // Sonido al abrir el modal (opt-in). Ausente = silencioso.
    // `path` vacío → doble tono del sistema (sin archivos); con path → .wav.
    // `remindEveryMs` > 0 repite el aviso hasta decidir; 0 = un solo ding.
    sound: z
      .object({
        enabled: z.boolean().default(false),
        path: z.string().default(''),
        remindEveryMs: z.number().int().min(0).default(20000),
      })
      .optional(),
  })
  .default({
    doublePressToConfirm: true,
    promptMaxRows: 8,
    promptFieldMaxWidth: 120,
    showClassifierRisk: true,
    modalTimeoutMs: 120000,
    subagentModalTimeoutMs: 120000,
    noUiAsks: 'bubble',
  })

// ─── Rotación de logs (compartida por telemetry y debug) ────────────────────
// Tamaño máximo SOFT del archivo activo. El drain rota CUANDO LA ESTIMACIÓN
// (stat inicial + bytes acumulados por batch) pasa de maxBytes.
// 5 MiB: con ~94 KB/día medidos en máquina real, ~2 meses de historia por
// archivo antes de rotar (5 MiB / 94 KB ≈ 55 días).
// Para desactivar la rotación existe el flag explícito `rotationEnabled`
// (false = el archivo crece sin límite); no uses centinelas numéricos.
export const DEFAULT_ROTATION_MAX_BYTES = 5 * 1024 * 1024
// Número de BACKUPS rotados que se conservan (path.1 ... path.N) cuando el
// archivo activo supera maxBytes. Techo total de disco: maxBytes*(maxFiles+1)
// (activo + N backups), aproximado por diseño.
export const DEFAULT_ROTATION_MAX_FILES = 3

// Fuente única de verdad de los campos de rotación: telemetry y debug los
// componen del mismo objeto, así sus schemas no pueden divergir.
const rotationFields = {
  // Interruptor explícito de la rotación. Default true = comportamiento de
  // siempre. Con false el log crece sin límite (coste medido: ~94 KB/día) y
  // `maxBytes`/`maxFiles` quedan sin efecto. SE LLAMA rotationEnabled, no
  // `enabled`, porque este objeto se propaga en bloques que ya tienen su
  // propio `enabled` (telemetry.enabled / debug.enabled) y chocaría.
  rotationEnabled: z.boolean().default(true),
  maxBytes: z.number().int().positive().default(DEFAULT_ROTATION_MAX_BYTES),
  maxFiles: z.number().int().positive().default(DEFAULT_ROTATION_MAX_FILES),
}

// ─── Telemetry Config ────────────────────────────────────────────────────────
const telemetryConfig = z
  .object({
    enabled: z.boolean().default(false),
    // '' → default: ~/.pi/pi-auto-mode.jsonl
    path: z
      .string()
      .default(DEFAULT_TELEMETRY_PATH)
      .transform((p) => (p.trim().length === 0 ? DEFAULT_TELEMETRY_PATH : p)),
    ...rotationFields,
  })
  .default({
    enabled: false,
    path: DEFAULT_TELEMETRY_PATH,
    rotationEnabled: true,
    maxBytes: DEFAULT_ROTATION_MAX_BYTES,
    maxFiles: DEFAULT_ROTATION_MAX_FILES,
  })

// ─── Debug Config (ESPEJO de telemetry, archivo separado) ────────────────────
// Opt-in apagado por default: sin `debug.enabled: true` no se escribe nada.
// Aquí van diagnósticos ruidosos (errores LLM con body upstream) que NO
// pertenecen al telemetry de decisiones.
const debugConfig = z
  .object({
    enabled: z.boolean().default(false),
    // '' → default: ~/.pi/pi-auto-mode.debug.jsonl
    path: z
      .string()
      .default(DEFAULT_DEBUG_PATH)
      .transform((p) => (p.trim().length === 0 ? DEFAULT_DEBUG_PATH : p)),
    ...rotationFields,
  })
  .default({
    enabled: false,
    path: DEFAULT_DEBUG_PATH,
    rotationEnabled: true,
    maxBytes: DEFAULT_ROTATION_MAX_BYTES,
    maxFiles: DEFAULT_ROTATION_MAX_FILES,
  })

// ──────────────────────────────────────────────────────────────────────────────
// ROOT SCHEMA — Config principal
// ──────────────────────────────────────────────────────────────────────────────

/**
 * ALGORITMO DE CASCADA (CSS-style — último match gana)
 *
 * sources = [ permissions (global), ...activePermissionSets.map(id => permissionSets[id].permissions) ]
 * // permissions global va PRIMERO (base/default), los activePermissionSets se aplican
 * // DESPUÉS en el orden en que aparecen en activePermissionSets.
 *
 * decision = undefined
 * for source in sources:                           // en orden, menor → mayor precedencia
 *   value = source.tools[toolName] ?? source.tools['*']  // (o .skills / .mcps)
 *     // '"*"' = catch-all solo para nombres SIN entrada propia (incl.
 *     // unknown tools). Entrada exacta con patterns que no matchean la
 *     // call = la fuente no opina (NO cae a '"*"', allow-final intacto).
 *   if value is undefined: continue                 // esta fuente no opina, seguir
 *   if value is SimpleAction ('allow'|'deny'|'ask'):
 *     decision = { action: value }                  // SOBREESCRIBE lo que había antes
 *   if value is PatternRule[]:
 *     match = firstMatch(value, callArgs)           // primer match del array gana
 *     if match:
 *       decision = { action: match.action, reason: match.reason }  // SOBREESCRIBE
 *     // si no hay match, esta fuente no opina para ESTA call puntual —
 *     // el `decision` de una fuente anterior se mantiene tal cual
 *
 * final = decision?.action ?? fallbackForMode(mode)
 *   // fallbackForMode: 'default'->'ask', 'strict'->'deny', 'yolo'->'allow'
 *
 * VISIBILIDAD EN SYSTEM PROMPT:
 *   Misma cascada, pero SOLO considerando entradas SimpleAction (string).
 *   Arrays de PatternRule se ignoran (no se sabe de antemano qué arg se invoca).
 *   Si la última entrada string en la cadena es "deny" → tool oculto;
 *   en cualquier otro caso (incluyendo solo arrays) → visible.
 *
 * EXTERNAL_DIRECTORY (scope de directorio, opt-in vía confineToWorkingDirectory):
 *   Mapa plano `external_directory: Record<glob, SimpleAction>` (SIN PatternRule[]).
 *   Cascada igual que tools/skills/mcps: global primero, sets activos después;
 *   último match gana (dentro de un mapa, la última clave que matchea gana).
 *   Solo opina sobre paths FUERA de process.cwd(); sin match explícito → 'ask'.
 *   No opina sobre paths internos. En el gate solo ENDURECE (ver gateToolCall).
 *   Worktrees git: con `trustGitWorktrees: true` (default), un path sin regla
 *   explícita que vive dentro de un worktree registrado del repo actual cuenta
 *   como interno (no ask). Las reglas explícitas ganan siempre: un deny/ask que
 *   matchea el path del worktree se aplica. Ver permission/git-worktrees.ts.
 *   Qué tools se validan: `externalDirectoryTools` lista los nombres de tool
 *   (globs) sobre los que aplica el scope. Default `['*']` = todas. Una tool
 *   fuera de la lista NO pasa por esta capa: si su cascada dijo allow, ese es
 *   el veredicto, aunque toque rutas fuera de cwd. `[]` = no validar ninguna.
 *
 * DÓNDE ENTRA classifier.llm:
 *   Solo se consulta cuando la cascada de permissions resuelve final === 'ask'.
 *   Si decide allow/deny, ese es el resultado; si falla/timeoutea, aplica classifier.fallback.
 *   Si classifier.enabled === false, un ask de la cascada pasa directo a denyStrategy.
 */
export const ConfigSchema = z
  .object({
    // Permission sets nombrados (cada uno con su bloque de permissions)
    permissionSets: z.record(z.string(), permissionSet).default({}),
    // Qué sets están activos. EL ORDEN IMPORTA: primero = menor precedencia.
    activePermissionSets: z.array(z.string()).default([]),
    // Bloque global de permisos (base). Va PRIMERO en la cascada.
    permissions: permissionsBlock.default({}),
    // Modo global de 'ask'
    mode: mode.default('default'),
    // Scope de directorio: cuando es true, los paths fuera de process.cwd()
    // endurecen el veredicto vía external_directory (default false = sin cambios).
    confineToWorkingDirectory: z.boolean().default(false),
    // Worktrees git del repo actual cuentan como internos al evaluar
    // external_directory (solo aplica si confineToWorkingDirectory es true).
    // true  → `git worktree add ../wt` y trabajar ahí no genera ask.
    // false → cada worktree es un directorio externo más.
    // Reglas explícitas de external_directory SIEMPRE ganan: un deny/ask que
    // matchea el path del worktree se respeta igual.
    trustGitWorktrees: z.boolean().default(true),
    // Qué tools evalúa la capa external_directory. Globs sobre el NOMBRE de la
    // tool (mismo matcher que los patterns de `permissions.tools`).
    //   ['*']                → todas (comportamiento histórico; default).
    //   ['bash','write']     → solo esas; p. ej. `read` queda fuera de la capa
    //                          y un allow suyo sigue siendo allow aunque lea
    //                          fuera de cwd.
    //   []                   → la capa no aplica a ninguna tool (apagada).
    // Solo QUITA endurecimiento: nunca relaja una regla de `permissions.tools`.
    externalDirectoryTools: z.array(z.string().min(1)).default(['*']),
    // Clasificador LLM
    classifier: classifierConfig,
    // Deny strategy (sin cambios)
    denyStrategy: denyStrategyConfig,
    // UI (sin cambios salvo doublePressToConfirm deprecated)
    ui: uiConfig,
    // Telemetry (sin cambios)
    telemetry: telemetryConfig,
    // Debug log (opt-in, separado de telemetry)
    debug: debugConfig,
  })
  .strict()

export type Config = z.infer<typeof ConfigSchema>

// Type exports para consumidores (src/permission/*, src/gate/*, src/classifier/*)
export type SimpleAction = 'allow' | 'deny' | 'ask'

export interface PatternRule {
  pattern: string
  action: SimpleAction
  reason?: string
}

export type ToolPermission = SimpleAction | PatternRule[]

export interface PermissionsBlock {
  tools?: Record<string, ToolPermission>
  skills?: Record<string, ToolPermission>
  mcps?: Record<string, ToolPermission>
  external_directory?: Record<string, SimpleAction>
}

export interface PermissionSet {
  permissions: PermissionsBlock
}

export interface LlmConfig {
  provider: string
  model: string
  baseUrl: string
  apiKey: string
  timeoutMs: number
  maxTokens: number
  fallbackModel: string
  systemPrompt: string
  enabled: boolean
  extraBody?: Record<string, unknown>
  extraHeaders?: Record<string, string>
  retries?: LlmRetryPolicy
}

/** Same-model retry policy (mirrors `retries` zod sub-tree). */
export interface LlmRetryPolicy {
  statuses?: Record<string, number>
  backoffMs?: number[]
}

export interface ClassifierConfig {
  enabled?: boolean
  llm: LlmConfig
  fallback: {
    onTimeout: 'ask-user' | 'deny' | 'allow'
    onError: 'ask-user' | 'deny' | 'allow'
  }
  onBlock?: 'ask' | 'deny'
  onBlockUserOverride?: boolean
}

export interface DenyStrategyConfig {
  mode: 'auto-retry' | 'ask-user' | 'both'
  escalation: { consecutive: number; total: number }
}

export interface UiConfig {
  doublePressToConfirm: boolean
  promptMaxRows: number
  promptFieldMaxWidth: number
  showClassifierRisk: boolean
  modalTimeoutMs: number
  subagentModalTimeoutMs: number
  noUiAsks: 'bubble' | 'deny'
  sound?: SoundConfig
}

/** Sound-notification configuration (mirrors `ui.sound` zod sub-tree). */
export interface SoundConfig {
  enabled: boolean
  path: string
  remindEveryMs: number
}

export interface TelemetryConfig {
  enabled: boolean
  path: string
  rotationEnabled: boolean
  maxBytes: number
  maxFiles: number
}

/** Debug-log configuration (mirrors `debug` zod sub-tree). */
export interface DebugConfig {
  enabled: boolean
  path: string
  rotationEnabled: boolean
  maxBytes: number
  maxFiles: number
}

// ──────────────────────────────────────────────────────────────────────────────
// DEFAULT CONFIG & PARSER
// ──────────────────────────────────────────────────────────────────────────────

export const DEFAULT_CONFIG: Config = ConfigSchema.parse({})

export function parseConfig(raw: unknown): Config {
  return ConfigSchema.parse(raw)
}
