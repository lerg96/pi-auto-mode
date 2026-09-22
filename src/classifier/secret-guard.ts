// Secret guard (Milestone M4-T3).
// Detects secret file paths, keywords, embedded credentials, and CLI flags.
// Anchored path patterns reduce false positives (e.g. `report.awsome`).

export interface SecretCheck {
  sensitive: boolean
  reason?: string
}

// 1. Secret file paths — anchored to path boundary to avoid false positives.
//    Matches `.env`, `.ssh`, `id_rsa` etc. only at start of string, after `/`, `\`, `.`, or `~`.
const PATH_RE =
  /(?:^|[/\\.~])\.(env(?:\.\w+)?|ssh|credentials|netrc|npmrc|aws|kube|pypirc|gitconfig)\b|(?:^|[/\\.~])\bid_(?:rsa|ed25519|dsa|ecdsa)\b/i

// 1b. Environment-style secret assignments: KEYNAME=value / KEYNAME: value.
//     The sensitive keyword must be a delimited key token: preceded by start-of
//     string or a non `[A-Za-z_]` char (so a sensitive word inside a longer
//     identifier like `password_reset` does NOT match), and NOT followed by a
//     letter/underscore (handled implicitly because the value separator `[=:]`
//     must come next). Compound keywords are listed BEFORE the simple ones so
//     `SECRET_KEY`, `ACCESS_KEY`, `CLIENT_SECRET`, etc. match as a whole. The
//     value part `[^\s"']*` is zero-or-more, allowing empty assignments like
//     `SECRET_KEY=` or `SECRET_KEY= `.
const ENV_RE =
  /(?:^|[^A-Za-z_])[A-Za-z_]*?(?:SECRET_ACCESS_KEY|ACCESS_KEY|SECRET_KEY|API[_-]?KEY|PRIVATE[_-]?KEY|CLIENT[_-]?SECRET|SECRET|TOKEN|PASSWORD|PASSWD|PWD|CREDENTIAL)\s*[=:]\s*[^\s"']+/i

// 2. Secret keywords — only matched when they are a *bare* strong indicator
//    (`password`/`credential`) or appear in an assignment/flag context (`=`, `:`),
//    so benign phrases like "the project has a secret feature" or an isolated
//    "token" no longer trigger a modal. Actual assignments (SECRET_KEY=xyz,
//    password=abc) are still caught here and by ENV_RE below.
const KEYWORD_RE =
  /\b(credential|password)s?\b|\b(secret|token|api[_-]?key)s?\b\s*[=:]/i

// 3. Embedded credentials: key=value, Bearer tokens, URL user:pass@host.
//    The URL branch accepts any RFC-3986-ish scheme (`[a-z][a-z0-9+.-]*`),
//    not just http(s): DSNs like `postgres://`, `mysql://`, `redis://`,
//    `mongodb+srv://` or `amqp://` carry passwords the same way and must
//    reach the model / telemetry masked. The userinfo user part is `*` so
//    password-only DSNs (`redis://:pw@cache`) are caught. All branches stay
//    linear (negated character classes, no nested quantifiers). Known false
//    positive: `http://proxy:8080@host` — a port in the userinfo position is
//    indistinguishable from a password without a scheme allowlist; noise is
//    preferred over under-masking.
//    The scheme quantifier is BOUNDED ({0,31}, RFC 3986 caps schemes at 63 and
//    no real DSN scheme is longer): an unbounded `[a-z0-9+.-]*` turns the scan
//    quadratic (measured 1.4s vs 7.6ms at 40k chars) because every position in
//    a long alphanumeric run restarts the inner backtrack.
const EMBEDDED_RE =
  /\b(client_secret|api[_-]?key|apikey)\s*[=:]\s*\S|bearer\s+\S|[a-z][a-z0-9+.-]{0,31}:\/\/[^/:@\s]*:[^/@\s]+@/i

// 4. Secret flags: --token / -token / --auth / -api-key etc. with = or space separator.
const FLAG_RE = /(?:--|-)(token|auth|secret|api[_-]?key|password)[=:\s]+\S/i

/** Returns the first matching category for `text`, or { sensitive: false }. */
function matchesAny(text: string): SecretCheck {
  if (PATH_RE.test(text)) return { sensitive: true, reason: 'secret file path' }
  if (ENV_RE.test(text))
    return { sensitive: true, reason: 'env secret assignment' }
  if (KEYWORD_RE.test(text))
    return { sensitive: true, reason: 'secret keyword' }
  if (EMBEDDED_RE.test(text))
    return { sensitive: true, reason: 'embedded credential' }
  if (FLAG_RE.test(text)) return { sensitive: true, reason: 'secret flag' }
  return { sensitive: false }
}

/**
 * Detects whether `text` touches secrets. Strips quotes, backslashes,
 * and variable expansions before re-checking so obfuscated secrets are caught.
 */
export function isSecretSensitive(text: string): SecretCheck {
  const direct = matchesAny(text)
  if (direct.sensitive) return direct

  const stripped = text
    .replace(/["'\\]/g, '')
    .replace(/\$\{[^}]*\}/g, '')
    .replace(/\$[A-Za-z_]\w*/g, '')
  if (stripped === text) return { sensitive: false }

  const obf = matchesAny(stripped)
  if (obf.sensitive)
    return { sensitive: true, reason: 'obfuscated ' + obf.reason }
  return { sensitive: false }
}

// ── Redaction for model-facing messages ─────────────────────────────
// Same secret vocabulary as the detectors above, but instead of reporting,
// these patterns mask the VALUE and preserve the key/structure. All
// patterns are linear (no nested quantifiers) to stay ReDoS-safe.

const REDACTED = '[REDACTED]'

// URL userinfo: scheme://user:pass@host → scheme://user:[REDACTED]@host.
// Any RFC-3986-ish scheme (see EMBEDDED_RE above), so DSNs are masked too.
// The password class excludes `"`, `'`, `,`, `;` and `` ` `` so a delimiter
// trailing the credential is never swallowed: `psql "postgres://user:pw@db"`
// keeps its quotes. Residual: a password containing one of those literals
// immediately before `@` is not masked by this pattern (the detector still
// flags the whole string as sensitive). Linear: three fixed groups, negated
// classes only, no nested quantifiers, and the scheme quantifier is bounded
// for the same ReDoS reason as EMBEDDED_RE above.
const URL_CREDS_RE = /([a-z][a-z0-9+.-]{0,31}:\/\/[^/:@\s]*:)([^/@"',;`]+)(@)/gi

// Bearer / Basic tokens: `Bearer xyz` → `Bearer [REDACTED]`.
const BEARER_BASIC_RE = /\b(Bearer|Basic)(\s*:?\s+)([^\s"'`,;]+)/gi

// CLI flags: --token=xyz / --token xyz → --token [REDACTED].
const FLAG_VALUE_RE =
  /((?:--|-)(?:token|auth|secret|api[_-]?key|password)[=:\s]+)("[^"]*"|'[^']*'|[^\s"'`,;]+)/gi

// Env-style assignments: PASSWORD=hunter2 → PASSWORD=[REDACTED].
// Mirrors ENV_RE's keyword set and boundary rule so substrings like
// `password_reset` never match.
const ENV_VALUE_RE =
  /(^|[^A-Za-z_])((?:[A-Za-z_]*?(?:SECRET_ACCESS_KEY|ACCESS_KEY|SECRET_KEY|API[_-]?KEY|PRIVATE[_-]?KEY|CLIENT[_-]?SECRET|SECRET|TOKEN|PASSWORD|PASSWD|PWD|CREDENTIAL))\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s"'`,;]+)/gi

/** Masks one credential value, preserving quotes and trailing closers. */
function maskSecretValue(value: string): string {
  // Already-redacted output (marker plus optional trailing closers) passes
  // through untouched so re-applying the redactor is idempotent.
  if (
    value === REDACTED ||
    (value.startsWith(REDACTED) &&
      /^[\])}.,!?;:]+$/.test(value.slice(REDACTED.length)))
  )
    return value
  if (value.length >= 2) {
    const first = value.charAt(0)
    const last = value.charAt(value.length - 1)
    if ((first === '"' && last === '"') || (first === "'" && last === "'"))
      return first + REDACTED + last
  }
  const trailing = value.match(/[)\].,!?]+$/)
  if (trailing && trailing[0].length < value.length)
    return REDACTED + trailing[0]
  return REDACTED
}

/**
 * Redacts secret VALUES from free text before it is shown to the model
 * (e.g. inside deny messages). Keys, flags and surrounding structure are
 * preserved so the message stays useful; only the credential material is
 * replaced with `[REDACTED]`. Conservative by design: unknown shapes pass
 * through untouched, and re-applying is idempotent. Never throws.
 */
export function redactSecretsForModel(text: string): string {
  if (!text) return text
  let out = text
  out = out.replace(URL_CREDS_RE, `$1${REDACTED}$3`)
  out = out.replace(BEARER_BASIC_RE, `$1$2${REDACTED}`)
  out = out.replace(
    FLAG_VALUE_RE,
    (_m: string, head: string, value: string) => head + maskSecretValue(value)
  )
  out = out.replace(
    ENV_VALUE_RE,
    (_m: string, boundary: string, head: string, value: string) =>
      boundary + head + maskSecretValue(value)
  )
  return out
}
