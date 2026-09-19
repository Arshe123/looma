import { expect, it } from 'vitest'
import { chooseOpenTarget, markdownArguments } from '../openWithRouting'

it('parses only explicit Markdown paths and resolves relative argv against the second instance cwd', () => {
  expect(markdownArguments(['app.exe', '--inspect', 'a.md', 'x.txt', 'x.markdown'], '/tmp')).toEqual(['/tmp/a.md'])
})
it('focuses an already open canonical file before using the most recent workspace', () => {
  const windows = [
    { id: 1, workspacePath: '/notes', opened: ['/notes/a.md'], focusedAt: 1 },
    { id: 2, workspacePath: '/other', opened: [], focusedAt: 2 },
  ]
  expect(chooseOpenTarget('/notes/a.md', windows)).toEqual({ owner: 1, relativePath: 'a.md' })
  expect(chooseOpenTarget('/outside/a.md', windows)).toEqual({ owner: 2 })
  expect(chooseOpenTarget('/other/new.md', windows)).toEqual({ owner: 2, relativePath: 'new.md' })
  expect(chooseOpenTarget('/otherness/new.md', windows)).toEqual({ owner: 2 })
  expect(chooseOpenTarget('/outside/a.md', [])).toBeNull()
  expect(chooseOpenTarget('/outside/real.md', [{ id: 1, workspacePath: '/notes', opened: ['/outside/real.md'], openedRelativePaths: { '/outside/real.md': 'alias.md' }, focusedAt: 1 }])).toEqual({ owner: 1, relativePath: 'alias.md' })
})
