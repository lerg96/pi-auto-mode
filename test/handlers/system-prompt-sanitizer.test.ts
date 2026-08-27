import {
  parseAvailableTools,
  scrubAvailableTools,
} from '../../src/handlers/system-prompt-sanitizer.ts'

const SAMPLE = `You are an expert coding assistant operating inside pi, a coding agent harness.

Available tools:
- read: Read a file from disk.
- bash: Run a shell command.
- edit: Modify an existing file.
- write: Create or overwrite a file.
- grep: Search inside files.

In addition to the tools above, you may have access to other custom tools depending on the project.

Guidelines:
- Be concise in your responses
- Show file paths clearly when working with files
`

describe('parseAvailableTools', () => {
  it('locates the Available tools: section', () => {
    const parsed = parseAvailableTools(SAMPLE)
    expect(parsed).not.toBeNull()
    expect(parsed?.header).toBe('Available tools:')
  })

  it('extracts every tool bullet in order', () => {
    const parsed = parseAvailableTools(SAMPLE)
    expect(parsed?.bullets.map((b) => b.name)).toEqual([
      'read',
      'bash',
      'edit',
      'write',
      'grep',
    ])
  })

  it('captures the snippet after the colon', () => {
    const parsed = parseAvailableTools(SAMPLE)
    expect(parsed?.bullets[0].rest).toBe('Read a file from disk.')
    expect(parsed?.bullets[1].rest).toBe('Run a shell command.')
  })

  it('returns null when the header is missing', () => {
    const prompt = 'You are pi.\nNo tools section here.'
    expect(parseAvailableTools(prompt)).toBeNull()
  })

  it('stops at the first non-bullet line (Guidelines: is preserved)', () => {
    const parsed = parseAvailableTools(SAMPLE)
    // section end should be at the line "In addition to the tools above..."
    const after = SAMPLE.slice(parsed!.sectionEnd)
    expect(
      after.replace(/^\n+/, '').startsWith('In addition to the tools above')
    ).toBe(true)
  })
})

describe('scrubAvailableTools / idempotence', () => {
  it('returns the original prompt byte-for-byte when every bullet is allowed', () => {
    const allowed = new Set(['read', 'bash', 'edit', 'write', 'grep'])
    expect(scrubAvailableTools(SAMPLE, allowed)).toBe(SAMPLE)
  })

  it('removes a denied tool bullet', () => {
    const allowed = new Set(['read', 'bash', 'edit', 'grep']) // write denied
    const out = scrubAvailableTools(SAMPLE, allowed)
    expect(out).not.toContain('- write:')
    expect(out).toContain('- read:')
    expect(out).toContain('- grep:')
  })

  it('removes the section header when ALL bullets are denied', () => {
    const out = scrubAvailableTools(SAMPLE, new Set())
    expect(out).not.toContain('Available tools:')
    expect(out).not.toContain('- read:')
    // The "In addition..." paragraph remains, joined cleanly to the rest.
    expect(out).toContain('In addition to the tools above')
  })

  it('preserves blank lines inside the section', () => {
    const prompt = `Available tools:

- read: r
- bash: b

Next paragraph.`
    const out = scrubAvailableTools(prompt, new Set())
    expect(out).not.toContain('Available tools:')
    expect(out).toContain('Next paragraph.')
  })

  it('returns the original prompt unchanged when the section is missing', () => {
    const prompt = 'No tools header here.'
    expect(scrubAvailableTools(prompt, new Set())).toBe(prompt)
  })

  it('keeps the section but drops a single bullet when other bullets remain', () => {
    const allowed = new Set(['read', 'bash', 'grep'])
    const out = scrubAvailableTools(SAMPLE, allowed)
    expect(out).toContain('Available tools:')
    expect(out).toContain('- read:')
    expect(out).toContain('- grep:')
    expect(out).not.toContain('- write:')
  })
})

describe('scrubAvailableTools / roundtrip', () => {
  it('preserves bytes when nothing changed (stability across turns)', () => {
    const allowed = new Set(['read', 'bash', 'edit', 'write', 'grep'])
    expect(scrubAvailableTools(SAMPLE, allowed)).toBe(SAMPLE)
  })

  it('byte-stable on empty-allowed when the section is absent', () => {
    const prompt = 'Header\n\nBody without tools section.'
    expect(scrubAvailableTools(prompt, new Set())).toBe(prompt)
  })
})
