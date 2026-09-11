import { watch } from 'vue'
import type { FontPreset } from '@/shared/utils/font-presets'

// Called during app setup so Vue disposes the watcher with the application.
export const watchFontPreset = (getPreset: () => FontPreset) =>
  watch(getPreset, (preset) => {
    document.documentElement.dataset.fontPreset = preset
  }, { immediate: true })
