import { describe, expect, it, vi } from 'vitest'
import { createStartupUpdateCheck } from '../startupUpdateCheck'

describe('startup update check', () => {
  it('runs one check and lets only one window claim the notification', async () => {
    const check = vi.fn(async () => ({ status: 'available' as const, version: '2.0.0' }))
    const startupCheck = createStartupUpdateCheck({
      enabled: () => true,
      getState: () => ({ status: 'idle' }),
      check,
    })

    const [first, second] = await Promise.all([startupCheck(), startupCheck()])

    expect(check).toHaveBeenCalledOnce()
    expect([first.notify, second.notify].sort()).toEqual([false, true])
  })

  it('keeps latest, failed, and disabled checks silent', async () => {
    const quietCheck = createStartupUpdateCheck({
      enabled: () => true,
      getState: () => ({ status: 'idle' }),
      check: vi.fn(async () => ({ status: 'not-available' as const })),
    })
    expect((await quietCheck()).notify).toBe(false)

    const disabledCheck = vi.fn(async () => ({ status: 'available' as const }))
    const disabled = createStartupUpdateCheck({
      enabled: () => false,
      getState: () => ({ status: 'idle' }),
      check: disabledCheck,
    })
    expect(await disabled()).toMatchObject({ state: { status: 'idle' }, notify: false })
    expect(disabledCheck).not.toHaveBeenCalled()
  })
})
