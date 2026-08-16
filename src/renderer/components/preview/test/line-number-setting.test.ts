import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const readSource = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8')

describe('rich-text line-number setting wiring', () => {
  it('exposes a persisted setting and passes it to the rich-text preview', () => {
    const settingsStore = readSource('src/renderer/stores/settings.ts')
    const editorSettings = readSource('src/renderer/components/settings/EditorSettings.vue')
    const markdownEditor = readSource('src/renderer/components/editor/MarkdownEditor.vue')

    expect(settingsStore).toContain('showLineNumbers: (state) => state.settings.editor.showLineNumbers')
    expect(settingsStore).toContain('async setShowLineNumbers(value: boolean)')
    expect(editorSettings).toContain('settingsStore.setShowLineNumbers(!settingsStore.showLineNumbers)')
    expect(markdownEditor).toContain(':show-line-numbers="settingsStore.showLineNumbers"')
  })

  it('hides numbers without removing the source-line anchors used by scroll sync', () => {
    const preview = readSource('src/renderer/components/preview/TiptapPreview.vue')

    expect(preview).toContain('showLineNumbers: boolean')
    expect(preview).toContain("'line-numbers-hidden': !props.showLineNumbers")
    expect(preview).toContain('.line-numbers-hidden .looma-line-number')
    expect(preview).toContain('visibility: hidden')
    expect(preview).toContain("querySelectorAll<HTMLElement>('.looma-line-number[data-line]')")
    expect(preview).not.toContain('.line-numbers-hidden .ProseMirror')
    expect(preview).not.toContain('.line-numbers-hidden .code-block-content')
  })

  it('documents where users can disable rich-text line numbers', () => {
    const help = readSource('src/renderer/components/help/help.md')

    expect(help).toContain('可在“设置 → 编辑器 → 编辑器外观”中关闭')
  })
})
