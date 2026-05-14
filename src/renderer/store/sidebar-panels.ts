import type { SidebarPanelId, SidebarPanelState } from './workspace-types'

export const SIDEBAR_PANEL_IDS: SidebarPanelId[] = ['files', 'outline']
export const DEFAULT_SIDEBAR_PANELS: SidebarPanelState[] = [{ id: 'files', size: 1 }]
const minPanelSize = 0.15

const roundSize = (size: number) => Math.round(size * 10000) / 10000

export const equalizeSidebarPanels = (panels: SidebarPanelState[]) => {
  if (panels.length === 0) return [] as SidebarPanelState[]
  const size = roundSize(1 / panels.length)
  const next = panels.map((panel) => ({ id: panel.id, size }))
  next[next.length - 1].size = roundSize(1 - size * (next.length - 1))
  return next
}

export const normalizeSidebarPanels = (panels?: SidebarPanelState[] | null): SidebarPanelState[] => {
  const seen = new Set<SidebarPanelId>()
  const valid = (panels || []).filter((panel): panel is SidebarPanelState => {
    if (!panel || !SIDEBAR_PANEL_IDS.includes(panel.id) || seen.has(panel.id)) return false
    seen.add(panel.id)
    return Number.isFinite(panel.size) && panel.size > 0
  })

  if (valid.length === 0) return DEFAULT_SIDEBAR_PANELS.map((panel) => ({ ...panel }))

  const total = valid.reduce((sum, panel) => sum + panel.size, 0)
  if (total <= 0) return equalizeSidebarPanels(valid)
  return valid.map((panel) => ({ id: panel.id, size: roundSize(panel.size / total) }))
}

export const toggleSidebarPanel = (panels: SidebarPanelState[], id: SidebarPanelId): SidebarPanelState[] => {
  if (panels.length === 0) return [{ id, size: 1 }]
  const normalized = normalizeSidebarPanels(panels)
  const exists = normalized.some((panel) => panel.id === id)
  const next = exists
    ? normalized.filter((panel) => panel.id !== id)
    : [...normalized, { id, size: 1 }]

  if (next.length === 0) return []
  return equalizeSidebarPanels(next)
}

export const resizeSidebarPanels = (
  panels: SidebarPanelState[],
  beforeIndex: number,
  deltaRatio: number,
): SidebarPanelState[] => {
  const next = normalizeSidebarPanels(panels)
  const afterIndex = beforeIndex + 1
  if (!next[beforeIndex] || !next[afterIndex]) return next

  const before = next[beforeIndex]
  const after = next[afterIndex]
  const pairTotal = before.size + after.size
  const minSize = Math.min(minPanelSize, pairTotal / 2)
  const nextBeforeSize = Math.min(Math.max(before.size + deltaRatio, minSize), pairTotal - minSize)
  const nextAfterSize = pairTotal - nextBeforeSize

  next[beforeIndex] = { id: before.id, size: roundSize(nextBeforeSize) }
  next[afterIndex] = { id: after.id, size: roundSize(nextAfterSize) }
  return normalizeSidebarPanels(next)
}

export const reorderSidebarPanels = (
  panels: SidebarPanelState[],
  fromIndex: number,
  toIndex: number,
): SidebarPanelState[] => {
  const next = normalizeSidebarPanels(panels)
  if (!next[fromIndex] || !next[toIndex] || fromIndex === toIndex) return next
  const [moved] = next.splice(fromIndex, 1)
  next.splice(toIndex, 0, moved)
  return next
}
