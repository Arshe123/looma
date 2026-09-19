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

  it('does not force a responsive editor closed while a user decides, and honors cancellation', async () => {
    vi.useFakeTimers()
    const win = new FakeWindow()
    const pending = prepareWindowsForQuit([win], 1000)
    win.emit('looma:close-pending')
    await vi.advanceTimersByTimeAsync(20000)
    expect(win.close).not.toHaveBeenCalled()
    win.emit('looma:close-cancelled')
    expect(await pending).toBe(false)
    vi.useRealTimers()
  })
  it('cancels the whole quit when one window cancels while another is still deciding', async () => {
    const first = new FakeWindow()
    const second = new FakeWindow()
    const pending = prepareWindowsForQuit([first, second], 1000)
    first.emit('looma:close-pending')
    second.emit('looma:close-pending')
    first.emit('looma:close-cancelled')
    expect(await Promise.race([pending, new Promise(resolve => setTimeout(() => resolve('hung'), 20))])).toBe(false)
    expect(second.close).not.toHaveBeenCalled()
    expect(second.listenerCount('looma:close-cancelled')).toBe(0)
  })
  it('cancels quit rather than discarding an unresponsive editor after timeout', async () => {
    vi.useFakeTimers()
    const win = new FakeWindow()
    const pending = prepareWindowsForQuit([win], 1_000)

    await vi.advanceTimersByTimeAsync(1_000)
    expect(await pending).toBe(false)

    expect(win.isReadyToClose).toBe(false)
    expect(win.close).not.toHaveBeenCalled()
    vi.useRealTimers()
  })
})
