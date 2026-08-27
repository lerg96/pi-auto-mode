import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { promisify } from 'node:util'
import type { SoundConfig } from '../types/config.ts'

export type SoundPlayer = (sound: SoundConfig) => void | Promise<void>

const execFileAsync = promisify(execFile)

async function systemBeep(): Promise<void> {
  if (process.platform === 'win32') {
    // Fixed script, no user input interpolated: injection-safe.
    await execFileAsync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '[console]::Beep(880,120); [console]::Beep(1320,180)',
    ])
  } else {
    process.stdout.write('\x07')
  }
}

async function playFile(path: string): Promise<void> {
  try {
    const st = await stat(path)
    if (!st.isFile()) return
  } catch {
    return // missing/unreadable → silent
  }
  if (process.platform === 'win32') {
    // Single-quoted PS string with quote-escaping; execFile (no shell).
    const quoted = `'${path.replace(/'/g, "''")}'`
    await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(New-Object Media.SoundPlayer ${quoted}).PlaySync()`,
      ],
      { timeout: 15000 }
    )
  } else if (process.platform === 'darwin') {
    await execFileAsync('afplay', [path], { timeout: 15000 })
  } else {
    await execFileAsync('aplay', [path], { timeout: 15000 })
  }
}

async function defaultPlayer(sound: SoundConfig): Promise<void> {
  const target = sound.path.trim()
  if (target.length > 0) await playFile(target)
  else await systemBeep()
}

/**
 * Best-effort modal chime. Never throws and never blocks the caller (the
 * resolver fires it with `void`): sound must not affect the gate. A
 * missing player/binary/path resolves silently.
 */
export async function playNotificationSound(
  sound: SoundConfig | undefined,
  player: SoundPlayer = defaultPlayer
): Promise<void> {
  try {
    if (!sound || sound.enabled !== true) return
    await player(sound)
  } catch {
    // Swallow: sound is advisory, the modal must survive it.
  }
}
