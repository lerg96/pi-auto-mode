import {
  extractArgv,
  buildSessionPatterns,
} from '../../src/permission/command-prefix.ts'

describe('extractArgv', () => {
  it('returns empty array for empty or whitespace-only segment', () => {
    expect(extractArgv('')).toEqual([])
    expect(extractArgv('   ')).toEqual([])
  })

  it('preserves quotes on quoted tokens', () => {
    expect(extractArgv('git commit -m "primer commit"')).toEqual([
      'git',
      'commit',
      '-m',
      '"primer commit"',
    ])
    expect(extractArgv('echo \'single quoted\' "double"')).toEqual([
      'echo',
      "'single quoted'",
      '"double"',
    ])
    expect(extractArgv('echo "hello \\"world\\"" hello\\ world')).toEqual([
      'echo',
      '"hello \\"world\\""',
      'hello\\ world',
    ])
  })

  it('drops leading env assignments', () => {
    expect(extractArgv('FOO=1 npm run build')).toEqual(['npm', 'run', 'build'])
    expect(extractArgv('FOO=1 BAR="baz" npm run build')).toEqual([
      'npm',
      'run',
      'build',
    ])
    expect(extractArgv('_SECRET_KEY=abc ./start.sh')).toEqual(['./start.sh'])
  })

  it('keeps non-leading env assignments as arguments', () => {
    expect(extractArgv('env FOO=1 node a.js')).toEqual([
      'env',
      'FOO=1',
      'node',
      'a.js',
    ])
    expect(extractArgv('git config user.name=test')).toEqual([
      'git',
      'config',
      'user.name=test',
    ])
  })

  it('drops redirection tokens and their targets', () => {
    expect(extractArgv('echo hi > out.txt')).toEqual(['echo', 'hi'])
    expect(extractArgv('echo hi >> out.txt')).toEqual(['echo', 'hi'])
    expect(extractArgv('cat < in.txt')).toEqual(['cat'])
    expect(extractArgv('cmd 2> err.log')).toEqual(['cmd'])
    expect(extractArgv('cmd 2>> err.log')).toEqual(['cmd'])
    expect(extractArgv('cmd &> all.log')).toEqual(['cmd'])
    expect(extractArgv('cmd &>> all.log')).toEqual(['cmd'])
  })

  it('drops standalone and attached redirection forms', () => {
    expect(extractArgv('echo hi 2>&1')).toEqual(['echo', 'hi'])
    expect(extractArgv('echo hi 1>&2')).toEqual(['echo', 'hi'])
    expect(extractArgv('echo hi >out.txt')).toEqual(['echo', 'hi'])
    expect(extractArgv('echo hi >>out.txt')).toEqual(['echo', 'hi'])
    expect(extractArgv('echo hi 2>err.log')).toEqual(['echo', 'hi'])
    expect(extractArgv('cmd &>out.txt')).toEqual(['cmd'])
    expect(extractArgv('cmd <in.txt')).toEqual(['cmd'])
  })

  it('preserves quoted redirection symbols as arguments', () => {
    expect(extractArgv('echo ">" "<"')).toEqual(['echo', '">"', '"<"'])
    expect(extractArgv('grep "2>&1" file')).toEqual(['grep', '"2>&1"', 'file'])
  })
})

describe('buildSessionPatterns', () => {
  const tableCases: Array<{ input: string; expected: string[] }> = [
    {
      input: 'npx tldr yarn',
      expected: ['npx tldr yarn', 'npx tldr *', 'npx *'],
    },
    {
      input: 'aws --version',
      expected: ['aws --version', 'aws *'],
    },
    {
      input: 'aws s3 ls',
      expected: ['aws s3 ls', 'aws s3 *', 'aws *'],
    },
    {
      input: 'aws s3 ls --region us-east-1',
      expected: [
        'aws s3 ls --region us-east-1',
        'aws s3 ls *',
        'aws s3 *',
        'aws *',
      ],
    },
    {
      input: './script.sh a',
      expected: ['./script.sh a', './script.sh *'],
    },
    {
      input: 'git commit -m "primer commit"',
      expected: ['git commit -m "primer commit"', 'git commit *', 'git *'],
    },
    {
      input: 'FOO=1 npm run build',
      expected: ['FOO=1 npm run build', 'npm run *', 'npm *'],
    },
    {
      input: 'sudo apt install x',
      expected: ['sudo apt install x', 'sudo apt install *', 'sudo apt *'],
    },
    {
      input: 'env FOO=1 node a.js',
      expected: ['env FOO=1 node a.js'],
    },
    {
      input: 'ls',
      expected: ['ls'],
    },
    {
      input: 'echo hi > out.txt',
      expected: ['echo hi > out.txt', 'echo *'],
    },
    {
      input: 'kubectl get pods a b',
      expected: [
        'kubectl get pods a b',
        'kubectl get pods a *',
        'kubectl get pods *',
        'kubectl get *',
      ],
    },
  ]

  it.each(tableCases)('$input', ({ input, expected }) => {
    expect(buildSessionPatterns(input)).toEqual(expected)
  })

  it('handles empty segment gracefully', () => {
    expect(buildSessionPatterns('')).toEqual([''])
    expect(buildSessionPatterns('   ')).toEqual([''])
  })

  it('caps at 3 most specific wildcard patterns', () => {
    const patterns = buildSessionPatterns('a b c d e f g')
    // exact + 3 wildcards = 4 patterns
    expect(patterns).toEqual([
      'a b c d e f g',
      'a b c d e f *',
      'a b c d e *',
      'a b c d *',
    ])
  })

  it('forbids k=1 for sudo and env variants (basename)', () => {
    expect(buildSessionPatterns('/usr/bin/sudo apt install')).toEqual([
      '/usr/bin/sudo apt install',
      '/usr/bin/sudo apt *',
    ])
    expect(buildSessionPatterns('/usr/bin/env node app.js')).toEqual([
      '/usr/bin/env node app.js',
      '/usr/bin/env node *',
    ])
    expect(buildSessionPatterns('sudo service nginx restart')).toEqual([
      'sudo service nginx restart',
      'sudo service nginx *',
      'sudo service *',
    ])
  })
})
