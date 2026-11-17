import type { Result } from '@/shared/types/Result'
import { parseGraphNote, type GraphNote } from '@/shared/utils/knowledge-graph'

export interface GraphLoadSource {
  list: () => Promise<Result<Array<string | { path: string; createdAt: number }>>>
  read: (path: string) => Promise<Result<string>>
}

/** Incremental, bounded reads. Cancellation also prevents stale requests filling the cache. */
export class KnowledgeGraphLoader {
  private cache = new Map<string, GraphNote>()
  private generation = 0

  invalidate(path?: string) {
    this.generation++
    if (path === undefined) this.cache.clear()
    else for (const key of this.cache.keys()) {
      if (key === path || key.startsWith(path + '/')) this.cache.delete(key)
    }
  }

  cancel() { this.generation++ }

  async load(source: GraphLoadSource, progress?: (done: number, total: number) => void): Promise<GraphNote[] | null> {
    const generation = ++this.generation
    const current = () => generation === this.generation
    const list = await source.list()
    if (!current()) return null
    if (!list.success || !list.data) throw new Error(list.error || '无法列出笔记')
    const createdAt = new Map(list.data.map(entry => typeof entry === 'string' ? [entry, 0] as const : [entry.path, entry.createdAt] as const))
    const paths = [...createdAt.keys()]
    const existing = new Set(paths)
    for (const key of this.cache.keys()) if (!existing.has(key)) this.cache.delete(key)
    const notes = new Array<GraphNote>(paths.length)
    let cursor = 0, done = 0
    await Promise.all(Array.from({ length: Math.min(4, paths.length) }, async () => {
      while (cursor < paths.length && current()) {
        const index = cursor++, path = paths[index]
        let note = this.cache.get(path)
        if (!note) {
          try {
            const read = await source.read(path)
            if (!current()) return
            if (!read.success || read.data === undefined) throw new Error(read.error || '无法读取笔记')
            note = parseGraphNote(path, read.data)
            this.cache.set(path, note)
          } catch (error) {
            if (!current()) return
            note = { path, title: path.split('/').pop()!.replace(/\.(md|txt)$/i, ''), citations: [],
              error: error instanceof Error ? error.message : '无法解析笔记' }
          }
        }
        notes[index] = { ...note, createdAt: createdAt.get(path) || 0 }
        progress?.(++done, paths.length)
        // Let input and paint run between batches, including when every note is cached.
        if (done % 16 === 0) await new Promise(resolve => setTimeout(resolve, 0))
      }
    }))
    return current() ? notes : null
  }
}
