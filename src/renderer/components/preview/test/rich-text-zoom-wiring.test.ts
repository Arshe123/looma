import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const readSource = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8')

describe('rich-text zoom wiring', () => {
  it('persists the zoom through editor settings', () => {
    const settingsStore = readSource('src/renderer/stores/settings.ts')
    const editorSettings = readSource('src/renderer/components/settings/EditorSettings.vue')

    expect(settingsStore).toContain('richTextZoom: (state) => state.settings.editor.richTextZoom')
    expect(settingsStore).toContain('async setRichTextZoom(value: number)')
    expect(editorSettings).toContain('settingsStore.setRichTextZoom')
    expect(editorSettings).toContain('settingsStore.richTextZoom }}%')
  })

  it('handles primary-modifier wheel zoom only in the rendered-note pane', () => {
    const markdownEditor = readSource('src/renderer/components/editor/MarkdownEditor.vue')

    expect(markdownEditor).toContain('isPrimaryModifierPressed(event, window.electronAPI.platform)')
    expect(markdownEditor).toContain('getNextRichTextZoom(settingsStore.richTextZoom, event.deltaY)')
    expect(markdownEditor).toContain('@wheel="handleRichTextZoomWheel"')
    expect(markdownEditor).toContain("'--rich-text-font-size': `${settingsStore.richTextZoom / 100}rem`")
    expect(markdownEditor).toContain('class="rich-text-zoom-scope')
  })

  it('shows the current percentage while wheel zooming', () => {
    const markdownEditor = readSource('src/renderer/components/editor/MarkdownEditor.vue')

    expect(markdownEditor).toContain('zoomIndicatorVisible.value = true')
    expect(markdownEditor).toContain('zoomIndicatorVisible.value = false')
    expect(markdownEditor).toContain('v-if="zoomIndicatorVisible"')
    expect(markdownEditor).toContain('{{ settingsStore.richTextZoom }}%')
    expect(markdownEditor).toContain('aria-live="polite"')
  })

  it('scales markdown text through reflow instead of transform or CSS zoom', () => {
    const styles = readSource('src/renderer/styles/style.css')

    expect(styles).toContain('.rich-text-zoom-scope .markdown-body')
    expect(styles).toContain('font-size: var(--rich-text-font-size, 1rem)')
    expect(styles).not.toContain('.rich-text-zoom-scope .markdown-body {\n  transform:')
    expect(styles).not.toContain('.rich-text-zoom-scope .markdown-body {\n  zoom:')
  })

  it('documents the wheel gesture and appearance setting', () => {
    const help = readSource('src/renderer/components/help/help.md')

    expect(help).toContain('按住 `Ctrl`（macOS 为 `Command`）并滚动滚轮')
    expect(help).toContain('设置 → 编辑器 → 编辑器外观')
  })
})
