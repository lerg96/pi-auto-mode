import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative, normalize, resolve, sep } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { parseConfig } from '../../src/types/config.ts'
import { normalizeToolCall } from '../../src/gate/normalize.ts'
import {
  evaluateExternalDirectory,
  externalScopeAppliesTo,
  extractBashPaths,
  isOutsideCwd,
  resolveFsPath,
} from '../../src/permission/external-directory.ts'

const cwd = process.cwd()
const outside = (name: string): string => resolve(cwd, '..', name)
const inside = (...parts: string[]): string => join(cwd, ...parts)

function cfgWith(raw: unknown): ReturnType<typeof parseConfig> {
  return parseConfig(raw)
}

describe('externalDirectoryTools (qué tools pasa por la capa)', () => {
  const abs = outside('probe.txt')
  const intents: Array<{ surface: string; value: string }> = [
    { surface: 'fs', value: abs },
  ]

  it("default ['*'] → se valida cualquier tool", () => {
    const cfg = cfgWith({ confineToWorkingDirectory: true })
    expect(
      evaluateExternalDirectory(cfg, intents, { toolName: 'read' })?.action
    ).toBe('ask')
    expect(
      evaluateExternalDirectory(cfg, intents, { toolName: 'write' })?.action
    ).toBe('ask')
  })

  it('tool fuera de la lista → sin opinión, aunque toque fuera de cwd', () => {
    const cfg = cfgWith({
      confineToWorkingDirectory: true,
      externalDirectoryTools: ['write'],
    })
    // `read` no está: la capa opina undefined y el allow de su cascada manda.
    expect(
      evaluateExternalDirectory(cfg, intents, { toolName: 'read' })
    ).toBeUndefined()
    expect(
      evaluateExternalDirectory(cfg, intents, { toolName: 'write' })?.action
    ).toBe('ask')
  })

  it('sin toolName → se valida: un olvido no apaga la capa', () => {
    const cfg = cfgWith({
      confineToWorkingDirectory: true,
      externalDirectoryTools: ['write'],
    })
    expect(evaluateExternalDirectory(cfg, intents)?.action).toBe('ask')
  })

  it('[] → la capa queda apagada para todas las tools', () => {
    const cfg = cfgWith({
      confineToWorkingDirectory: true,
      externalDirectoryTools: [],
    })
    expect(
      evaluateExternalDirectory(cfg, intents, { toolName: 'write' })
    ).toBeUndefined()
  })

  it('acepta globs sobre el nombre de la tool', () => {
    const cfg = cfgWith({
      confineToWorkingDirectory: true,
      externalDirectoryTools: ['mcp__*'],
    })
    expect(
      evaluateExternalDirectory(cfg, intents, { toolName: 'mcp__drive__ls' })
        ?.action
    ).toBe('ask')
    expect(
      evaluateExternalDirectory(cfg, intents, { toolName: 'bash' })
    ).toBeUndefined()
  })

  it('externalScopeAppliesTo decide sin calcular paths', () => {
    const cfg = cfgWith({ externalDirectoryTools: ['bash', 'write'] })
    expect(externalScopeAppliesTo(cfg, 'bash')).toBe(true)
    expect(externalScopeAppliesTo(cfg, 'read')).toBe(false)
    expect(externalScopeAppliesTo(cfg, undefined)).toBe(true)
  })
})

describe('external_directory scope', () => {
  it('flag off → undefined even for outside paths', () => {
    const cfg = cfgWith({ permissions: { tools: { read: 'allow' } } })
    expect(
      evaluateExternalDirectory(cfg, [
        { surface: 'fs', value: outside('x.txt') },
      ])
    ).toBeUndefined()
  })

  it('internal path → undefined', () => {
    const cfg = cfgWith({
      confineToWorkingDirectory: true,
      permissions: { tools: { read: 'allow' } },
    })
    expect(
      evaluateExternalDirectory(cfg, [
        { surface: 'fs', value: inside('src', 'index.ts') },
      ])
    ).toBeUndefined()
  })

  it('external path with no match → default ask with path + reason data', () => {
    const cfg = cfgWith({
      confineToWorkingDirectory: true,
      permissions: { tools: { read: 'allow' } },
    })
    const abs = outside('probe.txt')
    const verdict = evaluateExternalDirectory(cfg, [
      { surface: 'fs', value: abs },
    ])
    expect(verdict).toBeDefined()
    expect(verdict?.action).toBe('ask')
    expect(verdict?.absPath).toBe(abs)
  })

  it('explicit allow / deny / ask win', () => {
    const abs = outside('probe.txt')
    for (const action of ['allow', 'deny', 'ask'] as const) {
      const cfg = cfgWith({
        confineToWorkingDirectory: true,
        permissions: {
          tools: { read: 'allow' },
          external_directory: { '*': action },
        },
      })
      const verdict = evaluateExternalDirectory(cfg, [
        { surface: 'fs', value: abs },
      ])
      expect(verdict?.action).toBe(action)
      expect(verdict?.pattern).toBe('*')
      expect(verdict?.absPath).toBe(abs)
    }
  })

  it('last match wins across sources and within a map', () => {
    const abs = outside('probe.txt')
    const cfg = cfgWith({
      confineToWorkingDirectory: true,
      permissions: {
        tools: { read: 'allow' },
        external_directory: { '*': 'allow' },
      },
      permissionSets: {
        s1: { permissions: { external_directory: { '*': 'deny' } } },
      },
      activePermissionSets: ['s1'],
    })
    expect(
      evaluateExternalDirectory(cfg, [{ surface: 'fs', value: abs }])?.action
    ).toBe('deny')

    const cfg2 = cfgWith({
      confineToWorkingDirectory: true,
      permissions: {
        tools: { read: 'allow' },
        external_directory: { [resolve(cwd, '..', '*')]: 'deny', '*': 'allow' },
      },
    })
    const v2 = evaluateExternalDirectory(cfg2, [{ surface: 'fs', value: abs }])
    expect(v2?.action).toBe('allow')
    expect(v2?.pattern).toBe('*')
  })

  it('bash extraction: skips flags/URLs, expands ~, ignores bare words', () => {
    expect(extractBashPaths('ls -la /tmp')).toEqual(['/tmp'])
    expect(extractBashPaths('curl https://example.com/x')).toEqual([])
    expect(extractBashPaths('echo hello')).toEqual([])
    expect(extractBashPaths('cat "my docs/a.txt"')).toEqual(['my docs/a.txt'])
    const home = extractBashPaths('cat ~/notes.txt')
    expect(home).toEqual(['~/notes.txt'])
    expect(resolveFsPath(home[0] as string, cwd)).toBe(
      join(homedir(), 'notes.txt')
    )
  })

  it('shell intent with outside path → ask; internal-only → undefined', () => {
    const cfg = cfgWith({
      confineToWorkingDirectory: true,
      permissions: { tools: { bash: 'allow' } },
    })
    const v = evaluateExternalDirectory(cfg, [
      { surface: 'shell', value: `cat ${outside('a.txt')}` },
    ])
    expect(v?.action).toBe('ask')
    expect(v?.absPath).toBe(outside('a.txt'))
    expect(
      evaluateExternalDirectory(cfg, [
        { surface: 'shell', value: 'cat src/index.ts' },
      ])
    ).toBeUndefined()
  })

  it("fs '*' sentinel is skipped; custom surfaces are skipped", () => {
    const cfg = cfgWith({
      confineToWorkingDirectory: true,
      permissions: { tools: { read: 'allow' } },
    })
    expect(
      evaluateExternalDirectory(cfg, [{ surface: 'fs', value: '*' }])
    ).toBeUndefined()
    expect(
      evaluateExternalDirectory(cfg, [
        { surface: 'agent_send_message', value: '/etc/passwd' },
      ])
    ).toBeUndefined()
  })

  it('isOutsideCwd: cwd itself and children are inside', () => {
    expect(isOutsideCwd(cwd, cwd)).toBe(false)
    expect(isOutsideCwd(inside('a', 'b.txt'), cwd)).toBe(false)
    expect(isOutsideCwd(outside('x.txt'), cwd)).toBe(true)
  })

  it('tilde globs match resolved absolute paths', () => {
    // `~/../tilde-probe.txt` resolves outside cwd (parent of $HOME).
    const probe = join(homedir(), '..', 'tilde-probe.txt')
    const abs = resolveFsPath(probe, cwd)
    expect(isOutsideCwd(abs, cwd)).toBe(true)
    const cfg = cfgWith({
      confineToWorkingDirectory: true,
      permissions: {
        tools: { read: 'allow' },
        // NOTE: plain string concat — path.join would normalize `..` away
        // and eat the `~` prefix under test.
        external_directory: {
          [['~', '..', 'tilde-probe.txt'].join(sep)]: 'deny',
        },
      },
    })
    const verdict = evaluateExternalDirectory(cfg, [
      { surface: 'fs', value: probe },
    ])
    expect(verdict?.action).toBe('deny')
    expect(verdict?.absPath).toBe(abs)
  })

  it('absPath names the path that matched, not just the first outside one', () => {
    const first = outside('a.txt')
    const second = outside('b.txt')
    const cfg = cfgWith({
      confineToWorkingDirectory: true,
      permissions: {
        tools: { read: 'allow' },
        external_directory: { [second]: 'deny' },
      },
    })
    const verdict = evaluateExternalDirectory(cfg, [
      { surface: 'fs', value: first },
      { surface: 'fs', value: second },
    ])
    expect(verdict?.action).toBe('deny')
    expect(verdict?.pattern).toBe(second)
    expect(verdict?.absPath).toBe(second)
  })

  it('msys drive paths (/c/...) resolve to the drive (win32)', () => {
    const got = resolveFsPath(
      '/c/Users/test-user/personal-server-instance',
      cwd
    )
    if (process.platform === 'win32') {
      expect(got).toBe(normalize('C:/Users/test-user/personal-server-instance'))
    } else {
      // POSIX: /c/... is a legitimate absolute path, left untouched.
      expect(got).toBe(normalize('/c/Users/test-user/personal-server-instance'))
    }
  })

  it('non-drive slash paths (/cmd/...) are left untouched', () => {
    expect(resolveFsPath('/cmd/x', cwd)).toBe(normalize('/cmd/x'))
  })

  it('msys path inside cwd is not external (win32)', () => {
    // Vacuous pass on POSIX (no drive letters there by design).
    if (process.platform !== 'win32') return
    const drive = cwd.slice(0, 1).toLowerCase()
    const rest = cwd.slice(2).replace(/\\/g, '/')
    const msys = `/${drive}${rest}/probe.txt`
    const cfg = cfgWith({
      confineToWorkingDirectory: true,
      permissions: { tools: { read: 'allow' } },
    })
    expect(
      evaluateExternalDirectory(cfg, [{ surface: 'fs', value: msys }])
    ).toBeUndefined()
  })

  it('device sinks are not external: /dev/null (any platform)', () => {
    const cfg = cfgWith({
      confineToWorkingDirectory: true,
      permissions: { tools: { bash: 'allow', read: 'allow' } },
    })
    // The reported case: `>/dev/null` must not produce a verdict.
    expect(
      evaluateExternalDirectory(cfg, [
        { surface: 'shell', value: 'pgrep -f x >/dev/null && echo done' },
      ])
    ).toBeUndefined()
    expect(
      evaluateExternalDirectory(cfg, [{ surface: 'fs', value: '/dev/null' }])
    ).toBeUndefined()
    expect(extractBashPaths('cat /dev/null')).toEqual([])
  })

  it('win32 reserves: /dev/* blanket and DOS devices (NUL)', () => {
    // Vacuous pass on POSIX (no drive letters/devices there by design).
    if (process.platform !== 'win32') return
    const cfg = cfgWith({
      confineToWorkingDirectory: true,
      permissions: { tools: { bash: 'allow', read: 'allow' } },
    })
    expect(extractBashPaths('cat /dev/stderr')).toEqual([])
    expect(
      evaluateExternalDirectory(cfg, [{ surface: 'fs', value: 'NUL' }])
    ).toBeUndefined()
    expect(
      evaluateExternalDirectory(cfg, [{ surface: 'fs', value: 'nul.txt' }])
    ).toBeUndefined()
  })

  it('escape debris is not a path: lone \\n from dequoted scripts', () => {
    expect(extractBashPaths('echo \\n')).toEqual([])
  })

  it('default-ask reason names the real target, not soup debris', () => {
    const target = outside('f.patch')
    const cfg = cfgWith({
      confineToWorkingDirectory: true,
      permissions: { tools: { bash: 'allow' } },
    })
    const verdict = evaluateExternalDirectory(cfg, [
      {
        surface: 'shell',
        value: `node -e "x" && echo '\\n' && git apply --cached ${target}`,
      },
    ])
    expect(verdict?.action).toBe('ask')
    expect(verdict?.absPath).toBe(normalize(target))
  })

  it('win32 cmd flags are not paths: lone /X skipped in shell, kept on posix', () => {
    const toks = extractBashPaths('dir /b src')
    if (process.platform === 'win32') expect(toks).toEqual([])
    else expect(toks).toEqual(['/b'])
  })

  it('quoted pure globs are pattern debris, not paths', () => {
    expect(extractBashPaths('echo "\\*"')).toEqual([])
  })

  it('unquoted root globs still count (fail-closed: del \\*)', () => {
    expect(extractBashPaths('del \\*')).toEqual(['\\*'])
  })

  it('no spurious ask for win32 flag-only commands inside cwd', () => {
    const cfg = cfgWith({
      confineToWorkingDirectory: true,
      permissions: { tools: { bash: 'allow' } },
    })
    const verdict = evaluateExternalDirectory(cfg, [
      { surface: 'shell', value: `dir /b ${inside('f.txt')}` },
    ])
    if (process.platform === 'win32') expect(verdict).toBeUndefined()
    else expect(verdict?.action).toBe('ask')
  })

  it('shredded sed expressions are not paths: brace-leading fragments skipped', () => {
    // as the gate sees it (quotes stripped upstream, spaces split it)
    const toks = extractBashPaths(
      'sed -i s/\\.first {/.awaitFirst {/g app/x.kt'
    )
    // inside-relative tokens still extract (extraction != verdict);
    // the brace debris ({/.awaitFirst) and /g (win32 flag) must not
    if (process.platform === 'win32')
      expect(toks).toEqual(['s/\\.first', 'app/x.kt'])
    else expect(toks).toEqual(['s/\\.first', '/g', 'app/x.kt'])
  })

  it('no spurious ask for in-cwd sed expression (reported case shape)', () => {
    const cfg = cfgWith({
      confineToWorkingDirectory: true,
      permissions: { tools: { bash: 'allow' } },
    })
    const verdict = evaluateExternalDirectory(cfg, [
      {
        surface: 'shell',
        value: `sed -i s/\\.first {/.awaitFirst {/g ${inside('Test.kt')}`,
      },
    ])
    if (process.platform === 'win32') expect(verdict).toBeUndefined()
    else expect(verdict?.action).toBe('ask')
  })

  it('bare slash runs are regex debris, not paths (grep "//")', () => {
    expect(extractBashPaths('grep "//"')).toEqual([])
  })

  it('single slash still counts (root listing asks)', () => {
    expect(extractBashPaths('ls /')).toEqual(['/'])
  })

  it('no spurious ask for piped slash-slash search (reported case)', () => {
    const cfg = cfgWith({
      confineToWorkingDirectory: true,
      permissions: { tools: { bash: 'allow' } },
    })
    const verdict = evaluateExternalDirectory(cfg, [
      { surface: 'shell', value: 'rg -n "a|b" f.kt | grep "//"' },
    ])
    expect(verdict).toBeUndefined()
  })

  it('rooted regex debris skipped, real rooted paths kept', () => {
    // shredded `rg "\.dp|…"` / backrefs — not paths
    expect(extractBashPaths('rg -n \\.dp|import f.kt')).toEqual([])
    expect(extractBashPaths('x \\4 y')).toEqual([])
    // lone backslash (drive root) and real rooted paths still count
    expect(extractBashPaths('cd \\')).toEqual(['\\'])
    expect(extractBashPaths('ls \\tmp\\x')).toEqual(['\\tmp\\x'])
  })

  it('no spurious ask for shredded rg alternation (reported case shape)', () => {
    const cfg = cfgWith({
      confineToWorkingDirectory: true,
      permissions: { tools: { bash: 'allow' } },
    })
    const verdict = evaluateExternalDirectory(cfg, [
      {
        surface: 'shell',
        value: `rg -n \\.dp|import ${inside('C.kt')}`,
      },
    ])
    expect(verdict).toBeUndefined()
  })

  it('bare lowercase drive is loop-variable debris, uppercase still counts', () => {
    // `for p in …:` / `not in p:` — the reported `p:/` false positive
    expect(extractBashPaths('if x not in p: continue')).toEqual([])
    expect(extractBashPaths('del D:')).toEqual(['D:'])
  })

  it('no spurious ask for python loop over results (reported case shape)', () => {
    const cfg = cfgWith({
      confineToWorkingDirectory: true,
      permissions: { tools: { bash: 'allow' } },
    })
    const verdict = evaluateExternalDirectory(cfg, [
      {
        surface: 'shell',
        value: `for p in glob.glob('x/*.xml'): parse(${inside('a.txt')})`,
      },
    ])
    expect(verdict).toBeUndefined()
  })

  it('one allowed path does not whitelist other outside paths', () => {
    const allowedDir = resolve(cwd, '..', 'allowed')
    const allowedFile = join(allowedDir, 'a.txt')
    const secret = outside('secret.txt')
    const cfg = cfgWith({
      confineToWorkingDirectory: true,
      permissions: {
        tools: { bash: 'allow' },
        external_directory: { [join(allowedDir, '*')]: 'allow' },
      },
    })
    const verdict = evaluateExternalDirectory(cfg, [
      { surface: 'shell', value: `cat ${allowedFile} ${secret}` },
    ])
    expect(verdict?.action).toBe('ask')
    expect(verdict?.absPath).toBe(secret)
  })

  it('allowed paths never pollute the reported target', () => {
    const allowedDir = resolve(cwd, '..', 'allowed')
    const allowedFile = join(allowedDir, 'a.txt')
    const cfg = cfgWith({
      confineToWorkingDirectory: true,
      permissions: {
        tools: { bash: 'allow' },
        external_directory: { [join(allowedDir, '*')]: 'allow' },
      },
    })
    expect(
      evaluateExternalDirectory(cfg, [
        { surface: 'shell', value: `cat ${allowedFile}` },
      ])?.action
    ).toBe('allow')
  })

  it('verdict names the triggering intent, not the first', () => {
    const cfg = cfgWith({
      confineToWorkingDirectory: true,
      permissions: { tools: { bash: 'allow' } },
    })
    const verdict = evaluateExternalDirectory(cfg, [
      { surface: 'shell', value: 'git add a.txt' },
      { surface: 'shell', value: 'cd /tmp/uicheck' },
    ])
    expect(verdict?.action).toBe('ask')
    expect(verdict?.matchedValue).toBe('cd /tmp/uicheck')
    expect(verdict?.matchedSurface).toBe('shell')
  })

  it('no spurious ask for sed-with-space pipeline (reported LOOP shape)', () => {
    // `sed "s/^/LOOP$i: /"` — the space inside the quoted expression must
    // not shred into a lone `/` token (quote-aware segments, a654ffa).
    const cfg = cfgWith({
      confineToWorkingDirectory: true,
      permissions: { tools: { bash: 'allow' } },
    })
    const intents = normalizeToolCall('bash', {
      command:
        'for i in 1 2; do ./gradlew :app:x 2>&1 | rg "BUILD (SUCCESS|FAILED)" | tail -n 1 | sed "s/^/LOOP$i: /"; done (timeout 1200s)',
    })
    expect(evaluateExternalDirectory(cfg, intents)).toBeUndefined()
  })

  it('lone slash after sed head is debris; real root and s/a path kept', () => {
    expect(extractBashPaths('sed s/^/LOOP1: /')).toEqual(['s/^/LOOP1:'])
    expect(extractBashPaths('ls s/a /')).toEqual(['s/a', '/'])
  })
})

describe('external_directory × git worktrees', () => {
  // Real fixtures on disk: the scope reads the worktree registry from the
  // filesystem, so these cannot be pure in-memory paths. Layout mirrors Git
  // for Windows: <repo>/.git/worktrees/<id>/gitdir + <wt>/.git back-pointer.
  const tmp = mkdtempSync(join(tmpdir(), 'pi-am-extwt-'))

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  function repoWithWorktree(name: string): {
    repo: string
    wt: string
    unrelated: string
  } {
    const repo = join(tmp, name)
    const gitDir = join(repo, '.git')
    mkdirSync(join(gitDir, 'worktrees', 'feat'), { recursive: true })
    writeFileSync(join(gitDir, 'HEAD'), 'ref: refs/heads/main\n')
    const wt = join(tmp, `${name}-wt`)
    mkdirSync(wt, { recursive: true })
    const idDir = join(gitDir, 'worktrees', 'feat')
    writeFileSync(join(idDir, 'gitdir'), `${wt}${sep}.git\n`)
    writeFileSync(join(idDir, 'commondir'), `${gitDir}\n`)
    writeFileSync(join(wt, '.git'), `gitdir: ${idDir}\n`)
    const unrelated = join(tmp, `${name}-elsewhere`, 'secret.txt')
    return { repo, wt, unrelated }
  }

  it('fs intent inside a registered worktree → allow, flagged viaWorktree', () => {
    const { repo, wt } = repoWithWorktree('allow')
    const cfg = cfgWith({
      confineToWorkingDirectory: true,
      permissions: { tools: { write: 'ask' } },
    })
    const verdict = evaluateExternalDirectory(
      cfg,
      [{ surface: 'fs', value: join(wt, 'src', 'a.ts') }],
      { cwd: repo }
    )
    expect(verdict?.action).toBe('allow')
    expect(verdict?.viaWorktree).toBe(true)
  })

  it('relative shell intent resolving into the worktree → allow', () => {
    const { repo, wt } = repoWithWorktree('relshell')
    const cfg = cfgWith({
      confineToWorkingDirectory: true,
      permissions: { tools: { bash: 'allow' } },
    })
    const rel = relative(repo, join(wt, 'file.txt'))
    const verdict = evaluateExternalDirectory(
      cfg,
      [{ surface: 'shell', value: `echo hi > ${rel}` }],
      { cwd: repo }
    )
    expect(verdict?.action).toBe('allow')
    expect(verdict?.viaWorktree).toBe(true)
  })

  it('trustGitWorktrees: false → the worktree is external again', () => {
    const { repo, wt } = repoWithWorktree('optout')
    const cfg = cfgWith({
      confineToWorkingDirectory: true,
      trustGitWorktrees: false,
      permissions: { tools: { write: 'ask' } },
    })
    const verdict = evaluateExternalDirectory(
      cfg,
      [{ surface: 'fs', value: join(wt, 'a.ts') }],
      { cwd: repo }
    )
    expect(verdict?.action).toBe('ask')
    expect(verdict?.viaWorktree).toBeUndefined()
  })

  it('explicit deny on the worktree path wins over worktree trust', () => {
    const { repo, wt } = repoWithWorktree('deny')
    const cfg = cfgWith({
      confineToWorkingDirectory: true,
      permissions: {
        tools: { write: 'ask' },
        external_directory: { [join(wt, '**')]: 'deny' },
      },
    })
    const verdict = evaluateExternalDirectory(
      cfg,
      [{ surface: 'fs', value: join(wt, 'a.ts') }],
      { cwd: repo }
    )
    expect(verdict?.action).toBe('deny')
    expect(verdict?.absPath).toBe(join(wt, 'a.ts'))
  })

  it('explicit ask on the worktree path still asks', () => {
    const { repo, wt } = repoWithWorktree('ask')
    const cfg = cfgWith({
      confineToWorkingDirectory: true,
      permissions: {
        tools: { write: 'ask' },
        external_directory: { [join(wt, '**')]: 'ask' },
      },
    })
    const verdict = evaluateExternalDirectory(
      cfg,
      [{ surface: 'fs', value: join(wt, 'a.ts') }],
      { cwd: repo }
    )
    expect(verdict?.action).toBe('ask')
  })

  it('`.git` metadata of a worktree is not covered by trust', () => {
    const { repo, wt } = repoWithWorktree('gitmeta')
    const cfg = cfgWith({
      confineToWorkingDirectory: true,
      permissions: { tools: { write: 'ask' } },
    })
    const verdict = evaluateExternalDirectory(
      cfg,
      [{ surface: 'fs', value: join(wt, '.git', 'hooks', 'pre-commit') }],
      { cwd: repo }
    )
    expect(verdict?.action).toBe('ask')
  })

  it('a trusted worktree never whitelists a second, unrelated path', () => {
    const { repo, wt, unrelated } = repoWithWorktree('mixed')
    const cfg = cfgWith({
      confineToWorkingDirectory: true,
      permissions: { tools: { bash: 'allow' } },
    })
    const verdict = evaluateExternalDirectory(
      cfg,
      [
        { surface: 'fs', value: join(wt, 'a.ts') },
        { surface: 'fs', value: unrelated },
      ],
      { cwd: repo }
    )
    expect(verdict?.action).toBe('ask')
    expect(verdict?.absPath).toBe(unrelated)
  })

  it('worktree deleted after registration (stale) → ask again', () => {
    const { repo, wt } = repoWithWorktree('stale')
    const cfg = cfgWith({
      confineToWorkingDirectory: true,
      permissions: { tools: { write: 'ask' } },
    })
    rmSync(wt, { recursive: true, force: true })
    const verdict = evaluateExternalDirectory(
      cfg,
      [{ surface: 'fs', value: join(wt, 'a.ts') }],
      { cwd: repo }
    )
    expect(verdict?.action).toBe('ask')
  })

  it('main-checkout paths outside a subdirectory cwd are trusted', () => {
    const { repo } = repoWithWorktree('subcwd')
    const cwd = join(repo, 'packages', 'app')
    mkdirSync(cwd, { recursive: true })
    const cfg = cfgWith({
      confineToWorkingDirectory: true,
      permissions: { tools: { write: 'ask' } },
    })
    const verdict = evaluateExternalDirectory(
      cfg,
      [{ surface: 'fs', value: join(repo, 'README.md') }],
      { cwd: cwd }
    )
    expect(verdict?.action).toBe('allow')
    expect(verdict?.viaWorktree).toBe(true)
  })

  it('no repository at cwd → unchanged default ask', () => {
    const bare = join(tmp, 'norepo')
    mkdirSync(bare, { recursive: true })
    const cfg = cfgWith({
      confineToWorkingDirectory: true,
      permissions: { tools: { write: 'ask' } },
    })
    const verdict = evaluateExternalDirectory(
      cfg,
      [{ surface: 'fs', value: join(tmp, 'somewhere-else.txt') }],
      { cwd: bare }
    )
    expect(verdict?.action).toBe('ask')
  })
})
