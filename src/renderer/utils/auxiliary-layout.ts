import { MIN_MAIN_CONTENT_WIDTH } from './sidebar-layout'

export const AUXILIARY_WIDTH_STORAGE_KEY = 'looma.auxiliaryWidth'
export const parseAuxiliaryWidth = (value: string | null) => {
  const width = Number(value)
  return Number.isFinite(width) && width > 0 ? width : 360
}

export const clampAuxiliaryWidth = (width: number, viewportWidth: number, sidebarWidth: number) => {
  // Desktop: right padding (12), left divider (8), right divider (8).
  const maxWidth = Math.max(0, viewportWidth <= 1100
    ? viewportWidth - 76
    : viewportWidth - sidebarWidth - MIN_MAIN_CONTENT_WIDTH - 28)
  return Math.min(Math.max(280, width), maxWidth)
}
