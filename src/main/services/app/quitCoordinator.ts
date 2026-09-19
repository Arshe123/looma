type QuitWindow = {
  isDestroyed: () => boolean
  once: (event: string, listener: () => void) => unknown
  removeListener: (event: string, listener: () => void) => unknown
  close: () => void
  webContents: { send: (channel: string) => void }
  isReadyToClose?: boolean
}

const prepareWindowForQuit = (win: QuitWindow, timeoutMs: number, signal: AbortSignal) => {
  if (signal.aborted) return Promise.resolve(false)
  if (win.isDestroyed()) return Promise.resolve(true)

  return new Promise<boolean>((resolve) => {
    let settled = false
    // eslint-disable-next-line prefer-const -- timer 在闭包注册后延迟赋值，保持 undefined 初始态（TDZ 安全）
    let timer: ReturnType<typeof setTimeout> | undefined

    const finish = (accepted = true) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      win.removeListener('closed', finish)
      win.removeListener('looma:close-pending', pending)
      win.removeListener('looma:close-cancelled', cancel)
      signal.removeEventListener('abort', cancel)
      resolve(accepted)
    }

    const pending = () => { if (timer) clearTimeout(timer) }
    const cancel = () => finish(false)
    // Missing acknowledgement is not permission to discard unsaved content.
    const cancelUnresponsive = () => finish(false)

    signal.addEventListener('abort', cancel, { once: true })
    win.once('closed', finish)
    win.once('looma:close-pending', pending)
    win.once('looma:close-cancelled', cancel)
    timer = setTimeout(cancelUnresponsive, timeoutMs)

    try {
      win.webContents.send('window:prepare-close')
    } catch {
      cancelUnresponsive()
    }
  })
}

export const prepareWindowsForQuit = (windows: QuitWindow[], timeoutMs = 10_000) => {
  const cancellation = new AbortController()
  return Promise.all(windows.map(async win => {
    const accepted = await prepareWindowForQuit(win, timeoutMs, cancellation.signal)
    if (!accepted) cancellation.abort()
    return accepted
  })).then(results => results.every(Boolean))
}
