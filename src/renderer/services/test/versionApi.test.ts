import { describe, expect, it } from 'vitest'
import { compareVersions, mapGitHubRelease } from '../versionApi'

describe('versionApi', () => {
  it('compares semantic versions with v prefixes and prerelease suffixes', () => {
    expect(compareVersions('1.2.1', 'v1.3.0')).toBe(-1)
    expect(compareVersions('v1.2.1', '1.2.1')).toBe(0)
    expect(compareVersions('1.3.0-beta', '1.2.9')).toBe(1)
  })

  it('maps a GitHub release to the update model', () => {
    expect(mapGitHubRelease({
      tag_name: 'v1.3.0',
      name: 'Looma 1.3.0',
      body: '- 新功能',
      published_at: '2026-08-11T08:30:00Z',
      html_url: 'https://github.com/Arshe123/looma/releases/tag/v1.3.0',
    })).toEqual({
      version: '1.3.0',
      minVersion: null,
      releaseDate: '2026-08-11',
      notes: '- 新功能',
      downloadUrl: 'https://github.com/Arshe123/looma/releases/tag/v1.3.0',
      forceUpdate: false,
    })
  })
})
