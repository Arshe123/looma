export const childSignalForParentSignal = (signal, platform = process.platform) => {
  if (signal === 'SIGINT' && platform !== 'win32') return null
  return signal
}

export const isChildRunning = (child) =>
  Boolean(child && child.exitCode == null && child.signalCode == null)
