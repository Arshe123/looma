import { app, BrowserWindow } from 'electron'
import type { UpdateState } from '../../../shared/types/app-update'
import { checkForUpdate } from '../../../shared/utils/version-api'

let state: UpdateState = { status: 'idle' }
let pendingCheck: Promise<UpdateState> | null = null

const publish = (nextState: UpdateState) => {
  state = nextState
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('app:update:state', state)
  }
  return state
}

const check = () => {
  if (pendingCheck) return pendingCheck

  pendingCheck = (async () => {
    publish({ status: 'checking' })
    try {
      const result = await checkForUpdate(app.getVersion())
      if (!result?.hasUpdate) return publish({ status: 'not-available' })
      return publish({
        status: 'available',
        version: result.latest.version,
        releaseName: null,
        releaseNotes: result.latest.notes,
        releaseDate: result.latest.releaseDate,
        downloadUrl: result.latest.downloadUrl,
      })
    } catch (error) {
      console.error('[update:check] Failed to check GitHub Releases', error)
      return publish({ status: 'error', error: '暂时无法检查更新，请稍后重试。' })
    } finally {
      pendingCheck = null
    }
  })()

  return pendingCheck
}

export const manualUpdateService = {
  getState: () => state,
  check,
}
