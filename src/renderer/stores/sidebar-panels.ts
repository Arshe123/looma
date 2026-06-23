import type { SidebarPanelId, SidebarPanelState } from './workspace-types'

export const SIDEBAR_PANEL_IDS: SidebarPanelId[] = ['files', 'outline', 'ai']
export const DEFAULT_ACTIVE_SIDEBAR_PANEL: SidebarPanelId = 'files'

export const isSidebarPanelId = (value: unknown): value is SidebarPanelId =>
  typeof value === 'string' && SIDEBAR_PANEL_IDS.includes(value as SidebarPanelId)

export const resolveActiveSidebarPanel = (
  activeSidebarPanel?: SidebarPanelId | null,
  legacyPanels?: SidebarPanelState[] | null,
): SidebarPanelId | null => {
  if (activeSidebarPanel === null) return null
  if (isSidebarPanelId(activeSidebarPanel)) return activeSidebarPanel

  const migratedPanel = (legacyPanels || []).find((panel) => isSidebarPanelId(panel?.id))
  return migratedPanel?.id || DEFAULT_ACTIVE_SIDEBAR_PANEL
}

export const toggleActiveSidebarPanel = (
  current: SidebarPanelId | null,
  next: SidebarPanelId,
): SidebarPanelId | null => (current === next ? null : next)
