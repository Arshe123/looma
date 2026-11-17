import { beforeEach, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { KNOWLEDGE_GRAPH_WORLD, useKnowledgeGraphViewStore } from '../knowledge-graph-view'

beforeEach(() => { setActivePinia(createPinia()) })
it('retains the camera, reference preference and pinned cards when reopening a workspace graph', () => {
  const store = useKnowledgeGraphViewStore()
  const view = store.forWorkspace('notes')
  view.camera = { x: -380, y: -250, scale: .85 }
  view.initialized = true
  view.alwaysShowReferences = true
  view.cards.push({ path: '设计/a.md', x: -140, y: 300, width: 420, height: 360, edgeId: '', zIndex: 1 })
  view.cardPlacements['设计/a.md'] = { x: -140, y: 300, width: 420, height: 360 }
  expect(store.forWorkspace('notes')).toBe(view)
  expect(store.forWorkspace('notes').alwaysShowReferences).toBe(true)
  expect(store.forWorkspace('notes').camera).toEqual({ x: -380, y: -250, scale: .85 })
  expect(store.forWorkspace('notes').cards[0]).toMatchObject({ x: -140, y: 300, width: 420, height: 360 })
  expect(store.forWorkspace('notes').cardPlacements['设计/a.md']).toMatchObject({ x: -140, y: 300, width: 420, height: 360 })
  expect(KNOWLEDGE_GRAPH_WORLD).toEqual({ width: 1200, height: 800 })
})
it('isolates the camera and selection of different workspaces', () => {
  const store = useKnowledgeGraphViewStore()
  store.forWorkspace('a').selectedPath = 'a.md'
  store.forWorkspace('a').camera.scale = 2
  store.forWorkspace('a').alwaysShowReferences = true
  expect(store.forWorkspace('b').selectedPath).toBe('')
  expect(store.forWorkspace('b').camera.scale).toBe(1)
  expect(store.forWorkspace('b').initialized).toBe(false)
  expect(store.forWorkspace('b').alwaysShowReferences).toBe(false)
})
