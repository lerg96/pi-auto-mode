import {
  parseAvailableSkillsSections,
  scrubAvailableSkills,
} from '../../src/handlers/skill-prompt-sanitizer.ts'

const SAMPLE = `Header paragraph.

The following skills provide specialized instructions for specific tasks.
Use the read tool to load a skill's file when the task matches its description.
When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.

<available_skills>
  <skill>
    <name>ts-language-server</name>
    <description>TypeScript LSP integration.</description>
    <location>/skills/ts/SKILL.md</location>
  </skill>
  <skill>
    <name>python-lsp</name>
    <description>Python language server.</description>
    <location>/skills/py/SKILL.md</location>
  </skill>
  <skill>
    <name>&lt;dangerous&gt;</name>
    <description>Skills with &amp; embedded chars.</description>
    <location>/skills/danger/SKILL.md</location>
  </skill>
</available_skills>

Footer paragraph.`

describe('parseAvailableSkillsSections', () => {
  it('locates the <available_skills> block', () => {
    const sections = parseAvailableSkillsSections(SAMPLE)
    expect(sections.length).toBe(1)
    const s = sections[0]
    expect(SAMPLE.slice(s.start, s.end)).toContain('<available_skills>')
    expect(SAMPLE.slice(s.start, s.end)).toContain('</available_skills>')
  })

  it('extracts every skill entry with decoded XML', () => {
    const sections = parseAvailableSkillsSections(SAMPLE)
    expect(sections[0].entries.map((e) => e.name)).toEqual([
      'ts-language-server',
      'python-lsp',
      '<dangerous>',
    ])
    expect(sections[0].entries[2].description).toBe(
      'Skills with & embedded chars.'
    )
  })

  it('returns an empty array when no block is present', () => {
    expect(parseAvailableSkillsSections('plain prompt')).toEqual([])
  })
})

describe('scrubAvailableSkills / idempotence', () => {
  it('returns the original prompt byte-for-byte when every skill is allowed', () => {
    const allowed = new Set(['ts-language-server', 'python-lsp', '<dangerous>'])
    expect(scrubAvailableSkills(SAMPLE, allowed)).toBe(SAMPLE)
  })

  it('drops a denied skill entry, keeps the section', () => {
    const allowed = new Set(['ts-language-server'])
    const out = scrubAvailableSkills(SAMPLE, allowed)
    expect(out).toContain('ts-language-server')
    expect(out).not.toContain('python-lsp')
    expect(out).toContain('<available_skills>')
    expect(out).toContain('</available_skills>')
  })

  it('removes the section + preamble when ALL skills are denied', () => {
    const out = scrubAvailableSkills(SAMPLE, new Set())
    expect(out).not.toContain('<available_skills>')
    expect(out).not.toContain('ts-language-server')
    // The "The following skills provide..." preamble is also stripped so the
    // LLM does not see dangling "use the read tool to load a skill" text.
    expect(out).not.toContain('The following skills provide')
    // Surrounding paragraphs survive.
    expect(out).toContain('Header paragraph.')
    expect(out).toContain('Footer paragraph.')
  })

  it('returns the original prompt when no block is present', () => {
    const prompt = 'No skills here.'
    expect(scrubAvailableSkills(prompt, new Set())).toBe(prompt)
  })

  it('handles multiple sections (paranoia: Pi could emit more than one)', () => {
    const prompt = `<available_skills>
  <skill>
    <name>a</name>
    <description>A</description>
    <location>/a/SKILL.md</location>
  </skill>
</available_skills>
<available_skills>
  <skill>
    <name>b</name>
    <description>B</description>
    <location>/b/SKILL.md</location>
  </skill>
</available_skills>`
    const out = scrubAvailableSkills(prompt, new Set(['a']))
    expect(out).toContain('name>a')
    expect(out).not.toContain('name>b')
  })
})

describe('scrubAvailableSkills / roundtrip stability', () => {
  it('preserves bytes when nothing changed', () => {
    const allowed = new Set(['ts-language-server', 'python-lsp', '<dangerous>'])
    expect(scrubAvailableSkills(SAMPLE, allowed)).toBe(SAMPLE)
  })
})
