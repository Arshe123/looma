import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const readSource = (file: string) => readFileSync(resolve(process.cwd(), file), 'utf8')

describe('file-tree note template entry wiring', () => {
  it('opens the template dialog from the header and shortcut event while keeping context-menu creation inline', () => {
    const fileTree = readSource('src/renderer/components/FileTree.vue')

    expect(fileTree).toContain("import NoteTemplateDialog from './templates/NoteTemplateDialog.vue'")
    expect(fileTree).toContain('@click="openNoteTemplateDialog"')
    expect(fileTree).toContain('const onCreateFileRequest = () => openNoteTemplateDialog()')
    expect(fileTree).toContain('@click="addFile"')
    expect(fileTree).toContain('await startCreateFile(selectedFile.value)')
    expect(fileTree).toContain('if (noteTemplateDialogOpen.value) return')
    expect(fileTree).toContain("noteTemplateWorkspaceId.value = workspaceStore.activeWorkspaceId || ''")
    expect(fileTree).toContain(':workspace-id="noteTemplateWorkspaceId"')
  })

  it('documents that only the header and shortcut open the template picker', () => {
    const help = readSource('src/renderer/components/help/help.md')

    expect(help).toContain('笔记模板')
    expect(help).toContain('文件树标题栏')
    expect(help).toContain('Ctrl/Cmd+N')
    expect(help).toContain('右键菜单')
  })
})
