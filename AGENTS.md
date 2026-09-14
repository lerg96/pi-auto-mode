# AGENTS.md

Instrucciones operativas para agentes de IA que trabajen en **pi-auto-mode**. Léelo completo antes de tocar código; los archivos que menciones aquí son vinculantes.

## 1. Descripción del proyecto

**pi-auto-mode** es una extensión del runtime `@earendil-works/pi-coding-agent` que añade un **modo seguro de auto-ejecución de comandos**. Pi por defecto **ya permite todos los comandos** de forma automática; esta extensión **no añade** la auto-ejecución en sí, sino una capa de validación que intenta garantizar que cada _tool call_ sea **al menos segura de ejecutar**. Escucha eventos de `tool_call`, los normaliza, los evalúa contra _permission sets_ por orden en `activePermissionSets` y aplica una política `allow` / `deny` / `ask`, con un clasificador LLM opcional (solo cuando cascada = ask) y una estrategia de deny: `auto-retry` / `ask-user` / `both`.

- **Stack:** TypeScript 5 (estricto), Node.js ≥ 20 (dev en v24), ESM (`"type": "module"`, target ES2022).
- **Arquitectura:** monolito pequeño, una sola extensión, capas por carpeta idiomática (`gate`, `permission`, `classifier`, `config`, ...). No es monorepo y **no usa base de datos** (estado en memoria + ficheros de config).
- **Dependencia de runtime:** solo `zod` v3 (validación). El SDK `@earendil-works/pi-coding-agent` **no es un paquete npm**: lo inyecta el harness de Pi en runtime y se tipa vía stub `src/pi-sdk.d.ts` (mapeado con `paths` en `tsconfig.json`).

## 2. Estructura del repositorio

```
src/            Código de la extensión (entrada: src/index.ts)
  gate/         Orquesta tool calls: normalize.ts, gate.ts, ask.ts (decisión allow/deny/ask)
  permission/   Compone y evalúa permission sets: visibility.ts, wildcard-matcher.ts, modes.ts, session-rules.ts
  classifier/   Riesgo: block-rules.ts, pattern-matcher.ts, rule-evaluator.ts, secret-guard.ts, llm-layer.ts
  config/       Carga + validación zod de config.json (fail-closed): config-loader.ts
  commands/     Slash commands (set-commands.ts)
  deny/         Estrategia deny-and-continue (deny-service.ts)
  state/        Estado global en memoria (config-state.ts)
  ui/           Interfaz de confirmación (permission-modal.ts, ui-prompt.ts)
  telemetry/    Logging de eventos (telemetry.ts)
  types/        Tipos zod de config (config.ts) + tipos del TUI (pi-tui.d.ts)
  pi-sdk.d.ts   Stub de tipos del SDK Pi (NO debe importarse en runtime real)
test/           Espejo 1:1 de src/ (+ test/stubs/pi-tui.ts para tipar @earendil-works/pi-tui)
config.example.json  Plantilla para crear tu config.json (NUNCA editar config.json directamente)
TASK.md          Notas de plan, fases, y temas pendientes (UNTRACKED, ver §7)
dist/           Build de `npm run build` (gitignored, generado)
coverage/       Reporte de Jest (gitignored, generado)
```

El código de la parte "UI"/TUI y del SDK se referencia solo por tipos; la lógica real de negocio vive en `src/`. Cada submódulo en `src/` tiene su test espejo en `test/` con el mismo nombre de archivo.

## 3. Setup del entorno

```bash
npm install                 # instala dependencias
npm run prepare             # instala el hook de git (husky) — se ejecuta solo en install
```

- **Sin variables de entorno obligatorias.** Una opcional: `PI_AUTO_MODE_CONFIG` → ruta al archivo de config (si no existe, usa `config.json` en la raíz). Ver `src/index.ts:178`.
- **No hay `.nvmrc` / `.env`.** Runtime requerido: Node ≥ 20 (dev en v24), ESM. No fijado con versionador; respeta el comportamiento ESM del proyecto.
- Para la capa LLM del clasificador se puede pasar `apiKey`/`baseUrl` en el config; **no uses variables de entorno hardcodeadas** salvo que ya existan.

## 4. Comandos esenciales

```bash
npm run check        # typecheck: tsc --noEmit (NO compila a dist)
npm run build        # compila a dist/ (tsc -p tsconfig.json)
npm test             # tests con reporte de cobertura (Jest --coverage)
npm run test:watch   # jest --watch
npx prettier --write .         # formatear
npx prettier --check .         # verificar formato (uso como "lint"; no hay ESLint)
```

- **Correr un solo test / archivo:**

  ```bash
  npx jest test/gate/gate.test.ts          # archivo concreto
  npx jest -t "nombredeltest" test/gate/gate.test.ts   # por nombre
  ```

- **No hay migraciones de BD** (no hay base de datos). No generes nada de Prisma/TypeORM.

## 5. Convenciones de código

- **Formato:** Prettier con `.prettierrc` — **`semi: false`**, `singleQuote: true`, `tabWidth: 2`, `trailingComma: 'es5'`. Es config no negociable; un hook de husky/lint-staged aplica `prettier --write` + tests sobre los `.ts` staged. Código nuevo debe pasar `npx prettier --check .`.
- **TypeScript estricto:** `strict: true`. **Nunca uses `any`**; si necesitas flexibilidad, usa `unknown` con narrowing o tipos explícitos. Respeta los `paths` del tsconfig (`@earendil-works/pi-coding-agent` → stub local). Importa módulos ESM; el mapeo `.*\.js → $1` de Jest cubre las extensiones `.js` en imports.
- **Nombres de archivos:** kebab-case (`config-loader.ts`, `session-rules.ts`). Clases en `PascalCase`, funciones en `camelCase`, tipos de zod en `camelCase` (convención del repo, p. ej. `permissionSet`, `customBlockRule`).
- **Patrones que respetar:**
  - **Fail-closed:** cualquier error bloquea la ejecución (`createFailClosedToolCall`, carga de config con `loadInitialConfig`). **Nunca** relajes esto para "degradar con gracia" a defaults inseguros.
  - **Validación con zod** en los límites de entrada (`src/types/config.ts`, `src/config/config-loader.ts`). Todo config nuevo se declara como schema zod con defaults.
  - **Dependencias inyectadas:** el gate recibe `GateDeps` (configState, sessionRules, classify, denyService); inyecta en vez de importar directamente para facilitar tests.
- **Librerías:** usa `zod` para validación. **No** añadas otra librería de runtime sin justificación ni revisión en un PR separado. Sin dependencias de framework de tests alternativo (Jest es EL framework).

## 6. Testing

- **Framework:** Jest 30 + `@swc/jest` (transform rápido). Tests en `test/`, `**/*.test.ts`, entorno `node`.
- **Cobertura:** `collectCoverageFrom: src/**/*.ts` (excluye `*.d.ts`), pero **no hay umbral mínimo configurado** en `jest.config.js`. Aun así, toda lógica nueva debe venir con tests.
- **Obligatorio testear:** la matriz de decisión del gate (`allow`/`deny`/`ask`), cascada de permission sets, reglas del clasificador (block/allow/exception), deny strategy (auto-retry / ask-user / both).
- **Mocking de servicios externos:** el TUI (`@earendil-works/pi-tui`) y el SDK Pi se sustituyen con `jest.mock`; hay un stub base en `test/stubs/pi-tui.ts`. Usa `test/stubs` para shapes de runtime y `jest.mock` en cada archivo de test. Inyecta `classify`/`denyService` en `GateDeps` falsos en vez de golpear una API real.

## 7. Git / control de versiones

- **Conventional Commits** (evidencia en el historial): `feat:`, `fix:`, `chore:`, `style:`, `test:`, `perf:`, `refactor:`. Ej.: `fix: block rm -rf under quoted classifier`.
- **Branches:** no hay convención formal; `master` es la rama por defecto. Usa nombres descriptivos (`feat/<algo>`, `fix/<algo>`).
- **Pre-commit:** hook en dos pasos — `npm run check` (tsc whole-project, porque @swc/jest no typechequea) y luego `lint-staged` (prettier --write + tests sobre staged). Tu Working Tree debe quedar formateado, typechequeado y pasando tests **antes** de commitear.
- **Sin remoto configurado** (`git remote -v` vacío) y sin CI en el repo. **No asumas un remoto ni hagas `git push`**; si el usuario pide publicar/crear PR, confírmalo primero (p. ej. proponer `gh pr create` solo tras preguntar).
- **`TASK.md` es un archivo NO trackeado** (está en `.gitignore`). Es el documento vivo del usuario donde apunta planes, fases, y TODOs a medio/largo plazo. Reglas:
  - **NO se commitea.** Es un archivo personal del repo local, no parte del código fuente.
  - **NO se borra.** Aunque el usuario haya completado todos los items, el archivo se queda en disco como historial de qué se hizo y por qué. Si quiere empezar de cero, vacía el contenido y sigue usándolo; nunca `rm TASK.md` sin reemplazo explícito.
  - **Sí se lee.** Cuando un agente proponga trabajo nuevo o vaya a empezar una fase, primero debe leer `TASK.md` (a pesar de estar gitignored) para ver si hay un plan abierto o un TODO relacionado. El archivo siempre existe en el directorio de trabajo.
  - **No se asuma que el archivo está sincronizado con commits.** El usuario puede editar `TASK.md` libremente entre commits sin que eso afecte al historial git.
- Si falla el hook por YubiKey/signature SSH, no reintentes en bucle ni modifiques `git config`; avisa y espera confirmación.

## 8. Seguridad y límites

- **NUNCA modificar:**
  - `config.json` (gitignored; es config del usuario). Si quieres una opción nueva, edita `config.example.json` y valida el schema zod.
  - `dist/` y `coverage/` (generados; recoge con `npm run build`/`npm test`).
  - `config.example.json` es tu herramienta de diseño de config; los cambios de schema van con test de tipos.
  - Stubs de runtime (`src/pi-sdk.d.ts`) solo si cambia la forma del SDK — raro y sensible.
- **Acciones que requieren confirmación humana:** borrar datos, cambiar el comportamiento del gate (fail-closed ↔ fail-open), modificar la política de trust boundary (paths/canales protegidos), alterar la estrategia de deny-and-continue, y añadir/actualizar dependencias de runtime.
- **Secretos:** nunca hardcodees claves de API. Las claves LLM van en config (no en código ni en commits). Respeta `secret-guard.ts` y no debilites su cobertura.

## 9. CI/CD

No existe pipeline de CI (no hay `.github/` ni `.gitlab-ci.yml`). El "gate" de calidad previo a merge es:

- `npm run check` (tsc) en verde.
- `npm test` (Jest + cobertura) en verde.
- `npx prettier --check .` limpio.

Si se aporta CI, debe correr exactamente esos tres pasos; **no debes inventar ni crear un pipeline** sin que el usuario lo pida.

## 10. Contexto de negocio / dominio

- **Permission set:** conjunto nombrado de reglas (SIN priority). Se compone por orden en `activePermissionSets`.
- **Acciones:** `allow` (permitir), `deny` (bloquear), `ask` (pedir confirmación).
- **Surface:** tipo de superficie del tool call (`fs`, `shell`, `mcp`) + tools custom via `surfaceForTool`.
- **Fail-closed (clave):** ante cualquier error de carga/eval, se **bloquea** la tool call — nunca se abre a un default permiso inseguro. Romper esto es un cambio de seguridad mayor.
- **Trust boundary:** paths/órdenes protegidos — ahora en block rules del clasificador LLM, no en ruleBased.
- **External scope (`external_directory`):** opt-in vía `confineToWorkingDirectory` (default `false`). Mapa plano `Record<glob, SimpleAction>` en cascada; fuera de `cwd()` sin match → `ask`; solo endurece, nunca relaja. El clasificador solo endurece `ask`; `allow` explícito es final. Extracción shell con tree-sitter-bash (`src/permission/shell-parse.ts`, deps `web-tree-sitter` + `tree-sitter-wasms`, sin nativos) + fallback heurístico; veredicto lleva `engine`. Crash classes conocidas del wasm 0.20.x: heredocs `<<` y `case` (→ heurístico).
- **ReDoS / bypasses:** en `wildcard-matcher.ts`; al añadir patrones, mántelos lineales/seguros.

## 11. Troubleshooting común

- **`Cannot find module '@earendil-works/pi-tui'` en tests:** está mockeado vía `jest.mock` + `test/stubs/pi-tui.ts`. Si lo ves, es que el test mutó el stub o añadiste uno sin mapear.
- **Import con `.js` que no resuelve en Jest:** el `moduleNameMapper` `^(\..?\ /.+).js$ → $1` existe para esto; si falla, revisa que el import use la extensión real del archivo ESM.
- **`npm test` falla por formato en commit:** el hook lint-staged re-escribe con Prettier; corre `npx prettier --write .` antes de preparar el commit.
- **`npm run check` falla tras tocar `src/pi-sdk.d.ts` o types:** revalida contra el config real; el stub tipa shapes inyectadas por Pi, no las redefinas a gusto.

## 12. Preferencias de estilo de respuesta del agente

- Verbosidad **baja/concisa**: respuestas en español (el usuario trabaja en español), comentarios de código también en español cuando se pidan; el código y los mensajes de commit en inglés (convención del repo).
- Explica razonamiento **solo** al proponer un cambio de diseño o de seguridad; en tareas mecánicas, ejecuta y reporta brevemente.
- Propón alternativas solo cuando haya trade-offs reales (p. ej. fail-closed vs experiencia de usuario); no para decisiones triviales.

## 13. Development / Install (cargar la extensión en Pi)

Esta sección es **operativa** para quien (humano o agente) acabe de clonar el repo y necesite cargar la extensión en el runtime de Pi para probarla en local. Es complementaria a §3 (Setup del entorno, solo cubre `npm install`).

### Prerrequisitos

- **Node ≥ 20** (dev en v24, ESM `target ES2022`).
- **Pi instalado y accesible en `PATH`** — verifica con `pi --version`. El SDK `@earendil-works/pi-coding-agent` lo inyecta el harness en runtime; no es dependencia npm.
- El repo es **local y sin remoto configurado**. No se asume `git push` ni publicación.

### 1. Instalar dependencias

```bash
npm install          # deps (zod, jest, swc, husky, ...)
npm run prepare      # instala el hook pre-commit (husky) — se ejecuta solo en `install`
```

### 2. Verificar quality gates antes de cargar

Confirma que el árbol compila y pasa tests **antes** de meter la extensión en Pi:

```bash
npm run check        # tsc --noEmit (NO toca dist/)
npm test             # 579 tests (Jest + @swc/jest)
npx prettier --check .
```

Si cualquiera falla, no tiene sentido seguir: la extensión arrancará pero arrastrará el bug.

### 3. Linkar en Pi (dos pasos)

El primer paso publica el paquete en el `node_modules` global; el segundo lo registra en el config del runtime.

```bash
# Paso 1 — hacer el paquete descubrible globalmente (crea un symlink)
npm link

# Paso 2 — registrar el paquete en Pi (escribe la ruta absoluta en
# `~/.pi/agent/settings.json` → array `packages`; Pi lo carga con jiti
# desde `src/index.ts` directamente, sin build)
pi install path:/ruta/absoluta/al/repo/pi-auto-mode
# Equivalente, si el cwd ya es la raíz del repo:
pi install .
```

> Pi resuelve la ruta relativa contra el `cwd` y guarda la **absoluta** en `settings.json`. Consulta `pi install --help` si el comando de tu build de Pi difiere.

### 4. Verificar que Pi la carga

```bash
pi --verbose
```

Busca una línea tipo `[Extensions] ... pi-auto-mode` en la salida. Alternativamente, abre `~/.pi/agent/settings.json` y confirma que la entrada aparece en el array `packages`.

### 5. Recargar tras cambios de código

- Pi lee `src/index.ts` **vía jiti** al arrancar. **No hace falta `npm run build`** para desarrollo local — `dist/` solo se usa al publicar a npm.
- Para que un cambio en código fuente surta efecto: **reinicia Pi** (o usa `/reload` si la versión de Pi lo expone).
- El hook (`before_agent_start` y compañía) se vuelve a registrar en cada carga; cambios en `src/handlers/*.ts` aplican al siguiente arranque.

### 6. Desinstalar (limpiar el entorno)

```bash
# Quitar del config de Pi
pi remove /ruta/absoluta/al/repo/pi-auto-mode

# Opcional — quitar el symlink global
npm unlink pi-auto-mode
```

### 7. Dónde vive el estado

| Recurso                | Ruta                                                                                                                       |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Config del usuario     | `~/.pi/pi-auto-mode.json` (auto-seeded desde `config.example.json` al primer arranque; override con `PI_AUTO_MODE_CONFIG`) |
| Telemetría (default)   | `~/.pi/pi-auto-mode.jsonl` (configurable vía `Config.telemetry.path`)                                                      |
| Link del paquete en Pi | `~/.pi/agent/settings.json` → array `packages`                                                                             |

> **Importante:** `config.json` en la raíz del repo es gitignored y del usuario. Para cambios de diseño de schema, edita `config.example.json` + `src/types/config.ts`; **nunca** tocar `config.json`.

### 8. Pitfalls frecuentes

- **"Module not found" al arrancar Pi** → probablemente se saltó `npm install` o `npm link`. Vuelve a correr ambos.
- **Los cambios no se reflejan** → reinicia Pi. No hay hot-reload. El jiti cachea módulos hasta el siguiente arranque.
- **Reset del config** → borra `~/.pi/pi-auto-mode.json`; el siguiente arranque re-seeds desde `config.example.json`.
- **Reset completo del estado** → (1) quita la entrada de `packages` en `~/.pi/agent/settings.json`, (2) borra `~/.pi/pi-auto-mode.json` y `~/.pi/pi-auto-mode.jsonl`, (3) corre `pi install .` de nuevo.
- **`pi install` no acepta la ruta** → revisa `pi install --help` y la versión de Pi que tienes; puede que el flag `path:` sea distinto en builds antiguos.

## Notas para el agente

- **Nunca uses `any` en TypeScript** — `unknown` + narrowing o tipos explícitos (verificar con `npm run check`).
- **Siempre corre `npm test` y `npx prettier --check .` antes de dar una tarea por terminada.**
- **Nunca debilites el comportamiento fail-closed** ni la cobertura de `secret-guard.ts`; son medidas de seguridad vinculantes.
- **No edites `config.json`** (del usuario) ni `dist/`/`coverage/` (generados); diseña cambios de config en `config.example.json` + schema zod.
- **No des `git push` ni crees PRs** sin confirmación explícita: no hay remoto configurado en el repo.
- **Antes de proponer un plan nuevo, lee `TASK.md`** (a pesar de estar gitignored, el archivo está en el directorio de trabajo). No dupliques trabajo ni propongas fases que ya están documentadas como deferidas/pendientes.
- **`TASK.md` no se commitea ni se borra**; es el scratchpad del usuario en este repo local. Ver §7.
