import fs from 'fs/promises'
import path from 'path'
import type { Result } from '@/common/interface/Result'
import {
  defaultAppSettings,
  normalizeAppSettings,
  type AppSettings,
} from '@/common/util/tiptap-menu-actions'

export { defaultAppSettings }
export type { AppSettings }

export const makeAppSettingsPath = (appDataPath: string) =>
  path.join(appDataPath, 'workspace-meta', 'looma', 'settings.json')

export const createAppSettingsService = (settingsPath: string) => ({
  settingsPath,

  async getSettings(): Promise<Result<AppSettings>> {
    try {
      const raw = await fs.readFile(settingsPath, 'utf-8')
      return { success: true, data: normalizeAppSettings(JSON.parse(raw)) }
    } catch {
      return { success: true, data: defaultAppSettings }
    }
  },

  async setSettings(settings: AppSettings): Promise<Result<void>> {
    try {
      const normalized = normalizeAppSettings(settings)
      await fs.mkdir(path.dirname(settingsPath), { recursive: true })
      await fs.writeFile(settingsPath, JSON.stringify(normalized, null, 2), 'utf-8')
      return { success: true }
    } catch (error: any) {
      return { success: false, error: `保存系统设置失败: ${error?.message ?? String(error)}` }
    }
  },
})
