import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createNoteTemplateService } from '../noteTemplateService'
import { fileSystemService } from '../../file/fileSystemService'

const tempDirectories: string[] = []

const createFixture = async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'looma-note-templates-'))
  tempDirectories.push(directory)
  return {
    directory,
    storePath: path.join(directory, 'templates.json'),
    workspacePath: path.join(directory, 'workspace'),
  }
}

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })))
})

describe('note template service', () => {
  it('persists a created global template and loads it in a new service instance', async () => {
    const fixture = await createFixture()
    const service = createNoteTemplateService(fixture.storePath)

    const created = await service.create({
      name: '每日笔记',
      fileNameTemplate: '{{ now("YYYY-MM-DD") }}.md',
      contentTemplate: '# {{ now("YYYY-MM-DD") }}',
      variables: [],
    }, 0)

    expect(created.success).toBe(true)
    expect(created.data?.revision).toBe(1)
    expect(created.data?.templates).toHaveLength(1)

    const reloaded = await createNoteTemplateService(fixture.storePath).list()
    expect(reloaded.success).toBe(true)
    expect(reloaded.data?.templates[0]).toMatchObject({
      name: '每日笔记',
      fileNameTemplate: '{{ now("YYYY-MM-DD") }}.md',
      contentTemplate: '# {{ now("YYYY-MM-DD") }}',
    })
  })

  it('updates and removes templates only at the expected revision', async () => {
    const fixture = await createFixture()
    const service = createNoteTemplateService(fixture.storePath)
    const created = await service.create({
      name: '每日笔记',
      fileNameTemplate: 'daily.md',
      contentTemplate: '',
      variables: [],
    }, 0)
    const templateId = created.data!.templates[0].id

    const stale = await service.update(templateId, {
      name: '旧窗口修改',
      fileNameTemplate: 'stale.md',
      contentTemplate: '',
      variables: [],
    }, 0)
    expect(stale).toMatchObject({ success: false, errorCode: 'TEMPLATE_STALE' })

    const updated = await service.update(templateId, {
      name: '工作日志',
      fileNameTemplate: 'work.md',
      contentTemplate: '# 工作日志',
      variables: [],
    }, 1)
    expect(updated.data?.templates[0]).toMatchObject({ name: '工作日志', fileNameTemplate: 'work.md' })

    const removed = await service.remove(templateId, 2)
    expect(removed.data).toMatchObject({ revision: 3, templates: [] })
  })

  it('creates rendered Markdown and advances variables only after successful creation', async () => {
    const fixture = await createFixture()
    await fs.mkdir(path.join(fixture.workspacePath, 'journal'), { recursive: true })
    const service = createNoteTemplateService(fixture.storePath, {
      now: () => new Date(2026, 8, 3, 1, 2, 3),
    })
    const created = await service.create({
      name: '每日笔记',
      fileNameTemplate: '{{ now("YYYY-MM-DD") }}-{{ day }}.md',
      contentTemplate: '# 第 {{ day }} 天',
      variables: [{ id: 'day', name: 'day', type: 'number', value: 1, afterUseExpression: 'day + 1' }],
    }, 0)
    const templateId = created.data!.templates[0].id

    const instantiated = await service.instantiate(fixture.workspacePath, 'journal', templateId)

    expect(instantiated).toEqual({
      success: true,
      data: { relativePath: 'journal/2026-09-03-1.md', renderedFileName: '2026-09-03-1.md' },
    })
    await expect(fs.readFile(path.join(fixture.workspacePath, 'journal', '2026-09-03-1.md'), 'utf8'))
      .resolves.toBe('# 第 1 天')
    const listed = await service.list()
    expect(listed.data?.templates[0].variables[0].value).toBe(2)
  })

  it('does not advance variables when the rendered target already exists', async () => {
    const fixture = await createFixture()
    await fs.mkdir(fixture.workspacePath, { recursive: true })
    await fs.writeFile(path.join(fixture.workspacePath, 'daily.md'), 'existing', 'utf8')
    const service = createNoteTemplateService(fixture.storePath)
    const created = await service.create({
      name: '计数笔记',
      fileNameTemplate: 'daily.md',
      contentTemplate: '{{ count }}',
      variables: [{ id: 'count', name: 'count', type: 'number', value: 1, afterUseExpression: 'count + 1' }],
    }, 0)

    const instantiated = await service.instantiate(fixture.workspacePath, '', created.data!.templates[0].id)

    expect(instantiated.success).toBe(false)
    expect((await service.list()).data?.templates[0].variables[0].value).toBe(1)
    await expect(fs.readFile(path.join(fixture.workspacePath, 'daily.md'), 'utf8')).resolves.toBe('existing')
  })

  it('rejects invalid definitions and duplicate template names without changing revision', async () => {
    const fixture = await createFixture()
    const service = createNoteTemplateService(fixture.storePath)

    const invalid = await service.create({
      name: '',
      fileNameTemplate: '{{ missing }}.md',
      contentTemplate: '',
      variables: [],
    }, 0)
    expect(invalid).toMatchObject({ success: false, errorCode: 'TEMPLATE_INVALID' })

    await service.create({
      name: 'Daily',
      fileNameTemplate: 'daily.md',
      contentTemplate: '',
      variables: [],
    }, 0)
    const duplicate = await service.create({
      name: ' daily ',
      fileNameTemplate: 'other.md',
      contentTemplate: '',
      variables: [],
    }, 1)
    expect(duplicate).toMatchObject({ success: false, errorCode: 'TEMPLATE_NAME_EXISTS' })
    expect((await service.list()).data?.revision).toBe(1)
  })

  it('serializes concurrent writes so the same revision cannot be committed twice', async () => {
    const fixture = await createFixture()
    const service = createNoteTemplateService(fixture.storePath)
    const input = (name: string) => ({
      name,
      fileNameTemplate: `${name}.md`,
      contentTemplate: '',
      variables: [],
    })

    const results = await Promise.all([
      service.create(input('first'), 0),
      service.create(input('second'), 0),
    ])

    expect(results.filter(result => result.success)).toHaveLength(1)
    expect(results.filter(result => result.errorCode === 'TEMPLATE_STALE')).toHaveLength(1)
    expect((await service.list()).data).toMatchObject({ revision: 1 })
  })

  it('reports corrupt storage instead of silently replacing it with an empty store', async () => {
    const fixture = await createFixture()
    await fs.mkdir(path.dirname(fixture.storePath), { recursive: true })
    await fs.writeFile(fixture.storePath, '{not json', 'utf8')
    const service = createNoteTemplateService(fixture.storePath)

    const listed = await service.list()
    const created = await service.create({
      name: 'daily',
      fileNameTemplate: 'daily.md',
      contentTemplate: '',
      variables: [],
    }, 0)

    expect(listed).toMatchObject({ success: false, errorCode: 'TEMPLATE_LOAD_FAILED' })
    expect(created).toMatchObject({ success: false, errorCode: 'TEMPLATE_SAVE_FAILED' })
    expect(await fs.readFile(fixture.storePath, 'utf8')).toBe('{not json')
  })

  it('returns a readable load error when instantiation sees corrupt storage', async () => {
    const fixture = await createFixture()
    await fs.writeFile(fixture.storePath, '{not json', 'utf8')
    const service = createNoteTemplateService(fixture.storePath)

    const result = await service.instantiate(fixture.workspacePath, '', 'missing')

    expect(result).toMatchObject({ success: false, errorCode: 'TEMPLATE_LOAD_FAILED' })
  })

  it('rejects structurally invalid stored templates', async () => {
    const fixture = await createFixture()
    await fs.writeFile(fixture.storePath, JSON.stringify({
      schemaVersion: 1,
      revision: 1,
      templates: [{ id: 'broken', name: 'broken' }],
    }), 'utf8')
    const service = createNoteTemplateService(fixture.storePath)

    const result = await service.list()

    expect(result).toMatchObject({ success: false, errorCode: 'TEMPLATE_LOAD_FAILED' })
  })

  it('removes the created file when committing updated variables fails', async () => {
    const fixture = await createFixture()
    const setup = createNoteTemplateService(fixture.storePath)
    const created = await setup.create({
      name: 'counter',
      fileNameTemplate: 'counter-{{ day }}.md',
      contentTemplate: '{{ day }}',
      variables: [{ id: 'day', name: 'day', type: 'number', value: 1, afterUseExpression: 'day + 1' }],
    }, 0)
    const service = createNoteTemplateService(fixture.storePath, {
      rename: async () => { throw new Error('disk full') },
    })
    await fs.mkdir(fixture.workspacePath)

    const result = await service.instantiate(fixture.workspacePath, '', created.data!.templates[0].id)

    expect(result).toMatchObject({ success: false, errorCode: 'TEMPLATE_STATE_COMMIT_FAILED' })
    await expect(fs.stat(path.join(fixture.workspacePath, 'counter-1.md'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await setup.list()).data!.templates[0].variables[0].value).toBe(1)
  })

  it('reports partial success when both variable commit and file rollback fail', async () => {
    const fixture = await createFixture()
    const setup = createNoteTemplateService(fixture.storePath)
    const created = await setup.create({
      name: 'partial',
      fileNameTemplate: 'partial.md',
      contentTemplate: 'created',
      variables: [],
    }, 0)
    await fs.mkdir(fixture.workspacePath)
    const service = createNoteTemplateService(fixture.storePath, {
      rename: async () => { throw new Error('disk full') },
      unlink: async () => { throw new Error('locked') },
    })

    const result = await service.instantiate(fixture.workspacePath, '', created.data!.templates[0].id)

    expect(result).toMatchObject({
      success: false,
      errorCode: 'TEMPLATE_STATE_COMMIT_PARTIAL',
      data: { relativePath: 'partial.md', renderedFileName: 'partial.md' },
    })
    expect(await fs.readFile(path.join(fixture.workspacePath, 'partial.md'), 'utf8')).toBe('created')
  })

  it('does not delete a substituted file when rolling back a failed variable commit', async () => {
    const fixture = await createFixture()
    const setup = createNoteTemplateService(fixture.storePath)
    const created = await setup.create({
      name: 'substitution',
      fileNameTemplate: 'substitution.md',
      contentTemplate: 'created',
      variables: [],
    }, 0)
    await fs.mkdir(fixture.workspacePath)
    const createdPath = path.join(fixture.workspacePath, 'substitution.md')
    const movedPath = path.join(fixture.workspacePath, 'created-by-template.md')
    const service = createNoteTemplateService(fixture.storePath, {
      rename: async () => {
        await fs.rename(createdPath, movedPath)
        await fs.writeFile(createdPath, 'unrelated', 'utf8')
        throw new Error('disk full')
      },
    })

    const result = await service.instantiate(fixture.workspacePath, '', created.data!.templates[0].id)

    expect(result).toMatchObject({ success: false, errorCode: 'TEMPLATE_STATE_COMMIT_PARTIAL' })
    await expect(fs.readFile(createdPath, 'utf8')).resolves.toBe('unrelated')
    await expect(fs.readFile(movedPath, 'utf8')).resolves.toBe('created')
  })

  it('pins rollback identity before returning from transactional file creation', async () => {
    const fixture = await createFixture()
    const setup = createNoteTemplateService(fixture.storePath)
    const created = await setup.create({
      name: 'identity gap',
      fileNameTemplate: 'identity-gap.md',
      contentTemplate: 'created',
      variables: [],
    }, 0)
    await fs.mkdir(fixture.workspacePath)
    const createdPath = path.join(fixture.workspacePath, 'identity-gap.md')
    const movedPath = path.join(fixture.workspacePath, 'original-created-file.md')
    const originalCreate = fileSystemService.createFileForTransaction.bind(fileSystemService)
    vi.spyOn(fileSystemService, 'createFileForTransaction').mockImplementation(async (...args) => {
      const result = await originalCreate(...args)
      if (result.success) {
        await fs.rename(createdPath, movedPath)
        await fs.writeFile(createdPath, 'unrelated', 'utf8')
      }
      return result
    })
    const service = createNoteTemplateService(fixture.storePath, {
      rename: async () => { throw new Error('disk full') },
    })

    const result = await service.instantiate(fixture.workspacePath, '', created.data!.templates[0].id)

    expect(result).toMatchObject({ success: false, errorCode: 'TEMPLATE_STATE_COMMIT_PARTIAL' })
    await expect(fs.readFile(createdPath, 'utf8')).resolves.toBe('unrelated')
    await expect(fs.readFile(movedPath, 'utf8')).resolves.toBe('created')
  })
})
