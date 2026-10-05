import { defineStore } from 'pinia'
import {
  defaultInlineMenuItems,
  normalizeInlineMenuItems,
} from '@/shared/utils/tiptap-menu-actions'
import {
  defaultAppSettings,
  normalizeAppSettings,
  type AppSettings,
} from '@/shared/utils/app-settings'
import {
  createDefaultEditorShortcutSettings,
  type EditorShortcutBinding,
} from '@/shared/utils/editor-shortcuts'
import {
  createDefaultAppShortcutSettings,
  type AppShortcutId,
} from '@/shared/utils/app-shortcuts'
import { normalizeRichTextZoom } from '@/shared/utils/rich-text-zoom'
import { normalizeFontPreset, type FontPreset } from '@/shared/utils/font-presets'

type NamedEditorShortcut =
  | 'headingLevelUp'
  | 'headingLevelDown'
  | 'bold'
  | 'italic'
  | 'strike'
  | 'inlineCode'
  | 'highlight'
type EditorShortcutTarget = NamedEditorShortcut | number

export const useSettingsStore = defineStore('settings', {
  state: () => ({
    settings: normalizeAppSettings(defaultAppSettings) as AppSettings,
    confirmedSettings: normalizeAppSettings(defaultAppSettings) as AppSettings,
    isLoaded: false,
    lastError: '',
    memorySettingsBusy: false,
    revision: -1,
    notifiedRevision: -1,
    stopSettingsListener: undefined as undefined | (() => void),
  }),

  getters: {
    autoMaintainUserProfile: (state) => state.settings.memory.autoMaintainUserProfile,
    fontPreset: (state) => state.settings.appearance.fontPreset,
    inlineMenuItems: (state) => state.settings.inlineMenu.items,
    showLineNumbers: (state) => state.settings.editor.showLineNumbers,
    richTextZoom: (state) => state.settings.editor.richTextZoom,
    editorShortcuts: (state) => state.settings.editor.shortcuts,
    appShortcuts: (state) => state.settings.editor.appShortcuts,
    aiSettings: (state) => state.settings.ai,
  },

  actions: {
    async setAutoMaintainUserProfile(value: boolean): Promise<boolean> {
      if (this.memorySettingsBusy) return false
      this.memorySettingsBusy = true
      this.lastError = ''
      try {
        const result = await window.electronAPI?.appSettings?.patch?.({ memory: { autoMaintainUserProfile: value } })
        if (!result?.success || !result.data) throw new Error(result?.error || '保存长期记忆设置失败，请重试。')
        this.acceptSettings(result.data, result.revision)
        return true
      } catch (error) {
        await this.load()
        this.lastError = error instanceof Error ? error.message : '保存长期记忆设置失败，请重试。'
        return false
      } finally { this.memorySettingsBusy = false }
    },
    async setFontPreset(preset: FontPreset) {
      this.settings.appearance.fontPreset = normalizeFontPreset(preset)
      await this.persist({ appearance: { fontPreset: this.settings.appearance.fontPreset } })
    },

    acceptSettings(settings: AppSettings, revision?: number) {
      if (revision === undefined || revision < Math.max(this.revision, this.notifiedRevision)) return
      this.revision = revision
      this.confirmedSettings = normalizeAppSettings(settings)
      this.settings = normalizeAppSettings(settings)
    },
    stopSync() {
      this.stopSettingsListener?.()
      this.stopSettingsListener = undefined
    },
    async load() {
      if (!this.stopSettingsListener) {
        this.stopSettingsListener = window.electronAPI?.appSettings?.onChanged?.(revision => {
          if (Number.isSafeInteger(revision)) this.notifiedRevision = Math.max(this.notifiedRevision, revision)
          void this.load()
        })
      }
      try {
        const result = await window.electronAPI?.appSettings?.get?.()
        if (result?.success && result.data) {
          this.acceptSettings(result.data, result.revision)
        } else {
          this.lastError = result?.error ?? ''
        }
      } catch (error: any) {
        this.lastError = error?.message ?? String(error)
      } finally {
        this.isLoaded = true
      }
    },

    async persist(patch: unknown) {
      this.lastError = ''
      try {
        const result = await window.electronAPI?.appSettings?.patch?.(patch)
        if (!result?.success || !result.data) throw new Error(result?.error || '保存系统设置失败')
        this.acceptSettings(result.data, result.revision)
      } catch (error) {
        this.settings = normalizeAppSettings(this.confirmedSettings)
        await this.load()
        this.lastError = error instanceof Error ? error.message : String(error)
      }
    },

    async addInlineMenuItem(id: string) {
      if (this.settings.inlineMenu.items.includes(id)) return
      this.settings.inlineMenu.items = normalizeInlineMenuItems([
        ...this.settings.inlineMenu.items,
        id,
      ])
      await this.persist({ inlineMenu: { items: this.settings.inlineMenu.items } })
    },

    async removeInlineMenuItem(id: string) {
      this.settings.inlineMenu.items = normalizeInlineMenuItems(
        this.settings.inlineMenu.items.filter((itemId) => itemId !== id),
      )
      await this.persist({ inlineMenu: { items: this.settings.inlineMenu.items } })
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
      await this.persist({ inlineMenu: { items: this.settings.inlineMenu.items } })
    },

    async resetInlineMenu() {
      this.settings.inlineMenu.items = defaultInlineMenuItems()
      await this.persist({ inlineMenu: { items: this.settings.inlineMenu.items } })
    },

    async setShowLineNumbers(value: boolean) {
      this.settings.editor.showLineNumbers = value
      await this.persist({ editor: { showLineNumbers: value } })
    },

    async setRichTextZoom(value: number) {
      this.settings.editor.richTextZoom = normalizeRichTextZoom(value)
      await this.persist({ editor: { richTextZoom: this.settings.editor.richTextZoom } })
    },

    async setEditorShortcut(target: EditorShortcutTarget, binding: EditorShortcutBinding) {
      if (typeof target === 'number') {
        if (target < 0 || target >= this.settings.editor.shortcuts.inlineMenuSlots.length) return
        this.settings.editor.shortcuts.inlineMenuSlots[target] = { ...binding }
      } else {
        this.settings.editor.shortcuts[target] = { ...binding }
      }
      await this.persist({ editor: { shortcuts: typeof target === 'number' ? { inlineMenuSlots: this.settings.editor.shortcuts.inlineMenuSlots } : { [target]: binding } } })
    },

    async setAppShortcut(target: AppShortcutId, binding: EditorShortcutBinding) {
      this.settings.editor.appShortcuts[target] = { ...binding, enabled: true }
      await this.persist({ editor: { appShortcuts: { [target]: this.settings.editor.appShortcuts[target] } } })
    },

    async resetEditorShortcuts() {
      this.settings.editor.shortcuts = createDefaultEditorShortcutSettings()
      this.settings.editor.appShortcuts = createDefaultAppShortcutSettings()
      await this.persist({ editor: { shortcuts: this.settings.editor.shortcuts, appShortcuts: this.settings.editor.appShortcuts } })
    },

    async setAiSettings(next: Partial<AppSettings['ai']>) {
      this.settings.ai = normalizeAppSettings({
        ...this.settings,
        ai: {
          ...this.settings.ai,
          ...next,
          chat: {
            ...this.settings.ai.chat,
            ...next.chat,
          },
          embedding: {
            ...this.settings.ai.embedding,
            ...next.embedding,
          },
        },
      }).ai
      await this.persist({ ai: next })
    },
  },
})
