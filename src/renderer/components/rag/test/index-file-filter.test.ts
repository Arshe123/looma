import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { computed, ref } from 'vue'
import { describe, expect, it } from 'vitest'

type IndexStatus = 'indexed' | 'not_indexed' | 'outdated' | 'deleted' | 'failed' | 'ignored'
type IndexFile = { path: string; status: IndexStatus }

// Exercise the page's real computed filter without mounting stores or IPC.
const source = readFileSync(new URL('../RagIndexPage.vue', import.meta.url), 'utf8')
const declaration = source.match(/const filteredFiles = computed\(\(\) => \{[\s\S]*?\n}\)/)?.[0]
if (!declaration) throw new Error('未找到索引文件筛选逻辑')
const { outputText } = ts.transpileModule(`${declaration}\nreturn filteredFiles`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
})

const files: IndexFile[] = [
  { path: 'docs/guide.md', status: 'indexed' },
  { path: 'docs/new.md', status: 'not_indexed' },
  { path: 'docs/old.md', status: 'outdated' },
  { path: 'docs/deleted.md', status: 'deleted' },
  { path: 'docs/failed.md', status: 'failed' },
  { path: 'docs/ignored.md', status: 'ignored' },
]

const createFilter = () => {
  const status = ref({ files })
  const searchQuery = ref('')
  const statusFilter = ref<'all' | IndexStatus>('all')
  const filteredFiles = new Function('computed', 'status', 'searchQuery', 'statusFilter', outputText)(
    computed, status, searchQuery, statusFilter,
  ) as { readonly value: IndexFile[] }
  return { filteredFiles, searchQuery, statusFilter }
}

describe('索引库文件筛选', () => {
  it('默认隐藏已忽略文件，仅显式筛选已忽略时展示', () => {
    const { filteredFiles, searchQuery, statusFilter } = createFilter()
    expect(filteredFiles.value).toEqual(files.filter(file => file.status !== 'ignored'))

    searchQuery.value = 'ignored'
    expect(filteredFiles.value).toEqual([])

    statusFilter.value = 'ignored'
    expect(filteredFiles.value).toEqual([files[5]])

    statusFilter.value = 'all'
    expect(filteredFiles.value).toEqual([])
  })

  it('保留各状态筛选及忽略列表内的路径搜索', () => {
    const { filteredFiles, searchQuery, statusFilter } = createFilter()
    for (const file of files) {
      statusFilter.value = file.status
      expect(filteredFiles.value).toEqual([file])
    }
    searchQuery.value = '  DOCS/IGNORED  '
    expect(filteredFiles.value).toEqual([files[5]])
    searchQuery.value = 'guide'
    expect(filteredFiles.value).toEqual([])
  })
})
