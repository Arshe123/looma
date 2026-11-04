import path from 'node:path'
import { expect, it } from 'vitest'
import { chooseOpenTarget, markdownArguments } from '../openWithRouting'

it('parses only explicit Markdown paths and resolves relative argv against the second instance cwd', () => {
  const cwd = path.resolve('second-instance-cwd')
  expect(markdownArguments(['app.exe', '--inspect', 'a.md', 'x.txt', 'x.markdown'], cwd)).toEqual([path.join(cwd, 'a.md')])
})
it('focuses an already open canonical file before using the most recent workspace', () => {
  const notes = path.resolve('notes')
  const other = path.resolve('other')
  const outside = path.resolve('outside')
  const openFile = path.join(notes, 'a.md')
  const externalFile = path.join(outside, 'real.md')
  const windows = [
    { id: 1, workspacePath: notes, opened: [openFile], focusedAt: 1 },
    { id: 2, workspacePath: other, opened: [], focusedAt: 2 },
  ]
  expect(chooseOpenTarget(openFile, windows)).toEqual({ owner: 1, relativePath: 'a.md' })
  expect(chooseOpenTarget(path.join(outside, 'a.md'), windows)).toEqual({ owner: 2 })
  expect(chooseOpenTarget(path.join(other, 'new.md'), windows)).toEqual({ owner: 2, relativePath: 'new.md' })
  expect(chooseOpenTarget(path.resolve('otherness', 'new.md'), windows)).toEqual({ owner: 2 })
  expect(chooseOpenTarget(path.join(outside, 'a.md'), [])).toBeNull()
  expect(chooseOpenTarget(externalFile, [{ id: 1, workspacePath: notes, opened: [externalFile], openedRelativePaths: { [externalFile]: 'alias.md' }, focusedAt: 1 }])).toEqual({ owner: 1, relativePath: 'alias.md' })
})
