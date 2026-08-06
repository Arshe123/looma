import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { prepareWindowsForQuit } from '../quitCoordinator'

class FakeWindow extends EventEmitter {
  isReadyToClose = false
  destroyed = false
  webContents = { send: vi.fn() }
  close = vi.fn(() => {
    this.destroyed = true
    this.emit('closed')
  })

  isDestroyed() {
    return this.destroyed
  }
}

describe('prepareWindowsForQuit', () => {
  it('requests every window to save and waits until all windows close', async () => {
    const first = new FakeWindow()
    const second = new FakeWindow()
    const pending = prepareWindowsForQuit([first, second], 1_000)

    expect(first.webContents.send).toHaveBeenCalledWith('window:prepare-close')
    expect(second.webContents.send).toHaveBeenCalledWith('window:prepare-close')

    first.destroyed = true
    first.emit('closed')
    let finished = false
    void pending.then(() => { finished = true })
    await Promise.resolve()
    expect(finished).toBe(false)

    second.destroyed = true
    second.emit('closed')
    await pending
    expect(finished).toBe(true)
  })

  it('forces an unresponsive window closed after the timeout', async () => {
    vi.useFakeTimers()
    const win = new FakeWindow()
    const pending = prepareWindowsForQuit([win], 1_000)

    await vi.advanceTimersByTimeAsync(1_000)
    await pending

    expect(win.isReadyToClose).toBe(true)
    expect(win.close).toHaveBeenCalledOnce()
    vi.useRealTimers()
  })
})
