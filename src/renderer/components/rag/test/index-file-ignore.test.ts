import { readFileSync } from 'node:fs'
import ts from 'typescript'
import * as Vue from 'vue'
import { computed, ref } from 'vue'
import { compile } from '@vue/compiler-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

const source = readFileSync(new URL('../RagIndexPage.vue', import.meta.url), 'utf8')
const script = source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)![1].replace(/^import .*$/gm, '')
const names = ts.createSourceFile('page.ts', script, ts.ScriptTarget.Latest, true).statements
  .filter(ts.isVariableStatement)
  .flatMap(statement => statement.declarationList.declarations.map(declaration => declaration.name.getText()))
const code = ts.transpileModule(`${script}\nreturn { ${names.join(', ')} }`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText
const template = source.slice(source.indexOf('<template>') + '<template>'.length, source.lastIndexOf('</template>'))
const render = new Function('Vue', compile(template, { mode: 'function', prefixIdentifiers: true }).code)({
  // Child components and DOM directives are outside these VNode contract tests.
  ...Vue, resolveComponent: () => ({}), withDirectives: (node: unknown) => node,
})
const textOf = (node: any): string => typeof node === 'string' ? node
  : node?.type === Vue.Comment ? ''
    : Array.isArray(node?.children) ? node.children.map(textOf).join('') : typeof node?.children === 'string' ? node.children : ''
const buttons = (node: any): any[] => [
  ...(node?.type === 'button' ? [node] : []),
  ...(Array.isArray(node?.children) ? node.children.flatMap(buttons) : []),
]
const renderedButtons = (page: any) => buttons(render(Vue.proxyRefs(page), []))
const setup = () => {
  const rag = {
    status: vi.fn().mockResolvedValue({ success: true, data: { exists: true, files: [] } }),
    indexFile: {
      ignore: vi.fn().mockResolvedValue({ success: true, data: { success: true } }),
      unignore: vi.fn().mockResolvedValue({ success: true, data: { success: true } }),
      chunks: vi.fn().mockResolvedValue({ success: true, data: { chunks: [] } }),
      reindex: vi.fn().mockResolvedValue({ success: true, data: {} }),
      delete: vi.fn().mockResolvedValue({ success: true }),
    },
    indexStream: { start: vi.fn().mockResolvedValue({ success: true }) },
    deleteIndex: vi.fn().mockResolvedValue({ success: true }),
  }
  vi.stubGlobal('window', { electronAPI: { rag }, confirm: vi.fn(() => true), setInterval: vi.fn(), clearInterval: vi.fn(), setTimeout: vi.fn() })
  const noop = () => {}
  const page = new Function('ref', 'computed', 'watch', 'onMounted', 'onBeforeUnmount', 'useWorkspaceStore', 'scaleFileSize', code)(
    ref, computed, noop, noop, noop, () => ({ activeWorkspaceId: 'ws', activeWorkspace: { name: 'Workspace' } }), noop,
  )
  return { page, rag }
}
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
afterEach(() => { vi.unstubAllGlobals() })

describe('manual file ignore page', () => {
  it('renders ignore only for active files and unignore only in the ignored filter', async () => {
    const { page, rag } = setup()
    page.status.value = { files: ['indexed', 'not_indexed', 'outdated', 'failed', 'deleted', 'ignored'].map(status => ({ path: `${status}.md`, status })) }
    const active = renderedButtons(page).filter(button => textOf(button).trim() === '忽略')
    expect(active).toHaveLength(4)
    expect(active.every(button => !button.props.disabled)).toBe(true)
    page.statusFilter.value = 'ignored'
    const ignored = renderedButtons(page).filter(button => textOf(button).trim() === '取消忽略')
    expect(ignored).toHaveLength(1)
    const event = { stopPropagation: vi.fn() }
    await active[0].props.onClick(event)
    expect(rag.indexFile.ignore).toHaveBeenCalledWith('ws', 'indexed.md')
    await ignored[0].props.onClick(event)
    expect(rag.indexFile.unignore).toHaveBeenCalledWith('ws', 'ignored.md')
    expect(event.stopPropagation).toHaveBeenCalledTimes(2)
  })

  it.each(['ignoring', 'building', 'reindexing'])('disables conflicting buttons while %s', async (state) => {
    const { page } = setup()
    page.status.value = { files: [{ path: 'a.md', status: 'indexed' }, { path: 'deleted.md', status: 'deleted' }] }
    page.ignoringFilePath.value = state === 'ignoring' ? 'a.md' : ''
    page.isBuilding.value = state === 'building'
    page.reindexingFilePath.value = state === 'reindexing' ? 'a.md' : ''
    const actions = renderedButtons(page).filter(button => ['刷新状态', '增量更新', '重试失败', '全量重建', '删除全部索引', '重建', '重建中', '忽略', '处理中', '清理'].includes(textOf(button).trim()))
    expect(actions.length).toBeGreaterThanOrEqual(7)
    expect(actions.every(button => button.props.disabled)).toBe(true)
  })

  it('discards chunks returned after ignoring their file', async () => {
    const { page, rag } = setup()
    const chunks = deferred<any>()
    rag.indexFile.chunks.mockReturnValue(chunks.promise)
    const file = { path: 'docs/a.md', status: 'indexed' }
    const loading = page.openFileChunks(file)
    await page.setFileIgnored(file)
    chunks.resolve({ success: true, data: { chunks: [{ text: 'deleted vector' }] } })
    await loading
    expect(page.selectedFile.value).toBeNull()
    expect(page.fileChunks.value).toEqual([])
  })

  it.each(['ignore', 'unignore'] as const)('blocks conflicting actions until %s and its refresh finish', async (action) => {
    const { page, rag } = setup()
    const operation = deferred<any>()
    const refresh = deferred<any>()
    rag.indexFile[action].mockReturnValue(operation.promise)
    rag.status.mockReturnValue(refresh.promise)
    const file = { path: 'docs/a.md', status: action === 'ignore' ? 'indexed' : 'ignored' }
    const pending = page.setFileIgnored(file)
    void page.setFileIgnored(file)
    await page.buildIndex('incremental')
    await page.reindexFile('other.md')
    await page.deleteFileIndex('deleted.md')
    await page.deleteAllIndex()
    await page.openFileChunks({ path: 'other.md', status: 'indexed' })
    expect(rag.indexFile[action]).toHaveBeenCalledTimes(1)
    expect(rag.indexStream.start).not.toHaveBeenCalled()
    expect(rag.indexFile.reindex).not.toHaveBeenCalled()
    expect(rag.indexFile.delete).not.toHaveBeenCalled()
    expect(rag.deleteIndex).not.toHaveBeenCalled()
    expect(rag.indexFile.chunks).not.toHaveBeenCalled()
    operation.resolve({ success: true, data: { success: true } })
    await Promise.resolve()
    await page.buildIndex('incremental')
    expect(rag.indexStream.start).not.toHaveBeenCalled()
    refresh.resolve({ success: true, data: { files: [] } })
    await pending
    await page.buildIndex('incremental')
    expect(rag.indexStream.start).toHaveBeenCalledTimes(1)
  })

  it.each(['building', 'reindexing', 'deleted'])('does not ignore during %s', async (state) => {
    const { page, rag } = setup()
    page.isBuilding.value = state === 'building'
    page.reindexingFilePath.value = state === 'reindexing' ? 'other.md' : ''
    await page.setFileIgnored({ path: 'docs/a.md', status: state === 'deleted' ? 'deleted' : 'indexed' })
    expect(rag.indexFile.ignore).not.toHaveBeenCalled()
  })

  it('unignores without rebuilding and refreshes status', async () => {
    const { page, rag } = setup()
    await page.setFileIgnored({ path: 'docs/a.md', status: 'ignored' })
    expect(rag.indexFile.unignore).toHaveBeenCalledWith('ws', 'docs/a.md')
    expect(rag.indexFile.ignore).not.toHaveBeenCalled()
    expect(rag.indexFile.reindex).not.toHaveBeenCalled()
    expect(rag.indexStream.start).not.toHaveBeenCalled()
    expect(rag.status).toHaveBeenCalledWith('ws')
  })

  it('shows a Chinese error when unignore fails', async () => {
    const { page, rag } = setup()
    rag.indexFile.unignore.mockResolvedValue({ success: true, data: { success: false } })
    await page.setFileIgnored({ path: 'docs/a.md', status: 'ignored' })
    expect(page.errorText.value).toMatch(/取消忽略.*失败/)
    expect(rag.status).not.toHaveBeenCalled()
  })

  it.each([
    { success: false, error: 'offline' },
    { success: true, data: { error: 'cannot remove vectors' } },
    { success: true, data: { success: false } },
  ])('keeps the drawer and shows a Chinese error when ignore fails: %j', async (result) => {
    const { page, rag } = setup()
    rag.indexFile.ignore.mockResolvedValue(result as any)
    const file = { path: 'docs/a.md', status: 'indexed' }
    page.selectedFile.value = file
    page.fileChunks.value = [{ text: 'still indexed' }]
    await page.setFileIgnored(file)
    expect(page.errorText.value).toMatch(/忽略.*失败/)
    expect(rag.status).not.toHaveBeenCalled()
    expect(page.selectedFile.value).toEqual(file)
    expect(page.fileChunks.value).toEqual([{ text: 'still indexed' }])
  })

  it('shows a Chinese error when ignore throws', async () => {
    const { page, rag } = setup()
    rag.indexFile.ignore.mockRejectedValue(new Error('offline'))
    await page.setFileIgnored({ path: 'docs/a.md', status: 'indexed' })
    expect(page.errorText.value).toBe('忽略文件失败：offline')
  })

  it('ignores a file, closes its chunk drawer and refreshes status after success', async () => {
    const { page, rag } = setup()
    expect(page.setFileIgnored).toBeTypeOf('function')
    const file = { path: 'docs/a.md', status: 'indexed' }
    page.selectedFile.value = file
    page.fileChunks.value = [{ id: 'old', text: 'removed vectors' }]
    await page.setFileIgnored(file)
    expect(rag.indexFile.ignore).toHaveBeenCalledWith('ws', 'docs/a.md')
    expect(rag.status).toHaveBeenCalledWith('ws')
    expect(page.selectedFile.value).toBeNull()
    expect(page.fileChunks.value).toEqual([])
    expect(page.errorText.value).toBe('')
  })
})
