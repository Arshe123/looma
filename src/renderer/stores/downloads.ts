import { computed, reactive } from 'vue'
import { defineStore } from 'pinia'

export type DownloadStatus = 'idle' | 'downloading' | 'completed' | 'error' | 'cancelled'

export interface DownloadTask {
  id: string
  title: string
  message: string
  status: DownloadStatus
  receivedBytes: number
  totalBytes?: number
  percent?: number
  error?: string
  cancel?: () => Promise<void>
  retry?: () => Promise<void>
}

export type DownloadTaskInput = Pick<DownloadTask, 'id' | 'title'> & Partial<Omit<DownloadTask, 'id' | 'title'>>

export const useDownloadsStore = defineStore('downloads', () => {
  const tasks = reactive<Record<string, DownloadTask>>({})
  const closeTimers = new Map<string, number>()

  const visibleTasks = computed(() => {
    return Object.values(tasks).filter((task) => task.status !== 'idle' && task.status !== 'cancelled')
  })

  const clearCloseTimer = (id: string) => {
    const timer = closeTimers.get(id)
    if (!timer) return
    window.clearTimeout(timer)
    closeTimers.delete(id)
  }

  const startTask = (task: DownloadTaskInput) => {
    clearCloseTimer(task.id)
    tasks[task.id] = {
      message: '',
      status: 'downloading',
      receivedBytes: 0,
      ...task,
      error: task.error ?? '',
    }
  }

  const updateTask = (id: string, patch: Partial<DownloadTask>) => {
    const existing = tasks[id]
    if (!existing) return
    Object.assign(existing, patch)
  }

  const completeTask = (id: string, message?: string) => {
    updateTask(id, {
      status: 'completed',
      message: message ?? tasks[id]?.message ?? '',
      error: '',
      percent: tasks[id]?.percent ?? 100,
    })
  }

  const failTask = (id: string, error: string) => {
    updateTask(id, {
      status: 'error',
      error,
      message: error,
    })
  }

  const closeTask = (id: string) => {
    clearCloseTimer(id)
    delete tasks[id]
  }

  const scheduleCloseTask = (id: string, delay = 3000) => {
    clearCloseTimer(id)
    closeTimers.set(id, window.setTimeout(() => {
      closeTask(id)
    }, delay))
  }

  const cancelTask = async (id: string) => {
    const task = tasks[id]
    if (!task) return
    await task.cancel?.()
    updateTask(id, {
      status: 'cancelled',
      error: '',
      message: '',
    })
    closeTask(id)
  }

  const retryTask = async (id: string) => {
    const task = tasks[id]
    if (!task?.retry) return
    await task.retry()
  }

  const dispose = () => {
    for (const timer of closeTimers.values()) {
      window.clearTimeout(timer)
    }
    closeTimers.clear()
  }

  return {
    tasks,
    visibleTasks,
    startTask,
    updateTask,
    completeTask,
    failTask,
    cancelTask,
    retryTask,
    closeTask,
    scheduleCloseTask,
    dispose,
  }
})
