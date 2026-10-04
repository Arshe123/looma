import fs from 'fs/promises'
import path from 'path'
import { randomUUID } from 'node:crypto'
import type { Result } from '../../../shared/types/Result'
import {
  defaultAppSettings,
  normalizeAppSettings,
  type AppSettings,
} from '../../../shared/utils/app-settings'

export { defaultAppSettings }

export const makeAppSettingsPath = (appDataPath: string) =>
  path.join(appDataPath, 'workspace-meta', 'looma', 'settings.json')

export const createAppSettingsService = (settingsPath: string) => {
  // Live main-process authority, never a conversation snapshot. Fail closed until loaded.
  let current: AppSettings | undefined
  let queue: Promise<unknown> = Promise.resolve()
  const locked = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = queue.then(operation, operation)
    queue = next
    return next
  }
  return {
    settingsPath,
    canAutoMaintainUserProfile: () => current?.memory.autoMaintainUserProfile === true,
    getSettings: (): Promise<Result<AppSettings>> => locked(async () => {
      try {
        current = normalizeAppSettings(JSON.parse(await fs.readFile(settingsPath, 'utf-8')))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          current = undefined
          return { success: false, error: '读取系统设置失败，请检查文件后重试。' }
        }
        current = normalizeAppSettings(defaultAppSettings)
      }
      return { success: true, data: normalizeAppSettings(current) }
    }),
    setSettings(settings: AppSettings): Promise<Result<void>> {
      const normalized = normalizeAppSettings(settings)
      return locked(async () => {
        const temporary = `${settingsPath}.${randomUUID()}.tmp`
        try {
          await fs.mkdir(path.dirname(settingsPath), { recursive: true })
          await fs.writeFile(temporary, JSON.stringify(normalized, null, 2), { encoding: 'utf-8', mode: 0o600 })
          await fs.rename(temporary, settingsPath)
          current = normalized
          return { success: true }
        } catch {
          return { success: false, error: '保存系统设置失败，请检查文件权限和磁盘空间后重试。' }
        } finally { await fs.rm(temporary, { force: true }).catch(() => {}) }
      })
    },
  }
}
