export const shouldUseManualUpdate = (platform: string) => platform === 'darwin'

export const shouldAutoCheckUpdates = (platform: string, isPackaged: boolean) =>
  isPackaged && (platform === 'win32' || platform === 'darwin')
