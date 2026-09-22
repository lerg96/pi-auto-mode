// Home-path masking helper.
// Centralises "what counts as MY home directory, in which spellings, and how
// to mask it" so the knowledge lives in exactly one place. Used at the two
// DISCLOSURE boundaries — the JSONL telemetry log (`src/telemetry/telemetry.ts`)
// and the external classifier LLM payload (`redactSecrets` in
// `src/classifier/llm-layer.ts`). It is deliberately NOT used on model-facing
// deny messages (`redactSecretsForModel`): the model receiving a deny needs
// the real path to reformulate/retry, and a literal `[REDACTED]` there would
// be reissued verbatim (pinned by test/gate/deny-message.test.ts).
//
// Contract of `maskHomePrefix(text)`:
//   - Replaces ONLY the home-directory prefix with the same prefix whose
//     username segment is `[REDACTED]`, preserving the surrounding structure
//     (separators, casing of the untouched part, quotes):
//       C:/Users/lerg/Downloads/x.md -> C:/Users/[REDACTED]/Downloads/x.md
//   - Idempotent: the marker never contains the username, so re-running over
//     the output is a no-op.
//   - Never throws and never mutates more than the prefix; on a degenerate
//     home (see `isUsableHome`) it returns the input untouched.

import { homedir } from 'node:os'

const MARKER = '[REDACTED]'

// Characters that can plausibly continue the LAST path segment of a path
// (alphanumerics plus the punctuation common inside a directory name). After
// a home prefix, one of these means we are looking at a DIFFERENT directory
// (e.g. /home/lerg2 vs /home/lerg, C:\Users\Bob vs C:\Users\Bobby) and
// nothing is masked. Anything else — a separator, quote, whitespace, or the
// end of the string — is a real boundary.
const SEGMENT_BOUNDARY = '(?![A-Za-z0-9._\\-])'

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Last path segment under either separator spelling (the username). */
function lastSegment(home: string): string {
  const trimmed = home.replace(/[\\/]+$/, '')
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return idx === -1 ? trimmed : trimmed.slice(idx + 1)
}

/**
 * Guards the degenerate cases. Masking is skipped entirely (variants = [])
 * when homedir() reports:
 *   - ''            — nothing to look for;
 *   - '/' or '\\'   — the root: the "username" would be empty and a prefix
 *                     match would eat EVERY absolute path in the text;
 *   - a bare drive root ('C:', 'C:\\') — same problem on Windows: no
 *                     username, and 'C:\' prefixes every path on the disk;
 *   - a username shorter than 2 chars (e.g. home '/a') — the FLOOR we chose:
 *     single-character usernames essentially never occur in real installs,
 *     while a 1-char home prefix (`/a` before `(?![A-Za-z0-9._-])`) would
 *     only ever match via its boundary lookahead and mash ordinary text like
 *     '/a/b'. Trading that false-positive rate for a privacy win on a
 *     non-existent user is not worth it — skip instead.
 */
function isUsableHome(home: string): boolean {
  if (!home) return false
  const trimmed = home.replace(/[\\/]+$/, '')
  if (!trimmed) return false // '/' , '\\' , '///'
  if (/^[A-Za-z]:$/.test(trimmed)) return false // 'C:' / 'C:\'
  return lastSegment(home).length >= 2
}

/**
 * The spellings of the home directory to look for in free text, LONGEST
 * first (so an overlapping variant can never half-match inside a longer
 * one). Includes:
 *   - the spelling os.homedir() reports (backslashes on Windows);
 *   - the forward-slash spelling (Windows accepts both, and logs/commands
 *     mix them freely);
 *   - the JSON-escaped spelling with literal double backslashes (what a
 *     Windows path looks like once it has passed through JSON.stringify,
 *     e.g. inside an error message that embedded a serialized payload);
 *   - the POSIX `~username` form, which carries the username too.
 *
 * NOT included on purpose: `~`, `$HOME`, `${HOME}`, `%USERPROFILE%`,
 * `$env:USERPROFILE`. Those are environment references, not identifiers —
 * they reveal nothing about who the user is, so masking them would only
 * destroy log readability for zero privacy gain.
 *
 * homedir() is called at CALL time (not module-load time) so tests can
 * point it elsewhere with jest.doMock('node:os') — same pattern as
 * `file-extraction.ts`.
 */
export function homePathVariants(): string[] {
  const home = homedir()
  if (!isUsableHome(home)) return []
  const variants = new Set<string>([home])
  if (home.includes('\\')) {
    variants.add(home.replace(/\\/g, '/'))
    variants.add(home.replace(/\\/g, '\\\\'))
  }
  variants.add(`~${lastSegment(home)}`)
  return [...variants].sort((a, b) => b.length - a.length)
}

/**
 * Masks every occurrence of the home-directory prefix in `text`, keeping
 * the remainder of each path intact and readable. Case folding is enabled
 * ONLY on win32 (NTFS paths are case-insensitive); on POSIX, /home/lerg and
 * /home/LERG are different directories and only the exact spelling matches.
 * Never throws; returns the input unchanged when no usable home exists.
 */
export function maskHomePrefix(text: string): string {
  if (!text) return text
  const variants = homePathVariants()
  if (variants.length === 0) return text
  const username = lastSegment(homedir())
  const flags = process.platform === 'win32' ? 'gi' : 'g'
  let out = text
  for (const variant of variants) {
    // Every match ends with the username segment, so masking is "match minus
    // username + marker": the preserved prefix keeps EXACTLY the spelling and
    // casing that appeared in the text (only the username disappears).
    const re = new RegExp(escapeRegExp(variant) + SEGMENT_BOUNDARY, flags)
    // Replacer function (not a string) so a `$` inside a path can never be
    // interpreted as a replacement pattern.
    out = out.replace(
      re,
      (m) => m.slice(0, m.length - username.length) + MARKER
    )
  }
  return out
}
