import { playNotificationSound } from '../../src/ui/sound.ts'
import type { SoundConfig } from '../../src/types/config.ts'

const ON: SoundConfig = { enabled: true, path: '', remindEveryMs: 20000 }

describe('playNotificationSound (best-effort chime)', () => {
  it('calls the player with the sound config when enabled', async () => {
    const seen: SoundConfig[] = []
    await playNotificationSound(ON, (s) => {
      seen.push(s)
    })
    expect(seen).toEqual([ON])
  })

  it('stays silent when disabled or absent', async () => {
    const player = jest.fn()
    await playNotificationSound({ ...ON, enabled: false }, player)
    await playNotificationSound(undefined, player)
    expect(player).not.toHaveBeenCalled()
  })

  it('swallows player errors (never rejects, never blocks)', async () => {
    const player = jest.fn(async () => {
      throw new Error('no speaker')
    })
    await expect(playNotificationSound(ON, player)).resolves.toBeUndefined()
    expect(player).toHaveBeenCalledTimes(1)
  })

  it('supports sync players', async () => {
    const player = jest.fn(() => {})
    await playNotificationSound(ON, player)
    expect(player).toHaveBeenCalledTimes(1)
  })
})
