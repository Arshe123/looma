import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'

const source = (path: string) => readFileSync(resolve(process.cwd(), `src/renderer/components/${path}.vue`), 'utf8')
const manager = source('templates/NoteTemplateManager')
const rag = source('rag/RagIndexPage')
const ai = source('settings/AiSettings')

// Exercise the actual handler without mounting its unrelated preview/editor dependencies.
const handler = (text: string, name: string, scope: Record<string, unknown>) => {
  const declaration = text.match(new RegExp(`const ${name} = async [\\s\\S]*?\\n}`))?.[0]
  if (!declaration) throw new Error(`Missing handler ${name}`)
  const code = ts.transpileModule(`${declaration}\nreturn ${name}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText
  return new Function(...Object.keys(scope), code)(...Object.values(scope))
}
const deferred = () => {
  let resolve!: (value: boolean) => void
  const promise = new Promise<boolean>(done => { resolve = done })
  return { promise, resolve }
}

const templateFixture = () => {
  const confirmation = deferred()
  const store = { revision: 1, templates: [{ id: 'a', name: '模板 A' }, { id: 'b', name: '模板 B' }] }
  const selectedId = { value: 'a' }
  const pending = { value: false }
  const remove = vi.fn(async () => ({ success: true, data: { revision: 2, templates: [] } }))
  const confirmMessageDialog = vi.fn(() => confirmation.promise)
  const removeSelected = handler(manager, 'removeSelected', {
    props: { store }, selectedId, pending, errorText: { value: '' },
    noteTemplatesApi: { remove }, confirmMessageDialog,
    window: { confirm: () => false },
    emit: vi.fn(), loadTemplate: vi.fn(), clearDraft: vi.fn(),
  })
  return { confirmation, store, selectedId, pending, remove, confirmMessageDialog, removeSelected }
}

describe('scoped shared message prompts', () => {
  it('uses shared dialogs rather than browser or Electron prompts', () => {
    for (const text of [manager, rag, ai]) {
      expect(text.includes("from '@/renderer/stores/message-dialog'")).toBe(true)
      expect(text.includes('window.confirm')).toBe(false)
      expect(text.includes('window.electronAPI.app.showMessageBox')).toBe(false)
    }
  })

  it('awaits template confirmation and deletes only the confirmed template and revision', async () => {
    const f = templateFixture()
    const task = f.removeSelected()
    expect(f.remove).not.toHaveBeenCalled()
    expect(f.confirmMessageDialog).toHaveBeenCalledWith(expect.objectContaining({
      title: '删除模板', confirmText: '删除模板', danger: true,
    }))
    f.confirmation.resolve(true)
    await task
    expect(f.remove).toHaveBeenCalledWith('a', 1)
  })

  it.each(['cancel', 'selection', 'revision', 'removed', 'pending'])('does not delete after %s while confirming', async change => {
    const f = templateFixture()
    const task = f.removeSelected()
    if (change === 'selection') f.selectedId.value = 'b'
    if (change === 'revision') f.store.revision = 2
    if (change === 'removed') f.store.templates.shift()
    if (change === 'pending') f.pending.value = true
    f.confirmation.resolve(change !== 'cancel')
    await task
    expect(f.remove).not.toHaveBeenCalled()
  })

  it.each(['buildIndex', 'deleteAllIndex', 'deleteFileIndex'])('%s revalidates the workspace after async confirmation', async name => {
    const confirmation = deferred()
    const activeWorkspaceId = { value: 'workspace-a' }
    const operation = vi.fn()
    const action = handler(rag, name, {
      activeWorkspaceId, indexActionsBusy: { value: false },
      confirmMessageDialog: () => confirmation.promise,
      window: { confirm: () => false, electronAPI: { rag: {
        deleteIndex: operation, indexFile: { delete: operation }, indexStream: { start: operation },
      } } },
    })
    const task = action(name === 'buildIndex' ? 'full' : 'note.md')
    activeWorkspaceId.value = 'workspace-b'
    confirmation.resolve(true)
    await task
    expect(operation).not.toHaveBeenCalled()
  })
})
