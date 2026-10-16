import {
  extractArgv,
  buildSessionPatterns,
  stripEnvPrefix,
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
    expect(extractArgv('echo hi >&2')).toEqual(['echo', 'hi'])
    expect(extractArgv('echo hi >&-')).toEqual(['echo', 'hi'])
    expect(extractArgv('echo hi <&-')).toEqual(['echo', 'hi'])
    expect(extractArgv('echo hi 2>&-')).toEqual(['echo', 'hi'])
    expect(extractArgv('echo hi 0<&-')).toEqual(['echo', 'hi'])
    expect(extractArgv('echo hi <&0')).toEqual(['echo', 'hi'])
    expect(extractArgv('echo hi 0<&1')).toEqual(['echo', 'hi'])
    expect(extractArgv('echo hi >& file')).toEqual(['echo', 'hi'])
    expect(extractArgv('echo hi >&file')).toEqual(['echo', 'hi'])
    expect(extractArgv('echo hi 2>& 1')).toEqual(['echo', 'hi'])
    expect(extractArgv('echo hi >out.txt')).toEqual(['echo', 'hi'])
    expect(extractArgv('echo hi >>out.txt')).toEqual(['echo', 'hi'])
    expect(extractArgv('echo hi 2>err.log')).toEqual(['echo', 'hi'])
    expect(extractArgv('cmd &>out.txt')).toEqual(['cmd'])
    expect(extractArgv('cmd &> out.txt')).toEqual(['cmd'])
    expect(extractArgv('cmd &>> out.txt')).toEqual(['cmd'])
    expect(extractArgv('cmd <in.txt')).toEqual(['cmd'])
    expect(extractArgv('agy --help 2>&1')).toEqual(['agy', '--help'])
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

  it('excludes redirections from wildcard prefix levels', () => {
    expect(buildSessionPatterns('agy --help 2>&1')).toEqual([
      'agy --help 2>&1',
      'agy *',
    ])
    expect(buildSessionPatterns('agy models list 2>&1')).toEqual([
      'agy models list 2>&1',
      'agy models *',
      'agy *',
    ])
    expect(buildSessionPatterns('cmd 2>&1')).toEqual(['cmd 2>&1'])
    expect(buildSessionPatterns('cmd foo 2>&1')).toEqual([
      'cmd foo 2>&1',
      'cmd *',
    ])
    expect(buildSessionPatterns('cmd foo >&2')).toEqual([
      'cmd foo >&2',
      'cmd *',
    ])
    expect(buildSessionPatterns('cmd foo >&-')).toEqual([
      'cmd foo >&-',
      'cmd *',
    ])
    expect(buildSessionPatterns('cmd foo <&0')).toEqual([
      'cmd foo <&0',
      'cmd *',
    ])
    expect(buildSessionPatterns('cmd foo &>file.log')).toEqual([
      'cmd foo &>file.log',
      'cmd *',
    ])
    expect(buildSessionPatterns('cmd foo >& file.log')).toEqual([
      'cmd foo >& file.log',
      'cmd *',
    ])
    const patterns = buildSessionPatterns('agy models list 2>&1')
    expect(patterns.some((p) => p.includes('2>&1 *'))).toBe(false)
    expect(patterns).not.toContain('2>&1 *')
    expect(patterns).not.toContain('2>&1')
  })
})

describe('stripEnvPrefix', () => {
  it('strips a single leading env assignment', () => {
    expect(stripEnvPrefix('PYTHONPATH=. python -m pytest')).toBe(
      'python -m pytest'
    )
    expect(stripEnvPrefix('NODE_ENV=test npm test')).toBe('npm test')
    expect(stripEnvPrefix('FOO=1 ./run.sh')).toBe('./run.sh')
  })

  it('strips multiple leading env assignments', () => {
    expect(stripEnvPrefix('FOO="a b" BAR=1 npm test')).toBe('npm test')
    expect(stripEnvPrefix('A=1 B=2 C=3 cmd arg1 arg2')).toBe('cmd arg1 arg2')
  })

  it('handles quoted env values with spaces and special characters', () => {
    expect(stripEnvPrefix('FOO="hello world" cmd arg')).toBe('cmd arg')
    expect(stripEnvPrefix('FOO=\'hello world\' BAR="1 2" cmd')).toBe('cmd')
    expect(stripEnvPrefix('PATH="/custom/bin:$PATH" myapp')).toBe('myapp')
  })

  it('returns bare env assignment intact when there is no following command', () => {
    expect(stripEnvPrefix('FOO=bar')).toBe('FOO=bar')
    expect(stripEnvPrefix('FOO="bar baz"')).toBe('FOO="bar baz"')
    expect(stripEnvPrefix('FOO=1 BAR=2')).toBe('FOO=1 BAR=2')
  })

  it('returns command intact when index 0 is not an env assignment', () => {
    expect(stripEnvPrefix('python -m pytest')).toBe('python -m pytest')
    expect(stripEnvPrefix('npm test')).toBe('npm test')
    expect(stripEnvPrefix('git commit -m "FOO=bar"')).toBe(
      'git commit -m "FOO=bar"'
    )
  })

  it('preserves quotes and arguments intact after stripping env prefixes', () => {
    expect(
      stripEnvPrefix('FOO=1 python -c "import sys; print(sys.path)"')
    ).toBe('python -c "import sys; print(sys.path)"')
  })

  it('handles empty and whitespace-only strings gracefully', () => {
    expect(stripEnvPrefix('')).toBe('')
    expect(stripEnvPrefix('   ')).toBe('')
  })
})
