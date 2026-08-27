/**
 * Heuristic system-prompt sanitizer for the "Available tools:" section.
 *
 * The exact prompt format is owned by `@earendil-works/pi-coding-agent`
 * (see `core/system-prompt.ts`). It renders tools as bullet lines directly
 * under a section header:
 *
 *     Available tools:
 *     - read: ...snippet...
 *     - bash: ...snippet...
 *
 *     In addition to the tools above, ...
 *
 * The matcher below assumes that convention. The sanitiser is deliberately
 * narrow: it only touches the "Available tools:" section. Any unrecognized
 * input is returned unchanged (fail-closed against false positives).
 *
 * The format is a contract we discovered from reading the upstream source.
 * If Pi changes the layout, the fallback (return original) keeps the
 * extension safe — at worst the LLM sees a tool it should not.
 */

const AVAILABLE_TOOLS_HEADER = 'Available tools:'

/**
 * A single bullet line under "Available tools:". `name` is the first token
 * (matches `[A-Za-z0-9_-]+`); `rest` is everything after the first space
 * (typically `"name: <snippet>"`).
 */
export interface ParsedToolBullet {
  name: string
  rest: string
}

/**
 * Result of parsing the "Available tools:" section out of a prompt. The
 * section slice keeps the surrounding whitespace around the section so a
 * roundtrip (parse → no change → re-serialize) yields byte-stable output
 * for prompts where the section has not been edited.
 */
export interface ParsedAvailableTools {
  /** Original prompt (unchanged) — preserved for callers that need it. */
  prompt: string
  /** Index of the section's first character in `prompt`. */
  sectionStart: number
  /** Index one past the section's last character (exclusive). */
  sectionEnd: number
  /** Header line, e.g. `"Available tools:"`. */
  header: string
  /** Lines that appeared between the header and the first non-bullet, including blank lines. */
  bodyLines: string[]
  /** Tool bullets that were recognised under the header. */
  bullets: ParsedToolBullet[]
}

/** Recognise a tool-bullet line: leading whitespace, `- `, then a name. */
function parseBullet(line: string): ParsedToolBullet | null {
  const m = /^(\s*)-\s+([A-Za-z0-9_-]+)(.*)$/.exec(line)
  if (!m) return null
  // Pi renders bullets as `- <name>: <snippet>` — strip the leading ": " so
  // the caller can rebuild the line as `- <name><rest>` without doubling
  // the colon.
  const rest = (m[3] ?? '').replace(/^:\s*/, '').trimStart()
  return { name: m[2], rest }
}

/** True when a line is "obviously not a tool bullet" — i.e. end of section. */
function isNonBulletLine(line: string): boolean {
  if (line.trim().length === 0) return false // blanks are part of the section
  if (line.trimStart().startsWith('- ')) return false // bullets are part of the section
  return true
}

/**
 * Locate the "Available tools:" section in the prompt. Returns null when the
 * header is missing (the extension has nothing to filter). The section runs
 * from the header line through the last consecutive tool-bullet-or-blank
 * line. Anything after that (next section header, prose paragraph) is left
 * untouched.
 */
export function parseAvailableTools(
  prompt: string
): ParsedAvailableTools | null {
  if (typeof prompt !== 'string') return null
  const lines = prompt.split('\n')
  const headerIdx = lines.findIndex((l) => l.trim() === AVAILABLE_TOOLS_HEADER)
  if (headerIdx === -1) return null

  const bodyLines: string[] = []
  const bullets: ParsedToolBullet[] = []
  let i = headerIdx + 1
  while (i < lines.length) {
    const line = lines[i]
    if (isNonBulletLine(line)) break
    bodyLines.push(line)
    const b = parseBullet(line)
    if (b) bullets.push(b)
    i++
  }

  // Reconstruct section byte range. Each line is "<text>\n" except the last
  // (which has no trailing newline). `split('\n')` produces an empty trailing
  // element when the input ends with '\n', so we have to count bytes from the
  // original prompt.
  let sectionStart = 0
  for (let k = 0; k < headerIdx; k++) sectionStart += lines[k].length + 1
  let sectionEnd = sectionStart + lines[headerIdx].length
  for (let k = 0; k < bodyLines.length; k++) {
    sectionEnd += bodyLines[k].length + 1
  }

  return {
    prompt,
    sectionStart,
    sectionEnd,
    header: lines[headerIdx],
    bodyLines,
    bullets,
  }
}

/**
 * Drop tool bullets whose name is not in `allowedNames`. Whitelist-shaped so
 * adding a tool to a permission set never accidentally hides an existing one
 * — only tools explicitly named in `allowedNames` survive. Blank lines and
 * unrecognised prose inside the section are preserved.
 *
 * When every tool bullet is dropped, the section header itself is removed
 * (so the LLM does not see "Available tools: (none)" — Pi's source already
 * renders "(none)" for an empty `toolsList`, but we prefer to remove the
 * section outright to keep the prompt clean).
 */
export function scrubAvailableTools(
  prompt: string,
  allowedNames: ReadonlySet<string>
): string {
  const parsed = parseAvailableTools(prompt)
  if (parsed === null) return prompt // header missing: return original
  const allowedBullets = parsed.bullets.filter((b) => allowedNames.has(b.name))
  const droppedAny = allowedBullets.length !== parsed.bullets.length
  if (!droppedAny) return prompt // byte-stable: nothing changed

  if (allowedBullets.length === 0) {
    // remove section entirely. Also strip trailing blank lines so the next
    // paragraph abuts cleanly.
    const before = parsed.prompt
      .slice(0, parsed.sectionStart)
      .replace(/\n+$/, '\n')
    const after = parsed.prompt.slice(parsed.sectionEnd).replace(/^\n+/, '')
    // `before` already ends with '\n'; join with `after` to keep a clean break.
    return `${before}${after}`
  }

  // keep header, drop bullets that are not allowed, preserve blank lines
  const rebuilt = parsed.bodyLines.filter((line) => {
    const b = parseBullet(line)
    if (b === null) return true // blank line or prose bullet — keep
    return allowedNames.has(b.name)
  })
  const newSection = [parsed.header, ...rebuilt].join('\n')
  // +1 for the trailing newline of the last kept body line
  const trailingNewline = rebuilt.length > 0 ? '\n' : ''
  return (
    parsed.prompt.slice(0, parsed.sectionStart) +
    newSection +
    trailingNewline +
    parsed.prompt.slice(parsed.sectionEnd)
  )
}
