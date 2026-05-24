import { defineStore } from 'pinia'
import {
  defaultAppSettings,
  defaultInlineMenuItems,
  normalizeAppSettings,
  normalizeInlineMenuItems,
  type AppSettings,
} from '@/common/util/tiptap-menu-actions'

export const useSettingsStore = defineStore('settings', {
  state: () => ({
    settings: normalizeAppSettings(defaultAppSettings) as AppSettings,
    isLoaded: false,
    lastError: '',
  }),

  getters: {
    inlineMenuItems: (state) => state.settings.inlineMenu.items,
    aiSettings: (state) => state.settings.ai,
  },

  actions: {
    async load() {
      try {
        const result = await window.electronAPI?.appSettings?.get?.()
        if (result?.success && result.data) {
          this.settings = normalizeAppSettings(result.data)
        } else {
          this.settings = normalizeAppSettings(defaultAppSettings)
          this.lastError = result?.error ?? ''
        }
      } catch (error: any) {
        this.settings = normalizeAppSettings(defaultAppSettings)
        this.lastError = error?.message ?? String(error)
      } finally {
        this.isLoaded = true
      }
    },

    async persist() {
      const normalized = normalizeAppSettings(this.settings)
      this.settings = normalized
      const result = await window.electronAPI?.appSettings?.set?.(normalized)
      if (result && !result.success) this.lastError = result.error ?? '保存系统设置失败'
    },

    async addInlineMenuItem(id: string) {
      if (this.settings.inlineMenu.items.includes(id)) return
      this.settings.inlineMenu.items = normalizeInlineMenuItems([
        ...this.settings.inlineMenu.items,
        id,
      ])
      await this.persist()
    },

    async removeInlineMenuItem(id: string) {
      this.settings.inlineMenu.items = normalizeInlineMenuItems(
        this.settings.inlineMenu.items.filter((itemId) => itemId !== id),
      )
      await this.persist()
    },

    async moveInlineMenuItem(fromIndex: number, toIndex: number) {
      const items = [...this.settings.inlineMenu.items]
      if (
        fromIndex < 0 ||
        toIndex < 0 ||
        fromIndex >= items.length ||
        toIndex >= items.length ||
        fromIndex === toIndex
      ) {
        return
      }
      const [item] = items.splice(fromIndex, 1)
      items.splice(toIndex, 0, item)
      this.settings.inlineMenu.items = normalizeInlineMenuItems(items)
      await this.persist()
    },

    async resetInlineMenu() {
      this.settings.inlineMenu.items = defaultInlineMenuItems()
      await this.persist()
    },

    async setAiSettings(next: Partial<AppSettings['ai']>) {
      this.settings.ai = normalizeAppSettings({
        ...this.settings,
        ai: {
          ...this.settings.ai,
          ...next,
          provider: 'ollama',
        },
      }).ai
      await this.persist()
    },
  },
})
