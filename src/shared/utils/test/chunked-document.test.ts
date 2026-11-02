import { describe, expect, it, vi } from 'vitest'
import { Text } from '@codemirror/state'
import { ChunkedDocument } from '../chunked-document'

function reconstructed(doc: ChunkedDocument): string {
  return doc.chunks.map(chunk => doc.slice(chunk.from, chunk.to)).join('')
}

describe('ChunkedDocument', () => {
  it('undoes an entire native composition rather than its last phonetic replacement', () => {
    const doc = new ChunkedDocument('前后')
    doc.select(1)
    let previous = ''
    for (const text of ['n', 'ni', 'ni h', 'ni ha', 'ni hao', '你好']) {
      doc.applyChanges([{ from: 1, to: 1 + previous.length, insert: text }], { anchor: 1 + text.length, head: 1 + text.length },
        previous ? 'input.type.compose' : 'input.type.compose.start')
      previous = text
    }
    expect(doc.content).toBe('前你好后')
    expect(doc.undo()).toBe(true)
    expect(doc.content).toBe('前后')
    expect(doc.redo()).toBe(true)
    expect(doc.content).toBe('前你好后')
  })
  it('keeps separate composition sessions and ordinary edits independently reversible', () => {
    const doc = new ChunkedDocument('前后')
    doc.replace(1, 1, 'A')
    for (const [at, word] of [[2, '你好'], [4, '再见']] as const) {
      doc.select(at)
      doc.applyChanges([{ from: at, to: at, insert: 'n' }], undefined, 'input.type.compose.start')
      doc.applyChanges([{ from: at, to: at + 1, insert: word }], undefined, 'input.type.compose')
    }
    doc.replace(6, 6, 'B')
    for (const source of ['前A你好再见后', '前A你好后', '前A后', '前后']) {
      expect(doc.undo()).toBe(true)
      expect(doc.content).toBe(source)
    }
    for (let count = 0; count < 4; count++) expect(doc.redo()).toBe(true)
    expect(doc.content).toBe('前A你好再见B后')
  })
  it.each([3, 17, 8192])('reads exact fence context from the containing chunk at cap %i', cap => {
    const source = 'plain\r\n`````md\r\n# **literal**\r\n```\r\nstill code\r\n`````\r\n# actual'
    const doc = new ChunkedDocument(source, cap)
    expect(doc.contextAt(0)).toEqual({ fence: '', fenceLength: 0 })
    expect(doc.contextAt(source.indexOf('# **'))).toEqual({ fence: '`', fenceLength: 5 })
    expect(doc.contextAt(source.indexOf('still'))).toEqual({ fence: '`', fenceLength: 5 })
    expect(doc.contextAt(source.indexOf('# actual'))).toEqual({ fence: '', fenceLength: 0 })
    const inside = source.indexOf('still')
    doc.replace(0, 0, 'preface\n')
    expect(doc.contextAt(inside + 8).fence).toBe('`')
    expect(doc.undo()).toBe(true)
    expect(doc.contextAt(inside).fence).toBe('`')
    const long = new ChunkedDocument('```\n' + 'body\n'.repeat(10000) + '```\n', cap)
    const reads = vi.spyOn(long, 'slice')
    try {
      expect(long.contextAt(40003).fence).toBe('`')
      expect(reads.mock.calls.reduce((sum, [from, to]) => sum + to - from, 0)).toBeLessThanOrEqual(cap + 2)
    } finally { reads.mockRestore() }
  })
  it('keeps revision composition coherent through undo, redo, canonical saves and external resets', () => {
    const doc = new ChunkedDocument('[x](my note.md)\r\n😀', 4)
    const snapshots = [doc.text]
    const capture = (): void => {
      snapshots.push(doc.text)
      expect(doc.revision).toBe(snapshots.length - 1)
      for (let revision = 0; revision < snapshots.length; revision++) {
        expect(doc.changesSince(revision)!.apply(snapshots[revision]).eq(doc.text)).toBe(true)
      }
    }
    doc.replace(doc.length, doc.length, '!'); capture()
    expect(doc.undo()).toBe(true); capture()
    expect(doc.redo()).toBe(true); capture()
    expect(doc.reconcileSavedContent('[x](my%20note.md)\r\n😀!')).toBe(true); capture()
    expect(doc.undo()).toBe(true); capture()
    expect(doc.redo()).toBe(true); capture()
    expect(doc.reconcileSavedContent(doc.content)).toBe(false)
    expect(doc.replaceExternal('entirely different\r\n新')).toBe(true); capture()
    expect(doc.undo()).toBe(false)
    expect(doc.redo()).toBe(false)
    expect(doc.replaceExternal('entirely different\r\n新')).toBe(false)
    expect(doc.replaceExternal('')).toBe(true); capture()
    expect(doc.replaceExternal('again😀\r\n')).toBe(true); capture()
    doc.replace(0, 0, '!'); capture()
    expect(doc.undo()).toBe(true); capture()
    const flatten = vi.spyOn(Text.prototype, 'toString').mockImplementation(() => { throw new Error('flatten') })
    try {
      expect(doc.changesSince(0)!.apply(snapshots[0]).eq(doc.text)).toBe(true)
      expect(flatten).not.toHaveBeenCalled()
    } finally { flatten.mockRestore() }
  })
  it('retains exactly 128 source transitions and rejects expired or invalid revisions', () => {
    const doc = new ChunkedDocument('x')
    const initial = doc.text
    for (const revision of [-1, 0.5, NaN, Infinity, -Infinity, 1]) expect(doc.changesSince(revision)).toBeNull()
    doc.replace(0, 0, '0')
    const first = doc.text
    for (let i = 1; i < 128; i++) doc.replace(doc.length, doc.length, 'x')
    expect(doc.changesSince(0)!.apply(initial).eq(doc.text)).toBe(true)
    doc.select(0)
    doc.replace(0, 1, '0')
    expect(doc.changesSince(0)).not.toBeNull()
    doc.replace(doc.length, doc.length, '!')
    expect(doc.changesSince(0)).toBeNull()
    expect(doc.changesSince(1)!.apply(first).eq(doc.text)).toBe(true)
    expect(doc.changesSince(doc.revision)!.empty).toBe(true)
    expect(doc.changesSince(doc.revision)!.length).toBe(doc.length)
  })
  it('composes source revisions into incremental changes for a lagging full-document view', () => {
    const doc = new ChunkedDocument('012345\r\n😀tail', 4)
    const initial = doc.text
    const identity = doc.changesSince(0)!
    expect(identity.empty).toBe(true)
    expect(identity.apply(initial).eq(initial)).toBe(true)
    doc.applyChanges([{ from: 0, to: 1, insert: 'AB' }, { from: 4, to: 6, insert: '新' }])
    const first = doc.text
    const firstRevision = doc.revision
    doc.replace(doc.length, doc.length, '!')
    const second = doc.text
    const secondRevision = doc.revision
    doc.select(3)
    doc.replace(0, 2, 'AB')
    expect(doc.revision).toBe(secondRevision)
    expect(doc.changesSince(firstRevision)!.apply(first).eq(second)).toBe(true)
    const changes = doc.changesSince(0)!
    expect(changes.apply(initial).eq(second)).toBe(true)
    const ranges: number[][] = []
    changes.iterChanges((from, to) => ranges.push([from, to]))
    expect(ranges[0]).toEqual([0, 1])
    expect(ranges.at(-1)).toEqual([initial.length, initial.length])
  })
  it('exposes the immutable canonical rope without materializing source', () => {
    const doc = new ChunkedDocument('hello\r\n😀')
    const flatten = vi.spyOn(Text.prototype, 'toString').mockImplementation(() => { throw new Error('flatten') })
    try {
      const before = doc.text
      expect(before).toBeInstanceOf(Text)
      expect(doc.text).toBe(before)
      doc.select(1)
      expect(doc.text).toBe(before)
      doc.replace(0, 1, 'H')
      expect(doc.text).not.toBe(before)
      expect(before.sliceString(0, before.length)).toBe('hello\r\n😀')
      expect(doc.text.sliceString(0, doc.length)).toBe('Hello\r\n😀')
      expect(flatten).not.toHaveBeenCalled()
    } finally { flatten.mockRestore() }
  })
  it('reconciles a canonical saved representation without erasing user history', () => {
    const doc = new ChunkedDocument('[说明](my note.md)\n\n正文', 32)
    doc.replace(doc.length, doc.length, '!')
    expect(doc.reconcileSavedContent('[说明](my%20note.md)\n\n正文!')).toBe(true)
    expect(doc.undo()).toBe(true)
    expect(doc.content).toBe('[说明](my%20note.md)\n\n正文')
    expect(doc.redo()).toBe(true)
    expect(doc.content).toBe('[说明](my%20note.md)\n\n正文!')
  })
  it.each([2, 3, 13, 64])('matches seeded random multiline edits and complete undo/redo at cap %i', cap => {
    let seed = 0x7a91
    const random = (max: number): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed % max
    }
    let reference = 'start\r\n\n' + 'paragraph 😀\n\n'.repeat(12) + '\rfin'
    const doc = new ChunkedDocument(reference, cap)
    const past = [reference]
    const inserts = ['', 'x', '\r', '\n', '\r\n', '😀', '\ud83d', '\ude00', '```\n', '\n\ntext\r\n', '尾']
    const assertIndex = (): void => {
      expect(reconstructed(doc)).toBe(reference)
      expect(doc.content).toBe(reference)
      expect(doc.chunks[0].from).toBe(0)
      expect(doc.chunks.at(-1)?.to).toBe(reference.length)
      expect(new Set(doc.chunks.map(c => c.id)).size).toBe(doc.chunks.length)
      for (let i = 0; i < doc.chunks.length; i++) {
        const chunk = doc.chunks[i]
        expect(chunk.to - chunk.from).toBeLessThanOrEqual(cap)
        expect(chunk.to > chunk.from || reference.length === 0).toBe(true)
        if (i) expect(chunk.from).toBe(doc.chunks[i - 1].to)
        const edge = reference.slice(chunk.to - 1, chunk.to + 1)
        expect(edge).not.toBe('\r\n')
        expect(!(/[\ud800-\udbff]/.test(edge[0] ?? '') && /[\udc00-\udfff]/.test(edge[1] ?? ''))).toBe(true)
        expect(chunk.startLine).toBe(reference.slice(0, chunk.from).split('\n').length)
        expect(chunk.endLine).toBe(reference.slice(0, Math.max(chunk.from, chunk.to - 1)).split('\n').length)
      }
    }
    for (let i = 0; i < 300; i++) {
      const from = random(reference.length + 1)
      const to = Math.min(reference.length, from + random(12))
      const insert = inserts[random(inserts.length)]
      const next = reference.slice(0, from) + insert + reference.slice(to)
      expect(doc.replace(from, to, insert)).toBe(next !== reference)
      if (next !== reference) past.push(next)
      reference = next
      assertIndex()
    }
    for (let i = past.length - 2; i >= 0; i--) {
      expect(doc.undo()).toBe(true)
      reference = past[i]
      assertIndex()
    }
    expect(doc.undo()).toBe(false)
    for (let i = 1; i < past.length; i++) {
      expect(doc.redo()).toBe(true)
      reference = past[i]
      assertIndex()
    }
    expect(doc.redo()).toBe(false)
  })
  it('makes progress when deleting across chunks creates a new CRLF/surrogate pair', () => {
    for (const [source, expected] of [['a\rXX\nb', 'a\r\nb'], ['a\ud83dXX\ude00b', 'a😀b']]) {
      const doc = new ChunkedDocument(source, 2)
      const originalSlice = doc.slice.bind(doc)
      const reads = vi.spyOn(doc, 'slice').mockImplementation((from, to) => {
        if (from === to && doc.length > 0) throw new Error('zero-progress chunk scan')
        return originalSlice(from, to)
      })
      try { expect(doc.replace(2, 4, '')).toBe(true) } finally { reads.mockRestore() }
      expect(reconstructed(doc)).toBe(expected)
      expect(doc.chunks.every(c => c.to > c.from && c.to - c.from <= 2)).toBe(true)
    }
  })
  it('ignores equal external echoes and resets history only for genuine replacements', () => {
    const doc = new ChunkedDocument('before\r\n😀', 4)
    doc.replace(0, 6, 'after')
    const edited = 'after\r\n😀'
    const ids = doc.chunks.map(c => c.id)
    const revision = doc.revision
    expect(doc.replaceExternal(edited)).toBe(false)
    expect(doc.revision).toBe(revision)
    expect(doc.chunks.map(c => c.id)).toEqual(ids)
    expect(doc.undo()).toBe(true)
    expect(doc.replaceExternal('before\r\n😀')).toBe(false)
    expect(doc.redo()).toBe(true)
    expect(doc.replaceExternal('external\r\nbare\r😀')).toBe(true)
    expect(doc.content).toBe('external\r\nbare\r😀')
    expect(reconstructed(doc)).toBe(doc.content)
    expect(doc.undo()).toBe(false)
    expect(doc.redo()).toBe(false)
    doc.replace(0, 0, '!')
    expect(doc.undo()).toBe(true)
    expect(doc.content).toBe('external\r\nbare\r😀')
    expect(doc.replaceExternal('')).toBe(true)
    expect(doc.chunks).toHaveLength(1)
    expect(doc.selection).toEqual({ anchor: 0, head: 0 })
  })

  it('lazily snapshots edited source once per document revision', () => {
    const doc = new ChunkedDocument('hello\n\nworld', 6)
    const flatten = vi.spyOn(Text.prototype, 'toString')
    try {
      doc.replace(0, 1, 'H')
      expect(flatten).not.toHaveBeenCalled()
      expect(doc.content).toBe('Hello\n\nworld')
      expect(flatten).toHaveBeenCalledTimes(1)
      expect(doc.content).toBe('Hello\n\nworld')
      doc.select(2)
      expect(doc.content).toBe('Hello\n\nworld')
      expect(flatten).toHaveBeenCalledTimes(1)
    } finally { flatten.mockRestore() }
  })
  it.each(['blocks', 'giant-line'])('incrementally edits %s without flattening or reparsing the unchanged suffix', shape => {
    const source = shape === 'blocks' ? 'ordinary paragraph\r\n\r\n'.repeat(12_000) : 'x'.repeat(300_000)
    const doc = new ChunkedDocument(source, 128)
    const old = [...doc.chunks]
    const reads = vi.spyOn(doc, 'slice')
    const flatten = vi.spyOn(Text.prototype, 'toString').mockImplementation(() => { throw new Error('flatten during edit') })
    try {
      expect(doc.replace(20, 21, 'abc')).toBe(true)
      expect(reads.mock.calls.reduce((sum, [from, to]) => sum + to - from, 0)).toBeLessThan(128 * 8)
      expect(doc.chunks.at(-1)?.id).toBe(old.at(-1)?.id)
      expect(doc.chunks.slice(-100).map(c => c.id)).toEqual(old.slice(-100).map(c => c.id))
      expect(doc.undo()).toBe(true)
      expect(doc.redo()).toBe(true)
      expect(flatten).not.toHaveBeenCalled()
    } finally { reads.mockRestore(); flatten.mockRestore() }
    expect(doc.content).toBe(source.slice(0, 20) + 'abc' + source.slice(21))
    expect(reconstructed(doc)).toBe(doc.content)
  })

  it('retains exact chunk objects outside an equal-length local edit', () => {
    const doc = new ChunkedDocument('paragraph\n\n'.repeat(200), 32)
    const old = [...doc.chunks]
    const at = old[20].from + 2
    doc.replace(at, at + 1, 'X')
    expect(doc.chunks[0]).toBe(old[0])
    expect(doc.chunks.at(-1)).toBe(old.at(-1))
    expect(doc.chunks.at(-1)?.id).toBe(old.at(-1)?.id)
  })

  it('propagates changed fence context instead of reusing stale Markdown modes', () => {
    const source = 'opening\n\n' + 'body\n\n'.repeat(80)
    const doc = new ChunkedDocument(source, 24)
    doc.replace(0, 7, '`````')
    expect(doc.chunks.every(c => c.renderMode === 'source')).toBe(true)
    expect(doc.undo()).toBe(true)
    expect(doc.chunks.every(c => c.renderMode === 'markdown')).toBe(true)
  })
  it('edits across chunks with global selection and one atomic undo/redo history', () => {
    const source = 'alpha\r\n\n' + 'body '.repeat(30) + '\n\nomega😀'
    const doc = new ChunkedDocument(source, 20)
    doc.select(3, 145)
    expect(doc.revision).toBe(0)
    expect(doc.selection).toEqual({ anchor: 3, head: 145 })
    expect(doc.replace(3, 145, '新\r\n😀', { anchor: 9, head: 3 })).toBe(true)
    const edited = source.slice(0, 3) + '新\r\n😀' + source.slice(145)
    expect(doc.content).toBe(edited)
    expect(reconstructed(doc)).toBe(edited)
    expect(doc.selection).toEqual({ anchor: 9, head: 3 })
    expect(doc.revision).toBe(1)
    expect(doc.replace(doc.length, doc.length, '!')).toBe(true)
    expect(doc.undo()).toBe(true)
    expect(doc.content).toBe(edited)
    expect(doc.undo()).toBe(true)
    expect(doc.content).toBe(source)
    expect(doc.selection).toEqual({ anchor: 3, head: 145 })
    expect(doc.undo()).toBe(false)
    expect(doc.redo()).toBe(true)
    expect(doc.content).toBe(edited)
    expect(doc.selection).toEqual({ anchor: 9, head: 3 })
    expect(doc.redo()).toBe(true)
    expect(doc.content).toBe(edited + '!')
    expect(doc.redo()).toBe(false)
    expect(doc.revision).toBe(6)
  })

  it('applies simultaneous changes as one history entry and rejects invalid ranges', () => {
    const doc = new ChunkedDocument('0123456789', 4)
    doc.select(9, 2)
    expect(doc.applyChanges([{ from: 1, to: 3, insert: 'AB\r\n' }, { from: 7, to: 9, insert: '😀' }])).toBe(true)
    expect(doc.content).toBe('0AB\r\n3456😀9')
    expect(doc.undo()).toBe(true)
    expect(doc.content).toBe('0123456789')
    expect(doc.selection).toEqual({ anchor: 9, head: 2 })
    expect(() => doc.replace(-1, 2, 'x')).toThrow(RangeError)
    expect(() => doc.replace(5, 2, 'x')).toThrow(RangeError)
    expect(() => doc.applyChanges([{ from: 1, to: 5, insert: '' }, { from: 4, to: 8, insert: '' }])).toThrow(RangeError)
    const revision = doc.revision
    expect(doc.replace(0, 1, '0')).toBe(false)
    expect(doc.applyChanges([])).toBe(false)
    expect(doc.revision).toBe(revision)
  })

  it('clamps selections to valid UTF-16/CRLF boundaries without changing revision', () => {
    const doc = new ChunkedDocument('a😀\r\nb')
    doc.select(2, 4)
    expect(doc.selection).toEqual({ anchor: 1, head: 3 })
    doc.select(-100, 100)
    expect(doc.selection).toEqual({ anchor: 0, head: 6 })
    doc.select(3)
    expect(doc.selection).toEqual({ anchor: 3, head: 3 })
    expect(doc.revision).toBe(0)
  })
  it('prefers safe blank boundaries and marks cut paragraphs as source through their continuation', () => {
    const doc = new ChunkedDocument('first\n\n' + 'p'.repeat(47) + '\n\nlast', 16)
    expect(doc.chunks[0]).toMatchObject({ from: 0, to: 7, renderMode: 'markdown' })
    expect(doc.chunks.filter(c => c.from >= 7 && c.from < 56).every(c => c.renderMode === 'source')).toBe(true)
    expect(doc.chunks.at(-1)?.renderMode).toBe('markdown')
    expect(reconstructed(doc)).toBe(doc.content)
  })

  it.each(['`', '~'])('tracks %s fence lengths and ignores shorter/different inner fences', marker => {
    const source = marker.repeat(5) + '\n' + 'code\n'.repeat(8)
      + marker.repeat(3) + '\n\nSTILL CODE\n\n' + (marker === '`' ? '~' : '`').repeat(5)
      + '\n\n' + marker.repeat(6) + '\n\nafter\n\n'
    const doc = new ChunkedDocument(source, 20)
    const inside = source.indexOf('STILL CODE')
    expect(doc.getChunkAt(inside).renderMode).toBe('source')
    expect(doc.chunks.filter(c => c.from < source.indexOf('after')).every(c => c.renderMode === 'source')).toBe(true)
    expect(doc.getChunkAt(source.indexOf('after')).renderMode).toBe('markdown')
    expect(reconstructed(doc)).toBe(source)
  })

  it('never falsely renders split list, quote, indented code, or HTML continuations', () => {
    for (const opening of ['- item', '> quote', '    code', '<div>']) {
      const source = opening + '\n\n' + ' continuation\n'.repeat(15)
      const doc = new ChunkedDocument(source, 24)
      expect(doc.chunks.every(c => c.renderMode === 'source')).toBe(true)
    }
  })
  it('hard-bounds giant physical lines without splitting CRLF or surrogate pairs', () => {
    const source = 'x'.repeat(150_000) + '😀\r\n' + 'y'.repeat(90)
    const doc = new ChunkedDocument(source, 17)
    expect(reconstructed(doc)).toBe(source)
    expect(doc.chunks.length).toBeGreaterThan(8000)
    for (const chunk of doc.chunks) {
      expect(chunk.to - chunk.from).toBeLessThanOrEqual(17)
      expect(chunk.to).toBeGreaterThan(chunk.from)
      const around = source.slice(chunk.to - 1, chunk.to + 1)
      expect(around).not.toBe('\r\n')
      expect(around).not.toBe('😀')
      expect(doc.getChunkAt(chunk.from)).toBe(chunk)
    }
    expect(doc.getChunkAt(doc.length)).toBe(doc.chunks.at(-1))
    expect(() => new ChunkedDocument('x', 1)).toThrow(RangeError)
  })

  it('maps 1-based LF lines using clamped UTF-16 offsets without flattening', () => {
    const doc = new ChunkedDocument('one\r\n😀\nbare\rCR', 5)
    const flatten = vi.spyOn(Text.prototype, 'toString').mockImplementation(() => { throw new Error('flatten') })
    try {
      expect(doc.lineAt(6)).toEqual({ number: 2, from: 5, to: 7 })
      expect(doc.lineAt(-50)).toEqual({ number: 1, from: 0, to: 4 })
      expect(doc.lineAt(999)).toEqual({ number: 3, from: 8, to: 15 })
      expect(doc.offsetForLine(-1)).toBe(0)
      expect(doc.offsetForLine(2)).toBe(5)
      expect(doc.offsetForLine(999)).toBe(8)
      for (const chunk of doc.chunks) {
        expect(chunk.startLine).toBe(doc.lineAt(chunk.from).number)
        expect(chunk.endLine).toBe(doc.lineAt(Math.max(chunk.from, chunk.to - 1)).number)
      }
    } finally { flatten.mockRestore() }
  })
  it('preserves exact UTF-16 source and represents an empty document', () => {
    const source = '# Title\r\n\r\nText 😀\rbare\n尾\r\n'
    const doc = new ChunkedDocument(source)
    expect(doc.length).toBe(source.length)
    expect(doc.revision).toBe(0)
    expect(doc.content).toBe(source)
    expect(reconstructed(doc)).toBe(source)
    expect(doc.selection).toEqual({ anchor: 0, head: 0 })
    const empty = new ChunkedDocument('')
    expect(empty.chunks).toHaveLength(1)
    expect(empty.chunks[0]).toMatchObject({ from: 0, to: 0, startLine: 1, endLine: 1 })
    expect(empty.getChunkAt(0)).toBe(empty.chunks[0])
  })
})
