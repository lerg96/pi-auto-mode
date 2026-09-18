import {
  publishUi,
  borrowUi,
  withPromptLock,
  resetUiRegistry,
} from '../../src/state/ui-registry.ts'

function fakeUi(tag: string) {
  return { tag, custom: jest.fn(), notify: jest.fn() }
}

describe('ui-registry (proceso)', () => {
  afterEach(() => resetUiRegistry())

  it('devuelve undefined cuando nadie publicó UI (pi -p)', () => {
    expect(borrowUi()).toBeUndefined()
  })

  it('publica y devuelve la última UI dialog-capable', () => {
    const a = fakeUi('a')
    const b = fakeUi('b')
    publishUi(a as never)
    expect(borrowUi()).toBe(a)
    publishUi(b as never)
    expect(borrowUi()).toBe(b)
  })

  it('sobrevive a la re-evaluación del módulo: la clave es Symbol.for', () => {
    publishUi(fakeUi('x') as never)
    // Así lo lee cualquier otra copia del módulo en el mismo proceso (pi carga
    // la extensión con jiti moduleCache:false, y una sub-sesión con otro cwd
    // vuelve a evaluar el módulo desde cero).
    const viaSymbol = (
      globalThis as unknown as Record<symbol, { ui?: unknown } | undefined>
    )[Symbol.for('pi-auto-mode:ui-registry')]
    expect(viaSymbol?.ui).toBeDefined()
  })
})

describe('withPromptLock', () => {
  afterEach(() => resetUiRegistry())

  it('arranca la tarea de forma síncrona si la cola está libre', () => {
    let started = false
    void withPromptLock(async () => {
      started = true
    })
    expect(started).toBe(true)
  })

  it('serializa: la segunda tarea no arranca hasta cerrar la primera', async () => {
    const order: string[] = []
    let releaseFirst!: () => void
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })

    const p1 = withPromptLock(async () => {
      order.push('start-1')
      await first
      order.push('end-1')
    })
    const p2 = withPromptLock(async () => {
      order.push('start-2')
    })

    await Promise.resolve()
    expect(order).toEqual(['start-1'])

    releaseFirst()
    await Promise.all([p1, p2])
    expect(order).toEqual(['start-1', 'end-1', 'start-2'])
  })

  it('invoca task() una sola vez', async () => {
    const task = jest.fn(async () => 'ok')
    const result = await withPromptLock(task)
    expect(task).toHaveBeenCalledTimes(1)
    expect(result).toBe('ok')
  })

  it('un rechazo no envenena la cola', async () => {
    await expect(
      withPromptLock(async () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')

    expect(await withPromptLock(async () => 'siguiente')).toBe('siguiente')
  })

  it('un task síncrono que lanza libera el lock', async () => {
    await expect(
      withPromptLock(() => {
        throw new Error('sync boom')
      })
    ).rejects.toThrow('sync boom')

    expect(await withPromptLock(async () => 'ok')).toBe('ok')
  })
})
