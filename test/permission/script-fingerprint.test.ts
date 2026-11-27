import { mkdtempSync, writeFileSync, rmSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  detectExecutedScripts,
  computeFileHash,
  captureScriptFingerprints,
  areScriptFingerprintsIntact,
  verifyScriptFingerprints,
  isScriptFile,
} from '../../src/permission/script-fingerprint.ts'

describe('script-fingerprint', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'pi-auto-mode-fp-test-'))
  })

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // ignore cleanup errors
    }
  })

  describe('isScriptFile', () => {
    it('identifies supported extensions', () => {
      expect(isScriptFile('run.sh')).toBe(true)
      expect(isScriptFile('run.BASH')).toBe(true)
      expect(isScriptFile('run.zsh')).toBe(true)
      expect(isScriptFile('test.ps1')).toBe(true)
      expect(isScriptFile('script.py')).toBe(true)
      expect(isScriptFile('app.js')).toBe(true)
      expect(isScriptFile('lib.mjs')).toBe(true)
      expect(isScriptFile('lib.cjs')).toBe(true)
      expect(isScriptFile('main.ts')).toBe(true)
      expect(isScriptFile('ui.tsx')).toBe(true)
      expect(isScriptFile('"quoted.sh"')).toBe(true)
      expect(isScriptFile("'quoted.py'")).toBe(true)
    })

    it('rejects unsupported extensions', () => {
      expect(isScriptFile('file.txt')).toBe(false)
      expect(isScriptFile('image.png')).toBe(false)
      expect(isScriptFile('doc.json')).toBe(false)
      expect(isScriptFile('binary.exe')).toBe(false)
    })
  })

  describe('detectExecutedScripts', () => {
    it('detects direct script execution', () => {
      const scripts = detectExecutedScripts('/tmp/cw/q.sh arg1 arg2', tempDir)
      expect(scripts).toHaveLength(1)
      expect(scripts[0]).toBe(resolve('/tmp/cw/q.sh'))
    })

    it('detects relative direct script execution', () => {
      const scripts = detectExecutedScripts('./scripts/run.py', tempDir)
      expect(scripts).toHaveLength(1)
      expect(scripts[0]).toBe(resolve(tempDir, 'scripts/run.py'))
    })

    it('detects interpreter execution: python and python3', () => {
      const s1 = detectExecutedScripts('python3 /tmp/cw/parse.py', tempDir)
      expect(s1).toEqual([resolve('/tmp/cw/parse.py')])

      const s2 = detectExecutedScripts('python -u ./worker.py', tempDir)
      expect(s2).toEqual([resolve(tempDir, 'worker.py')])

      const s3 = detectExecutedScripts('python3.11 ./script.py', tempDir)
      expect(s3).toEqual([resolve(tempDir, 'script.py')])
    })

    it('detects interpreter execution: shells (bash, sh, zsh)', () => {
      const s1 = detectExecutedScripts('bash /tmp/cw/q.sh "arg"', tempDir)
      expect(s1).toEqual([resolve('/tmp/cw/q.sh')])

      const s2 = detectExecutedScripts('sh -x ./run.sh', tempDir)
      expect(s2).toEqual([resolve(tempDir, 'run.sh')])

      const s3 = detectExecutedScripts('zsh setup.zsh', tempDir)
      expect(s3).toEqual([resolve(tempDir, 'setup.zsh')])
    })

    it('detects interpreter execution: node, tsx, bun, deno', () => {
      const s1 = detectExecutedScripts('node app.js', tempDir)
      expect(s1).toEqual([resolve(tempDir, 'app.js')])

      const s2 = detectExecutedScripts('tsx src/cli.tsx', tempDir)
      expect(s2).toEqual([resolve(tempDir, 'src/cli.tsx')])

      const s3 = detectExecutedScripts('bun run script.ts', tempDir)
      expect(s3).toEqual([resolve(tempDir, 'script.ts')])

      const s4 = detectExecutedScripts('deno run main.ts', tempDir)
      expect(s4).toEqual([resolve(tempDir, 'main.ts')])
    })

    it('detects interpreter execution: pwsh and powershell', () => {
      const s1 = detectExecutedScripts('pwsh -File test.ps1', tempDir)
      expect(s1).toEqual([resolve(tempDir, 'test.ps1')])

      const s2 = detectExecutedScripts(
        'pwsh -ExecutionPolicy Bypass -File test.ps1',
        tempDir
      )
      expect(s2).toEqual([resolve(tempDir, 'test.ps1')])

      const s3 = detectExecutedScripts('powershell ./deploy.ps1', tempDir)
      expect(s3).toEqual([resolve(tempDir, 'deploy.ps1')])
    })

    it('unwraps leading wrappers: sudo, env, nohup, npx', () => {
      const s1 = detectExecutedScripts(
        'sudo -u admin python3 /tmp/admin.py',
        tempDir
      )
      expect(s1).toEqual([resolve('/tmp/admin.py')])

      const s2 = detectExecutedScripts(
        'env FOO=BAR python3 /tmp/env.py',
        tempDir
      )
      expect(s2).toEqual([resolve('/tmp/env.py')])

      const s3 = detectExecutedScripts('nohup ./long-run.sh &', tempDir)
      expect(s3).toEqual([resolve(tempDir, 'long-run.sh')])

      const s4 = detectExecutedScripts('npx tsx script.ts', tempDir)
      expect(s4).toEqual([resolve(tempDir, 'script.ts')])
    })

    it('ignores inline code execution', () => {
      expect(
        detectExecutedScripts(
          'python3 -c "import os; os.system(\'ls\')"',
          tempDir
        )
      ).toEqual([])
      expect(
        detectExecutedScripts('node -e "console.log(123)"', tempDir)
      ).toEqual([])
      expect(
        detectExecutedScripts('bash -c "echo hello world"', tempDir)
      ).toEqual([])
      expect(
        detectExecutedScripts('python3 -m http.server 8000', tempDir)
      ).toEqual([])
      expect(
        detectExecutedScripts('pwsh -Command "Write-Host Hi"', tempDir)
      ).toEqual([])
    })

    it('tracks cd across compound segments', () => {
      const targetDir = join(tempDir, 'sub')
      const s = detectExecutedScripts(`cd sub && ./run.sh`, tempDir)
      expect(s).toEqual([resolve(targetDir, 'run.sh')])
    })

    it('detects multiple scripts in pipelines and compound commands', () => {
      const s = detectExecutedScripts(
        'echo "$R" | python3 /tmp/cw/parse.py && ./cleanup.sh',
        tempDir
      )
      expect(s).toEqual([
        resolve('/tmp/cw/parse.py'),
        resolve(tempDir, 'cleanup.sh'),
      ])
    })

    it('deduplicates duplicate script references', () => {
      const s = detectExecutedScripts('./run.sh && ./run.sh', tempDir)
      expect(s).toEqual([resolve(tempDir, 'run.sh')])
    })

    it('handles the user exact scenario with compound date commands', () => {
      const cmd = `/tmp/cw/q.sh "/ecs/alegra-app-production/nginx" $(date -d '-24 hours' +%s) $(date +%s) \
'fields @timestamp, status, request_time, host, request
| filter request like /initialize-categories/
| stats count(*) as n, avg(request_time) as avg_ms, max(request_time) as max_ms by bin(1h), status
| sort _bin desc | limit 40'`

      const s = detectExecutedScripts(cmd, tempDir)
      expect(s).toEqual([resolve('/tmp/cw/q.sh')])
    })
  })

  describe('fingerprinting and verification', () => {
    it('computes sha256 hash of an existing file', () => {
      const filePath = join(tempDir, 'test.py')
      writeFileSync(filePath, 'print("hello world")\n')
      const hash = computeFileHash(filePath)
      expect(hash).toBeTruthy()
      expect(hash).toHaveLength(64)
    })

    it('returns null for non-existent file or directory', () => {
      expect(computeFileHash(join(tempDir, 'missing.py'))).toBeNull()
      expect(computeFileHash(tempDir)).toBeNull()
    })

    it('captures fingerprints and verifies intact content', () => {
      const filePath = join(tempDir, 'q.sh')
      writeFileSync(filePath, '#!/bin/bash\necho "ok"\n')

      const fps = captureScriptFingerprints(`./q.sh`, tempDir)
      expect(fps).toHaveLength(1)
      expect(fps[0].path).toBe(resolve(tempDir, 'q.sh'))
      expect(fps[0].hash).not.toBe('__MISSING__')

      expect(areScriptFingerprintsIntact(fps)).toBe(true)
      expect(verifyScriptFingerprints(fps, `./q.sh`, tempDir)).toBe(true)
    })

    it('invalidates when script content is modified', () => {
      const filePath = join(tempDir, 'q.sh')
      writeFileSync(filePath, '#!/bin/bash\necho "initial"\n')

      const fps = captureScriptFingerprints(`./q.sh`, tempDir)
      expect(areScriptFingerprintsIntact(fps)).toBe(true)

      // Modify the file on disk
      writeFileSync(filePath, '#!/bin/bash\necho "modified"\n')

      expect(areScriptFingerprintsIntact(fps)).toBe(false)
      expect(verifyScriptFingerprints(fps, `./q.sh`, tempDir)).toBe(false)
    })

    it('invalidates when script file is deleted', () => {
      const filePath = join(tempDir, 'q.sh')
      writeFileSync(filePath, '#!/bin/bash\necho "initial"\n')

      const fps = captureScriptFingerprints(`./q.sh`, tempDir)
      unlinkSync(filePath)

      expect(areScriptFingerprintsIntact(fps)).toBe(false)
      expect(verifyScriptFingerprints(fps, `./q.sh`, tempDir)).toBe(false)
    })

    it('remains intact for mock/missing file unless created on disk', () => {
      const filePath = join(tempDir, 'virtual.py')
      const fps = captureScriptFingerprints(`python3 ${filePath}`, tempDir)
      expect(fps[0].hash).toBe('__MISSING__')

      // Still missing: intact
      expect(areScriptFingerprintsIntact(fps)).toBe(true)
      expect(
        verifyScriptFingerprints(fps, `python3 ${filePath}`, tempDir)
      ).toBe(true)

      // Created on disk: now invalidates!
      writeFileSync(filePath, 'print("created now")\n')
      expect(areScriptFingerprintsIntact(fps)).toBe(false)
    })

    it('rejects command executing an un-fingerprinted script', () => {
      const file1 = join(tempDir, 'a.py')
      const file2 = join(tempDir, 'b.py')
      writeFileSync(file1, 'print("a")\n')
      writeFileSync(file2, 'print("b")\n')

      const fps = captureScriptFingerprints(`python3 ${file1}`, tempDir)
      expect(verifyScriptFingerprints(fps, `python3 ${file1}`, tempDir)).toBe(
        true
      )

      // Running b.py under rule fingerprinted only for a.py fails verification
      expect(verifyScriptFingerprints(fps, `python3 ${file2}`, tempDir)).toBe(
        false
      )
    })

    it('source and dot builtin execution detect and fingerprint scripts', () => {
      const qPath = join(tempDir, 'q.sh')
      const envPath = join(tempDir, 'env.sh')
      writeFileSync(qPath, 'echo "source test"\n')
      writeFileSync(envPath, 'export FOO=1\n')

      const s1 = detectExecutedScripts(`source ${qPath}`, tempDir)
      expect(s1).toEqual([resolve(qPath)])

      const s2 = detectExecutedScripts(`. ./env.sh`, tempDir)
      expect(s2).toEqual([resolve(tempDir, 'env.sh')])

      const fps = captureScriptFingerprints(`. ./env.sh`, tempDir)
      expect(fps).toHaveLength(1)
      expect(fps[0].path).toBe(resolve(tempDir, 'env.sh'))
      expect(fps[0].hash).not.toBe('__MISSING__')
      expect(areScriptFingerprintsIntact(fps)).toBe(true)
    })

    it('unwraps uv run, poetry run, and npx tsx wrappers', () => {
      const pyScript = join(tempDir, 'script.py')
      const tsScript = join(tempDir, 'cli.tsx')
      writeFileSync(pyScript, 'print("py")\n')
      writeFileSync(tsScript, 'console.log("ts")\n')

      const s1 = detectExecutedScripts(`uv run script.py`, tempDir)
      expect(s1).toEqual([resolve(tempDir, 'script.py')])

      const s2 = detectExecutedScripts(
        `uv run --with requests script.py`,
        tempDir
      )
      expect(s2).toEqual([resolve(tempDir, 'script.py')])

      const s3 = detectExecutedScripts(`poetry run python script.py`, tempDir)
      expect(s3).toEqual([resolve(tempDir, 'script.py')])

      const s4 = detectExecutedScripts(`npx --yes tsx cli.tsx`, tempDir)
      expect(s4).toEqual([resolve(tempDir, 'cli.tsx')])

      const s5 = detectExecutedScripts(`bunx tsx cli.tsx`, tempDir)
      expect(s5).toEqual([resolve(tempDir, 'cli.tsx')])
    })

    it('handles combined shell flags and inline vs script arguments', () => {
      const scriptPath = join(tempDir, 'script.sh')
      const psScript = join(tempDir, 'script.ps1')
      writeFileSync(scriptPath, 'echo "ok"\n')
      writeFileSync(psScript, 'Write-Host "ok"\n')

      // bash -xc "echo hi" -> inline code, no script
      expect(detectExecutedScripts('bash -xc "echo hi"', tempDir)).toEqual([])

      // bash -euo pipefail ./script.sh -> script extracted
      expect(
        detectExecutedScripts('bash -euo pipefail ./script.sh', tempDir)
      ).toEqual([resolve(tempDir, 'script.sh')])

      // pwsh -file=./script.ps1 -> script extracted
      expect(detectExecutedScripts('pwsh -file=./script.ps1', tempDir)).toEqual(
        [resolve(tempDir, 'script.ps1')]
      )
    })

    it('file replacement: identical content stays intact, 1-byte diff or truncation invalidates', () => {
      const scriptPath = join(tempDir, 'replace.sh')
      const originalContent = 'echo "hello original"\n'
      writeFileSync(scriptPath, originalContent)

      const fps = captureScriptFingerprints(`./replace.sh`, tempDir)
      expect(areScriptFingerprintsIntact(fps)).toBe(true)

      // 1. Delete and recreate with identical content -> still intact
      unlinkSync(scriptPath)
      expect(areScriptFingerprintsIntact(fps)).toBe(false)
      writeFileSync(scriptPath, originalContent)
      expect(areScriptFingerprintsIntact(fps)).toBe(true)

      // 2. Modify by 1 byte -> invalidates
      writeFileSync(scriptPath, 'echo "hello originak"\n')
      expect(areScriptFingerprintsIntact(fps)).toBe(false)

      // 3. Truncate to empty file -> invalidates
      writeFileSync(scriptPath, '')
      expect(areScriptFingerprintsIntact(fps)).toBe(false)
    })

    it('nested script extraction: fingerprints nested script and detects tampering of nested file', () => {
      const qPath = join(tempDir, 'q.sh')
      const parsePath = join(tempDir, 'parse.py')
      writeFileSync(
        qPath,
        'if [ "$S" = "Complete" ]; then echo "$R" | python3 parse.py; break; fi\n'
      )
      writeFileSync(parsePath, 'import sys; print("parsed")\n')

      const fps = captureScriptFingerprints(`./q.sh`, tempDir)
      // Captures both q.sh AND parse.py!
      expect(fps).toHaveLength(2)
      expect(fps.map((f) => f.path)).toContain(resolve(tempDir, 'q.sh'))
      expect(fps.map((f) => f.path)).toContain(resolve(tempDir, 'parse.py'))
      expect(areScriptFingerprintsIntact(fps)).toBe(true)

      // Modify ONLY parse.py (nested script), leave q.sh untouched!
      writeFileSync(parsePath, 'import sys; print("tampered")\n')
      expect(areScriptFingerprintsIntact(fps)).toBe(false)
    })

    it('nested script extraction ignores referenced scripts that do not exist on disk', () => {
      const qPath = join(tempDir, 'q.sh')
      writeFileSync(qPath, 'echo "running" && python3 does_not_exist.py\n')

      const fps = captureScriptFingerprints(`./q.sh`, tempDir)
      // Only q.sh is fingerprinted, does_not_exist.py is not included
      expect(fps).toHaveLength(1)
      expect(fps[0].path).toBe(resolve(tempDir, 'q.sh'))
    })
  })
})
