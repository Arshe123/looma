import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const component = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

describe('三条正文焦点接线', () => {
  for (const path of ['../../../renderer/components/editor/Editor.vue', '../../../renderer/components/preview/TiptapPreview.vue', '../../../renderer/components/preview/ChunkedMarkdownPreview.vue']) {
    it(`${path} 点击捕获独立于 selection 更新，KeepAlive 禁止后台通知`, () => {
      const source = component(path)
      expect(source).toContain("from '@/shared/utils/editor-focus'")
      expect(source).toContain('relativeFilePath')
      expect(source).toContain("addEventListener('click', handleEditorFocusClick, true)")
      expect(source).toContain("removeEventListener('click', handleEditorFocusClick, true)")
      expect(source).toContain('onActivated(() => { editorFocusActive = true })')
      expect(source).toContain('onDeactivated(() => { editorFocusActive = false })')
      expect(source).toContain('if (!editorFocusActive')
    })
  }
  it('可编辑正文随键盘选区变化更新，仅限真实焦点且非外部内容替换', () => {
    const cm = component('../../../renderer/components/editor/Editor.vue')
    expect(cm).toMatch(/update\.selectionSet[\s\S]*publishEditorFocus\(update\.view\)/)
    expect(cm).toContain('!view.hasFocus || applyingExternalUpdate')
    const tiptap = component('../../../renderer/components/preview/TiptapPreview.vue')
    expect(tiptap).toContain('onSelectionUpdate: () => publishSelectionFocus()')
    expect(tiptap).toContain('!currentEditor.isFocused || isUpdatingFromExternal')
  })
})
