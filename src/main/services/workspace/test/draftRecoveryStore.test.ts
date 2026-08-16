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
    expect((await readdir(workspacePath)).every((name) => !name.endsWith('.tmp'))).toBe(true)
    expect(JSON.parse(await readFile(path.join(workspacePath, recordName), 'utf8')).schemaVersion).toBe(1)
  })
})
