// Palette colors live only in styles/style.css; previews use those same selectors.
export const THEME_PALETTES = [
  { id: 'paper', label: '暮纸', description: '暖纸日间，柔和暮色' },
  { id: 'graphite', label: '石墨', description: '中性灰阶，专注书写' },
  { id: 'ocean', label: '海蓝', description: '清透海蓝，沉静夜色' },
] as const

export type ThemePalette = typeof THEME_PALETTES[number]['id']
export const DEFAULT_THEME_PALETTE: ThemePalette = 'paper'
export const THEME_PALETTE_STORAGE_KEY = 'looma.themePalette'

export const normalizeThemePalette = (value: unknown): ThemePalette =>
  THEME_PALETTES.find((palette) => palette.id === value)?.id ?? DEFAULT_THEME_PALETTE

export const getStoredThemePalette = (): ThemePalette =>
  normalizeThemePalette(typeof localStorage === 'undefined' ? null : localStorage.getItem(THEME_PALETTE_STORAGE_KEY))
