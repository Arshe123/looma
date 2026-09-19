import { expect, it } from 'vitest'
import fs from 'node:fs'
const source = (file: string) => fs.readFileSync(new URL(`../../../../../${file}`, import.meta.url), 'utf8')
it('wires early OS delivery, isolated editor startup and registered md associations', () => {
  const main = source('src/main/index.ts')
  expect(main).toContain("app.on('open-file'")
  expect(main).toContain('markdownArguments(argv, cwd)')
  expect(main).toContain('editorOnly')
  expect(source('electron-builder.yml')).toContain('fileAssociations:')
  expect(source('resources/open-with.nsh')).toContain('OpenWithProgids')
  expect(source('resources/open-with.nsh')).not.toMatch(/WriteRegStr[^\n]*"Software\\Classes\\\.md"\s+""/)
  expect(source('src/preload/index.ts')).toContain('externalDocuments:')
  expect(source('src/renderer/App.vue')).toContain('externalDocuments.ready')
  expect(source('src/renderer/components/editor/MarkdownEditor.vue')).toContain('documentSession')
  expect(source('src/renderer/components/TopBar.vue')).toContain('externalDocuments.closeAll()')
  expect(main).toContain('if (!openedWorkspaceWindow) return true')
  expect(main).toContain('if (openWith.hasPending() || BrowserWindow.getAllWindows().length) return;')
})
