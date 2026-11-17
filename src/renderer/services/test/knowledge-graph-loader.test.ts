import { describe, expect, it, vi } from 'vitest'
import { KnowledgeGraphLoader } from '../knowledge-graph-loader'
import type { Result } from '@/shared/types/Result'

describe('incremental knowledge graph loading', () => {
  it('reuses parsed notes, invalidates whole directories and removes deleted notes', async () => {
    const loader = new KnowledgeGraphLoader()
    const list = vi.fn().mockResolvedValue({ success: true, data: ['a.md', 'dir/b.md', 'dir/sub/c.md'] })
    const read = vi.fn().mockResolvedValue({ success: true, data: '# Note' })
    await loader.load({ list, read })
    expect(read).toHaveBeenCalledTimes(3)
    await loader.load({ list, read })
    expect(read).toHaveBeenCalledTimes(3)
    loader.invalidate('dir')
    await loader.load({ list, read })
    expect(read).toHaveBeenCalledTimes(5)
    list.mockResolvedValue({ success: true, data: ['a.md'] })
    expect((await loader.load({ list, read }))?.map(n => n.path)).toEqual(['a.md'])
    list.mockResolvedValue({ success: true, data: ['dir/b.md'] })
    await loader.load({ list, read })
    expect(read).toHaveBeenCalledTimes(6)
  })

  it('drops stale reads after cancellation so another workspace cannot inherit them', async () => {
    const loader = new KnowledgeGraphLoader()
    let release!: (result: Result<string>) => void
    const read = vi.fn(() => new Promise<Result<string>>(resolve => { release = resolve }))
    const list = async () => ({ success: true, data: ['same.md'] })
    const stale = loader.load({ list, read })
    await Promise.resolve()
    loader.invalidate()
    const current = await loader.load({ list, read: async () => ({ success: true, data: '# New workspace' }) })
    release({ success: true, data: '# Old workspace' })
    expect(await stale).toBe(null)
    expect(current?.[0].title).toBe('New workspace')
    expect((await loader.load({ list, read }))?.[0].title).toBe('New workspace')
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('keeps failed files as nodes and retries them, but reports directory enumeration failures', async () => {
    const loader = new KnowledgeGraphLoader()
    const list = async () => ({ success: true, data: ['bad.md', 'good.md'] })
    const read = vi.fn(async (path: string) => path === 'bad.md'
      ? { success: false, error: 'permission denied' } : { success: true, data: '# Good' })
    const notes = await loader.load({ list, read })
    expect(notes).toHaveLength(2)
    expect(notes?.[0].error).toBe('permission denied')
    await loader.load({ list, read })
    expect(read).toHaveBeenCalledTimes(3)
    await expect(loader.load({ list: async () => ({ success: false, error: 'disk unavailable' }), read })).rejects.toThrow('disk unavailable')
  })

  it('bounds concurrent disk reads to four', async () => {
    const loader = new KnowledgeGraphLoader()
    let pending = 0, maximum = 0
    const read = async () => {
      maximum = Math.max(maximum, ++pending)
      await new Promise(resolve => setTimeout(resolve, 1))
      pending--
      return { success: true, data: '' }
    }
    await loader.load({ list: async () => ({ success: true, data: Array.from({ length: 30 }, (_, i) => `${i}.md`) }), read })
    expect(maximum).toBe(4)
  })
})

it('retains filesystem creation times while reusing parsed content', async () => {
  const loader = new KnowledgeGraphLoader(), read = vi.fn().mockResolvedValue({ success: true, data: '# Note' })
  const list = async () => ({ success: true, data: [{ path: 'note.md', createdAt: 1234 }] })
  expect((await loader.load({ list, read }))?.[0].createdAt).toBe(1234)
  expect((await loader.load({ list, read }))?.[0].createdAt).toBe(1234)
  expect(read).toHaveBeenCalledTimes(1)
})
