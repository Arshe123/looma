import { defineStore } from 'pinia'
import type { FloatingGraphCardBounds } from '@/renderer/utils/floating-graph-card'

export interface GraphNoteCard extends FloatingGraphCardBounds { path: string; edgeId: string; zIndex: number }

// The graph has its own world proportions. A sidebar is only a window onto it.
export const KNOWLEDGE_GRAPH_WORLD = { width: 1200, height: 800 } as const

export interface KnowledgeGraphView {
  camera: { x: number; y: number; scale: number }
  initialized: boolean
  selectedPath: string
  focused: boolean
  alwaysShowReferences: boolean
  query: string
  cards: GraphNoteCard[]
  cardPlacements: Record<string, FloatingGraphCardBounds>
}

export const useKnowledgeGraphViewStore = defineStore('knowledge-graph-view', {
  state: () => ({ views: {} as Record<string, KnowledgeGraphView> }),
  actions: {
    forWorkspace(id: string): KnowledgeGraphView {
      if (!this.views[id]) this.views[id] = {
        camera: { x: 16, y: 16, scale: 1 }, initialized: false,
        selectedPath: '', focused: false, alwaysShowReferences: false, query: '', cards: [], cardPlacements: {},
      }
      return this.views[id]
    },
  },
})
