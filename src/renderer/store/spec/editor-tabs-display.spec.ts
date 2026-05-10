import { describe, expect, it } from 'vitest'

describe('EditorTabs file display', () => {
  it('renders tab labels with file names without extensions', async () => {
    const fs = process.getBuiltinModule('fs/promises')
    const editorTabs = await fs.readFile(new URL('../../components/EditorTabs.vue', import.meta.url), 'utf-8')

    expect(editorTabs).toContain('getTabDisplayName')
    expect(editorTabs).toContain('const fileName = relPath.split')
    expect(editorTabs).toContain('return ext ? fileName.slice(0, -ext.length) : fileName')
    expect(editorTabs).toContain('{{ getTabDisplayName(relPath) }}')
    expect(editorTabs).not.toContain('{{ relPath.split(\'/\').pop() }}')
  })
})
