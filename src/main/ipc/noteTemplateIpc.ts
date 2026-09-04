import path from 'node:path'
import { app, ipcMain } from 'electron'
import { createNoteTemplateService } from '../services/app/noteTemplateService'
import { getWorkspacePathById } from './workspaceIpc'
import type { NoteTemplateInput } from '../../shared/utils/note-template'

const noteTemplateService = createNoteTemplateService(
  path.join(app.getPath('userData'), 'note-templates', 'templates.json'),
)

ipcMain.handle('noteTemplates:list', async () => noteTemplateService.list())

const invalidRequest = () => ({
  success: false,
  errorCode: 'TEMPLATE_INVALID_REQUEST',
  error: '模板请求参数无效。',
})
const isExpectedRevision = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0

ipcMain.handle('noteTemplates:create', async (_, input: unknown, expectedRevision: unknown) => {
  if (!input || typeof input !== 'object' || !isExpectedRevision(expectedRevision)) return invalidRequest()
  return noteTemplateService.create(input as NoteTemplateInput, expectedRevision)
})

ipcMain.handle('noteTemplates:update', async (_, id: unknown, input: unknown, expectedRevision: unknown) => {
  if (typeof id !== 'string' || !id || !input || typeof input !== 'object' || !isExpectedRevision(expectedRevision)) return invalidRequest()
  return noteTemplateService.update(id, input as NoteTemplateInput, expectedRevision)
})

ipcMain.handle('noteTemplates:remove', async (_, id: unknown, expectedRevision: unknown) => {
  if (typeof id !== 'string' || !id || !isExpectedRevision(expectedRevision)) return invalidRequest()
  return noteTemplateService.remove(id, expectedRevision)
})

ipcMain.handle('noteTemplates:instantiate', async (_, input: unknown) => {
  if (!input || typeof input !== 'object') return invalidRequest()
  const payload = input as Record<string, unknown>
  if (typeof payload.workspaceId !== 'string' || typeof payload.parentDirRelativePath !== 'string' || typeof payload.templateId !== 'string') return invalidRequest()
  const workspacePath = await getWorkspacePathById(payload.workspaceId)
  if (!workspacePath) return { success: false, errorCode: 'WORKSPACE_NOT_FOUND', error: '工作空间不存在。' }
  return noteTemplateService.instantiate(workspacePath, payload.parentDirRelativePath, payload.templateId)
})

export { noteTemplateService }
