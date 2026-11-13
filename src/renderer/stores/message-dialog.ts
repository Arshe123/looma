import { defineStore } from 'pinia'
import { shallowRef } from 'vue'

export interface MessageDialogOptions {
  type?: 'none' | 'info' | 'warning' | 'error' | 'question'
  title?: string
  message: string
  detail?: string
  detailLabel?: string
  buttons?: string[]
  defaultId?: number
  cancelId?: number
  dangerId?: number
}

export interface ConfirmationDialogOptions {
  title: string
  message: string
  confirmText?: string
  cancelText?: string
  danger?: boolean
}

export function normalizeMessageDialogOptions(options: MessageDialogOptions) {
  const type = options.type ?? 'info'
  const buttons = options.buttons?.length ? [...options.buttons] : ['知道了']
  const validId = (id: number | undefined): id is number => typeof id === 'number' && Number.isInteger(id) && id >= 0 && id < buttons.length
  const cancelId = validId(options.cancelId) ? options.cancelId : buttons.length - 1
  return {
    ...options,
    type,
    title: options.title || ({ none: '提示', info: '提示', warning: '请注意', error: '操作失败', question: '请确认' })[type],
    buttons,
    cancelId,
    defaultId: validId(options.defaultId) ? options.defaultId : cancelId,
    dangerId: validId(options.dangerId) ? options.dangerId : undefined,
  }
}

export interface MessageDialogRequest {
  id: number
  options: ReturnType<typeof normalizeMessageDialogOptions>
}

export const useMessageDialogStore = defineStore('messageDialog', () => {
  const current = shallowRef<MessageDialogRequest | null>(null)
  let sequence = 0
  const pending: { request: MessageDialogRequest; resolve: (result: { response: number }) => void }[] = []

  function show(options: MessageDialogOptions): Promise<{ response: number }> {
    const request = { id: ++sequence, options: normalizeMessageDialogOptions(options) }
    return new Promise(resolve => {
      pending.push({ request, resolve })
      current.value ??= request
    })
  }

  function respond(id: number, response: number) {
    if (current.value?.id !== id || !Number.isInteger(response)
      || response < 0 || response >= current.value.options.buttons.length) return
    const item = pending.shift()!
    current.value = pending[0]?.request ?? null
    item.resolve({ response })
  }

  function cancelAll() {
    const items = pending.splice(0)
    current.value = null
    for (const item of items) item.resolve({ response: item.request.options.cancelId })
  }

  return { current, show, respond, cancelAll }
})

export const showMessageDialog = (options: MessageDialogOptions) => useMessageDialogStore().show(options)

export async function confirmMessageDialog(options: ConfirmationDialogOptions): Promise<boolean> {
  const result = await showMessageDialog({
    type: options.danger ? 'warning' : 'question',
    title: options.title,
    message: options.message,
    buttons: [options.confirmText?.trim() || '确定', options.cancelText?.trim() || '取消'],
    defaultId: 1,
    cancelId: 1,
    dangerId: options.danger ? 0 : undefined,
  })
  return result.response === 0
}
