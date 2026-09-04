import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Result } from '../../../shared/types/Result'
import {
  normalizeNoteTemplateInput,
  renderNoteTemplateInstance,
  validateNoteTemplate,
  type NoteTemplate,
  type NoteTemplateInput,
  type NoteTemplateStore,
} from '../../../shared/utils/note-template'
import { fileSystemService } from '../file/fileSystemService'

const emptyStore = (): NoteTemplateStore => ({ schemaVersion: 1, revision: 0, templates: [] })

const normalizeStore = (value: unknown): NoteTemplateStore => {
  if (!value || typeof value !== 'object') throw new Error('模板存储格式无效。')
  const record = value as Record<string, unknown>
  if (record.schemaVersion !== 1 || !Number.isSafeInteger(record.revision) || Number(record.revision) < 0 || !Array.isArray(record.templates)) {
    throw new Error('模板存储格式无效。')
  }
  const names = new Set<string>()
  const templates = record.templates.map((value) => {
    const validated = validateNoteTemplate(value)
    if (validated.ok === false) throw new Error(`模板存储格式无效：${validated.error.message}`)
    const template = validated.value
    const normalized = normalizeNoteTemplateInput({
      name: template.name,
      fileNameTemplate: template.fileNameTemplate,
      contentTemplate: template.contentTemplate,
      variables: template.variables,
    })
    if (normalized.ok === false) throw new Error(`模板“${template.name || template.id}”格式无效：${normalized.error.message}`)
    const normalizedName = normalized.value.name.toLocaleLowerCase()
    if (names.has(normalizedName)) throw new Error('模板名称重复。')
    names.add(normalizedName)
    return {
      ...normalized.value,
      id: template.id,
      createdAt: template.createdAt as number,
      updatedAt: template.updatedAt as number,
    }
  })
  return {
    schemaVersion: 1,
    revision: Number(record.revision),
    templates,
  }
}

type NoteTemplateServiceOptions = {
  now?: () => Date
  rename?: typeof fs.rename
  unlink?: typeof fs.unlink
}

type RollbackTarget = {
  path: string
  dev: number | bigint
  ino: number | bigint
  birthtimeMs: number | bigint
}

export const createNoteTemplateService = (storePath: string, options: NoteTemplateServiceOptions = {}) => {
  const readStore = async () => {
    try {
      return normalizeStore(JSON.parse(await fs.readFile(storePath, 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyStore()
      throw error
    }
  }

  const writeStore = async (store: NoteTemplateStore) => {
    await fs.mkdir(path.dirname(storePath), { recursive: true })
    const temporaryPath = `${storePath}.${randomUUID()}.tmp`
    try {
      await fs.writeFile(temporaryPath, JSON.stringify(store, null, 2), 'utf8')
      await (options.rename ?? fs.rename)(temporaryPath, storePath)
    } finally {
      await fs.rm(temporaryPath, { force: true })
    }
  }

  const staleResult = (): Result<NoteTemplateStore> => ({
    success: false,
    errorCode: 'TEMPLATE_STALE',
    error: '模板已在其他窗口中更新，请刷新后重试。',
  })

  let writeQueue: Promise<void> = Promise.resolve()
  const withWriteLock = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = writeQueue.then(operation, operation)
    writeQueue = result.then(() => undefined, () => undefined)
    return result
  }

  return {
    async list(): Promise<Result<NoteTemplateStore>> {
      try {
        return { success: true, data: await readStore() }
      } catch (error) {
        return {
          success: false,
          errorCode: 'TEMPLATE_LOAD_FAILED',
          error: `模板加载失败: ${error instanceof Error ? error.message : String(error)}`,
        }
      }
    },

    async create(input: NoteTemplateInput, expectedRevision: number): Promise<Result<NoteTemplateStore>> {
      return withWriteLock(async () => {
        try {
          const normalized = normalizeNoteTemplateInput(input)
          if (normalized.ok === false) return { success: false, errorCode: 'TEMPLATE_INVALID', error: normalized.error.message }
          const store = await readStore()
          if (store.revision !== expectedRevision) return staleResult()
          if (store.templates.some(template => template.name.toLocaleLowerCase() === normalized.value.name.toLocaleLowerCase())) {
            return { success: false, errorCode: 'TEMPLATE_NAME_EXISTS', error: '模板名称已存在。' }
          }
          const now = Date.now()
          const template: NoteTemplate = {
            ...normalized.value,
            id: randomUUID(),
            createdAt: now,
            updatedAt: now,
          }
          const next = { ...store, revision: store.revision + 1, templates: [...store.templates, template] }
          await writeStore(next)
          return { success: true, data: next }
        } catch (error) {
          return { success: false, errorCode: 'TEMPLATE_SAVE_FAILED', error: `保存模板失败: ${error instanceof Error ? error.message : String(error)}` }
        }
      })
    },

    async update(id: string, input: NoteTemplateInput, expectedRevision: number): Promise<Result<NoteTemplateStore>> {
      return withWriteLock(async () => {
        try {
          const normalized = normalizeNoteTemplateInput(input)
          if (normalized.ok === false) return { success: false, errorCode: 'TEMPLATE_INVALID', error: normalized.error.message }
          const store = await readStore()
          if (store.revision !== expectedRevision) return staleResult()
          const index = store.templates.findIndex(template => template.id === id)
          if (index < 0) return { success: false, errorCode: 'TEMPLATE_NOT_FOUND', error: '模板不存在或已被删除。' }
          if (store.templates.some(template => template.id !== id && template.name.toLocaleLowerCase() === normalized.value.name.toLocaleLowerCase())) {
            return { success: false, errorCode: 'TEMPLATE_NAME_EXISTS', error: '模板名称已存在。' }
          }
          const templates = [...store.templates]
          templates[index] = {
            ...templates[index],
            ...normalized.value,
            id: templates[index].id,
            createdAt: templates[index].createdAt,
            updatedAt: Date.now(),
          }
          const next = { ...store, revision: store.revision + 1, templates }
          await writeStore(next)
          return { success: true, data: next }
        } catch (error) {
          return { success: false, errorCode: 'TEMPLATE_SAVE_FAILED', error: `保存模板失败: ${error instanceof Error ? error.message : String(error)}` }
        }
      })
    },

    async remove(id: string, expectedRevision: number): Promise<Result<NoteTemplateStore>> {
      return withWriteLock(async () => {
        try {
          const store = await readStore()
          if (store.revision !== expectedRevision) return staleResult()
          if (!store.templates.some(template => template.id === id)) {
            return { success: false, errorCode: 'TEMPLATE_NOT_FOUND', error: '模板不存在或已被删除。' }
          }
          const next = {
            ...store,
            revision: store.revision + 1,
            templates: store.templates.filter(template => template.id !== id),
          }
          await writeStore(next)
          return { success: true, data: next }
        } catch (error) {
          return { success: false, errorCode: 'TEMPLATE_SAVE_FAILED', error: `删除模板失败: ${error instanceof Error ? error.message : String(error)}` }
        }
      })
    },

    async instantiate(
      workspacePath: string,
      parentDirRelativePath: string,
      templateId: string,
    ): Promise<Result<{ relativePath: string; renderedFileName: string }>> {
      return withWriteLock(async () => {
        let store: NoteTemplateStore
        try {
          store = await readStore()
        } catch (error) {
          return {
            success: false,
            errorCode: 'TEMPLATE_LOAD_FAILED',
            error: `模板加载失败: ${error instanceof Error ? error.message : String(error)}`,
          }
        }
        const template = store.templates.find(item => item.id === templateId)
        if (!template) return { success: false, errorCode: 'TEMPLATE_NOT_FOUND', error: '模板不存在或已被删除。' }

        const rendered = renderNoteTemplateInstance(template, options.now?.() ?? new Date())
        if (rendered.ok === false) {
          return { success: false, errorCode: `TEMPLATE_${rendered.error.code}`, error: rendered.error.message }
        }

        const created = await fileSystemService.createFileForTransaction(
          workspacePath,
          parentDirRelativePath,
          rendered.value.filename,
          rendered.value.content,
        )
        if (!created.success || !created.data) {
          return {
            success: false,
            errorCode: created.errorCode === 'TARGET_EXISTS' ? 'TARGET_EXISTS' : 'TEMPLATE_FILE_CREATE_FAILED',
            error: created.error || '创建模板文件失败。',
          }
        }
        const rollbackTarget: RollbackTarget = {
          path: created.data.absolutePath,
          dev: created.data.dev,
          ino: created.data.ino,
          birthtimeMs: created.data.birthtimeMs,
        }

        const nextStore: NoteTemplateStore = {
          ...store,
          revision: store.revision + 1,
          templates: store.templates.map(item => item.id === templateId
            ? { ...item, variables: rendered.value.nextVariables, updatedAt: Date.now() }
            : item),
        }
        try {
          await writeStore(nextStore)
        } catch (error) {
          try {
            const currentStat = await fs.lstat(rollbackTarget.path)
            if (currentStat.isSymbolicLink()
              || !currentStat.isFile()
              || currentStat.dev !== rollbackTarget.dev
              || currentStat.ino !== rollbackTarget.ino
              || currentStat.birthtimeMs !== rollbackTarget.birthtimeMs) {
              throw new Error('刚创建的文件路径已发生变化。')
            }
            await (options.unlink ?? fs.unlink)(rollbackTarget.path)
          } catch (rollbackError) {
            return {
              success: false,
              errorCode: 'TEMPLATE_STATE_COMMIT_PARTIAL',
              error: `文件已创建，但模板变量未更新: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
              data: { relativePath: created.data.relativePath, renderedFileName: rendered.value.filename },
            }
          }
          return {
            success: false,
            errorCode: 'TEMPLATE_STATE_COMMIT_FAILED',
            error: `模板变量保存失败，已撤销文件创建: ${error instanceof Error ? error.message : String(error)}`,
          }
        }

        return {
          success: true,
          data: { relativePath: created.data.relativePath, renderedFileName: rendered.value.filename },
        }
      })
    },
  }
}
