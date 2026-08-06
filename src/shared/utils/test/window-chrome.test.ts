import { describe, expect, it } from 'vitest'
import { getWindowChromeOptions, isMacPlatform } from '../window-chrome'

describe('window chrome', () => {
  it('uses native inset traffic lights on macOS', () => {
    expect(getWindowChromeOptions('darwin')).toEqual({
      frame: true,
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 14, y: 16 },
    })
    expect(isMacPlatform('darwin')).toBe(true)
  })

  it('keeps the custom frameless chrome on Windows and Linux', () => {
    expect(getWindowChromeOptions('win32')).toEqual({ frame: false, titleBarStyle: 'hidden' })
    expect(getWindowChromeOptions('linux')).toEqual({ frame: false, titleBarStyle: 'hidden' })
    expect(isMacPlatform('win32')).toBe(false)
  })
})
