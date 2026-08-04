export const SIDEBAR_WIDTH_STORAGE_KEY = 'looma.sidebarWidth'
export const DEFAULT_SIDEBAR_WIDTH = 320
export const SIDEBAR_TOOLBAR_WIDTH = 56
export const MIN_SIDEBAR_PANEL_WIDTH = 180
export const MIN_EXPANDED_SIDEBAR_WIDTH = SIDEBAR_TOOLBAR_WIDTH + MIN_SIDEBAR_PANEL_WIDTH
export const MIN_MAIN_CONTENT_WIDTH = 360

export const parseStoredSidebarWidth = (rawValue: string | null) => {
  if (rawValue === null || rawValue.trim() === '') return DEFAULT_SIDEBAR_WIDTH
  const parsed = Number(rawValue)
  return Number.isFinite(parsed) ? parsed : DEFAULT_SIDEBAR_WIDTH
}

export const clampExpandedSidebarWidth = (width: number, viewportWidth: number) => {
  const maxWidth = Math.max(MIN_EXPANDED_SIDEBAR_WIDTH, viewportWidth - MIN_MAIN_CONTENT_WIDTH)
  return Math.min(Math.max(width, MIN_EXPANDED_SIDEBAR_WIDTH), maxWidth)
}

export const shouldCloseSidebarOnResize = (pointerX: number, isOpen: boolean) =>
  isOpen && pointerX < MIN_EXPANDED_SIDEBAR_WIDTH

export const shouldOpenSidebarOnResize = (pointerX: number, isOpen: boolean) =>
  !isOpen && pointerX >= MIN_EXPANDED_SIDEBAR_WIDTH
