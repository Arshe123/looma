import { describe, expect, it } from 'vitest'

describe('FileTree file display', () => {
  it('renders file names without extensions and file extensions as right-side badges', async () => {
    const fs = process.getBuiltinModule('fs/promises')
    const fileTree = await fs.readFile(new URL('../../components/FileTree.vue', import.meta.url), 'utf-8')

    expect(fileTree).toContain('getDisplayName')
    expect(fileTree).toContain('getDisplayExt')
    expect(fileTree).toContain('shouldShowEntry')
    expect(fileTree).toContain("entry.name === '.gitignore'")
    expect(fileTree).toContain("!entry.name.startsWith('.')")
    expect(fileTree).toContain('entries.filter(shouldShowEntry)')
    expect(fileTree).toContain('{{ getDisplayName(row) }}')
    expect(fileTree).toContain('v-if="getDisplayExt(row) && getDisplayExt(row) !== \'.md\'"')
    expect(fileTree).toContain('{{ getDisplayExt(row) }}')
    expect(fileTree).not.toContain('{{ row.name }}')
  })
})
