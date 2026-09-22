// Test mirror of src/classifier/block-rules.ts.
//
// block-rules.ts is a pure dataset (DEFAULT_BLOCK_RULES); its security value
// only materializes through PatternMatcher (the same matcher the rule
// evaluator feeds to `evaluateBlockRules`). These tests therefore pin each
// rule's REAL matching behavior — positives, near-misses, adversarial
// variants — by running DEFAULT_BLOCK_RULES through PatternMatcher.
//
// Note on quoted data: PatternMatcher treats input as opaque text, so
// `echo "rm -rf"` matches at this level. Deciding data-vs-execution is the
// rule-evaluator's job (its own suite covers that); over-match pins marked
// "[matcher-level]" below do NOT imply the evaluator blocks the command.

import { DEFAULT_BLOCK_RULES } from '../../src/classifier/block-rules.ts'
import type { BlockRule, Severity } from '../../src/classifier/block-rules.ts'
import { PatternMatcher } from '../../src/classifier/pattern-matcher.ts'

const matcher = new PatternMatcher()

function ruleById(id: string): BlockRule {
  const rule = DEFAULT_BLOCK_RULES.find((r) => r.id === id)
  if (!rule) throw new Error(`rule ${id} not found`)
  return rule
}

/** Ids of every rule whose pattern matches `text` (default list order). */
function hitIds(
  text: string,
  rules: BlockRule[] = DEFAULT_BLOCK_RULES
): string[] {
  return rules.filter((r) => matcher.match(r.pattern, text)).map((r) => r.id)
}

const KNOWN_SEVERITIES: Severity[] = [
  'critical',
  'high',
  'medium',
  'low',
  'soft',
]

const KNOWN_CATEGORIES = [
  'destruction',
  'system-config',
  'security',
  'execution',
  'network-db',
  'vcs',
  'cloud',
  'system-admin',
]

interface RuleCase {
  /** Inputs that MUST trigger this rule. */
  mustBlock: string[]
  /** Near-miss inputs that must NOT trigger this rule. */
  nearMiss: string[]
  /** Inputs that DO trigger the rule but arguably should not (pinned behavior). */
  overMatch?: string[]
}

// One behavioral case per rule id. Every rule id in DEFAULT_BLOCK_RULES must
// appear here (enforced by the coverage test at the bottom).
const MATRIX: Record<string, RuleCase> = {
  // ── Destruction ──────────────────────────────────────────────
  'BR-001': {
    mustBlock: [
      'rm -rf ./dir',
      'RM -RF /tmp', // case-insensitive
      'sudo rm -rf /', // wrapper prefix, still contains 'rm -rf'
      // FIXED GAP (whitespace normalization): a double space used to evade
      // the literal; matching is now matches(raw) || matches(collapsed(raw)).
      'rm  -rf /',
    ],
    nearMiss: ['rm -r ./tmp', 'rm -f file.txt', 'rmdir build'],
    overMatch: [
      // [matcher-level] quoted data; rule-evaluator skips quoted segments.
      'echo "rm -rf"',
    ],
  },
  'BR-002': {
    mustBlock: ['rm -fr .'],
    nearMiss: ['rm -r --force .', 'rm -rf ./dir'], // '-fr' vs '-rf'/'--force'
  },
  'BR-003': {
    mustBlock: ['docker rm -f mycontainer'],
    nearMiss: [
      'docker rm mycontainer',
      // SUSPECTED GAP: `docker rmi -f` (force-remove image) evades.
      'docker rmi -f img',
    ],
  },
  'BR-004': {
    mustBlock: ['docker system prune -f'],
    nearMiss: [
      'docker system prune',
      // '--volumes' without '-f' evades (still destructive once confirmed).
      'docker system prune --volumes',
    ],
  },
  'BR-005': {
    mustBlock: ['dd if=/dev/zero of=/dev/sda bs=1M'],
    nearMiss: ['dd bs=1M', 'dd --help'],
  },
  'BR-006': {
    mustBlock: ['mkfs.ext4 /dev/sdb1'],
    nearMiss: ['fsck -y /mnt/data'],
    overMatch: [
      // Substring: any filename containing 'mkfs' matches.
      'touch my-mkfs-helper.sh',
    ],
  },
  'BR-007': {
    mustBlock: ['ls build | xargs rm'],
    nearMiss: ["xargs -n1 echo 'hi'"],
  },
  'BR-008': {
    mustBlock: ['find /var -delete'],
    nearMiss: [
      "find . -name '*.tmp'",
      // SUSPECTED GAP: the glob is anchored at both ends, so trailing
      // arguments after '-delete' evade.
      'find . -delete extra',
    ],
  },

  // ── System config ────────────────────────────────────────────
  'BR-009': {
    mustBlock: [
      'sudo systemctl restart nginx',
      'SUDO LS',
      // Trailing-space pattern: extra spaces after sudo still match here.
      'sudo  apt update',
      // FIXED GAP (whitespace normalization): a tab after sudo used to evade.
      'sudo\tapt update',
    ],
    nearMiss: [
      // SUSPECTED GAP: 'sudoedit' is not caught (no trailing-space match).
      'sudoedit file.txt',
    ],
  },
  'BR-010': {
    mustBlock: ['sudo chmod u+s /usr/bin/foo'],
    nearMiss: ['chmod u+x f'], // chmod without sudo: no BR-010 hit
  },
  'BR-011': {
    mustBlock: ['chmod 777 /tmp/dir'],
    nearMiss: [
      'chmod 644 app.sh',
      // SUSPECTED GAP: octal leading zero evades the literal.
      'chmod 0777 /tmp/dir',
    ],
  },
  'BR-012': {
    mustBlock: ['chmod -R 755 ./node_modules'],
    nearMiss: [
      'chmod 644 app.sh',
      // SUSPECTED GAP: long flag evades the '-R' literal.
      'chmod --recursive 755 ./dir',
    ],
  },
  'BR-013': {
    mustBlock: ['chown -R www-data:www-data /var/www'],
    nearMiss: ['chown user:user file.txt', 'chown --recursive user:user ./dir'],
  },
  'BR-014': {
    mustBlock: [
      'systemctl restart nginx',
      // FIXED GAP (whitespace normalization): double space used to evade.
      'systemctl  restart nginx',
    ],
    nearMiss: ['systemctl status nginx'],
  },
  'BR-015': {
    mustBlock: ['systemctl stop nginx'],
    nearMiss: ['systemctl start nginx', 'systemctl status nginx'],
  },
  'BR-016': {
    mustBlock: ['systemctl disable nginx'],
    nearMiss: ['systemctl enable nginx', 'systemctl status nginx'],
  },
  'BR-017': {
    mustBlock: ['cat /etc/shadow'],
    nearMiss: ['cat etc/passwd'], // relative 'etc/' without leading slash
    overMatch: [
      // Any embedded '/etc/' path segment matches, vendored dirs included.
      'cat ./vendor/etc/settings.conf',
      'ls /var/etc/x',
    ],
  },

  // ── Security / credentials ───────────────────────────────────
  'BR-018': {
    mustBlock: ['cat ~/.ssh/id_rsa'],
    nearMiss: [
      // SUSPECTED GAP (severity=critical): only the literal '~/.ssh/' form
      // matches; absolute or relative .ssh paths evade this rule. The
      // hardcoded trust boundary in rule-evaluator uses the same literal,
      // so it shares the gap.
      'less /root/.ssh/config',
      'cp .ssh/id_rsa /tmp',
    ],
  },
  'BR-019': {
    mustBlock: ['cat ~/.env'],
    nearMiss: [
      // Bare relative '.env' is not BR-019 (it is BR-054, by design).
      'cat .env',
    ],
  },
  'BR-054': {
    mustBlock: ['cat .env', 'cat .env.production', 'ls .env.bak'],
    nearMiss: ['cat config/settings.json', '/usr/bin/env python3'],
    overMatch: [
      // Documented trade-off (fail-closed): any '.env' substring matches.
      'cat .env.example',
      // SUSPECTED over-match: directories merely starting with '.env'.
      'cat .environment/defaults',
    ],
  },
  'BR-020': {
    mustBlock: ['cat ~/.ssh/id_rsa', 'cat id_rsa'],
    nearMiss: [
      'cat report.txt',
      // SUSPECTED GAP: glob is end-anchored, so suffixed key files evade
      // (e.g. backed-up private keys ending in .bak/.old).
      'cat id_rsa.pub',
      'cat .ssh/id_rsa.bak',
      // Glob start-anchor: 'mycat' does not match 'cat ...'.
      'mycat id_rsa',
    ],
  },
  'BR-021': {
    mustBlock: ['echo $DATABASE_URL'],
    nearMiss: [
      'echo hello',
      // SUSPECTED GAP: quoting the expansion evades the 'echo $' literal
      // even though the shell still expands it inside double quotes.
      'echo "$SECRET"',
      "echo '$SECRET'",
    ],
  },
  'BR-022': {
    mustBlock: ['openssl genrsa -out key.pem 2048'],
    nearMiss: [
      // SUSPECTED GAP: trailing-space pattern, bare 'openssl' at end of
      // input evades.
      'openssl',
    ],
  },

  // ── Execution (soft severity) ────────────────────────────────
  'BR-023': {
    mustBlock: [
      // The ONLY shape the anchored glob matches: literal spaces around
      // bare 'import os'. Anything realistic evades — see nearMiss below.
      'python  -c  import os',
    ],
    nearMiss: [
      // SUSPECTED GAP (near-dead rule): quoting is how inline Python is
      // actually written, and quotes break the end-anchored glob; so does
      // the single-space form and 'python3'.
      'python -c "import os"',
      "python -c 'import os'",
      'python -c import os',
      'python3 -c "import os"',
      'python -c "import os; print(1)"',
    ],
  },
  'BR-024': {
    mustBlock: ['subprocess("ls")'],
    nearMiss: [
      // SUSPECTED GAP: literal 'subprocess(' only; the common module-call
      // forms evade (Popen is separately covered by BR-026).
      'subprocess.run(cmd)',
      'subprocess.check_output(cmd)',
    ],
  },
  'BR-025': {
    mustBlock: ['os.system("ls")'],
    nearMiss: [
      // Dot required by the literal '.system('.
      'system("ls")',
    ],
  },
  'BR-026': {
    mustBlock: ['subprocess.Popen(cmd)'],
    nearMiss: ['Popen(cmd)'],
  },
  'BR-027': {
    mustBlock: ['child_process.exec(cmd)'],
    nearMiss: ['exec(cmd)'],
  },
  'BR-028': {
    mustBlock: ["cp.spawn('ls')"],
    nearMiss: ['spawn("ls")'],
  },
  'BR-029': {
    mustBlock: ['child_process.fork(server.js)'],
    nearMiss: ['fork(pid)'],
  },
  'BR-030': {
    mustBlock: [
      // Contrived on purpose: a literal dot directly before 'child_process'
      // essentially never occurs in real code — see nearMiss.
      'vm.child_process',
    ],
    nearMiss: [
      // SUSPECTED GAP (near-dead rule): the canonical import forms do NOT
      // contain the literal '.child_process' and all evade.
      "require('child_process')",
      "require('node:child_process')",
      'import child_process',
    ],
  },

  // ── Network / DB ─────────────────────────────────────────────
  'BR-031': {
    mustBlock: ['iptables -A INPUT -j DROP'],
    nearMiss: ['ip6tables -L', 'ip route show'],
    // NOTE: no arg discrimination — read-only 'iptables -L' also matches.
  },
  'BR-032': {
    mustBlock: ['ufw allow 22'],
    nearMiss: ['grep firewall log'],
    overMatch: [
      // SUSPECTED over-match: 'ufw' inside any word (no boundaries).
      'cp notes/ufw-notes.md backup.md',
    ],
  },
  'BR-033': {
    mustBlock: ['nmap -sV 10.0.0.1'],
    nearMiss: ['portscan.sh'],
    overMatch: ['echo nmap notes'],
  },
  'BR-034': {
    mustBlock: ['DROP TABLE users;', 'Drop Table x'],
    nearMiss: ['select * from users'],
  },
  'BR-035': {
    mustBlock: [
      'DELETE FROM users;',
      // Unlike the literal rules, the regex handles irregular whitespace.
      'delete  from users',
      'DELETE   FROM users',
    ],
    nearMiss: [
      'DELETE FROM users WHERE id=1',
      'delete from users where id=1',
      'select * from users',
    ],
  },
  'BR-036': {
    mustBlock: ['TRUNCATE TABLE users;'],
    nearMiss: [
      // SUSPECTED GAP: trailing-space pattern; 'TRUNCATE' ending the input
      // evades.
      'TRUNCATE',
    ],
    overMatch: [
      // SUSPECTED over-match: coreutils 'truncate' on files matches too.
      'truncate -s 0 empty.txt',
    ],
  },

  // ── VCS ──────────────────────────────────────────────────────
  'BR-037': {
    mustBlock: [
      'git reset --hard HEAD~1',
      // FIXED GAP (whitespace normalization): double space used to evade.
      'git reset  --hard HEAD~1',
    ],
    nearMiss: ['git reset HEAD~1'],
  },
  'BR-038': {
    mustBlock: ['git reset --soft HEAD~1'],
    nearMiss: ['git reset HEAD~1'],
  },
  'BR-039': {
    mustBlock: ['git push --force origin main'],
    nearMiss: [
      'git push origin main',
      // SUSPECTED GAP: remote between push and flag evades.
      'git push origin --force',
    ],
    overMatch: [
      // Pinned: the safer --force-with-lease flow is also caught.
      'git push --force-with-lease origin main',
    ],
  },
  'BR-040': {
    mustBlock: ['git push -f origin main'],
    nearMiss: ['git push -u origin main'],
  },
  'BR-051': {
    mustBlock: ['git clean -fd'],
    nearMiss: [
      'git clean',
      // SUSPECTED GAP: swapped flags (-df) evade the '-fd' literal.
      'git clean -df',
    ],
    overMatch: ['git clean -fdx'],
  },

  // ── Cloud ────────────────────────────────────────────────────
  'BR-041': {
    mustBlock: ['kubectl delete ns prod'],
    nearMiss: ['kubectl get pods'],
  },
  'BR-042': {
    mustBlock: ['aws iam list-users'], // read-only IAM also matches by design
    nearMiss: ['aws s3 ls', 'aws ec2 describe-instances'],
  },
  'BR-043': {
    mustBlock: ['{"Action":"iam:CreateUser"}'],
    nearMiss: [
      'iam:GetUser',
      // SUSPECTED GAP: only the 3 enumerated actions are covered, e.g.
      // 'iam:CreateRole' (privilege grant) evades.
      'iam:CreateRole',
    ],
  },
  'BR-044': {
    mustBlock: ['iam:DeleteRole'],
    nearMiss: ['iam:GetRole', 'iam:DeleteUser'],
  },
  'BR-045': {
    mustBlock: ['iam:PutPolicy'],
    nearMiss: ['iam:GetPolicy'],
  },

  // ── System admin ─────────────────────────────────────────────
  'BR-046': {
    mustBlock: ['crontab -e'],
    nearMiss: ['crontab -l'],
  },
  'BR-047': {
    mustBlock: ['insmod vuln.ko'],
    nearMiss: ['modinfo br_netfilter'],
    overMatch: [
      // SUSPECTED over-match: substring, no word boundaries.
      'insmodutil',
    ],
  },
  'BR-048': {
    mustBlock: ['modprobe br_netfilter'],
    nearMiss: ['modinfo br_netfilter'],
  },
  'BR-049': {
    mustBlock: ['shutdown -h now'],
    nearMiss: ['uptime'],
    overMatch: ['ls shutdown-docs'],
  },
  'BR-050': {
    mustBlock: ['reboot'],
    nearMiss: ['roboot'],
    overMatch: ['tail /var/log/reboot.log'],
  },
  'BR-052': {
    mustBlock: ['wipefs -a /dev/sda'],
    nearMiss: ['wipe /home/user/notes.txt', 'fdisk -l'],
  },
  'BR-053': {
    // FIXED GAP (whitespace normalization): double space used to evade.
    mustBlock: ['kill -9 4242', 'kill  -9 1'],
    nearMiss: [
      'kill -TERM 1234',
      'kill -KILL 123',
      // SUSPECTED GAP: equivalent force-kills evade.
      'killall -9 node',
    ],
  },
}

describe('DEFAULT_BLOCK_RULES — whitespace-variant hardening (fixed class)', () => {
  // Matching is matches(raw) || matches(collapsed(raw)): runs of spaces,
  // tabs and newlines inside a command collapse to a single space for a
  // second, additive matching pass. Every literal with interior spaces must
  // fire regardless of separator whitespace. The raw (single-space) forms are
  // already pinned in the per-rule matrix above.
  const targets = [
    { id: 'BR-001', core: 'rm -rf', tail: ' /' },
    { id: 'BR-037', core: 'git reset --hard', tail: ' HEAD~1' },
    { id: 'BR-014', core: 'systemctl restart', tail: ' nginx' },
    { id: 'BR-003', core: 'docker rm -f', tail: ' x' },
  ]
  const separators: Array<[string, string]> = [
    ['double space', '  '],
    ['extra space after word', '   '],
    ['tab', '\t'],
    ['space+tab', ' \t'],
    ['tab+space', '\t '],
    ['newline', '\n'],
  ]
  for (const t of targets) {
    for (const [label, ws] of separators) {
      const input = t.core.replace(/ /g, ws) + t.tail
      it(`${t.id} fires on ${label}: ${JSON.stringify(input)}`, () => {
        expect(hitIds(input)).toContain(t.id)
      })
    }
  }
})

// ── Corpus asserted to trigger NO default rule at all ───────────
const NO_MATCH_CORPUS = [
  'echo hello world',
  'ls -la',
  'rm -r ./tmp',
  'rm -f file.txt',
  'rmdir build',
  'docker rm mycontainer',
  'docker system prune',
  'systemctl status nginx',
  'chmod 644 app.sh',
  'chown user:user file.txt',
  'git push origin main',
  'git reset HEAD~1',
  'git worktree add ../x',
  'kubectl get pods',
  'aws s3 ls',
  'crontab -l',
  'kill -TERM 1234',
  'npm run lint',
  'cp config/config.json backup.json',
  "xargs -n1 echo 'hi'",
  "find . -name '*.tmp'",
  'ssh-keygen -t ed25519',
  '/usr/bin/env python3',
  'cat README.md',
  'printenv',
  'echo hello',
  'TRUNCATE',
  'select * from users',
  'fsck -y /mnt/data',
  'sudoedit file.txt',
  'modinfo br_netfilter',
]

describe('DEFAULT_BLOCK_RULES — dataset integrity', () => {
  it('ships 54 rules (BR-001..BR-053 plus BR-054)', () => {
    expect(DEFAULT_BLOCK_RULES).toHaveLength(54)
  })

  it('has unique, well-formed ids', () => {
    const ids = DEFAULT_BLOCK_RULES.map((r) => r.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) {
      expect(id).toMatch(/^BR-\d{3}$/)
    }
  })

  it('places BR-054 (relative .env) right after BR-019, not appended last', () => {
    // Array order is load-bearing (evaluateBlockRules is first-match-wins);
    // BR-054 was inserted in the security section rather than appended.
    const ids = DEFAULT_BLOCK_RULES.map((r) => r.id)
    expect(ids.indexOf('BR-054')).toBe(ids.indexOf('BR-019') + 1)
  })

  it('every rule is a complete, enabled pattern-type entry', () => {
    for (const rule of DEFAULT_BLOCK_RULES) {
      expect(rule.type).toBe('pattern')
      expect(rule.pattern.length).toBeGreaterThan(0)
      expect(rule.category.length).toBeGreaterThan(0)
      expect(rule.description.length).toBeGreaterThan(0)
      // All rules ship enabled; `enabled: false` is the user-facing toggle
      // honored by the rule evaluator (`enabled !== false`).
      expect(rule.enabled).toBe(true)
    }
  })

  it('uses only known severities and categories', () => {
    for (const rule of DEFAULT_BLOCK_RULES) {
      expect(KNOWN_SEVERITIES).toContain(rule.severity)
      expect(KNOWN_CATEGORIES).toContain(rule.category)
    }
  })

  it('has exactly one regex: rule (BR-035) and no other special prefixes', () => {
    const regexRules = DEFAULT_BLOCK_RULES.filter((r) =>
      r.pattern.startsWith('regex:')
    )
    expect(regexRules.map((r) => r.id)).toEqual(['BR-035'])
  })

  it('each rule pattern matches its own pattern text (no self-blind rules)', () => {
    for (const rule of DEFAULT_BLOCK_RULES) {
      expect(matcher.match(rule.pattern, rule.pattern)).toBe(true)
    }
  })

  it('matching is case-invariant for every pattern (lower/upper text)', () => {
    for (const rule of DEFAULT_BLOCK_RULES) {
      expect(matcher.match(rule.pattern, rule.pattern.toLowerCase())).toBe(true)
      expect(matcher.match(rule.pattern, rule.pattern.toUpperCase())).toBe(true)
    }
  })

  it('no rule fires on the benign text "echo hello world"', () => {
    expect(hitIds('echo hello world')).toEqual([])
  })

  it('matches all 54 rules against a 2KB command well under 200ms', () => {
    const text = 'echo hello world && '.repeat(100)
    const start = performance.now()
    hitIds(text)
    expect(performance.now() - start).toBeLessThan(200)
  })
})

describe('DEFAULT_BLOCK_RULES — consumption semantics', () => {
  it('honors the enabled toggle: a disabled BR-001 no longer matches rm -rf', () => {
    // Mirrors `evaluateBlockRules`'s `rules.filter(r => r.enabled !== false)`.
    const toggled = DEFAULT_BLOCK_RULES.map((r) =>
      r.id === 'BR-001' ? { ...r, enabled: false } : r
    )
    const enabled = toggled.filter((r) => r.enabled !== false)
    expect(hitIds('rm -rf /', toggled)).toContain('BR-001')
    expect(hitIds('rm -rf /', enabled)).not.toContain('BR-001')
  })

  it('first match in array order wins for overlapping rules (BR-001 before BR-009)', () => {
    // evaluateBlockRules picks the first matching enabled rule; order of
    // DEFAULT_BLOCK_RULES is therefore load-bearing. Pinned:
    expect(hitIds('sudo rm -rf /')[0]).toBe('BR-001')
  })
})

describe('DEFAULT_BLOCK_RULES — per-rule behavior matrix', () => {
  const ids = Object.keys(MATRIX).sort()

  it('covers exactly the rule ids shipped by block-rules.ts', () => {
    expect(ids).toEqual(DEFAULT_BLOCK_RULES.map((r) => r.id).sort())
  })

  for (const id of ids) {
    const ruleCase = MATRIX[id]
    describe(`${id} — ${ruleById(id).pattern}`, () => {
      it.each(ruleCase.mustBlock)('blocks %j', (input) => {
        expect(hitIds(input)).toContain(id)
      })
      it.each(ruleCase.nearMiss)('does not block %j', (input) => {
        expect(hitIds(input)).not.toContain(id)
      })
      for (const input of ruleCase.overMatch ?? []) {
        it(`over-matches (pinned current behavior) %j`, () => {
          expect(hitIds(input)).toContain(id)
        })
      }
    })
  }
})

describe('DEFAULT_BLOCK_RULES — grouped evasion patterns (suspected gaps)', () => {
  // FIXED (whitespace normalization): literal-substring rules with interior
  // spaces no longer evade when the separator is irregular whitespace.
  // Matching is matches(raw) || matches(collapsed(raw)); these cases pinned
  // the pre-fix hole and now assert the corrected behavior.
  it.each([
    'rm  -rf /',
    'git reset  --hard',
    'systemctl  restart nginx',
    'docker rm  -f x',
    'kill  -9 1',
    'sudo\tapt update',
    'git push\t--force',
    'TRUNCATE\tTABLE users',
  ])(
    'at least one default rule fires on %j (irregular whitespace)',
    (input) => {
      expect(hitIds(input).length).toBeGreaterThan(0)
    }
  )

  it.each([
    // Argument order between the literal's words evades:
    'git push origin --force',
    'chown /var/www -R user:user',
    // Long-flag equivalents evade short-flag literals:
    'chmod --recursive 777 ./dir',
    'git push origin -f',
  ])('no default rule fires on %j (flag/order permutation)', (input) => {
    expect(hitIds(input)).toEqual([])
  })
})

describe('DEFAULT_BLOCK_RULES — near-miss corpus (zero rules fire)', () => {
  it.each(NO_MATCH_CORPUS)('no rule matches %j', (input) => {
    expect(hitIds(input)).toEqual([])
  })
})
