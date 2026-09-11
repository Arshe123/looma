export const FONT_PRESETS = [
  { id: 'simple', label: '简洁统一', bodyFont: '思源黑体', description: '清晰克制，适合知识管理与技术笔记。' },
  { id: 'literary', label: '书卷阅读', bodyFont: '思源宋体', description: '纸书气质，适合长文阅读与随笔。' },
  { id: 'handwritten', label: '柔和手写', bodyFont: '霞鹜文楷', description: '柔和自然，适合日记与随手记录。' },
] as const

export type FontPreset = typeof FONT_PRESETS[number]['id']
export const DEFAULT_FONT_PRESET: FontPreset = 'handwritten'

export const normalizeFontPreset = (value: unknown): FontPreset =>
  FONT_PRESETS.find((preset) => preset.id === value)?.id ?? DEFAULT_FONT_PRESET
