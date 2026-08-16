import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DraftRecoveryStore } from '../draftRecoveryStore'

const WORKSPACE_ID = 'workspace:windows/mac'
const RELATIVE_PATH = '目录\\note.md'

let rootDir = ''
let store: DraftRecoveryStore

beforeEach(async () => {
  rootDir = await mkdtemp(path.join(os.tmpdir(), 'looma-draft-recovery-'))
  store = new DraftRecoveryStore(rootDir)
})

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true })
})

describe('DraftRecoveryStore', () => {
  it('stores a draft outside the workspace and restores it against the unchanged disk content', async () => {
    await store.save({
      workspaceId: WORKSPACE_ID,
      relativePath: RELATIVE_PATH,
      draftContent: '# 未保存内容',
      baseContent: '# 已保存内容',
      revision: 'revision-1',
    })

    const restored = await store.get(WORKSPACE_ID, '目录/note.md', '# 已保存内容')

    expect(restored).toMatchObject({
      status: 'restorable',
      draft: {
        workspaceId: WORKSPACE_ID,
        relativePath: '目录/note.md',
        draftContent: '# 未保存内容',
        revision: 'revision-1',
      },
    })
    expect(await readdir(rootDir)).toHaveLength(1)
  })

  it('commits each replacement to a new filename before retiring the previous record', async () => {
    await store.save({
      workspaceId: WORKSPACE_ID,
      relativePath: RELATIVE_PATH,
      draftContent: 'first',
      baseContent: 'saved',
      revision: 'revision-1',
    })
    const [workspaceDirectory] = await readdir(rootDir)
    const firstFiles = (await readdir(path.join(rootDir, workspaceDirectory))).filter((name) => name.endsWith('.json'))

    await store.save({
      workspaceId: WORKSPACE_ID,
      relativePath: RELATIVE_PATH,
      draftContent: 'second',
      baseContent: 'saved',
      revision: 'revision-2',
    })
    const secondFiles = (await readdir(path.join(rootDir, workspaceDirectory))).filter((name) => name.endsWith('.json'))

    expect(firstFiles).toHaveLength(1)
    expect(secondFiles).toHaveLength(1)
    expect(secondFiles[0]).not.toBe(firstFiles[0])
  })

  it('reports a conflict when the file changed outside Looma', async () => {
    await store.save({
      workspaceId: WORKSPACE_ID,
      relativePath: RELATIVE_PATH,
      draftContent: '草稿',
      baseContent: '原内容',
      revision: 'revision-1',
    })

    const restored = await store.get(WORKSPACE_ID, RELATIVE_PATH, '外部修改')

    expect(restored.status).toBe('conflict')
    if (restored.status !== 'none') expect(restored.draft.draftContent).toBe('草稿')
  })

  it('discards a stale recovery record when the same content already reached disk', async () => {
    await store.save({
      workspaceId: WORKSPACE_ID,
      relativePath: RELATIVE_PATH,
      draftContent: 'already saved',
      baseContent: 'older content',
      revision: 'revision-1',
    })

    expect(await store.get(WORKSPACE_ID, RELATIVE_PATH, 'already saved')).toEqual({ status: 'none' })
    expect(await store.get(WORKSPACE_ID, RELATIVE_PATH, 'older content')).toEqual({ status: 'none' })
  })

  it('only removes the revision that was actually saved', async () => {
    await store.save({
      workspaceId: WORKSPACE_ID,
      relativePath: RELATIVE_PATH,
      draftContent: 'newer draft',
      baseContent: 'saved',
      revision: 'revision-2',
    })

    expect(await store.remove(WORKSPACE_ID, RELATIVE_PATH, 'revision-1')).toBe(false)
    const retained = await store.get(WORKSPACE_ID, RELATIVE_PATH, 'saved')
    expect(retained.status).not.toBe('none')
    if (retained.status !== 'none') expect(retained.draft.revision).toBe('revision-2')
    expect(await store.remove(WORKSPACE_ID, RELATIVE_PATH, 'revision-2')).toBe(true)
    expect(await store.get(WORKSPACE_ID, RELATIVE_PATH, 'saved')).toEqual({ status: 'none' })
  })

  it('moves a matching recovery revision to a renamed path', async () => {
    await store.save({
      workspaceId: WORKSPACE_ID,
      relativePath: 'old/note.md',
      draftContent: 'draft',
      baseContent: 'saved',
      revision: 'revision-1',
    })

    expect(await store.move(WORKSPACE_ID, 'old/note.md', 'new/note.md', 'revision-1')).toBe(true)
    expect(await store.get(WORKSPACE_ID, 'old/note.md', 'saved')).toEqual({ status: 'none' })
    const moved = await store.get(WORKSPACE_ID, 'new/note.md', 'saved')
    expect(moved.status).toBe('restorable')
    if (moved.status !== 'none') {
      expect(moved.draft.relativePath).toBe('new/note.md')
      expect(moved.draft.draftContent).toBe('draft')
    }
  })

  it('moves dormant drafts under a renamed directory without renderer state', async () => {
    await store.save({ workspaceId: WORKSPACE_ID, relativePath: 'old/a.md', draftContent: 'draft a', baseContent: 'saved a', revision: 'a-1' })
    await store.save({ workspaceId: WORKSPACE_ID, relativePath: 'old/nested/b.md', draftContent: 'draft b', baseContent: 'saved b', revision: 'b-1' })

    expect(await store.movePaths(WORKSPACE_ID, [{ from: 'old', to: 'renamed' }])).toBe(2)
    expect((await store.get(WORKSPACE_ID, 'renamed/a.md', 'saved a')).status).toBe('restorable')
    expect((await store.get(WORKSPACE_ID, 'renamed/nested/b.md', 'saved b')).status).toBe('restorable')
    expect(await store.get(WORKSPACE_ID, 'old/a.md', 'saved a')).toEqual({ status: 'none' })
  })

  it('removes dormant drafts under a deleted directory without renderer state', async () => {
    await store.save({ workspaceId: WORKSPACE_ID, relativePath: 'deleted/a.md', draftContent: 'draft a', baseContent: 'saved a', revision: 'a-1' })
    await store.save({ workspaceId: WORKSPACE_ID, relativePath: 'kept/b.md', draftContent: 'draft b', baseContent: 'saved b', revision: 'b-1' })

    expect(await store.removePaths(WORKSPACE_ID, ['deleted'])).toBe(1)
    expect(await store.get(WORKSPACE_ID, 'deleted/a.md', 'saved a')).toEqual({ status: 'none' })
    expect((await store.get(WORKSPACE_ID, 'kept/b.md', 'saved b')).status).toBe('restorable')
  })

  it('ignores corrupt records without losing later valid writes', async () => {
    await store.save({
      workspaceId: WORKSPACE_ID,
      relativePath: RELATIVE_PATH,
      draftContent: 'first',
      baseContent: 'saved',
      revision: 'revision-1',
    })
    const [workspaceDirectory] = await readdir(rootDir)
    const workspacePath = path.join(rootDir, workspaceDirectory)
    const [recordName] = (await readdir(workspacePath)).filter((name) => name.endsWith('.json'))
    await writeFile(path.join(workspacePath, recordName), '{broken json', 'utf8')

    expect(await store.get(WORKSPACE_ID, RELATIVE_PATH, 'saved')).toEqual({ status: 'none' })

    await store.save({
      workspaceId: WORKSPACE_ID,
      relativePath: RELATIVE_PATH,
      draftContent: 'second',
      baseContent: 'saved',
      revision: 'revision-2',
    })
    const restored = await store.get(WORKSPACE_ID, RELATIVE_PATH, 'saved')
    expect(restored.status).not.toBe('none')
    if (restored.status !== 'none') expect(restored.draft.draftContent).toBe('second')
    const remainingNames = await readdir(workspacePath)
    expect(remainingNames.every((name) => !name.endsWith('.tmp'))).toBe(true)
    const [validRecordName] = remainingNames.filter((name) => name.endsWith('.json'))
    expect(JSON.parse(await readFile(path.join(workspacePath, validRecordName), 'utf8')).schemaVersion).toBe(1)
  })
})
