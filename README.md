# pi-auto-mode

Extensión para el runtime de **Pi Coding Agent** (`@earendil-works/pi-coding-agent`) que añade un **modo seguro de auto-ejecución de comandos**. Pi por defecto ya permite todos los comandos de forma automática — esta extensión **no añade** la auto-ejecución en sí, sino una capa de validación que intenta garantizar que lo que se ejecuta sea al menos seguro. Cada llamada a herramientas se evalúa contra reglas de permisos, un clasificador de riesgo y una estrategia de bloqueo, y decide por ti entre `allow`, `deny` o `ask`. Pensado para quien quiere que el agente avance sin fricciones pero sin ceder el control de las operaciones sensibles.

## Características principales

- **Modelo de 4 capas** — la decisión combina un _visibility filter_ (qué ve el LLM), un _pattern matcher_ basado en claves exactas de toolName, un clasificador LLM opcional (solo cuando la cascada = `ask`) y una _deny strategy_ (qué pasa tras un bloque). Ver [Modelo de 4 capas](#modelo-de-4-capas).
- **Política por permission sets en cascada** — defines conjuntos nombrados de permisos; se evalúan en orden (global primero, sets activos después), último match gana.
- **Tres acciones de decisión** — `allow` (permite y sigue), `deny` (bloquea) y `ask` (pide confirmación), con matriz de decisión bien definida.
- **Clasificador LLM opcional** — se invoca **solo** cuando la cascada de permisos resuelve a `ask`; lee archivo referenciado (≤8KB) con trust-boundary check y redactor de secretos.
- **Fail-closed por diseño** — ante cualquier error de carga o evaluación, la herramienta se **bloquea**. Nunca se degrada a un permiso inseguro por defecto.
- **Estrategia `auto-retry`** — tras N bloqueos consecutivos o totales, escala el aviso para que el agente no se atasque en un bucle de intentos denegados. Alias retrocompatible: `deny-and-continue` se acepta y se normaliza a `auto-retry`.
- **Guard de secretos y trust boundary** — protege rutas y comandos sensibles (`/etc`, `~/.ssh`, `.env`, `sudo`, `rm -rf`, `git push --force`); el extractor de archivos respeta la misma frontera antes de pasar contenido al LLM.
- **Tres modos globales (`default` / `strict` / `yolo`)** — `yolo` reescribe `ask` → `allow` sin tocar los `deny` explícitos; `strict` reescribe `ask` → `deny`. Conmutables en caliente con `/auto-mode:mode`.
- **Ajustes en caliente** — recargas de config en runtime que **debiliten** la seguridad (desactivar clasificador, relajar fallback a `allow`, bajar la restricción del deny strategy, …) se rechazan automáticamente.
- **Comandos de sesión** — activa/desactiva permission sets y cambia el modo en caliente con confirmación explícita; contadores de bloqueo se reinician entre sesiones.

## Tabla de contenidos

- [Requisitos previos](#requisitos-previos)
- [Instalación](#instalación)
- [Modelo de 4 capas](#modelo-de-4-capas)
- [Configuración](#configuración)
- [Uso](#uso)
- [Flujo de confirmación (Ask)](#flujo-de-confirmación-ask)
- [Eventos](#eventos)
- [Ejemplos de configuración](#ejemplos-de-configuración)
- [Scripts disponibles](#scripts-disponibles)
- [Estructura del proyecto](#estructura-del-proyecto)
- [Testing](#testing)
- [Roadmap](#roadmap)
- [Cómo contribuir](#cómo-contribuir)
- [Desarrollo / Instalación local](#desarrollo--instalación-local)
- [Licencia](#licencia)

## Requisitos previos

- **Node.js >= 20** (desarrollo en v24). El proyecto es ESM (`"type": "module"`), target ES2022.
- **npm** (viene con Node).
- La extensión se ejecuta **dentro del runtime de Pi Coding Agent**, que inyecta el SDK `@earendil-works/pi-coding-agent` en tiempo de ejecución.

## Instalación

```bash
# 1. Clonar el repositorio
git clone <url-del-repo> pi-auto-mode
cd pi-auto-mode

# 2. Instalar dependencias
npm install
```

Hasta aquí tienes el proyecto listo para desarrollo. Para usarlo como extensión real, añádelo/cárgalo en tu configuración del runtime de Pi Coding Agent (el harness de Pi inyecta el SDK y dispara los eventos `tool_call`, `session_start`, etc.).

## Modelo de 4 capas

Una tool call atraviesa **cuatro capas** en orden antes de ejecutarse. Las tres primeras deciden _qué se ejecuta_; la cuarta decide _qué hacer tras un bloqueo_.

1. **Capa 1 — Visibility filter** (`before_agent_start`).

   - Permisos globales `permissions.tools` / `permissions.skills` / `permissions.mcps` (claves exactas `toolName`, sin `tool:arg-pattern`).
   - Type: `ToolPermission = SimpleAction | PatternRule[]` donde `SimpleAction = 'allow' | 'ask' | 'deny'` y `PatternRule = { pattern: string; action: SimpleAction; reason?: string }`.
   - Sets activos (`activePermissionSets[]`) se evalúan **después** del global, en orden de array; último match gana (cascada).
   - Resultado por nombre: `allow` | `ask` | `deny`; se pasa por el `mode` global (ver [Modos globales](#modos-globales)).
   - `setActiveTools(...)` + dos _sanitizers_ del system prompt (`Available tools:` y `<available_skills>`) ocultan lo que resuelve a `deny`. `unknown` (sin entrada) se trata como **visible** para no romper configs previos.
   - Implementación: `src/permission/visibility.ts`, `src/permission/active-tools.ts`, `src/permission/skill-filter.ts`, `src/permission/modes.ts`, `src/permission/wildcard-matcher.ts`, `src/handlers/before-agent-start.ts`, `src/handlers/system-prompt-sanitizer.ts`, `src/handlers/skill-prompt-sanitizer.ts`.

2. **Capa 2 — Rule-based pattern matcher**.

   - Evalúa `PatternRule[]` (del global y de los sets activos en cascada) contra la tool call normalizada usando claves exactas `toolName`.
   - Acciones: `allow` | `ask` | `deny`.
   - Incluye trust boundary (`/etc`, `~/.ssh`, `~/.env`, `sudo`, `rm -rf`, `git push --force`), allow-exceptions (cubre todo el comando compuesto), block rules (primer match gana; severidad crítica → bloqueo), wrapper unwrapping (`sh -c`, `eval`, `sudo`, …) y detección de interpolación → `ask` (fail-closed).
   - Implementación: `src/permission/visibility.ts`, `src/permission/wildcard-matcher.ts`, `src/permission/compose.ts`, `src/permission/evaluate.ts`, `src/permission/rule.ts`.

3. **Capa 3 — LLM classifier** (opcional, solo cuando cascada = `ask`; solo endurece `ask`: un `allow` explícito de la cascada es final y no consulta al LLM).

   - Cuando Capa 2 devuelve `ask`, se ejecuta el clasificador LLM con dos sub-pasos previos: secret guard y rule-based block rules.
   - **File extraction**: si la tool lleva un campo `command` (shell), el clasificador intenta leer el primer archivo path-like referenciado (≤8KB), aplicando la trust boundary y un redactor de contenido sospechoso (`eval(`, `child_process`, `exec(`, `Buffer.from`, `os.system`, …). El contenido nunca llega al LLM si cae en la frontera o es sospechoso. **Nunca lanza**: cualquier error se convierte en `{ kind: 'unsupported' }`.
   - Fallback en `classifier.fallback.onTimeout` / `classifier.fallback.onError` (ver [Fallback del clasificador](#fallback-del-clasificador)).
   - Implementación: `src/classifier/llm-layer.ts`, `src/classifier/file-extraction.ts`, `src/classifier/pattern-matcher.ts`, `src/classifier/rule-evaluator.ts`, `src/classifier/secret-guard.ts`, `src/classifier/llm-client.ts`.

4. **Capa 4 — Deny strategy**.

   - Decide qué hacer **después** de un `deny`: `auto-retry` (deny + motivo al LLM para que reformule), `ask-user` (modal inmediato) o `both` (`auto-retry` hasta N consecutivos, luego `ask-user`).
   - Alias retrocompatible: `deny-and-continue` se acepta en el JSON y se normaliza a `auto-retry` en memoria (ver [Deny strategy](#deny-strategy)).
   - Implementación: `src/deny/deny-service.ts`.

El gate (`src/gate/gate.ts`) orquesta las cuatro; el resolver `ask` (`src/gate/ask.ts`) es el único punto donde el usuario ve un modal, y solo se invoca cuando Capa 2 o Capa 3 devuelven `ask`.

## Configuración

La extensión lee un único archivo de config JSON (fail-closed: si no lo puede leer/validar, **no arranca**). Elige su ruta de dos formas:

1. Variable de entorno `PI_AUTO_MODE_CONFIG` → ruta al archivo de config.
2. Si no está definida, usa `config.json` en la raíz del repo.

> **Ojo:** `config.json` está en `.gitignore`. **Nunca lo edites directamente** como parte de un cambio — es config del usuario. Los cambios de diseño de config van en `config.example.json` + schema zod en `src/types/config.ts`.

Empieza copiando la plantilla:

```bash
cp config.example.json config.json
```

### Variables de entorno

| Variable              | Obligatoria | Descripción                                                      |
| --------------------- | ----------- | ---------------------------------------------------------------- |
| `PI_AUTO_MODE_CONFIG` | No          | Ruta al archivo de config JSON. Si no existe, usa `config.json`. |

No hay otras variables de entorno obligatorias. Las claves de API del clasificador LLM van **dentro del config** (campos `apiKey` / `baseUrl` de la sección `classifier.llm`), no en el entorno ni en código.

### Estructura del config (schema v2)

Los bloques principales de `config.example.json`:

- **`permissions`** (global, Capa 1 + 2) — mapa con tres claves opcionales:
  - `tools` — `{ toolName: SimpleAction | PatternRule[] }`. Claves son **nombres exactos** de tool (p.ej. `"bash"`, `"read"`, `"write"`). Sin `tool:arg-pattern`. Wildcards `*` y `?` dentro de `PatternRule.pattern`.
  - `skills` — `{ skillName: SimpleAction }` (nombre puro, sin patterns).
  - `mcps` — `{ mcpName: SimpleAction }` (nombre puro).
- **`permissionSets`** — conjuntos nombrados que extienden/sobrescriben el global. Cada set admite los mismos tres bloques (`tools`, `skills`, `mcps`) con la misma estructura. **Sin `priority`**: el orden de evaluación lo define `activePermissionSets`.
- **`activePermissionSets`** — array de strings (nombres de sets). **El orden importa**: se evalúan en secuencia tras el global; último match gana (cascada).
- **`mode`** (top-level, Capa 1) — modo global de visibilidad: `default` (honra los mapas tal cual), `strict` (colapsa `ask` → `deny`), `yolo` (colapsa `ask` → `allow`, mantiene los `deny` explícitos). Conmutable en caliente con `/auto-mode:mode`.
- **`classifier`** — capa LLM opcional (`llm`: provider/model/apiKey). **`provider` es string libre** (cualquier ID del Pi modelRegistry). Bloque `ruleBased` **eliminado** (trust boundary, allow-exceptions, block rules viven en Capa 2). El bloque `fallback` define el comportamiento ante `onTimeout` / `onError`: `ask-user` (default, fail-closed), `deny` (fail-closed, bloqueo silencioso) o `allow` (opt-in fail-open, rechazado por `isSecurityWeakening()` al recargar). `onBlock` y `onBlockUserOverride` controlan qué pasa tras un bloqueo del clasificador.
- **`denyStrategy`** — estrategia post-bloqueo (Capa 4): `auto-retry` (canónico, antes `deny-and-continue`), `ask-user` (modal inmediato) o `both` (auto-retry con escalado). Ver [Deny strategy](#deny-strategy).
- **`ui`** — comportamiento de la interfaz de confirmación (`promptMaxRows`, `promptFieldMaxWidth`, `showClassifierRisk`, `modalTimeoutMs`). **`doublePressToConfirm` eliminado** (deprecado).
- **`telemetry`** — logging de eventos (activable con ruta opcional; ver [Telemetría](#telemetría-con-ruta-por-defecto)).

### Modos globales

Tres valores, todos opt-in (default = `default`):

| `mode`    | `ask` se trata como | `deny` explícito | Uso típico                                      |
| --------- | ------------------- | ---------------- | ----------------------------------------------- |
| `default` | `ask` (modal)       | `deny`           | comportamiento por defecto, prompts al usuario  |
| `strict`  | `deny` (silencioso) | `deny`           | setups zero-prompt (CI, batch)                  |
| `yolo`    | `allow`             | `deny`           | ejecución fluida sin prompts; los `deny` siguen |

`unknown` (tool/skill sin entrada en los mapas) **no** se reescribe: se considera visible para mantener compatibilidad.

Conmuta el modo en caliente:

```
/auto-mode:mode default
/auto-mode:mode strict
/auto-mode:mode yolo
```

El cambio requiere confirmación explícita (mismo flujo que `auto-mode:sets activate`).

### Ámbito de directorio externo (`external_directory`)

Opt-in vía `confineToWorkingDirectory` (default `false` = sin cambios). Cuando está activo, cualquier acceso `fs` o segmento `shell` a un path fuera de `process.cwd()` endurece el veredicto: match explícito en `external_directory` (cascada como el resto, última coincidencia gana) o `ask` por defecto. Los paths internos no opinan, y un `deny` explícito de tools siempre gana a un `allow` externo.

Los segmentos `shell` se extraen con tree-sitter-bash (`web-tree-sitter` + wasm, sin binarios nativos): las strings entrecomilladas quedan atómicas (un `sed "s/a/ /"` o un `python3 -c "…"` nunca se trituran en falsos paths) y se excluyen por tipo de nodo comentarios, heredocs, regexes y variables. Si el parser no está listo o el segmento lo excede (`<<` heredocs, `case`, >64KB), se usa el extractor heurístico; el veredicto indica el motor (`engine`).

```json
{
  "confineToWorkingDirectory": true,
  "permissions": {
    "tools": { "read": "allow" },
    "external_directory": { "/tmp/*": "ask", "/etc/*": "deny" }
  }
}
```

### Fallback del clasificador

`classifier.fallback.onTimeout` y `classifier.fallback.onError` aceptan tres valores:

| Valor      | Comportamiento                                                                                                                                                                                                       |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ask-user` | Default. Prompt al usuario (fail-closed).                                                                                                                                                                            |
| `deny`     | Bloqueo silencioso (fail-closed, sin prompt; útil para `strict`).                                                                                                                                                    |
| `allow`    | **Opt-in fail-open.** Apertura del gate. Solo llega a aplicarse cuando el usuario lo declara explícitamente; `isSecurityWeakening()` lo marca como debilitamiento y rechaza la recarga si se introduce a posteriori. |

`allow` nunca es el default del schema; nunca se llega por accidente a esta rama.

### Deny strategy

`denyStrategy.mode` controla qué pasa **después** de un `deny` (Capa 4):

| Valor        | Comportamiento                                                                                                         |
| ------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `auto-retry` | Deny + motivo al LLM para que reformule el tool call. Default práctico.                                                |
| `ask-user`   | Modal de confirmación inmediato; el LLM no recibe el motivo hasta que el usuario decide.                               |
| `both`       | `auto-retry` hasta `escalation.consecutive` (o `escalation.total`); al superar el umbral, escala a `ask-user` (modal). |

El nombre canónico es **`auto-retry`** (alineado con opencode-auto-mode). El alias `deny-and-continue` se sigue aceptando en el JSON por retrocompatibilidad y se normaliza a `auto-retry` en memoria via `ConfigSchema`.

Los límites se controlan en `denyStrategy.escalation`: `consecutive` (racha de denegaciones consecutivas) y `total` (acumulado en la sesión). Una aprobación del usuario resetea `consecutive` pero deja `total` intacto.

### Bloque `ui`

| Campo                 | Tipo      | Default  | Descripción                                                                                                            |
| --------------------- | --------- | -------- | ---------------------------------------------------------------------------------------------------------------------- |
| `promptMaxRows`       | `number`  | `10`     | Máximo de filas visibles en el preview del tool call dentro del modal.                                                 |
| `promptFieldMaxWidth` | `number`  | `80`     | Ancho máximo del campo de valor mostrado en el modal.                                                                  |
| `showClassifierRisk`  | `boolean` | `true`   | Muestra el nivel de riesgo (`low`/`medium`/`high`) y la razón del clasificador en la descripción.                      |
| `modalTimeoutMs`      | `number`  | `120000` | Tiempo máximo (ms) que el modal espera una decisión antes de resolverse como `deny` (fail-closed). `-1` = sin timeout. |

> Cualquier recarga de config en caliente que **debilite** la seguridad (desactivar el clasificador, relajar el deny, introducir fallos-open o permite sobre superficies restringidas) se rechaza y se conserva la config anterior.

## Uso

La extensión funciona de forma pasiva: una vez cargada en el runtime, intercepta cada evento `tool_call` y aplica la política. Tú defines las reglas en el config; la lógica interna recorre las cuatro capas descritas arriba en orden. Resumido:

1. **Normalizar** el tool call (nombre + entrada).
2. **Filtrar visibilidad** en `before_agent_start` (Capa 1): combinar `permissions.tools/skills/mcps` global + sets activos en cascada (orden de `activePermissionSets`), aplicar el `mode` global, llamar a `setActiveTools(...)` y reescribir el system prompt (secciones `Available tools:` y `<available_skills>`).
3. **Evaluar reglas** (Capa 2): clasificar la tool call contra `PatternRule[]` del global y sets activos (cascada), con trust boundary, allow-exceptions, block rules y wrapper unwrapping. Resultado: `allow` | `ask` | `deny`.
4. **Consultar el clasificador LLM** (Capa 3, opcional): **solo si Capa 2 = `ask`**. Si la tool lleva un campo `command`, se extrae el archivo referenciado (≤8KB, trust-check, redactor de secretos) y se inyecta en el prompt del LLM. `onTimeout` / `onError` aplican el `fallback` configurado.
5. **Aplicar la deny strategy** (Capa 4) tras un `deny`: `auto-retry` (deny + motivo al LLM), `ask-user` (modal inmediato) o `both` (auto-retry con escalado).
6. **Decidir** `allow` / `deny` / `ask` y actuar (bloquear con motivo, pedir confirmación vía modal, o registrar en telemetría).

### Comandos de sesión

La extensión registra dos slash commands para gestionar la configuración en caliente:

```
auto-mode:sets activate <nombre>
auto-mode:sets deactivate <nombre>
auto-mode:sets list

auto-mode:mode default | strict | yolo
```

Cambiar los sets activos o el modo global es una **elevación de privilegios**: requiere confirmación explícita (reutiliza el mismo resolver `ask` del gate) y arroja un error si el nombre no existe.

## Flujo de confirmación (Ask)

Cuando una tool call cae en `ask` (porque la regla de permiso lo pide o porque el clasificador la marcó como dudosa), el gate la delega al `AskResolver`, que por defecto es el modal de confirmación. El contrato end-to-end es:

1. El gate genera un `requestId` (UUID) y construye un `AskRequest` con `surface`, `value`, la `Rule` que matcheó y el `ClassifierRisk` (si lo hay).
2. Se emite el evento `permissions:ui_prompt` con ese `requestId` (ver [Eventos](#eventos)).
3. Se abre el modal con la lista de decisiones y se arma el `Promise<AskDecision>`.
4. El usuario elige una opción; el modal resuelve con `'allow'`, `'deny'` o `{ decision: 'deny', reason }` (solo en "Deny with reason").
5. El gate consume el resultado:
   - **Allow** → registra aprobación de sesión, resetea el streak de denegaciones consecutivas y emite `permissions:decision` con `result: 'allow'`.
   - **Deny** → lanza `AskDeniedError` cuyo `message` empieza por `Permission denied by user` y, si hubo razón, la anexa (`Permission denied by user: <razón>`). El error llega al modelo tal cual y al evento `permissions:decision` como `denialReason`.

### Opciones del modal

El select expone cuatro opciones (la opción resaltada por defecto es **Deny**):

| Opción              | Efecto                                                                                                                                                                                                                                                               |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Deny`              | Resuelve `'deny'`. Cierra el modal.                                                                                                                                                                                                                                  |
| `Allow`             | Resuelve `'allow'` con un solo click.                                                                                                                                                                                                                                |
| `Allow for session` | Persiste la aprobación para futuras tool calls equivalentes.                                                                                                                                                                                                         |
| `Deny with reason`  | Abre un input libre (`pi.ui.input`) para capturar la razón; si hay texto no vacío, devuelve `{ decision: 'deny', reason }`. Si se cancela o queda vacío, cae a `'deny'` sin razón. La razón se sanea (sin saltos de línea, recortada) antes de inyectarse al modelo. |

### Timeout configurable (`ui.modalTimeoutMs`)

El modal tiene un temporizador fail-closed controlado por el campo `ui.modalTimeoutMs`:

- **Default:** `120000` (2 minutos).
- **`-1`** → sin timeout: el modal espera la respuesta del usuario indefinidamente.
- Cualquier otro valor positivo → al expirar, el modal se cierra y resuelve `'deny'` (fail-closed).

La lectura del timeout se hace sobre el config vivo (no un snapshot), así que un reload a mitad de sesión cambia el comportamiento sin reiniciar.

### Invariantes fail-closed del modal

El modal preserva el principio **fail-closed** de la extensión. Cualquier ruta de salida que no sea una decisión explícita del usuario termina en `'deny'`:

- `!pi.ui` → `'deny'` (sin TUI no se pregunta).
- `pi.ui.custom(...).catch(...)` → `'deny'` (cualquier error de la UI).
- `try { ... } catch { settleDeny() }` → `'deny'` (excepción síncrona al armar el modal).
- `onExit` del overlay → `'deny'` (el usuario cierra la overlay con una tecla distinta).
- Timeout (`ui.modalTimeoutMs` distinto de `-1`) → `'deny'`.
- Opción desconocida del select → `'deny'`.

La única ruta que puede resolver `'allow'` es que el usuario elija explícitamente `Allow` o complete la confirmación de `Allow for session`.

### Auditoría y eventos

El gate es la **única** fuente de verdad para la sesión: el modal ya no llama a `sessionRules.approveForSession` directamente, lo hace el gate al recibir `'allow'`. Esto evita aprobaciones duplicadas y mantiene un único punto de auditoría.

Los eventos emitidos quedan así (ver sección [Eventos](#eventos) para los shapes completos):

- **`permissions:ui_prompt`** — se emite al abrir el modal; ahora siempre lleva `requestId`.
- **`permissions:decision`** — al resolver el ask, se enriquece con `{ requestId, decidedBy: 'user', via: 'modal', matchedPattern, denialReason? }`. El `matchedPattern` es el patrón de la regla que disparó el ask; `denialReason` solo aparece cuando el usuario eligió `Deny with reason` y escribió algo.

## Eventos

La extensión emite dos eventos a través de `pi.events.emit` que permiten auditar el flujo de decisión sin acoplarse a la UI. Ambos son fire-and-forget: si el consumo falla, no se interrumpe la tool call.

### `permissions:ui_prompt`

Se emite **al abrir** el modal de confirmación (antes de que el usuario decida). Es la señal de que el agente está esperando input humano.

```ts
{
  requestId: string,          // UUID generado por el gate; correlaciona ui_prompt ↔ decision
  source: 'tool_call',        // reservado para 'skill_input' | 'skill_read' en el futuro
  surface: string,            // p.ej. 'fs', 'shell'
  value: string,              // path o comando que disparó el ask
  agentName: string | null,
  request: { surface: string, value: string }
}
```

### `permissions:decision`

Se emite al **resolver** cada tool call. El shape base es siempre `{ surface, value, result, resolution }` y, en el camino del ask, se enriquece con un bloque de auditoría:

```ts
{
  surface: string,
  value: string,
  result: 'allow' | 'deny',
  resolution:
    | 'allow'
    | 'permission'
    | 'classifier_block'
    | 'deny_and_continue'
    | 'permission_ask'
    | 'classifier_ask'
    | 'escalate'
    | 'unknown_tool',
  // Solo cuando resolution es 'permission_ask' o 'classifier_ask':
  requestId?: string,
  decidedBy?: 'user',
  via?: 'modal',
  matchedPattern?: string,     // patrón de la regla que disparó el ask
  denialReason?: string       // presente solo si el usuario eligió "Deny with reason" y escribió algo
}
```

Notas:

- `denialReason` viaja **solo** en el camino del ask (no en denegaciones automáticas por clasificador o trust boundary).
- `matchedPattern` identifica qué regla (de permiso o del clasificador) fue la representante para el ask — útil para entender por qué el usuario tuvo que decidir.
- `result: 'deny'` + `resolution: 'permission_ask'` + `denialReason` es la señal canónica de que el modelo va a recibir `Permission denied by user: <razón>`.

### Ejemplo mínimo de config (config.example.json)

```json
{
  "permissions": {
    "tools": {
      "read": "allow",
      "write": "ask",
      "bash": [
        { "pattern": "aws get_*", "action": "allow" },
        {
          "pattern": "aws delete_*",
          "action": "deny",
          "reason": "comando destructivo no permitido"
        },
        { "pattern": "rm -rf *", "action": "deny", "reason": "destructivo" },
        {
          "pattern": "cat *.env",
          "action": "deny",
          "reason": "no se permite leer variables de entorno"
        },
        {
          "pattern": "git push --force*",
          "action": "deny",
          "reason": "force-push bloqueado"
        }
      ]
    },
    "skills": {},
    "mcps": {}
  },
  "permissionSets": {
    "project-default": {
      "permissions": {
        "tools": {
          "bash": [
            {
              "pattern": "aws *",
              "action": "deny",
              "reason": "aws bloqueado en este proyecto"
            }
          ]
        },
        "skills": { "ts-language-server": "allow" }
      }
    }
  },
  "activePermissionSets": ["project-default"],
  "mode": "default",
  "classifier": {
    "enabled": true,
    "llm": {
      "provider": "anthropic",
      "model": "claude-opus-4",
      "baseUrl": "",
      "apiKey": "",
      "timeoutMs": 30000,
      "maxTokens": 1024,
      "fallbackModel": "claude-sonnet-4",
      "systemPrompt": "You classify whether a tool call is safe to auto-approve.",
      "enabled": true
    },
    "fallback": { "onTimeout": "ask-user", "onError": "ask-user" },
    "onBlock": "deny",
    "onBlockUserOverride": false
  },
  "denyStrategy": {
    "mode": "auto-retry",
    "escalation": { "consecutive": 3, "total": 10 }
  },
  "ui": {
    "promptMaxRows": 10,
    "promptFieldMaxWidth": 80,
    "showClassifierRisk": true,
    "modalTimeoutMs": 120000
  },
  "telemetry": { "enabled": false, "path": "" }
}
```

## Ejemplos de configuración

Tres patrones habituales que no encajan en el `Ejemplo mínimo` anterior.

### Telemetría con ruta por defecto

Si activas `telemetry.enabled` y omites `telemetry.path`, los eventos se
escriben en `~/.pi/pi-auto-mode.jsonl` (sin necesidad de configurar la ruta).
Una línea por evento, una por línea — formato JSONL.

```json
{
  "telemetry": { "enabled": true }
}
```

```jsonl
{"ts":"2026-09-02T10:11:12.000Z","type":"permissions:decision","payload":{"surface":"shell","value":"rm -rf /tmp","result":"deny","resolution":"permission"}}
{"ts":"2026-09-02T10:11:13.000Z","type":"permissions:ui_prompt","payload":{"requestId":"9c1...","source":"tool_call","surface":"shell","value":"sudo apt update"}}
```

Las claves con `secret|token|password|api_key|…` se redactan a `[REDACTED]`
antes de escribirse; ver `src/telemetry/telemetry.ts`.

### Surface personalizada para una tool propia

Si tu agente expone una tool que no es `bash`/`fs`/`mcp` (por ejemplo
`agent_send_message`), mándala a una surface con nombre propio vía el mapa
`permissions.tools` y luego escribe reglas como cualquier otra surface. Sin entrada en
`permissions.tools`, la tool sigue cayendo al sentinel `denied` (fail-closed).

```json
{
  "permissions": { "tools": { "agent_send_message": "agent" } },
  "permissionSets": {
    "agent-policy": {
      "permissions": {
        "tools": {
          "agent": [
            {
              "pattern": "*password*",
              "action": "ask",
              "reason": "posible secreto"
            },
            { "pattern": "*", "action": "allow" }
          ]
        }
      }
    }
  },
  "activePermissionSets": ["agent-policy"]
}
```

### llama.cpp / Ollama con `provider` libre

El cliente LLM ya habla chat-completions genérico, así que basta con cambiar
`provider` y apuntar `baseUrl` al endpoint OpenAI-compatible de tu servidor
local (Ollama, llama.cpp server, LM Studio, vLLM…). `provider` acepta **cualquier ID del Pi modelRegistry**.

```json
{
  "classifier": {
    "llm": {
      "provider": "openai-compatible",
      "model": "llama-3.1-8b-instruct",
      "baseUrl": "http://localhost:8080/v1",
      "apiKey": "",
      "timeoutMs": 30000
    }
  }
}
```

## Scripts disponibles

| Comando                  | Descripción                                             |
| ------------------------ | ------------------------------------------------------- |
| `npm run check`          | Typecheck: `tsc --noEmit` (no compila a `dist/`).       |
| `npm run build`          | Compila a `dist/` (`tsc -p tsconfig.json`).             |
| `npm test`               | Ejecuta los tests con cobertura (Jest `--coverage`).    |
| `npm run test:watch`     | Tests en modo watch (`jest --watch`).                   |
| `npx prettier --write .` | Formatea todo el repo.                                  |
| `npx prettier --check .` | Verifica el formato (actúa como "lint"; no hay ESLint). |

Correr un único test o archivo:

```bash
npx jest test/gate/gate.test.ts
npx jest -t "nombredel test" test/gate/gate.test.ts
```

## Estructura del proyecto

```
src/            Código de la extensión (entrada: src/index.ts)
  gate/         Orquesta tool calls (normalize, gate, ask)
  permission/   Capa 1 (visibility) + Capa 2 (rules):
                visibility, active-tools, skill-filter, modes,
                wildcard-matcher, compose, evaluate, rule,
                session-rules
  classifier/   Capa 3: rule-based (block-rules, pattern-matcher,
                rule-evaluator, secret-guard) + LLM (llm-layer,
                llm-client, file-extraction)
  handlers/     Hooks del SDK: before-agent-start,
                system-prompt-sanitizer, skill-prompt-sanitizer
  config/       Carga + validación zod del config (fail-closed)
  commands/     Slash commands (set-commands: auto-mode:sets, auto-mode:mode)
  deny/         Capa 4: deny-service (auto-retry / ask-user / both)
  state/        Estado global en memoria (config-state, ui-context)
  ui/           Interfaz de confirmación (permission-modal, ui-prompt)
  telemetry/    Logging de eventos (default path ~/.pi/pi-auto-mode.jsonl)
  types/        Schemas zod del config + tipos del TUI
  pi-sdk.d.ts   Stub de tipos del SDK Pi (no importar en runtime real)
test/           Espejo 1:1 de src/ + stubs para el TUI
config.example.json  Plantilla para crear tu config.json
dist/           Build de `npm run build` (generado, gitignored)
coverage/       Reporte de cobertura (generado, gitignored)
```

## Testing

Framework: **Jest 30 + SWC** (transform rápido). Los tests en `test/`, espejo 1:1 de `src/`.

```bash
npm test        # suite completa con cobertura (579 tests)
```

Los servicios externos (TUI y SDK de Pi) se sustituyen con `jest.mock` y stubs en `test/stubs/`. La matriz de decisión del gate, la composición en cascada, las reglas del clasificador, las cuatro capas y la estrategia `auto-retry` están cubiertas por tests: no degraden esta cobertura.

## Cómo contribuir

Sin remoto configurado ni CI. El flujo es ahora manual:

1. Crea una rama descriptiva (`fix/<algo>`, `feat/<algo>`).
2. Realiza los cambios con **Conventional Commits** (`feat:`, `fix:`, `chore:`, `refactor:`, `test:`, `perf:`, `style:`).
3. Deja el árbol del trabajo formateado y con tests en verde:
   - `npm run check`
   - `npm test`
   - `npx prettier --check .`

El hook pre-commit (`husky` + `lint-staged`) formatea y corre tests sobre los `.ts` staged. Lee `AGENTS.md` completo antes de tocar código — contiene convenciones y límites de seguridad vinculantes.

## Desarrollo / Instalación local

Esta sección describe el flujo para **cargar la extensión dentro del runtime de Pi** desde el repo local y poder probarla con hot-edit sobre `src/`. Complementa a [Instalación](#instalación), que solo cubre `npm install`.

### Prerrequisitos

- **Node.js >= 20** (dev en v24). ESM nativo.
- **Pi Coding Agent instalado** — `pi --version` debe responder.
- El repo es local; **no** hay remoto configurado, **no** se hace `git push` ni publicación sin confirmación.

### 1. Instalar dependencias

```bash
npm install
npm run prepare      # instala el hook pre-commit (husky)
```

### 2. Verificar los quality gates

Antes de cargar la extensión en Pi, confirma que el árbol está sano:

```bash
npm run check        # tsc --noEmit
npm test             # 579 tests con Jest + @swc/jest
npx prettier --check .
```

Si falla cualquiera, corrígelo antes de seguir.

### 3. Linkar en Pi (dos pasos)

Pi necesita dos cosas: que el paquete sea descubrible globalmente y que esté registrado en su config.

```bash
# Paso 1 — symlink en el node_modules global
npm link

# Paso 2 — registrar la ruta absoluta en ~/.pi/agent/settings.json (array `packages`)
pi install path:/ruta/absoluta/al/repo/pi-auto-mode
# Atajo equivalente, si el cwd ya es la raíz del repo:
pi install .
```

> Pi resuelve `.` contra el cwd y guarda la **ruta absoluta** en `settings.json`. La carga se hace con jiti contra `src/index.ts` directamente, así que **no** hace falta `npm run build` durante el desarrollo. Consulta `pi install --help` si el flag cambia entre versiones.

### 4. Confirmar que Pi la ve

```bash
pi --verbose
```

Busca una línea del tipo `[Extensions] ... pi-auto-mode` en la salida. Como alternativa, abre `~/.pi/agent/settings.json` y comprueba que el path aparece en el array `packages`.

### 5. Recargar tras editar código

- **No hay build step local**: Pi lee `src/index.ts` directamente con jiti. `dist/` solo se usa al publicar a npm.
- Para que un cambio aplique: **reinicia Pi** (o usa `/reload` si tu build lo expone).
- Los hooks (`before_agent_start`, sanitizers, …) se registran en cada carga; no hace falta tocar nada más.

### 6. Desinstalar

```bash
pi remove /ruta/absoluta/al/repo/pi-auto-mode
# opcional — limpiar el symlink global
npm unlink pi-auto-mode
```

### Dónde vive el estado

| Recurso                    | Ruta                                                                                                                       |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Config del usuario         | `~/.pi/pi-auto-mode.json` (se autoseed desde `config.example.json` al primer arranque; override con `PI_AUTO_MODE_CONFIG`) |
| Telemetría                 | `~/.pi/pi-auto-mode.jsonl` (configurable en `telemetry.path`)                                                              |
| Registro del paquete en Pi | `~/.pi/agent/settings.json` → `packages[]`                                                                                 |

### Pitfalls habituales

- **"Module not found" al arrancar Pi** → probablemente se saltó `npm install` o `npm link`. Vuelve a correrlos.
- **Mis cambios no surten efecto** → reinicia Pi. No hay hot-reload.
- **Reset del config** → borra `~/.pi/pi-auto-mode.json`; el siguiente arranque lo re-seedea desde `config.example.json`.
- **Reset total del estado** → quita la entrada de `packages` en `~/.pi/agent/settings.json`, borra `~/.pi/pi-auto-mode.json` y `~/.pi/pi-auto-mode.jsonl`, y vuelve a correr `pi install .`.

## Licencia

Publicado bajo la licencia **MIT**. Ver el archivo `LICENSE`. (Aún no hay archivo `LICENSE` en el repo; se debe añadir.)
