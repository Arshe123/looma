export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error'

export type UpdateState = {
  status: UpdateStatus
  version?: string
  releaseName?: string | null
  releaseNotes?: string | null
  releaseDate?: string | null
  percent?: number
  transferred?: number
  total?: number
  bytesPerSecond?: number
  error?: string
}

export type UpdateActionResult = {
  success: boolean
  state: UpdateState
}
