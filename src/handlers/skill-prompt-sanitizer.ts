/**
 * Skill-prompt sanitizer. Parses `<available_skills>...</available_skills>`
 * blocks out of the system prompt and rewrites them so the LLM only sees
 * entries the user has approved.
 *
 * The format is owned by `@earendil-works/pi-coding-agent`
 * (`core/skills.ts:formatSkillsForPrompt`). It emits a single block:
 *
 *     <available_skills>
 *       <skill>
 *         <name>ts-language-server</name>
 *         <description>...</description>
 *         <location>...</location>
 *       </skill>
 *       ...
 *     </available_skills>
 *
 * The skill block is preceded by a 4-line preamble (an intro sentence, a
 * "use the read tool..." sentence, a "resolve it against..." sentence, and
 * a blank line). We strip the preamble together with the block when there
 * are no visible skills left, so the prompt remains coherent.
 */

const AVAILABLE_OPEN = '<available_skills>'
const AVAILABLE_CLOSE = '</available_skills>'
const SKILL_OPEN = '<skill>'
const SKILL_CLOSE = '</skill>'
const NAME_OPEN_RE = /<name>([\s\S]*?)<\/name>/
const DESCRIPTION_OPEN_RE = /<description>([\s\S]*?)<\/description>/
const LOCATION_OPEN_RE = /<location>([\s\S]*?)<\/location>/

export interface ParsedSkillEntry {
  name: string
  description: string
  location: string
}

export interface ParsedSkillSection {
  start: number
  end: number
  entries: ParsedSkillEntry[]
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function encodeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function parseEntries(sectionBody: string): ParsedSkillEntry[] {
  const out: ParsedSkillEntry[] = []
  let cursor = 0
  while (cursor < sectionBody.length) {
    const open = sectionBody.indexOf(SKILL_OPEN, cursor)
    if (open === -1) break
    const close = sectionBody.indexOf(SKILL_CLOSE, open)
    if (close === -1) break
    const block = sectionBody.slice(open + SKILL_OPEN.length, close)
    const nameMatch = NAME_OPEN_RE.exec(block)
    const descMatch = DESCRIPTION_OPEN_RE.exec(block)
    const locMatch = LOCATION_OPEN_RE.exec(block)
    if (nameMatch && locMatch) {
      out.push({
        name: decodeXml(nameMatch[1].trim()),
        description: descMatch ? decodeXml(descMatch[1].trim()) : '',
        location: decodeXml(locMatch[1].trim()),
      })
    }
    cursor = close + SKILL_CLOSE.length
  }
  return out
}

/**
 * Locate every `<available_skills>` block in the prompt. Each block is
 * returned with the byte range it occupies and the parsed entries.
 *
 * The function is forgiving: a missing closing tag simply aborts parsing at
 * the first open tag and returns no section. That keeps the extension safe
 * if Pi's prompt format ever drifts.
 */
export function parseAvailableSkillsSections(
  prompt: string
): ParsedSkillSection[] {
  if (typeof prompt !== 'string') return []
  const sections: ParsedSkillSection[] = []
  let searchStart = 0
  while (searchStart < prompt.length) {
    const open = prompt.indexOf(AVAILABLE_OPEN, searchStart)
    if (open === -1) break
    const close = prompt.indexOf(AVAILABLE_CLOSE, open + AVAILABLE_OPEN.length)
    if (close === -1) break
    const body = prompt.slice(open + AVAILABLE_OPEN.length, close)
    sections.push({
      start: open,
      end: close + AVAILABLE_CLOSE.length,
      entries: parseEntries(body),
    })
    searchStart = close + AVAILABLE_CLOSE.length
  }
  return sections
}

/**
 * Drop `<skill>` blocks whose `name` is not in `allowedNames`. Whitelist-
 * shaped: adding a skill never hides a previously-listed one.
 *
 * If the section ends up empty (all skills dropped) AND Pi's preamble is
 * present immediately above the block, the preamble is removed too so the
 * prompt does not contain dangling "The following skills provide..." text.
 * Otherwise the section is left as-is with no children (the LLM will see
 * an empty block — but the prompt still mentions skills; we accept this
 * rather than guess where the preamble ends).
 */
export function scrubAvailableSkills(
  prompt: string,
  allowedNames: ReadonlySet<string>
): string {
  const sections = parseAvailableSkillsSections(prompt)
  if (sections.length === 0) return prompt

  // Apply replacements back-to-front so byte offsets stay valid.
  let result = prompt
  for (let s = sections.length - 1; s >= 0; s--) {
    const section = sections[s]
    const kept = section.entries.filter((e) => allowedNames.has(e.name))
    if (kept.length === section.entries.length) continue

    if (kept.length === 0) {
      // remove section, including the blank line above (when present).
      const before = result.slice(0, section.start).replace(/\n+$/, '\n')
      const after = result.slice(section.end).replace(/^\n+/, '')
      // Also strip the Pi preamble ("The following skills provide ... /\n\n")
      // so the LLM does not see dangling "Use the read tool to load a skill"
      // text with no skills listed.
      const preambleIdx = before.lastIndexOf('The following skills provide')
      const stripped =
        preambleIdx === -1
          ? before
          : before.slice(0, preambleIdx).replace(/\n+$/, '\n')
      result = `${stripped}${after}`
      continue
    }

    const rendered = renderAvailableSkills(kept)
    result =
      result.slice(0, section.start) + rendered + result.slice(section.end)
  }
  return result
}

function renderAvailableSkills(entries: readonly ParsedSkillEntry[]): string {
  const lines = [AVAILABLE_OPEN]
  for (const e of entries) {
    lines.push('  <skill>')
    lines.push(`    <name>${encodeXml(e.name)}</name>`)
    lines.push(`    <description>${encodeXml(e.description)}</description>`)
    lines.push(`    <location>${encodeXml(e.location)}</location>`)
    lines.push('  </skill>')
  }
  lines.push(AVAILABLE_CLOSE)
  return lines.join('\n')
}
