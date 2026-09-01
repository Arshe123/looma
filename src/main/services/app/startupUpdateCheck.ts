import type { UpdateStartupResult, UpdateState } from '../../../shared/types/app-update'

type StartupUpdateCheckOptions = {
  enabled: () => boolean
  getState: () => UpdateState
  check: () => Promise<UpdateState>
}

export const createStartupUpdateCheck = (options: StartupUpdateCheckOptions) => {
  let pendingCheck: Promise<UpdateState> | null = null
  let notificationClaimed = false

  return async (): Promise<UpdateStartupResult> => {
    if (!options.enabled()) {
      return { success: true, state: options.getState(), notify: false }
    }

    pendingCheck ??= options.check()
    const state = await pendingCheck
    const notify = state.status === 'available' && !notificationClaimed
    if (notify) notificationClaimed = true
    return { success: state.status !== 'error', state, notify }
  }
}
