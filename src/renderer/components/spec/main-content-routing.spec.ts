import { describe, expect, it } from 'vitest'
import { getMediaPreviewTabs, isMediaPath, resolveWorkspaceFilePath } from '../main-content-routing'

describe('main content routing', () => {
  it('filters opened files to media preview tabs and resolves absolute paths', () => {
    const tabs = getMediaPreviewTabs(
      ['notes/today.md', 'videos/Intro.MP4', 'images/photo.webp', 'docs/readme.txt'],
      'C:\\workspace',
    )

    expect(tabs).toEqual([
      { relativePath: 'videos/Intro.MP4', filePath: 'C:\\workspace\\videos\\Intro.MP4' },
      { relativePath: 'images/photo.webp', filePath: 'C:\\workspace\\images\\photo.webp' },
    ])
  })

  it('detects image and video paths without treating text files as media', () => {
    expect(isMediaPath('icons/app.ICO')).toBe(true)
    expect(isMediaPath('notes/video-plan.md')).toBe(false)
  })

  it('uses the workspace separator when resolving relative paths', () => {
    expect(resolveWorkspaceFilePath('/Users/me/workspace', 'images/photo.png')).toBe('/Users/me/workspace/images/photo.png')
  })
})
