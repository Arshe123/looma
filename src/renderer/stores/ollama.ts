import { ref } from 'vue'
import { defineStore } from 'pinia'
import { useDownloadsStore } from '@/renderer/stores/downloads'

const ollamaInstallerDownloadId = 'ollama-installer'

export const useOllamaStore = defineStore('ollama', () => {
  const downloadsStore = useDownloadsStore()
  const installed = ref(false)
  const isChecking = ref(false)
  const isDownloading = ref(false)
  const pullingModels = ref<Record<string, boolean>>({})
  const deletingModels = ref<Record<string, boolean>>({})
  const modelListVersion = ref(0)

  let stopDownloadProgress: (() => void) | null = null
  let stopPullModelProgress: (() => void) | null = null
  let installCheckTimer: number | null = null
  let lastBaseUrl = 'http://127.0.0.1:11434'
  const completedProgressModels = new Set<string>()

  const getModelPullTaskId = (model: string) => `ollama-model-${model}`

  const setModelPulling = (model: string, value: boolean) => {
    const name = model.trim()
    if (!name) return
    const next = { ...pullingModels.value }
    if (value) next[name] = true
    else delete next[name]
    pullingModels.value = next
  }

  const isPullingModel = (model: string) => Boolean(pullingModels.value[model.trim()])

  const setModelDeleting = (model: string, value: boolean) => {
    const name = model.trim()
    if (!name) return
    const next = { ...deletingModels.value }
    if (value) next[name] = true
    else delete next[name]
    deletingModels.value = next
  }

  const isDeletingModel = (model: string) => Boolean(deletingModels.value[model.trim()])

  const formatPullMessage = (model: string, message?: string) => {
    return message ? `${model}: ${message}` : `正在下载 ${model}...`
  }

  const markModelListChanged = () => {
    modelListVersion.value += 1
  }

  const markInstalled = (value: boolean) => {
    installed.value = value
    if (!value) return
    const task = downloadsStore.tasks[ollamaInstallerDownloadId]
    if (task?.status === 'completed') {
      downloadsStore.completeTask(ollamaInstallerDownloadId, 'Ollama 安装成功。')
      downloadsStore.updateTask(ollamaInstallerDownloadId, {
        title: 'Ollama 安装成功',
      })
      downloadsStore.scheduleCloseTask(ollamaInstallerDownloadId, 3000)
    }
    if (installCheckTimer) {
      window.clearInterval(installCheckTimer)
      installCheckTimer = null
    }
  }

  const checkInstalled = async (baseUrl: string) => {
    lastBaseUrl = baseUrl || lastBaseUrl
    isChecking.value = true
    try {
      const result = await window.electronAPI.ollama.checkInstalled(lastBaseUrl)
      markInstalled(Boolean(result.success && result.data?.installed))
      return installed.value
    } catch {
      installed.value = false
      return false
    } finally {
      isChecking.value = false
    }
  }

  const startInstallPolling = (baseUrl = lastBaseUrl) => {
    lastBaseUrl = baseUrl || lastBaseUrl
    if (installCheckTimer) window.clearInterval(installCheckTimer)
    let attempts = 0
    installCheckTimer = window.setInterval(async () => {
      attempts += 1
      const isInstalled = await checkInstalled(lastBaseUrl)
      if (isInstalled || attempts >= 60) {
        if (installCheckTimer) {
          window.clearInterval(installCheckTimer)
          installCheckTimer = null
        }
      }
    }, 5000)
  }

  const attachDownloadProgress = () => {
    if (stopDownloadProgress) return
    stopDownloadProgress = window.electronAPI.ollama.onDownloadProgress((payload) => {
      downloadsStore.updateTask(ollamaInstallerDownloadId, {
        status: payload.status,
        receivedBytes: payload.receivedBytes,
        totalBytes: payload.totalBytes,
        percent: payload.percent,
      })
      if (payload.status === 'downloading') {
        downloadsStore.updateTask(ollamaInstallerDownloadId, {
          message: '正在下载 Ollama...',
        })
      }
      if (payload.status === 'completed') {
        downloadsStore.completeTask(ollamaInstallerDownloadId, '下载完成，已打开安装器。安装完成后会自动检测。')
        downloadsStore.updateTask(ollamaInstallerDownloadId, {
          title: 'Ollama 安装器已打开',
        })
        isDownloading.value = false
      }
      if (payload.status === 'error') {
        downloadsStore.failTask(ollamaInstallerDownloadId, payload.error || '下载 Ollama 失败。')
        isDownloading.value = false
      }
      if (payload.status === 'cancelled') {
        isDownloading.value = false
        downloadsStore.closeTask(ollamaInstallerDownloadId)
      }
    })
  }

  const attachPullModelProgress = () => {
    if (stopPullModelProgress) return
    stopPullModelProgress = window.electronAPI.ollama.onPullModelProgress((payload) => {
      const taskId = getModelPullTaskId(payload.model)
      const message = formatPullMessage(payload.model, payload.message)
      downloadsStore.updateTask(taskId, {
        status: payload.status,
        receivedBytes: payload.receivedBytes,
        totalBytes: payload.totalBytes,
        percent: payload.percent,
        message,
        error: payload.error ?? '',
      })

      if (payload.status === 'completed') {
        setModelPulling(payload.model, false)
        completedProgressModels.add(payload.model)
        markModelListChanged()
        downloadsStore.completeTask(taskId, `${payload.model} 下载完成。`)
        downloadsStore.scheduleCloseTask(taskId, 3000)
      }

      if (payload.status === 'error') {
        setModelPulling(payload.model, false)
        downloadsStore.failTask(taskId, payload.error || `下载模型 ${payload.model} 失败。`)
      }

      if (payload.status === 'cancelled') {
        setModelPulling(payload.model, false)
        downloadsStore.closeTask(taskId)
      }
    })
  }

  const downloadInstaller = async (baseUrl = lastBaseUrl) => {
    if (isDownloading.value) return
    lastBaseUrl = baseUrl || lastBaseUrl
    attachDownloadProgress()
    isDownloading.value = true
    downloadsStore.startTask({
      id: ollamaInstallerDownloadId,
      title: '下载 Ollama',
      message: '正在下载 Ollama...',
      status: 'downloading',
      receivedBytes: 0,
      cancel: cancelDownload,
      retry: retryDownload,
    })

    try {
      const result = await window.electronAPI.ollama.downloadInstaller()
      if (!result.success) {
        if (!downloadsStore.tasks[ollamaInstallerDownloadId]) {
          return
        }
        downloadsStore.failTask(ollamaInstallerDownloadId, result.error || '下载 Ollama 失败。')
        return
      }
      downloadsStore.completeTask(ollamaInstallerDownloadId, '下载完成，已打开安装器。安装完成后会自动检测。')
      downloadsStore.updateTask(ollamaInstallerDownloadId, {
        title: 'Ollama 安装器已打开',
      })
      startInstallPolling(lastBaseUrl)
    } catch (error: any) {
      downloadsStore.failTask(ollamaInstallerDownloadId, error?.message ?? String(error))
    } finally {
      isDownloading.value = false
    }
  }

  const retryDownload = async () => {
    await downloadInstaller(lastBaseUrl)
  }

  const cancelDownload = async () => {
    if (!isDownloading.value) return
    await window.electronAPI.ollama.cancelDownload()
    isDownloading.value = false
    downloadsStore.closeTask(ollamaInstallerDownloadId)
  }

  const pullModel = async (baseUrl: string, model: string, title = '下载模型') => {
    const name = model.trim()
    if (!name || isPullingModel(name)) return
    const pullBaseUrl = baseUrl || lastBaseUrl
    lastBaseUrl = pullBaseUrl
    attachPullModelProgress()
    setModelPulling(name, true)
    const taskId = getModelPullTaskId(name)
    downloadsStore.startTask({
      id: taskId,
      title,
      message: `正在下载 ${name}...`,
      status: 'downloading',
      receivedBytes: 0,
      cancel: async () => cancelPullModel(name),
      retry: async () => pullModel(pullBaseUrl, name, title),
    })

    try {
      const result = await window.electronAPI.ollama.pullModel(pullBaseUrl, name)
      if (!result.success) {
        if (!downloadsStore.tasks[taskId]) return
        downloadsStore.failTask(taskId, result.error || `下载模型 ${name} 失败。`)
        return
      }
      downloadsStore.completeTask(taskId, `${name} 下载完成。`)
      downloadsStore.scheduleCloseTask(taskId, 3000)
      if (!completedProgressModels.has(name)) {
        markModelListChanged()
      }
    } catch (error: any) {
      downloadsStore.failTask(taskId, error?.message ?? String(error))
    } finally {
      completedProgressModels.delete(name)
      setModelPulling(name, false)
    }
  }

  const cancelPullModel = async (model: string) => {
    const name = model.trim()
    if (!name || !isPullingModel(name)) return
    await window.electronAPI.ollama.cancelPullModel(name)
    setModelPulling(name, false)
    downloadsStore.closeTask(getModelPullTaskId(name))
  }

  const deleteModel = async (baseUrl: string, model: string) => {
    const name = model.trim()
    if (!name || isDeletingModel(name) || isPullingModel(name)) {
      return { success: false, error: isPullingModel(name) ? '模型正在下载中，无法删除。' : '模型名称不能为空。' }
    }
    setModelDeleting(name, true)
    try {
      const result = await window.electronAPI.ollama.deleteModel(baseUrl || lastBaseUrl, name)
      if (result.success) {
        markModelListChanged()
      }
      return result
    } finally {
      setModelDeleting(name, false)
    }
  }

  const dispose = () => {
    stopDownloadProgress?.()
    stopDownloadProgress = null
    stopPullModelProgress?.()
    stopPullModelProgress = null
    if (installCheckTimer) {
      window.clearInterval(installCheckTimer)
      installCheckTimer = null
    }
  }

  return {
    installed,
    isChecking,
    isDownloading,
    pullingModels,
    deletingModels,
    modelListVersion,
    markInstalled,
    checkInstalled,
    downloadInstaller,
    retryDownload,
    cancelDownload,
    pullModel,
    cancelPullModel,
    deleteModel,
    isPullingModel,
    isDeletingModel,
    startInstallPolling,
    attachDownloadProgress,
    attachPullModelProgress,
    dispose,
  }
})
