import fs from 'fs/promises'
import path from 'path'
import { randomUUID } from 'node:crypto'
import type { Result } from '../../../shared/types/Result'
import { defaultAppSettings, normalizeAppSettings, type AppSettings } from '../../../shared/utils/app-settings'

export { defaultAppSettings }
export const makeAppSettingsPath = (appDataPath: string) => path.join(appDataPath, 'workspace-meta', 'looma', 'settings.json')
type SettingsResult = Result<AppSettings> & { revision?: number }

export const createAppSettingsService = (settingsPath: string) => {
  let current: AppSettings | undefined
  let revision = 0
  let queue: Promise<unknown> = Promise.resolve()
  const listeners = new Set<(revision: number) => void>()
  const locked = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = queue.then(operation, operation)
    queue = next
    return next
  }
  const load = async () => {
    try {
      const loaded = normalizeAppSettings(JSON.parse(await fs.readFile(settingsPath, 'utf-8')))
      if (JSON.stringify(loaded) !== JSON.stringify(current)) revision++
      current = loaded
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        current = undefined
        throw new Error('读取系统设置失败，请检查文件后重试。')
      }
      if (!current) { current = normalizeAppSettings(defaultAppSettings); revision++ }
    }
    return current
  }
  const save = async (settings: AppSettings): Promise<SettingsResult> => {
    const temporary = `${settingsPath}.${randomUUID()}.tmp`
    try {
      await fs.mkdir(path.dirname(settingsPath), { recursive: true })
      const file = await fs.open(temporary, 'wx', 0o600)
      try { await file.writeFile(JSON.stringify(settings, null, 2), 'utf-8'); await file.sync() }
      finally { await file.close() }
      await fs.rename(temporary, settingsPath)
      current = settings
      revision++
      for (const listener of listeners) { try { listener(revision) } catch { /* Closed listeners cannot fail committed saves. */ } }
      return { success: true, data: normalizeAppSettings(current), revision }
    } catch {
      return { success: false, error: '保存系统设置失败，请检查文件权限和磁盘空间后重试。' }
    } finally { await fs.rm(temporary, { force: true }).catch(() => {}) }
  }
  return {
    settingsPath,
    canAutoMaintainUserProfile: () => current?.memory.autoMaintainUserProfile === true,
    subscribe(listener: (revision: number) => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    getSettings: (): Promise<SettingsResult> => locked(async () => {
      try { await load(); return { success: true, data: normalizeAppSettings(current), revision } }
      catch (error) { return { success: false, error: (error as Error).message } }
    }),
    // Legacy full snapshots require CAS; unversioned callers cannot overwrite permissions.
    setSettings(settings: AppSettings, expectedRevision?: number): Promise<SettingsResult> {
      return locked(async () => {
        try {
          await load()
          if (expectedRevision !== revision) return { success: false, error: '设置已变更，请重新加载后重试。' }
          return await save(normalizeAppSettings(settings))
        } catch (error) { return { success: false, error: (error as Error).message } }
      })
    },
    patchSettings(patch: unknown): Promise<SettingsResult> {
      return locked(async () => {
        try {
          const latest = await load()
          return await save(normalizeAppSettings(mergeSettingsPatch(latest, patch, normalizeAppSettings(defaultAppSettings))))
        } catch (error) { return { success: false, error: (error as Error).message } }
      })
    },
  }
}

// Validate known paths before merging, never fill missing fields from a stale snapshot.
function mergeSettingsPatch(current: unknown, patch: unknown, schema: unknown): unknown {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('无效的设置更新。')
  const output = { ...current as Record<string, unknown> }
  const shape = schema as Record<string, unknown>
  for (const [key, value] of Object.entries(patch)) {
    if (!Object.prototype.hasOwnProperty.call(shape, key)) throw new Error('未知的设置字段。')
    const expected = shape[key]
    if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
      output[key] = mergeSettingsPatch(output[key], value, expected)
    } else {
      if (Array.isArray(expected) ? !Array.isArray(value) : expected !== undefined && typeof value !== typeof expected) throw new Error('无效的设置值。')
      output[key] = value
    }
  }
  return output
}
