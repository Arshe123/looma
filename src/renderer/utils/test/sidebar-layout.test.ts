import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SIDEBAR_WIDTH,
  MIN_EXPANDED_SIDEBAR_WIDTH,
  MIN_SIDEBAR_PANEL_WIDTH,
  SIDEBAR_TOOLBAR_WIDTH,
  clampExpandedSidebarWidth,
  parseStoredSidebarWidth,
  shouldCloseSidebarOnResize,
  shouldOpenSidebarOnResize,
} from '../sidebar-layout'

describe('sidebar layout', () => {
  it('uses the default width when no persisted width exists', () => {
    expect(parseStoredSidebarWidth(null)).toBe(DEFAULT_SIDEBAR_WIDTH)
    expect(parseStoredSidebarWidth('')).toBe(DEFAULT_SIDEBAR_WIDTH)
    expect(parseStoredSidebarWidth('invalid')).toBe(DEFAULT_SIDEBAR_WIDTH)
  })

  it('keeps an expanded panel wide enough to remain usable', () => {
    expect(MIN_EXPANDED_SIDEBAR_WIDTH).toBe(SIDEBAR_TOOLBAR_WIDTH + MIN_SIDEBAR_PANEL_WIDTH)
    expect(clampExpandedSidebarWidth(0, 1200)).toBe(MIN_EXPANDED_SIDEBAR_WIDTH)
  })

  it('closes only when an open sidebar is dragged below its minimum width', () => {
    expect(shouldCloseSidebarOnResize(MIN_EXPANDED_SIDEBAR_WIDTH, true)).toBe(false)
    expect(shouldCloseSidebarOnResize(MIN_EXPANDED_SIDEBAR_WIDTH - 1, true)).toBe(true)
    expect(shouldCloseSidebarOnResize(MIN_EXPANDED_SIDEBAR_WIDTH - 1, false)).toBe(false)
  })

  it('reopens only when a closed sidebar is dragged to its minimum width', () => {
    expect(shouldOpenSidebarOnResize(MIN_EXPANDED_SIDEBAR_WIDTH - 1, false)).toBe(false)
    expect(shouldOpenSidebarOnResize(MIN_EXPANDED_SIDEBAR_WIDTH, false)).toBe(true)
    expect(shouldOpenSidebarOnResize(MIN_EXPANDED_SIDEBAR_WIDTH, true)).toBe(false)
  })
})