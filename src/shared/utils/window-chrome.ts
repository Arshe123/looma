export const isMacPlatform = (platform: string) => platform === 'darwin'

export const getWindowChromeOptions = (platform: string) => {
  if (isMacPlatform(platform)) {
    return {
      frame: true,
      titleBarStyle: 'hiddenInset' as const,
      trafficLightPosition: { x: 14, y: 16 },
    }
  }

  return {
    frame: false,
    titleBarStyle: 'hidden' as const,
  }
}
