import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useWorkspaceStore } from '../workspace'

const storage = new Map<string, string>()
const root = { dataset: {} as Record<string, string>, classList: { toggle: vi.fn() } }
const listeners = new Set<() => void>()
const media = {
  matches: false,
  addEventListener: (_event: string, listener: () => void) => listeners.add(listener),
  removeEventListener: (_event: string, listener: () => void) => listeners.delete(listener),
}

beforeEach(() => {
  setActivePinia(createPinia())
  storage.clear()
  root.dataset = {}
  root.classList.toggle.mockClear()
  media.matches = false
  listeners.clear()
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) })
  vi.stubGlobal('document', { documentElement: root })
  vi.stubGlobal('window', { matchMedia: () => media })
})
afterEach(() => { vi.unstubAllGlobals() })

describe('theme palette persistence', () => {
  it.each(['graphite', 'ocean'] as const)('applies and persists %s independently of mode, including system changes', (palette) => {
    const store = useWorkspaceStore()
    store.applyTheme()
    store.setThemePalette(palette)
    expect(store.theme).toBe('system')
    expect(root.dataset).toEqual({ theme: 'light', palette })
    expect(storage.get('looma.themePalette')).toBe(palette)
    expect(listeners.size).toBe(1)
    media.matches = true
    listeners.forEach((listener) => listener())
    expect(store.resolvedTheme).toBe('dark')
    expect(root.dataset).toEqual({ theme: 'dark', palette })
    expect(root.classList.toggle).toHaveBeenLastCalledWith('dark', true)
    store.setTheme('light')
    expect(store.themePalette).toBe(palette)
    expect(root.dataset).toEqual({ theme: 'light', palette })
    expect(listeners.size).toBe(0)
    setActivePinia(createPinia())
    const reloaded = useWorkspaceStore()
    expect(reloaded.themePalette).toBe(palette)
    expect(reloaded.theme).toBe('light')
    reloaded.restoreDefaultTheme()
    expect(reloaded.themePalette).toBe('paper')
    expect(reloaded.theme).toBe('system')
    expect(root.dataset).toEqual({ theme: 'dark', palette: 'paper' })
    expect(storage.get('theme')).toBe('system')
    expect(storage.get('looma.themePalette')).toBe('paper')
    reloaded.setTheme('light')
  })
  it.each([null, '', 'unknown', 'dark', '__proto__'])('falls back to 暮纸 for palette %s without changing legacy mode', (palette) => {
    storage.set('theme', 'dark')
    if (palette !== null) storage.set('looma.themePalette', palette)
    const store = useWorkspaceStore()
    expect(store.theme).toBe('dark')
    expect(store.themePalette).toBe('paper')
  })
  it('defaults to system mode and 暮纸', () => {
    const store = useWorkspaceStore()
    expect(store.theme).toBe('system')
    expect(store.themePalette).toBe('paper')
  })
})
