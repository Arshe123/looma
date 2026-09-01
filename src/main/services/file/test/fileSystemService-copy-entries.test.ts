import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  fileSystemService,
  parseFileNameWFilePaths,
  parseMacPlistFilePaths,
  parseTrashFileName,
  parseUriListFilePaths,
} from '../fileSystemService'

const tempDirectories: string[] = []

const createTempDirectory = async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'looma-copy-entries-'))
  tempDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })))
})

describe('fileSystemService.copyEntries', () => {
  it('copies files and folders within the workspace, keeping sources intact', async () => {
    const directory = await createTempDirectory()
    const workspace = path.join(directory, 'workspace')
    await fs.mkdir(path.join(workspace, 'src', 'docs'), { recursive: true })
    await fs.writeFile(path.join(workspace, 'src', 'notes.md'), 'hello', 'utf8')
    await fs.writeFile(path.join(workspace, 'src', 'docs', 'guide.md'), 'guide', 'utf8')

    const result = await fileSystemService.copyEntries(workspace, ['src/notes.md', 'src/docs'], '')

    expect(result).toEqual({
      success: true,
      data: {
        copied: [
          { name: 'notes.md', relativePath: 'notes.md', isDirectory: false },
          { name: 'docs', relativePath: 'docs', isDirectory: true },
        ],
      },
    })
    await expect(fs.readFile(path.join(workspace, 'src', 'notes.md'), 'utf8')).resolves.toBe('hello')
    await expect(fs.readFile(path.join(workspace, 'docs', 'guide.md'), 'utf8')).resolves.toBe('guide')
  })

  it('auto-renames a destination that already exists with an incrementing suffix', async () => {
    const directory = await createTempDirectory()
    const workspace = path.join(directory, 'workspace')
    await fs.mkdir(path.join(workspace, 'backup'), { recursive: true })
    await fs.writeFile(path.join(workspace, 'a.md'), 'original', 'utf8')
    await fs.writeFile(path.join(workspace, 'backup', 'a.md'), 'copy1', 'utf8')
    await fs.writeFile(path.join(workspace, 'backup', 'a (2).md'), 'copy2', 'utf8')

    const result = await fileSystemService.copyEntries(workspace, ['a.md'], 'backup')

    expect(result.success).toBe(true)
    expect(result.data?.copied).toEqual([
      { name: 'a (3).md', relativePath: 'backup/a (3).md', isDirectory: false },
    ])
    await expect(fs.readFile(path.join(workspace, 'backup', 'a (3).md'), 'utf8')).resolves.toBe('original')
  })

  it('rejects copying a folder into its own subtree', async () => {
    const directory = await createTempDirectory()
    const workspace = path.join(directory, 'workspace')
    await fs.mkdir(path.join(workspace, 'folder', 'nested'), { recursive: true })
    await fs.writeFile(path.join(workspace, 'folder', 'nested', 'x.txt'), 'x', 'utf8')

    const result = await fileSystemService.copyEntries(workspace, ['folder'], 'folder/nested')

    expect(result.success).toBe(false)
    expect(result.error).toContain('自身内部')
  })

  it('rejects paths outside the workspace', async () => {
    const directory = await createTempDirectory()
    const workspace = path.join(directory, 'workspace')
    await fs.mkdir(workspace, { recursive: true })
    await fs.writeFile(path.join(directory, 'outside.md'), 'outside', 'utf8')

    const result = await fileSystemService.copyEntries(workspace, ['../outside.md'], '')

    expect(result.success).toBe(false)
    expect(result.error).toContain('工作空间内')
  })

  it('fails cleanly when a source does not exist, leaving no partial copies', async () => {
    const directory = await createTempDirectory()
    const workspace = path.join(directory, 'workspace')
    await fs.mkdir(workspace, { recursive: true })
    await fs.writeFile(path.join(workspace, 'keep.md'), 'keep', 'utf8')

    const result = await fileSystemService.copyEntries(workspace, ['missing.md', 'keep.md'], '')

    expect(result.success).toBe(false)
    const entries = await fs.readdir(workspace)
    expect(entries).toEqual(['keep.md'])
  })
})

describe('clipboard file path parsers', () => {
  it('parses a macOS NSFilenamesPboardType plist', () => {
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<array>
\t<string>/Users/alice/notes/a.md</string>
\t<string>/Users/alice/notes/b.md</string>
</array>
</plist>
`
    expect(parseMacPlistFilePaths(plist)).toEqual(['/Users/alice/notes/a.md', '/Users/alice/notes/b.md'])
  })

  it('ignores non-path strings inside a plist', () => {
    const plist = `<plist version="1.0"><array><string>hello</string><string>/tmp/x.md</string></array></plist>`
    expect(parseMacPlistFilePaths(plist)).toEqual(['/tmp/x.md'])
  })

  it('parses a Windows FileNameW UTF-16LE null-separated buffer', () => {
    const buffer = Buffer.from('C:\\Users\\alice\\a.md\0D:\\data\\b.txt\0', 'utf16le')
    expect(parseFileNameWFilePaths(buffer)).toEqual(['C:\\Users\\alice\\a.md', 'D:\\data\\b.txt'])
  })

  it('parses a Linux text/uri-list', () => {
    const uriList = `file:///home/alice/a%20b.md
file:///home/alice/docs/
# comment
not-a-uri
`
    expect(parseUriListFilePaths(uriList)).toEqual(['/home/alice/a b.md', '/home/alice/docs/'])
  })

  it('returns empty for clipboards without file paths', () => {
    expect(parseMacPlistFilePaths('<plist></plist>')).toEqual([])
    expect(parseUriListFilePaths('plain text')).toEqual([])
    expect(parseFileNameWFilePaths(Buffer.from('', 'utf16le'))).toEqual([])
  })
})

describe('trash entries', () => {
  it('parses both legacy and UUID-backed trash names', () => {
    expect(parseTrashFileName('1700000000000_notes%2Fa.md')).toEqual({
      stamp: 1700000000000,
      originalName: 'a.md',
      restoreTo: 'notes/a.md',
    })
    expect(parseTrashFileName('1700000000000_v2_123e4567-e89b-12d3-a456-426614174000_notes%2Fa.md')).toEqual({
      stamp: 1700000000000,
      originalName: 'a.md',
      restoreTo: 'notes/a.md',
    })
    expect(parseTrashFileName('1700000000000_123e4567-e89b-12d3-a456-426614174000_note.md')).toEqual({
      stamp: 1700000000000,
      originalName: '123e4567-e89b-12d3-a456-426614174000_note.md',
      restoreTo: '123e4567-e89b-12d3-a456-426614174000_note.md',
    })
  })

  it('refuses to restore over an existing workspace item', async () => {
    const directory = await createTempDirectory()
    const workspace = path.join(directory, 'workspace')
    await fs.mkdir(workspace, { recursive: true })
    await fs.writeFile(path.join(workspace, 'note.md'), 'new file', 'utf8')

    const result = await fileSystemService.restoreFromTrash('workspace-test', workspace, 'missing-trash-item', 'note.md')

    expect(result.success).toBe(false)
    expect(result.errorCode).toBe('RESTORE_TARGET_EXISTS')
    await expect(fs.readFile(path.join(workspace, 'note.md'), 'utf8')).resolves.toBe('new file')
  })
})
