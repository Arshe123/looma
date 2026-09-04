import { describe, expect, it } from 'vitest'
import { getFileTreeRowVisualState } from '../file-tree-display'

describe('file tree row visual state', () => {
  it('uses a strong selection only while the file tree is focused', () => {
    expect(getFileTreeRowVisualState({
      relativePath: 'a.md',
      selectedPaths: ['a.md'],
      activeFileRelativePath: 'a.md',
      fileTreeFocused: true,
      isDirectory: false,
      isDropTarget: false,
    })).toBe('selected')

    expect(getFileTreeRowVisualState({
      relativePath: 'a.md',
      selectedPaths: ['a.md'],
      activeFileRelativePath: 'a.md',
      fileTreeFocused: false,
      isDirectory: false,
      isDropTarget: false,
    })).toBe('selected-inactive')
  })

  it('does not make a stale selected file and active tab look equally active', () => {
    expect(getFileTreeRowVisualState({
      relativePath: 'a.md',
      selectedPaths: ['a.md'],
      activeFileRelativePath: 'b.md',
      fileTreeFocused: false,
      isDirectory: false,
      isDropTarget: false,
    })).toBe('selected-inactive')

    expect(getFileTreeRowVisualState({
      relativePath: 'b.md',
      selectedPaths: ['a.md'],
      activeFileRelativePath: 'b.md',
      fileTreeFocused: false,
      isDirectory: false,
      isDropTarget: false,
    })).toBe('active-inactive')
  })
})
