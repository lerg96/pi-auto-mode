import {
  isSecretSensitive,
  redactSecretsForModel,
} from '../../src/classifier/secret-guard.ts'

describe('isSecretSensitive', () => {
  // ── Positive: sensitive detections ─────────────────────────
  describe('sensitive === true', () => {
    it('detects .env file path', () => {
      // PATH_RE requires a path boundary (start, /, \, or .) before the dot;
      // "cat .env" intentionally does NOT match (space is not a boundary).
      const result = isSecretSensitive('.env')
      expect(result.sensitive).toBe(true)
    })

    it('detects cat ~/.npmrc', () => {
      const result = isSecretSensitive('cat ~/.npmrc')
      expect(result.sensitive).toBe(true)
    })

    it('detects client_secret=xyz', () => {
      const result = isSecretSensitive('client_secret=xyz')
      expect(result.sensitive).toBe(true)
    })

    it('detects AWS_SECRET_ACCESS_KEY=... assignment', () => {
      const result = isSecretSensitive('AWS_SECRET_ACCESS_KEY=xyz')
      expect(result.sensitive).toBe(true)
    })

    it('detects DB_PASSWORD=... assignment', () => {
      const result = isSecretSensitive('DB_PASSWORD=hunter2')
      expect(result.sensitive).toBe(true)
    })

    it('detects MY_API_KEY=... assignment', () => {
      const result = isSecretSensitive('MY_API_KEY=abc123')
      expect(result.sensitive).toBe(true)
    })

    it('detects export TOKEN=... assignment', () => {
      const result = isSecretSensitive('export TOKEN=xyz')
      expect(result.sensitive).toBe(true)
    })

    it('detects api_key: abc', () => {
      const result = isSecretSensitive('api_key: abc')
      expect(result.sensitive).toBe(true)
    })

    it('detects -token flag with value', () => {
      const result = isSecretSensitive('-token xyz')
      expect(result.sensitive).toBe(true)
    })

    it('detects embedded credentials in URL', () => {
      const result = isSecretSensitive('https://user:pass@host')
      expect(result.sensitive).toBe(true)
    })

    it('detects obfuscated secret path cat $HOME/.en v', () => {
      // The obfuscation stripping: removes $HOME → leaves cat /.en v
      // After stripping $HOME, we get 'cat /.en v' — but the source strips
      // \$\{...\} and \$[A-Za-z_]\w* — so $HOME becomes '' and we get
      // 'cat /.env' which matches the path regex
      const result = isSecretSensitive('cat "$HOME/.en"v')
      expect(result.sensitive).toBe(true)
    })
  })

  // ── Negative: non-sensitive ────────────────────────────────
  describe('sensitive === false', () => {
    it('ls is not sensitive', () => {
      const result = isSecretSensitive('ls')
      expect(result.sensitive).toBe(false)
    })

    it('cat report.awsome is not sensitive (no dot prefix before env-like name)', () => {
      const result = isSecretSensitive('cat report.awsome')
      expect(result.sensitive).toBe(false)
    })

    it('myid_rsa is not sensitive (no dot/separator prefix)', () => {
      const result = isSecretSensitive('myid_rsa')
      expect(result.sensitive).toBe(false)
    })

    it('ordinary command is not sensitive', () => {
      const result = isSecretSensitive('echo hello world')
      expect(result.sensitive).toBe(false)
    })

    it('echo hello is not sensitive (no env assignment)', () => {
      const result = isSecretSensitive('echo hello')
      expect(result.sensitive).toBe(false)
    })
  })

  // ── H5: combined hay coverage ──────────────────────────────
  describe('combined hay coverage (H5)', () => {
    it('detects secret in JSON arguments even when value is benign', () => {
      const hay =
        JSON.stringify({ command: 'cat ~/.npmrc && echo ok' }) +
        '\n' +
        'echo ok'
      const result = isSecretSensitive(hay)
      expect(result.sensitive).toBe(true)
    })
  })

  // ── ENV_RE refinements: M3 empty value + L1 false-positive fix ──
  describe('ENV_RE empty value & false-positive fix', () => {
    // M8 (medium): an empty/whitespace-only secret assignment must NOT be
    // treated as sensitive — M3's empty-value match regressed into a modal-DoS.
    it('SECRET_KEY= (empty value) is NOT sensitive (M8)', () => {
      const result = isSecretSensitive('SECRET_KEY=')
      expect(result.sensitive).toBe(false)
    })

    it('SECRET_KEY=  (value=space only) is NOT sensitive (M8)', () => {
      const result = isSecretSensitive('SECRET_KEY= ')
      expect(result.sensitive).toBe(false)
    })

    it('SECRET_KEY=xyz (non-empty value) IS sensitive (M8)', () => {
      const result = isSecretSensitive('SECRET_KEY=xyz')
      expect(result.sensitive).toBe(true)
      expect(result.reason).toBe('env secret assignment')
    })

    // L1 (low): sensitive word as substring must NOT match
    it('password_reset=true is not sensitive (substring)', () => {
      const result = isSecretSensitive('password_reset=true')
      expect(result.sensitive).toBe(false)
    })

    it('token_bucket_size=100 is not sensitive (substring)', () => {
      const result = isSecretSensitive('token_bucket_size=100')
      expect(result.sensitive).toBe(false)
    })

    it('credential_type=oauth2 is not sensitive (substring)', () => {
      const result = isSecretSensitive('credential_type=oauth2')
      expect(result.sensitive).toBe(false)
    })

    it('secret_santa_list=alice,bob is not sensitive (substring)', () => {
      const result = isSecretSensitive('secret_santa_list=alice,bob')
      expect(result.sensitive).toBe(false)
    })

    it('access_key_binding=ctrl+a is not sensitive (substring)', () => {
      const result = isSecretSensitive('access_key_binding=ctrl+a')
      expect(result.sensitive).toBe(false)
    })
  })

  // ── Reason field ───────────────────────────────────────────
  describe('reason field', () => {
    it('provides a reason for secret file path', () => {
      const result = isSecretSensitive('cat ~/.ssh/id_rsa')
      expect(result.sensitive).toBe(true)
      expect(result.reason).toBeDefined()
    })

    it('provides a reason for secret keyword', () => {
      const result = isSecretSensitive('password')
      expect(result.sensitive).toBe(true)
      expect(result.reason).toBeDefined()
    })

    it('provides a reason for embedded credential', () => {
      const result = isSecretSensitive('api_key: secret123')
      expect(result.sensitive).toBe(true)
      expect(result.reason).toBeDefined()
    })

    it('provides a reason for secret flag', () => {
      const result = isSecretSensitive('--token abc123')
      expect(result.sensitive).toBe(true)
      expect(result.reason).toBeDefined()
    })

    it('provides obfuscated reason for stripped matches', () => {
      const result = isSecretSensitive('cat "$HOME/.en"v')
      expect(result.sensitive).toBe(true)
      expect(result.reason).toMatch(/obfuscated/i)
    })
  })

  // ── DSN credentials: any RFC-3986 scheme, not just http(s) ─
  describe('embedded credentials in DSN schemes', () => {
    it('detects postgres:// DSN credentials', () => {
      const result = isSecretSensitive('psql "postgres://user:hunter2@db/prod"')
      expect(result.sensitive).toBe(true)
      expect(result.reason).toBe('embedded credential')
    })

    it('detects mysql:// DSN credentials', () => {
      const result = isSecretSensitive('mysql://user:hunter2@db/prod')
      expect(result.sensitive).toBe(true)
      expect(result.reason).toBe('embedded credential')
    })

    it('detects redis:// DSN credentials with empty username', () => {
      const result = isSecretSensitive('redis-cli -u redis://:pw@cache:6379/0')
      expect(result.sensitive).toBe(true)
      expect(result.reason).toBe('embedded credential')
    })

    it('detects mongodb+srv:// DSN credentials (scheme with + and -)', () => {
      const result = isSecretSensitive(
        'mongosh "mongodb+srv://u:p@cluster0.mongodb.net/test"'
      )
      expect(result.sensitive).toBe(true)
      expect(result.reason).toBe('embedded credential')
    })

    it('detects amqp:// DSN credentials', () => {
      const result = isSecretSensitive('amqp://guest:guest@mq.internal/vhost')
      expect(result.sensitive).toBe(true)
      expect(result.reason).toBe('embedded credential')
    })

    it('still detects http(s):// embedded credentials', () => {
      const result = isSecretSensitive('https://user:pass@host')
      expect(result.sensitive).toBe(true)
      expect(result.reason).toBe('embedded credential')
    })

    it('ssh:// userinfo without a password is NOT sensitive', () => {
      const result = isSecretSensitive('ssh://git@github.com:user/repo.git')
      expect(result.sensitive).toBe(false)
    })

    it('plain https:// docs URL is NOT sensitive', () => {
      const result = isSecretSensitive('https://example.com/docs')
      expect(result.sensitive).toBe(false)
    })

    it('DSN without userinfo is NOT sensitive', () => {
      const result = isSecretSensitive(
        'psql postgresql://db.example.com:5432/prod'
      )
      expect(result.sensitive).toBe(false)
    })

    // Documented false positive: a port in the userinfo position is
    // indistinguishable from a password without a scheme allowlist.
    it('http://proxy:8080@host is flagged (accepted false positive)', () => {
      const result = isSecretSensitive('curl http://proxy:8080@host')
      expect(result.sensitive).toBe(true)
      expect(result.reason).toBe('embedded credential')
    })
  })

  // ── H5: KEYWORD_RE reduced false positives ─────────────────
  describe('H5: KEYWORD_RE reduced false positives', () => {
    it("benign phrase 'the project has a secret feature' is NOT sensitive", () => {
      const result = isSecretSensitive(
        'echo "the project has a secret feature"'
      )
      expect(result.sensitive).toBe(false)
    })

    it("isolated 'token' word is NOT sensitive", () => {
      const result = isSecretSensitive('rotate the token please')
      expect(result.sensitive).toBe(false)
    })

    it('SECRET_KEY=xyz (assignment context) IS sensitive', () => {
      const result = isSecretSensitive('SECRET_KEY=xyz')
      expect(result.sensitive).toBe(true)
    })

    it('password=abc (assignment context) IS sensitive', () => {
      const result = isSecretSensitive('password=abc')
      expect(result.sensitive).toBe(true)
    })

    it("bare 'password' keyword IS sensitive", () => {
      const result = isSecretSensitive('password')
      expect(result.sensitive).toBe(true)
    })
  })
})

describe('redactSecretsForModel', () => {
  it('masks a Bearer token but preserves scheme and structure', () => {
    const out = redactSecretsForModel('curl -H "Authorization: Bearer xyz"')
    expect(out).not.toContain('xyz')
    expect(out).toContain('Bearer [REDACTED]')
    expect(out).toContain('Authorization:')
  })

  it('masks a Basic token', () => {
    const out = redactSecretsForModel(
      'curl -H "Authorization: Basic dXNlcjpwYXNz"'
    )
    expect(out).not.toContain('dXNlcjpwYXNz')
    expect(out).toContain('Basic [REDACTED]')
  })

  it('masks PASSWORD-style assignments but preserves the key', () => {
    const out = redactSecretsForModel('export DB_PASSWORD=hunter2')
    expect(out).not.toContain('hunter2')
    expect(out).toContain('DB_PASSWORD=[REDACTED]')
  })

  it('masks passwd/pwd fragments in assignments', () => {
    expect(redactSecretsForModel('passwd=hunter2')).toBe('passwd=[REDACTED]')
    expect(redactSecretsForModel('MYSQL_PWD=s3cret')).toBe(
      'MYSQL_PWD=[REDACTED]'
    )
  })

  it('masks secret CLI flags', () => {
    const out = redactSecretsForModel('deploy --token abc123 --verbose')
    expect(out).not.toContain('abc123')
    expect(out).toContain('--token [REDACTED]')
    expect(out).toContain('--verbose')
  })

  it('masks URL-embedded passwords but preserves user and host', () => {
    const out = redactSecretsForModel(
      'git clone https://user:pass123@host/repo'
    )
    expect(out).not.toContain('pass123')
    expect(out).toContain('https://user:[REDACTED]@host/repo')
  })

  it('preserves quotes around redacted values', () => {
    expect(redactSecretsForModel('PASSWORD="hunter2"')).toBe(
      'PASSWORD="[REDACTED]"'
    )
    expect(redactSecretsForModel("PASSWORD='hunter2'")).toBe(
      "PASSWORD='[REDACTED]'"
    )
  })

  it('leaves normal commands byte-identical', () => {
    const commands = [
      'ls -la /tmp',
      'echo hello world',
      'git status',
      'cat README.md',
      'npm run check',
    ]
    for (const cmd of commands) expect(redactSecretsForModel(cmd)).toBe(cmd)
  })

  it('leaves empty and short strings untouched', () => {
    for (const s of ['', 'a', 'hi', 'ls', '--help', 'ok'])
      expect(redactSecretsForModel(s)).toBe(s)
  })

  it('does not redact sensitive words inside longer identifiers', () => {
    expect(redactSecretsForModel('password_reset=true')).toBe(
      'password_reset=true'
    )
    expect(redactSecretsForModel('token_bucket_size=100')).toBe(
      'token_bucket_size=100'
    )
  })

  it('leaves empty assignments untouched', () => {
    expect(redactSecretsForModel('SECRET_KEY=')).toBe('SECRET_KEY=')
  })

  it('masks DSN passwords for non-http schemes and preserves structure', () => {
    expect(
      redactSecretsForModel('psql "postgres://user:hunter2@db/prod"')
    ).toBe('psql "postgres://user:[REDACTED]@db/prod"')
    expect(redactSecretsForModel('mysql://user:hunter2@db/prod')).toBe(
      'mysql://user:[REDACTED]@db/prod'
    )
    expect(redactSecretsForModel('redis-cli -u redis://:pw@cache:6379/0')).toBe(
      'redis-cli -u redis://:[REDACTED]@cache:6379/0'
    )
    expect(
      redactSecretsForModel('mongosh "mongodb+srv://u:p@cluster0.example.net"')
    ).toBe('mongosh "mongodb+srv://u:[REDACTED]@cluster0.example.net"')
    expect(redactSecretsForModel('amqp://guest:guest@mq/vhost')).toBe(
      'amqp://guest:[REDACTED]@mq/vhost'
    )
  })

  it('masks several DSNs in one string without eating separators', () => {
    const out = redactSecretsForModel(
      'urls: postgres://a:b@h1/db,mysql://c:d@h2/db; redis://e:f@h3/0'
    )
    expect(out).toBe(
      'urls: postgres://a:[REDACTED]@h1/db,mysql://c:[REDACTED]@h2/db; redis://e:[REDACTED]@h3/0'
    )
  })

  it('still masks http(s) URL passwords', () => {
    expect(redactSecretsForModel('git clone https://user:pw@host/r')).toBe(
      'git clone https://user:[REDACTED]@host/r'
    )
  })

  it('leaves DSNs without credentials untouched', () => {
    for (const s of [
      'ssh://git@github.com:user/repo.git',
      'https://example.com/docs',
      'psql postgresql://db.example.com:5432/prod',
    ])
      expect(redactSecretsForModel(s)).toBe(s)
  })

  it('is idempotent for DSN passwords', () => {
    const once = redactSecretsForModel(
      'psql "postgres://user:hunter2@db/prod" mysql://c:d@h2/db'
    )
    expect(redactSecretsForModel(once)).toBe(once)
  })

  it('is idempotent', () => {
    const once = redactSecretsForModel(
      'curl -H "Authorization: Bearer xyz" --token abc PASSWORD=pw'
    )
    expect(redactSecretsForModel(once)).toBe(once)
  })
})
