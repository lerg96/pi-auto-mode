# pi-auto-mode

An extension for the **Pi Coding Agent** runtime (`@earendil-works/pi-coding-agent`) that adds a **safe command auto-execution mode**. Pi already auto-allows every command by default — this extension does **not** add auto-execution itself, but a validation layer that tries to guarantee whatever runs is at least safe. Every tool call is evaluated against permission rules, a risk classifier and a blocking strategy, and decides for you between `allow`, `deny` or `ask`. Built for those who want the agent to move forward without friction but without giving up control of sensitive operations.

## Key features

- **4-layer model** — the decision combines a _visibility filter_ (what the LLM sees), an exact-`toolName`-keyed _pattern matcher_, an optional LLM classifier (only when the cascade resolves to `ask`) and a _deny strategy_ (what happens after a block). See [4-layer model](#4-layer-model).
- **Cascading permission-set policy** — define named permission sets; they evaluate in order (global first, active sets after), last match wins.
- **Three decision actions** — `allow` (permit and continue), `deny` (block) and `ask` (prompt for confirmation), with a well-defined decision matrix.
- **Optional LLM classifier** — invoked **only** when the permission cascade resolves to `ask`; reads referenced files (≤8KB) with trust-boundary check and secret redaction.
- **Fail-closed by design** — on any load or evaluation error, the tool is **blocked**. It never degrades to an unsafe default permission.
- **`auto-retry` strategy** — after N consecutive or total blocks, escalates the notice so the agent doesn't get stuck in a denied-attempt loop. Backwards-compatible alias: `deny-and-continue` is accepted and normalized to `auto-retry`.
- **Secret guard and trust boundary** — protects sensitive paths and commands (`/etc`, `~/.ssh`, `.env`, `sudo`, `rm -rf`, `git push --force`); the file extractor respects the same boundary before passing content to the LLM.
- **Three global modes (`default` / `strict` / `yolo`)** — `yolo` rewrites `ask` → `allow` without touching explicit `deny`s; `strict` rewrites `ask` → `deny`. Switchable live via `/auto-mode:mode`.
- **Live adjustments** — runtime config reloads that would **weaken** security (disabling the classifier, relaxing fallback to `allow`, lowering deny-strategy restrictiveness, …) are automatically rejected.
- **Session commands** — enable/disable permission sets and switch mode live with explicit confirmation; block counters reset between sessions.

## Table of contents

- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [4-layer model](#4-layer-model)
- [Configuration](#configuration)
- [Usage](#usage)
- [Confirmation flow (Ask)](#confirmation-flow-ask)
- [Events](#events)
- [Configuration examples](#configuration-examples)
- [Available scripts](#available-scripts)
- [Project structure](#project-structure)
- [Testing](#testing)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [Local development / install](#local-development-install)
- [License](#license)

## Prerequisites

- **Node.js >= 20** (developed on v24). The project is ESM (`"type": "module"`), ES2022 target.
- **npm** (ships with Node).
- The extension runs **inside the Pi Coding Agent runtime**, which injects the `@earendil-works/pi-coding-agent` SDK at runtime.

## Installation

```bash
# 1. Clone the repository
git clone <repo-url> pi-auto-mode
cd pi-auto-mode

# 2. Install dependencies
npm install
```

That gets the project ready for development. To use it as a real extension, add/load it in your Pi Coding Agent runtime configuration (the Pi harness injects the SDK and fires the `tool_call`, `session_start`, etc. events).

## 4-layer model

A tool call goes through **four layers** in order before executing. The first three decide _what runs_; the fourth decides _what to do after a block_.

1. **Layer 1 — Visibility filter** (`before_agent_start`).

   - Global `permissions.tools` / `permissions.skills` / `permissions.mcps` permissions (exact `toolName` keys, no `tool:arg-pattern`).
   - Type: `ToolPermission = SimpleAction | PatternRule[]` where `SimpleAction = 'allow' | 'ask' | 'deny'` and `PatternRule = { pattern: string; action: SimpleAction; reason?: string }`.
   - Active sets (`activePermissionSets[]`) evaluate **after** the global one, in array order; last match wins (cascade).
   - Per-name result: `allow` | `ask` | `deny`; passed through the global `mode` (see [Global modes](#global-modes)).
   - `setActiveTools(...)` + two system-prompt _sanitizers_ (`Available tools:` and `<available_skills>`) hide whatever resolves to `deny`. `unknown` (no entry) is treated as **visible** to avoid breaking existing configs.
   - Implementation: `src/permission/visibility.ts`, `src/permission/active-tools.ts`, `src/permission/skill-filter.ts`, `src/permission/modes.ts`, `src/permission/wildcard-matcher.ts`, `src/handlers/before-agent-start.ts`, `src/handlers/system-prompt-sanitizer.ts`, `src/handlers/skill-prompt-sanitizer.ts`.

2. **Layer 2 — Rule-based pattern matcher**.

   - Evaluates `PatternRule[]` (from the global and the active sets in cascade) against the normalized tool call using exact `toolName` keys.
   - Actions: `allow` | `ask` | `deny`.
   - Includes trust boundary (`/etc`, `~/.ssh`, `~/.env`, `sudo`, `rm -rf`, `git push --force`), allow-exceptions (cover the whole compound command), block rules (first match wins; critical severity → block), wrapper unwrapping (`sh -c`, `eval`, `sudo`, …) and interpolation detection → `ask` (fail-closed).
   - Implementation: `src/permission/visibility.ts`, `src/permission/wildcard-matcher.ts`, `src/permission/compose.ts`, `src/permission/evaluate.ts`, `src/permission/rule.ts`.

3. **Layer 3 — LLM classifier** (optional, only when cascade = `ask`; only hardens `ask`: an explicit cascade `allow` is final and never consults the LLM).

   - When Layer 2 returns `ask`, the LLM classifier runs with two prior sub-steps: secret guard and rule-based block rules.
   - **File extraction**: if the tool carries a `command` field (shell), the classifier tries to read the first path-like referenced file (≤8KB), applying the trust boundary and a suspicious-content redactor (`eval(`, `child_process`, `exec(`, `Buffer.from`, `os.system`, …). Content never reaches the LLM if it falls inside the boundary or looks suspicious. **Never throws**: any error becomes `{ kind: 'unsupported' }`.
   - Fallback in `classifier.fallback.onTimeout` / `classifier.fallback.onError` (see [Classifier fallback](#classifier-fallback)).
   - Implementation: `src/classifier/llm-layer.ts`, `src/classifier/file-extraction.ts`, `src/classifier/pattern-matcher.ts`, `src/classifier/rule-evaluator.ts`, `src/classifier/secret-guard.ts`, `src/classifier/llm-client.ts`.

4. **Layer 4 — Deny strategy**.

   - Decides what to do **after** a `deny`: `auto-retry` (deny + reason to the LLM so it reformulates), `ask-user` (immediate modal) or `both` (`auto-retry` up to N consecutive, then `ask-user`).
   - Backwards-compatible alias: `deny-and-continue` is accepted in JSON and normalized to `auto-retry` in memory (see [Deny strategy](#deny-strategy)).
   - Implementation: `src/deny/deny-service.ts`.

The gate (`src/gate/gate.ts`) orchestrates all four; the `ask` resolver (`src/gate/ask.ts`) is the only place where the user sees a modal, and it is only invoked when Layer 2 or Layer 3 return `ask`.

## Configuration

The extension reads a single JSON config file (fail-closed: if it cannot read/validate it, it **won't start**). Its path is chosen two ways:

1. `PI_AUTO_MODE_CONFIG` environment variable → path to the config file.
2. If unset, `config.json` at the repo root.

> **Note:** `config.json` is in `.gitignore`. **Never edit it directly** as part of a change — it is user config. Config design changes go in `config.example.json` + the zod schema in `src/types/config.ts`.

Start by copying the template:

```bash
cp config.example.json config.json
```

### Environment variables

| Variable              | Required | Description                                                   |
| --------------------- | -------- | ------------------------------------------------------------- |
| `PI_AUTO_MODE_CONFIG` | No       | Path to the JSON config file. If missing, uses `config.json`. |

No other environment variables are required. The LLM classifier API keys go **inside the config** (`apiKey` / `baseUrl` fields of the `classifier.llm` section), not in the environment or code.

### Config structure (schema v2)

The main blocks of `config.example.json`:

- **`permissions`** (global, Layer 1 + 2) — map with three optional keys:
  - `tools` — `{ toolName: SimpleAction | PatternRule[] }`. Keys are **exact** tool names (e.g. `"bash"`, `"read"`, `"write"`). No `tool:arg-pattern`. `*` and `?` wildcards inside `PatternRule.pattern`.
  - `skills` — `{ skillName: SimpleAction }` (bare name, no patterns).
  - `mcps` — `{ mcpName: SimpleAction }` (bare name).
- **`permissionSets`** — named sets that extend/override the global one. Each set accepts the same three blocks (`tools`, `skills`, `mcps`) with the same structure. **No `priority`**: evaluation order is defined by `activePermissionSets`.
- **`activePermissionSets`** — array of strings (set names). **Order matters**: they evaluate in sequence after the global one; last match wins (cascade).
- **`mode`** (top-level, Layer 1) — global visibility mode: `default` (honors the maps as-is), `strict` (collapses `ask` → `deny`), `yolo` (collapses `ask` → `allow`, keeps explicit `deny`s). Switchable live via `/auto-mode:mode`.
- **`classifier`** — optional LLM layer (`llm`: provider/model/apiKey). **`provider` is a free-form string** (any Pi modelRegistry ID). `ruleBased` block **removed** (trust boundary, allow-exceptions, block rules live in Layer 2). The `fallback` block defines behavior on `onTimeout` / `onError`: `ask-user` (default, fail-closed), `deny` (fail-closed, silent block) or `allow` (opt-in fail-open, rejected by `isSecurityWeakening()` on reload). `onBlock` and `onBlockUserOverride` control what happens after a classifier block.
- **`denyStrategy`** — post-block strategy (Layer 4): `auto-retry` (canonical, formerly `deny-and-continue`), `ask-user` (immediate modal) or `both` (auto-retry with escalation). See [Deny strategy](#deny-strategy).
- **`ui`** — confirmation UI behavior (`promptMaxRows`, `promptFieldMaxWidth`, `showClassifierRisk`, `modalTimeoutMs`, `subagentModalTimeoutMs`, `noUiAsks`). **`doublePressToConfirm` removed** (deprecated).
- **`telemetry`** — event logging (enableable with optional path; see [Telemetry with default path](#telemetry-with-default-path)).

### Global modes

Three values, all opt-in (default = `default`):

| `mode`    | `ask` is treated as | Explicit `deny` | Typical use                                                |
| --------- | ------------------- | --------------- | ---------------------------------------------------------- |
| `default` | `ask` (modal)       | `deny`          | default behavior, prompts the user                         |
| `strict`  | `deny` (silent)     | `deny`          | zero-prompt setups (CI, batch)                             |
| `yolo`    | `allow`             | `deny`          | frictionless execution without prompts; `deny`s still hold |

`unknown` (tool/skill with no entry in the maps) is **not** rewritten: it is considered visible for backwards compatibility.

Switch mode live:

```
/auto-mode:mode default
/auto-mode:mode strict
/auto-mode:mode yolo
```

The change requires explicit confirmation (same flow as `auto-mode:sets activate`).

### External directory scope (`external_directory`)

Opt-in via `confineToWorkingDirectory` (default `false` = no change). When active, any `fs` access or `shell` segment touching a path outside `process.cwd()` hardens the verdict: explicit match in `external_directory` (cascaded like the rest, last match wins) or default `ask`. Internal paths get no opinion, and an explicit tool `deny` always beats an external `allow`.

`shell` segments are extracted with tree-sitter-bash (`web-tree-sitter` + wasm, no native binaries): quoted strings stay atomic (a `sed "s/a/ /"` or `python3 -c "…"` never shreds into false paths) and comments, heredocs, regexes and variables are excluded by node type. If the parser isn't ready or the segment exceeds it (`<<` heredocs, `case`, >64KB), the heuristic extractor is used; the verdict reports the engine (`engine`).

```json
{
  "confineToWorkingDirectory": true,
  "permissions": {
    "tools": { "read": "allow" },
    "external_directory": { "/tmp/*": "ask", "/etc/*": "deny" }
  }
}
```

#### Which tools get validated (`externalDirectoryTools`)

The scope is a **path** check, so by default it runs for every tool that can name a path. `externalDirectoryTools` narrows that to a list of tool-name globs (`*` and `?`, the same matcher as `permissions.tools` patterns). Default `['*']`.

```json
{
  "confineToWorkingDirectory": true,
  "externalDirectoryTools": ["bash", "write", "read"],
  "permissions": {
    "tools": { "read": "allow", "write": "ask" },
    "external_directory": { "~/secrets/*": "deny" }
  }
}
```

With that config, `write` still asks for anything outside cwd and both tools are stopped by `~/secrets/*`, but a tool that is **not** listed (say `edit`) never reaches this layer: its cascaded verdict stands, so an `allow` for `edit` reads and writes anywhere on disk. This is deliberate — it lets you pay the path check only where you want it — but it is a **removal of hardening**, not an addition:

- The list only takes away the external-directory opinion. It never relaxes a `deny`/`ask` coming from `permissions.tools`.
- `[]` disables the layer for every tool (equivalent to leaving `confineToWorkingDirectory` off, except the rules stay written down).
- Keep every tool that can touch the filesystem in the list. In this runtime that is `read`, `write`, `edit`, `bash` (plus `find`/`grep`/`ls` and any `mcp__*` tool with path arguments) — add them if you use them, or use a glob like `"mcp__*"`.
- A tool call whose name is unknown to the gate is still validated: a missing name never switches the layer off.

#### Git worktrees (`trustGitWorktrees`)

`git worktree add ../feature-wt` puts a second checkout of the **same repository** outside `process.cwd()`, and a sub-agent working there (cwd is still the original checkout) used to hit an `ask` on every write. With `trustGitWorktrees: true` (default, only consulted when `confineToWorkingDirectory` is on), a path that matches **no** `external_directory` rule and lives under one of the repository's registered worktrees counts as internal.

```json
{
  "confineToWorkingDirectory": true,
  "trustGitWorktrees": true
}
```

Boundaries of that trust (`src/permission/git-worktrees.ts`):

- Roots come only from the repository found by walking up from the scope base dir — never from a directory named inside the tool call.
- Shapes covered: normal checkout, linked worktree (from either side), submodule checkout, `--separate-git-dir`. A bare repository contributes only its linked worktrees (it has no working tree). Git records no back-link from a `--separate-git-dir` common dir, so that checkout is trusted only when the walk-up starts inside it.
- Discovery reads the filesystem (`<repo>/.git/worktrees/<id>/gitdir` + the `<worktree>/.git` back-pointer). No `git` subprocess, no shell-out per tool call.
- A registration is trusted only when the back-pointer validates: `<worktree>/.git` must be a file whose `gitdir:` resolves to that exact registration. Deleted worktrees (stale) and planted `gitdir` files pointing elsewhere are dropped.
- `<worktree>/.git/**` is **never** covered: the common dir is shared by every worktree and holds hooks/config, so writing it from a foreign worktree would be code execution.
- Explicit rules win. `external_directory` entries are resolved first; a `deny`/`ask` matching a worktree path still denies/asks. Worktree trust never whitelists a second, unrelated path in the same call.

Set `trustGitWorktrees: false` to treat every worktree as an ordinary external directory.

### Classifier fallback

`classifier.fallback.onTimeout` and `classifier.fallback.onError` accept three values:

| Value      | Behavior                                                                                                                                                                                  |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ask-user` | Default. Prompts the user (fail-closed).                                                                                                                                                  |
| `deny`     | Silent block (fail-closed, no prompt; useful for `strict`).                                                                                                                               |
| `allow`    | **Opt-in fail-open.** Opens the gate. Only applies when the user declares it explicitly; `isSecurityWeakening()` flags it as a weakening and rejects the reload if introduced afterwards. |

`allow` is never the schema default; this branch is never reached by accident.

### Deny strategy

`denyStrategy.mode` controls what happens **after** a `deny` (Layer 4):

| Value        | Behavior                                                                                                                  |
| ------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `auto-retry` | Deny + reason to the LLM so it reformulates the tool call. Practical default.                                             |
| `ask-user`   | Immediate confirmation modal; the LLM doesn't get the reason until the user decides.                                      |
| `both`       | `auto-retry` up to `escalation.consecutive` (or `escalation.total`); past the threshold, escalates to `ask-user` (modal). |

The canonical name is **`auto-retry`** (aligned with opencode-auto-mode). The `deny-and-continue` alias is still accepted in JSON for backwards compatibility and normalized to `auto-retry` in memory via `ConfigSchema`.

Limits are controlled in `denyStrategy.escalation`: `consecutive` (run of consecutive denials) and `total` (session total). A user approval resets `consecutive` but leaves `total` untouched.

### `ui` block

| Field                    | Type      | Default  | Description                                                                                                                                                                                                                                                                                                                    |
| ------------------------ | --------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `promptMaxRows`          | `number`  | `10`     | Max visible rows in the tool-call preview inside the modal.                                                                                                                                                                                                                                                                    |
| `promptFieldMaxWidth`    | `number`  | `80`     | Max width of the value field shown in the modal.                                                                                                                                                                                                                                                                               |
| `showClassifierRisk`     | `boolean` | `true`   | Shows the classifier risk level (`low`/`medium`/`high`) and reason in the description.                                                                                                                                                                                                                                         |
| `modalTimeoutMs`         | `number`  | `120000` | Max time (ms) the modal waits for a decision before resolving to `deny` (fail-closed). `-1` = no timeout.                                                                                                                                                                                                                      |
| `subagentModalTimeoutMs` | `number`  | `120000` | Timeout for prompts rendered on the **parent's** UI because the asking sub-session had none. Independent of `modalTimeoutMs`, which keeps governing the session's own modal. `-1` = no timeout.                                                                                                                                |
| `noUiAsks`               | `string`  | `bubble` | What an `ask` does when **this session** has no UI (e.g. a sub-agent session created by another extension, which never receives a `uiContext`). `bubble` renders the modal on the parent session's UI if this process has one; `deny` rejects without asking. Has no effect in headless `pi -p`, where nothing publishes a UI. |

> Any live config reload that would **weaken** security (disabling the classifier, relaxing the deny, introducing fail-opens, or allows over restricted surfaces) is rejected and the previous config is kept.

## Usage

The extension works passively: once loaded in the runtime, it intercepts every `tool_call` event and applies the policy. You define the rules in the config; the internals walk the four layers described above in order. In short:

1. **Normalize** the tool call (name + input).
2. **Filter visibility** on `before_agent_start` (Layer 1): combine global `permissions.tools/skills/mcps` + active sets in cascade (`activePermissionSets` order), apply the global `mode`, call `setActiveTools(...)` and rewrite the system prompt (`Available tools:` and `<available_skills>` sections).
3. **Evaluate rules** (Layer 2): classify the tool call against `PatternRule[]` from the global and active sets (cascade), with trust boundary, allow-exceptions, block rules and wrapper unwrapping. Result: `allow` | `ask` | `deny`.
4. **Consult the LLM classifier** (Layer 3, optional): **only if Layer 2 = `ask`**. If the tool carries a `command` field, the referenced file is extracted (≤8KB, trust-check, secret redactor) and injected into the LLM prompt. `onTimeout` / `onError` apply the configured `fallback`.
5. **Apply the deny strategy** (Layer 4) after a `deny`: `auto-retry` (deny + reason to the LLM), `ask-user` (immediate modal) or `both` (auto-retry with escalation).
6. **Decide** `allow` / `deny` / `ask` and act (block with reason, prompt for confirmation via modal, or log to telemetry).

### Session commands

The extension registers two slash commands to manage configuration live:

```
auto-mode:sets activate <name>
auto-mode:sets deactivate <name>
auto-mode:sets list

auto-mode:mode default | strict | yolo
```

Changing the active sets or the global mode is a **privilege escalation**: it requires explicit confirmation (reuses the gate's same `ask` resolver) and throws an error if the name doesn't exist.

## Confirmation flow (Ask)

When a tool call lands on `ask` (because the permission rule asks for it or because the classifier flagged it as dubious), the gate delegates to the `AskResolver`, which by default is the confirmation modal. The end-to-end contract is:

1. The gate generates a `requestId` (UUID) and builds an `AskRequest` with `surface`, `value`, the matched `Rule` and the `ClassifierRisk` (if any).
2. The `permissions:ui_prompt` event is emitted with that `requestId` (see [Events](#events)).
3. The modal opens with the decision list and the `Promise<AskDecision>` is assembled.
4. The user picks an option; the modal resolves with `'allow'`, `'deny'` or `{ decision: 'deny', reason }` (only on "Deny with reason").
5. The gate consumes the result:
   - **Allow** → records session approval, resets the consecutive-denial streak and emits `permissions:decision` with `result: 'allow'`.
   - **Deny** → throws `AskDeniedError` whose `message` starts with `Permission denied by user` and, if a reason was given, appends it (`Permission denied by user: <reason>`). The error reaches the model verbatim and the `permissions:decision` event as `denialReason`.

### Modal options

The select exposes options for standard tool-permission prompts
(`Allow` pre-highlighted); the external-directory modal adds two more:

| Option                | Effect                                                                                                                                                                                                                                                                       |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Deny`                | Resolves `'deny'`. Closes the modal.                                                                                                                                                                                                                                         |
| `Allow`               | Resolves `'allow'` with a single click.                                                                                                                                                                                                                                      |
| `Allow for session`   | Persists the approval for future equivalent tool calls.                                                                                                                                                                                                                      |
| `Deny with reason`    | Opens a free-text input (`pi.ui.input`) to capture the reason; if there is non-empty text, returns `{ decision: 'deny', reason }`. If cancelled or left empty, falls back to reason-less `'deny'`. The reason is sanitized (no newlines, trimmed) before reaching the model. |
| `Allow for this tool` | (external-directory only) Resolves `'allow_dir_tool'`. The gate records a session rule (`userVerdict: 'allow_dir_tool'`).                                                                                                                                                    |
| `Allow for all tools` | (external-directory only) Resolves `'allow_dir_all'`. The gate adds to a process allowlist (`userVerdict: 'allow_dir_all'`).                                                                                                                                                 |

### Configurable timeout (`ui.modalTimeoutMs`)

The modal has a fail-closed timer controlled by `ui.modalTimeoutMs`:

- **Default:** `120000` (2 minutes).
- **`-1`** → no timeout: the modal waits for the user response indefinitely.
- Any other positive value → on expiry, the modal closes and resolves `'deny'` (fail-closed).

The timeout is read from the live config (not a snapshot), so a mid-session reload changes behavior without restarting.

Prompts raised by a **sub-session** and rendered on the parent's UI use `ui.subagentModalTimeoutMs` instead — the person in front of the terminal is not the one waiting, and a background agent should not hold the prompt slot forever. The two timers are independent: `modalTimeoutMs: -1` with `subagentModalTimeoutMs: 300000` means "my own prompts wait forever, a sub-agent's prompt expires in 5 minutes". An expired prompt is audited as `decidedBy: 'timeout'`, never as a user denial.

### Sub-sessions without a UI (`ui.noUiAsks`)

Pi binds a session's extension runner to a real UI only when the harness hands one over: interactive TUI and RPC do, `pi -p` (print/JSON) does not. A session created **inside** the process by another extension inherits whatever the creator passed — `@tintinweb/pi-subagents`, for example, binds child sessions with no `uiContext`, so every one of their events reports `ctx.hasUI === false` and an `ask` raised there has nowhere to render.

With `ui.noUiAsks: "bubble"` (default) the extension keeps a process-wide handle on the last UI that reported itself dialog-capable (`Symbol.for('pi-auto-mode:ui-registry')`, because Pi re-evaluates extension modules per session and a child session with another working directory does not share module state) and renders the modal there. The prompt says it was `raised by a child session`, since it is not about the session in front of you.

Rules of that path:

- A UI is published **only** when `ctx.hasUI` was true. Pi's no-op context is never published: it answers `select() → undefined` / `confirm() → false`, which would be a fabricated human decision.
- Nothing is published in `pi -p` / JSON mode, so headless runs keep denying — `hasUI` stays false exactly as in the parent.
- Prompts take a process-wide lock: Pi owns a single extension selector, and a second modal rendered over the first would orphan the first promise (a sub-agent hanging forever, especially with `modalTimeoutMs: -1`). This is why `ui.subagentModalTimeoutMs` defaults to a finite 2 minutes even when `modalTimeoutMs` is `-1`: an unanswered background prompt releases the lock instead of blocking every other ask in the process.
- When a borrowed prompt expires the denial says `the confirmation prompt expired without an answer` and is audited `via: 'timeout'`, `decidedBy: 'timeout'`.
- `ui.noUiAsks: "deny"` restores the historical behavior: no UI, no question, deny.
- This is a workaround for those child sessions only. Extensions that prompt through their own `ui.confirm()` inside a UI-less session are still denied, because their `ctx.hasUI` is still false — the real fix is passing `uiContext` when the session is bound (upstream).

### Dual-modal: external-directory permissions

When `confineToWorkingDirectory` triggers an `ask` for a path outside the
working directory, the modal renders a **different layout** than the standard
permission prompt. This makes it clear that the question is about the
**target directory**, not about the tool itself.

> The external-directory modal is only shown when the **external-directory
> layer itself produced the `ask`** (i.e. the path check is what triggered
> the prompt). If a normal permission rule produces the `ask` but the call
> also references an allowed external path, the standard permission modal
> is shown instead.

Whichever button you pick, the approval is scoped to a **directory**, and the
row the modal labels `path` shows exactly that directory — what is displayed
is what gets persisted. The gate computes it once (`grantDirFor`) and hands
the same value to the modal and to persistence, so the two can never drift.
The directory is resolved as:

| Offending path                | Directory granted               |
| ----------------------------- | ------------------------------- |
| exists and is a directory     | the path itself                 |
| exists and is not a directory | its parent                      |
| does not exist                | its parent                      |
| stat fails for another reason | the path itself (never upwards) |

If the grant would be a **filesystem root** (`/`, `C:\`), nothing is persisted
and the approval degrades to a one-time allow: the prompt comes back next
time rather than silently whitelisting the whole drive.

The modal shows:

| Button                  | Effect                                                                                                                                                                                                           |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Allow this call**     | Grant once — nothing is remembered (`'allow'`).                                                                                                                                                                  |
| **Allow for this tool** | The gate records a **session rule** scoped to that tool (surface `external_directory:<tool>`, pattern `<dir>/**`). Other tools still prompt (`'allow_dir_tool'`). Event carries `userVerdict: 'allow_dir_tool'`. |
| **Allow for all tools** | The gate adds the directory to a **process-scoped allowlist** that `evaluateExternalDirectory` pre-checks for every tool and every session (`'allow_dir_all'`). Event carries `userVerdict: 'allow_dir_all'`.    |
| **Deny**                | Block this call only.                                                                                                                                                                                            |
| **Deny with reason**    | Block and attach your reason for the model.                                                                                                                                                                      |

A hand-written session rule on the bare `external_directory` surface grants
the directory to **all** tools, like `Allow for all tools` but stored as a
session rule.

The standard permission modal (for tools that triggered a rule-based `ask`)
keeps its original four-button layout: `Allow`, `Allow for session`,
`Deny`, `Deny with reason`.

The gate owns all session-approval persistence: it receives the decision id
from the modal and applies the appropriate side effect (session rule or
allowlist) so that the modal never mutates state directly.

### Modal fail-closed invariants

The modal preserves the extension's **fail-closed** principle. Any exit path that isn't an explicit user decision ends in `'deny'`:

- No UI bound for this session **and** nothing borrowable in the process (`pi -p`, or `ui.noUiAsks: "deny"`) → `{ decision: 'deny', via: 'no-ui' }`, with no modal and no user attribution.
- `pi.ui.custom(...).catch(...)` → `'deny'` (any UI error).
- `try { ... } catch { settleDeny() }` → `'deny'` (sync exception while building the modal).
- Overlay `onExit` → `'deny'` (the user closes the overlay with another key).
- Timeout (`ui.modalTimeoutMs`, or `ui.subagentModalTimeoutMs` for a borrowed prompt, other than `-1`) → `{ decision: 'deny', via: 'timeout' }` — a timeout is nobody answering, not somebody saying no.
- Unknown select option → `'deny'`.

The only path that can resolve `'allow'` is the user explicitly picking `Allow` or completing the `Allow for session` confirmation.

### Audit and events

The gate is the **only** source of truth for the session: the modal no longer calls `sessionRules.approveForSession` directly, the gate does it on receiving `'allow'`. This avoids duplicate approvals and keeps a single audit point.

The emitted events look like this (see [Events](#events) for the full shapes):

- **`permissions:ui_prompt`** — emitted when the modal opens; always carries `requestId` now.
- **`permissions:decision`** — when the ask resolves, enriched with `{ requestId, decidedBy: 'user', via: 'modal', matchedPattern, denialReason? }`. `matchedPattern` is the pattern of the rule that triggered the ask; `denialReason` only appears when the user picked `Deny with reason` and typed something.

## Events

The extension emits two events through `pi.events.emit` that allow auditing the decision flow without coupling to the UI. Both are fire-and-forget: if consumption fails, the tool call is not interrupted.

### `permissions:ui_prompt`

Emitted **when** the confirmation modal opens (before the user decides). It signals the agent is waiting for human input.

```ts
{
  requestId: string,          // UUID generated by the gate; correlates ui_prompt ↔ decision
  source: 'tool_call',        // reserved for 'skill_input' | 'skill_read' in the future
  surface: string,            // e.g. 'fs', 'shell'
  value: string,              // path or command that triggered the ask
  agentName: string | null,
  request: { surface: string, value: string }
}
```

### `permissions:decision`

Emitted when **resolving** each tool call. The base shape is always `{ surface, value, result, resolution }` and, on the ask path, is enriched with an audit block:

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
  // Only when resolution is 'permission_ask' or 'classifier_ask':
  requestId?: string,
  decidedBy?: 'user' | 'session' | 'no-ui' | 'timeout',
  via?: 'modal' | 'parent-modal' | 'no-ui' | 'timeout' | 'session-rules',
  matchedPattern?: string,     // pattern of the rule that triggered the ask
  denialReason?: string       // present only if the user picked "Deny with reason" and typed something
}
```

Notes:

- `denialReason` travels **only** on the ask path (not on automatic classifier or trust-boundary denials).
- `matchedPattern` identifies which rule (permission or classifier) was the representative for the ask — useful to understand why the user had to decide.
- `result: 'deny'` + `resolution: 'permission_ask'` + `denialReason` is the canonical signal that the model is about to receive `Permission denied by user: <reason>`.
- `via: 'parent-modal'` means the modal was rendered on another session's UI (a sub-session asked, the human answered in the parent window) — it is still a real human decision. `via: 'no-ui'` / `decidedBy: 'no-ui'` means **nobody was asked**: the call was blocked because no prompt could be shown, and the model receives `Permission denied without asking: ...` instead of a claim about what the user decided.
- `via: 'timeout'` / `decidedBy: 'timeout'` means the prompt was shown and **nobody answered** before `ui.modalTimeoutMs` (or `ui.subagentModalTimeoutMs`) elapsed; the model receives `Permission denied: the confirmation prompt expired without an answer`.

### Minimal config example (config.example.json)

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
          "reason": "destructive command not allowed"
        },
        { "pattern": "rm -rf *", "action": "deny", "reason": "destructive" },
        {
          "pattern": "cat *.env",
          "action": "deny",
          "reason": "reading environment variables is not allowed"
        },
        {
          "pattern": "git push --force*",
          "action": "deny",
          "reason": "force-push blocked"
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
              "reason": "aws blocked in this project"
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
    "modalTimeoutMs": 120000,
    "subagentModalTimeoutMs": 120000,
    "noUiAsks": "bubble"
  },
  "telemetry": { "enabled": false, "path": "" }
}
```

## Configuration examples

Three common patterns that don't fit the `minimal example` above.

### Telemetry with default path

If you enable `telemetry.enabled` and omit `telemetry.path`, events are
written to `~/.pi/pi-auto-mode.jsonl` (no need to configure the path).
One event per line — JSONL format.

```json
{
  "telemetry": { "enabled": true }
}
```

```jsonl
{"ts":"2026-09-02T10:11:12.000Z","type":"permissions:decision","payload":{"surface":"shell","value":"rm -rf /tmp","result":"deny","resolution":"permission"}}
{"ts":"2026-09-02T10:11:13.000Z","type":"permissions:ui_prompt","payload":{"requestId":"9c1...","source":"tool_call","surface":"shell","value":"sudo apt update"}}
```

Keys with `secret|token|password|api_key|…` are redacted to `[REDACTED]`
before writing; see `src/telemetry/telemetry.ts`.

### Custom surface for your own tool

If your agent exposes a tool that isn't `bash`/`fs`/`mcp` (e.g.
`agent_send_message`), route it to a custom-named surface via the
`permissions.tools` map and then write rules like any other surface. With no entry in
`permissions.tools`, the tool still falls through to the `denied` sentinel (fail-closed).

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
              "reason": "possible secret"
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

### llama.cpp / Ollama with free-form `provider`

The LLM client already speaks generic chat-completions, so just switch
`provider` and point `baseUrl` at your local server's OpenAI-compatible endpoint
(Ollama, llama.cpp server, LM Studio, vLLM…). `provider` accepts **any Pi modelRegistry ID**.

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

## Available scripts

| Command                  | Description                                             |
| ------------------------ | ------------------------------------------------------- |
| `npm run check`          | Typecheck: `tsc --noEmit` (doesn't compile to `dist/`). |
| `npm run build`          | Compiles to `dist/` (`tsc -p tsconfig.json`).           |
| `npm test`               | Runs tests with coverage (Jest `--coverage`).           |
| `npm run test:watch`     | Tests in watch mode (`jest --watch`).                   |
| `npx prettier --write .` | Formats the whole repo.                                 |
| `npx prettier --check .` | Verifies formatting (acts as "lint"; no ESLint).        |

Running a single test or file:

```bash
npx jest test/gate/gate.test.ts
npx jest -t "test name" test/gate/gate.test.ts
```

## Project structure

```
src/            Extension code (entry: src/index.ts)
  gate/         Orchestrates tool calls (normalize, gate, ask)
  permission/   Layer 1 (visibility) + Layer 2 (rules):
                visibility, active-tools, skill-filter, modes,
                wildcard-matcher, compose, evaluate, rule,
                session-rules, external-directory (+ git-worktrees)
  classifier/   Layer 3: rule-based (block-rules, pattern-matcher,
                rule-evaluator, secret-guard) + LLM (llm-layer,
                llm-client, file-extraction)
  handlers/     SDK hooks: before-agent-start,
                system-prompt-sanitizer, skill-prompt-sanitizer
  config/       Config loading + zod validation (fail-closed)
  commands/     Slash commands (set-commands: auto-mode:sets, auto-mode:mode)
  deny/         Layer 4: deny-service (auto-retry / ask-user / both)
  state/        Global in-memory state (config-state, ui-context)
  ui/           Confirmation UI (permission-modal, ui-prompt)
  telemetry/    Event logging (default path ~/.pi/pi-auto-mode.jsonl)
  types/        Config zod schemas + TUI types
  pi-sdk.d.ts   Pi SDK type stub (don't import in real runtime)
test/           1:1 mirror of src/ + TUI stubs
config.example.json  Template for creating your config.json
dist/           `npm run build` output (generated, gitignored)
coverage/       Coverage report (generated, gitignored)
```

## Testing

Framework: **Jest 30 + SWC** (fast transform). Tests in `test/`, 1:1 mirror of `src/`.

```bash
npm test        # full suite with coverage (579 tests)
```

External services (Pi TUI and SDK) are replaced with `jest.mock` and stubs in `test/stubs/`. The gate decision matrix, cascade composition, classifier rules, all four layers and the `auto-retry` strategy are covered by tests: don't degrade this coverage.

## Contributing

No configured remote or CI. The flow is manual for now:

1. Create a descriptive branch (`fix/<something>`, `feat/<something>`).
2. Make changes with **Conventional Commits** (`feat:`, `fix:`, `chore:`, `refactor:`, `test:`, `perf:`, `style:`).
3. Leave the work tree formatted and tests green:
   - `npm run check`
   - `npm test`
   - `npx prettier --check .`

The pre-commit hook (`husky` + `lint-staged`) formats and runs tests over staged `.ts` files. Read `AGENTS.md` in full before touching code — it contains binding conventions and security limits.

## Local development / install

This section describes the flow for **loading the extension inside the Pi runtime** from the local repo so you can test it with hot edits over `src/`. It complements [Installation](#installation), which only covers `npm install`.

### Prerequisites

- **Node.js >= 20** (dev on v24). Native ESM.
- **Pi Coding Agent installed** — `pi --version` must answer.
- The repo is local; there is **no** configured remote, **no** `git push` or publishing without confirmation.

### 1. Install dependencies

```bash
npm install
npm run prepare      # installs the pre-commit hook (husky)
```

### 2. Verify the quality gates

Before loading the extension into Pi, confirm the tree is healthy:

```bash
npm run check        # tsc --noEmit
npm test             # 579 tests with Jest + @swc/jest
npx prettier --check .
```

If any of them fails, fix it before continuing.

### 3. Link into Pi (two steps)

Pi needs two things: the package to be globally discoverable and registered in its config.

```bash
# Step 1 — symlink into the global node_modules
npm link

# Step 2 — register the absolute path in ~/.pi/agent/settings.json (`packages` array)
pi install path:/absolute/path/to/repo/pi-auto-mode
# Equivalent shortcut, if cwd is already the repo root:
pi install .
```

> Pi resolves `.` against the cwd and stores the **absolute path** in `settings.json`. Loading is done with jiti against `src/index.ts` directly, so **no** `npm run build` is needed during development. Check `pi install --help` if the flag changes between versions.

### 4. Confirm Pi sees it

```bash
pi --verbose
```

Look for a line like `[Extensions] ... pi-auto-mode` in the output. Alternatively, open `~/.pi/agent/settings.json` and check the path appears in the `packages` array.

### 5. Reload after editing code

- **No local build step**: Pi reads `src/index.ts` directly with jiti. `dist/` is only used when publishing to npm.
- For a change to apply: **restart Pi** (or use `/reload` if your build exposes it).
- Hooks (`before_agent_start`, sanitizers, …) register on every load; nothing else to touch.

### 6. Uninstall

```bash
pi remove /absolute/path/to/repo/pi-auto-mode
# optional — clean the global symlink
npm unlink pi-auto-mode
```

### Where state lives

| Resource                | Path                                                                                                                  |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------- |
| User config             | `~/.pi/pi-auto-mode.json` (auto-seeded from `config.example.json` on first boot; override with `PI_AUTO_MODE_CONFIG`) |
| Telemetry               | `~/.pi/pi-auto-mode.jsonl` (configurable via `telemetry.path`)                                                        |
| Pi package registration | `~/.pi/agent/settings.json` → `packages[]`                                                                            |

### Common pitfalls

- **"Module not found" on Pi boot** → `npm install` or `npm link` was probably skipped. Re-run them.
- **My changes have no effect** → restart Pi. No hot-reload.
- **Config reset** → delete `~/.pi/pi-auto-mode.json`; the next boot re-seeds it from `config.example.json`.
- **Full state reset** → remove the `packages` entry in `~/.pi/agent/settings.json`, delete `~/.pi/pi-auto-mode.json` and `~/.pi/pi-auto-mode.jsonl`, and re-run `pi install .`.

## License

Released under the **MIT** license. See the `LICENSE` file. (No `LICENSE` file in the repo yet; one must be added.)
