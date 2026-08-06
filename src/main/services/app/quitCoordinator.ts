type QuitWindow = {
  isDestroyed: () => boolean
  once: (event: 'closed', listener: () => void) => unknown
  removeListener: (event: 'closed', listener: () => void) => unknown
  close: () => void
  webContents: { send: (channel: string) => void }
  isReadyToClose?: boolean
}

const prepareWindowForQuit = (win: QuitWindow, timeoutMs: number) => {
  if (win.isDestroyed()) return Promise.resolve()

  return new Promise<void>((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const finish = () => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      win.removeListener('closed', finish)
      resolve()
    }

    const forceClose = () => {
      if (!win.isDestroyed()) {
        win.isReadyToClose = true
        try {
          win.close()
        } catch {}
      }
      finish()
    }

    win.once('closed', finish)
    timer = setTimeout(forceClose, timeoutMs)

    try {
      win.webContents.send('window:prepare-close')
    } catch {
      forceClose()
    }
  })
}

export const prepareWindowsForQuit = (windows: QuitWindow[], timeoutMs = 10_000) =>
  Promise.all(windows.map((win) => prepareWindowForQuit(win, timeoutMs))).then(() => undefined)
