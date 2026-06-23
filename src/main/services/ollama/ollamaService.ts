import { app, shell } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { execFile } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import fs from 'fs/promises'
import path from 'path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const ollamaWindowsInstallerUrl = 'https://ollama.com/download/OllamaSetup.exe'

let isDownloadingOllamaInstaller = false
let ollamaDownloadAbortController: AbortController | null = null
let activeInstallerPath = ''
const activeModelPulls = new Map<string, AbortController>()

export const normalizeOllamaBaseUrl = (baseUrl: string) => {
  const value = (baseUrl || '').trim() || 'http://127.0.0.1:11434'
  return value.replace(/\/+$/, '')
}

const fetchWithTimeout = async (url: string, timeoutMs = 2500) => {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { signal: controller.signal })
  } finally {
    clearTimeout(timeout)
  }
}

const parseOllamaVersion = (value: string) => {
  return (value || '').trim().replace(/^ollama\s+version\s+/i, '').trim()
}

type OllamaDownloadProgressPayload = {
  status: 'downloading' | 'completed' | 'error' | 'cancelled'
  receivedBytes: number
  totalBytes?: number
  percent?: number
  error?: string
}

type OllamaModelPullProgressPayload = OllamaDownloadProgressPayload & {
  model: string
  message?: string
}

const sendOllamaDownloadProgress = (
  event: IpcMainInvokeEvent,
  payload: OllamaDownloadProgressPayload,
) => {
  if (!event.sender.isDestroyed()) {
    event.sender.send('ollama:downloadProgress', payload)
  }
}

const sendOllamaModelPullProgress = (
  event: IpcMainInvokeEvent,
  payload: OllamaModelPullProgressPayload,
) => {
  if (!event.sender.isDestroyed()) {
    event.sender.send('ollama:pullModelProgress', payload)
  }
}

const listModels = async (baseUrl: string) => {
  try {
    const response = await fetch(`${normalizeOllamaBaseUrl(baseUrl)}/api/tags`)
    const data = await response.json().catch(() => null)
    if (!response.ok) {
      return { success: false, error: data?.error || `Ollama 请求失败: HTTP ${response.status}` }
    }
    const models = Array.isArray(data?.models)
      ? data.models
        .map((model: any) => typeof model?.name === 'string' ? model.name : '')
        .filter(Boolean)
      : []
    return { success: true, data: { models } }
  } catch (error: any) {
    return { success: false, error: `无法连接 Ollama: ${error?.message ?? String(error)}。请确认 Ollama 已启动。` }
  }
}

const checkInstalled = async (baseUrl: string) => {
  try {
    const response = await fetchWithTimeout(`${normalizeOllamaBaseUrl(baseUrl)}/api/tags`)
    if (response.ok) {
      return { success: true, data: { installed: true } }
    }
  } catch {
    // Continue with local executable checks.
  }

  try {
    const { stdout } = await execFileAsync('ollama', ['--version'], { windowsHide: true, timeout: 2500 })
    return { success: true, data: { installed: true, version: parseOllamaVersion(stdout) || undefined } }
  } catch {
    // Continue with Windows default install path checks.
  }

  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA
    const programFiles = process.env.ProgramFiles
    const candidates = [
      localAppData ? path.join(localAppData, 'Programs', 'Ollama', 'ollama.exe') : '',
      programFiles ? path.join(programFiles, 'Ollama', 'ollama.exe') : '',
    ].filter(Boolean)

    for (const candidate of candidates) {
      try {
        await fs.access(candidate)
        return { success: true, data: { installed: true } }
      } catch {
        // Try the next candidate.
      }
    }
  }

  return { success: true, data: { installed: false } }
}

const downloadInstaller = async (event: IpcMainInvokeEvent) => {
  if (process.platform !== 'win32') {
    return { success: false, error: '当前版本仅支持在 Windows 内下载 Ollama，请前往 https://ollama.com/download 手动下载。' }
  }

  if (isDownloadingOllamaInstaller) {
    return { success: false, error: 'Ollama 安装器正在下载中。' }
  }

  isDownloadingOllamaInstaller = true
  const installerPath = path.join(app.getPath('downloads') || app.getPath('temp'), 'OllamaSetup.exe')
  activeInstallerPath = installerPath
  ollamaDownloadAbortController = new AbortController()
  let wasCancelled = false
  let receivedBytes = 0

  try {
    const response = await fetch(ollamaWindowsInstallerUrl, { signal: ollamaDownloadAbortController.signal })
    if (!response.ok || !response.body) {
      throw new Error(`下载安装器失败: HTTP ${response.status}`)
    }

    const totalHeader = response.headers.get('content-length')
    const totalBytes = totalHeader ? Number.parseInt(totalHeader, 10) : undefined
    const fileStream = createWriteStream(installerPath)
    const fileFinished = new Promise<void>((resolve, reject) => {
      fileStream.on('finish', resolve)
      fileStream.on('error', reject)
    })
    const reader = response.body.getReader()

    sendOllamaDownloadProgress(event, {
      status: 'downloading',
      receivedBytes,
      totalBytes: Number.isFinite(totalBytes) ? totalBytes : undefined,
      percent: totalBytes ? 0 : undefined,
    })

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        receivedBytes += value.byteLength
        fileStream.write(Buffer.from(value))
        const percent = totalBytes ? Math.min(100, Math.round((receivedBytes / totalBytes) * 100)) : undefined
        sendOllamaDownloadProgress(event, {
          status: 'downloading',
          receivedBytes,
          totalBytes: Number.isFinite(totalBytes) ? totalBytes : undefined,
          percent,
        })
      }
    } finally {
      fileStream.end()
    }

    await fileFinished

    const openError = await shell.openPath(installerPath)
    if (openError) throw new Error(openError)

    sendOllamaDownloadProgress(event, {
      status: 'completed',
      receivedBytes,
      totalBytes: Number.isFinite(totalBytes) ? totalBytes : undefined,
      percent: totalBytes ? 100 : undefined,
    })

    return { success: true, data: { installerPath } }
  } catch (error: any) {
    if (error?.name === 'AbortError') {
      wasCancelled = true
      sendOllamaDownloadProgress(event, {
        status: 'cancelled',
        receivedBytes,
      })
      return { success: false, error: 'Ollama 下载已取消。' }
    }

    const message = error?.message ?? String(error)
    sendOllamaDownloadProgress(event, {
      status: 'error',
      receivedBytes,
      error: message,
    })
    return { success: false, error: message }
  } finally {
    if (wasCancelled && installerPath) {
      await fs.unlink(installerPath).catch(() => {})
    }
    isDownloadingOllamaInstaller = false
    ollamaDownloadAbortController = null
    activeInstallerPath = ''
  }
}

const cancelDownload = async () => {
  if (!isDownloadingOllamaInstaller || !ollamaDownloadAbortController) {
    return { success: true }
  }

  ollamaDownloadAbortController.abort()
  return { success: true }
}

const pullModel = async (event: IpcMainInvokeEvent, baseUrl: string, model: string) => {
  const name = (model || '').trim()
  if (!name) return { success: false, error: '模型名称不能为空。' }
  if (activeModelPulls.has(name)) return { success: false, error: `${name} 正在下载中。` }

  const controller = new AbortController()
  activeModelPulls.set(name, controller)
  const layers = new Map<string, { completed: number; total?: number }>()
  let receivedBytes = 0
  let totalBytes: number | undefined

  const updateTotals = (data: any) => {
    const completed = Number.isFinite(data?.completed) ? Number(data.completed) : undefined
    const total = Number.isFinite(data?.total) ? Number(data.total) : undefined
    if (typeof completed !== 'number' && typeof total !== 'number') return

    const key = typeof data?.digest === 'string' && data.digest ? data.digest : '__current__'
    const current = layers.get(key) ?? { completed: 0, total: undefined }
    layers.set(key, {
      completed: typeof completed === 'number' ? completed : current.completed,
      total: typeof total === 'number' ? total : current.total,
    })

    receivedBytes = Array.from(layers.values()).reduce((sum, layer) => sum + layer.completed, 0)
    const knownTotals = Array.from(layers.values()).map((layer) => layer.total)
    totalBytes = knownTotals.every((value) => typeof value === 'number')
      ? knownTotals.reduce((sum, value) => sum + (value ?? 0), 0)
      : undefined
  }

  const emitProgress = (data: any) => {
    updateTotals(data)
    const percent = totalBytes ? Math.min(100, Math.round((receivedBytes / totalBytes) * 100)) : undefined
    sendOllamaModelPullProgress(event, {
      model: name,
      status: 'downloading',
      receivedBytes,
      totalBytes,
      percent,
      message: typeof data?.status === 'string' ? data.status : undefined,
    })
  }

  try {
    const response = await fetch(`${normalizeOllamaBaseUrl(baseUrl)}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, stream: true }),
      signal: controller.signal,
    })

    if (!response.ok) {
      const data = await response.json().catch(() => null)
      if (response.status === 404) {
        return { success: false, error: `此模型不存在：${name}` }
      }
      return { success: false, error: data?.error || `Ollama 下载失败: HTTP ${response.status}` }
    }
    if (!response.body) return { success: false, error: 'Ollama 未返回可读取的下载进度。' }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const rawLine of lines) {
        const line = rawLine.trim()
        if (!line) continue
        const data = JSON.parse(line)
        if (data?.error) throw new Error(data.error)
        emitProgress(data)
      }
    }

    buffer += decoder.decode()
    const finalLine = buffer.trim()
    if (finalLine) {
      const data = JSON.parse(finalLine)
      if (data?.error) throw new Error(data.error)
      emitProgress(data)
    }

    sendOllamaModelPullProgress(event, {
      model: name,
      status: 'completed',
      receivedBytes,
      totalBytes,
      percent: totalBytes ? 100 : undefined,
      message: '下载完成',
    })
    return { success: true }
  } catch (error: any) {
    if (error?.name === 'AbortError') {
      sendOllamaModelPullProgress(event, {
        model: name,
        status: 'cancelled',
        receivedBytes,
        totalBytes,
        message: '下载已取消',
      })
      return { success: false, error: `${name} 下载已取消。` }
    }
    sendOllamaModelPullProgress(event, {
      model: name,
      status: 'error',
      receivedBytes,
      totalBytes,
      error: error?.message ?? String(error),
    })
    return { success: false, error: `Ollama 下载失败: ${error?.message ?? String(error)}` }
  } finally {
    if (activeModelPulls.get(name) === controller) {
      activeModelPulls.delete(name)
    }
  }
}

const cancelPullModel = async (model: string) => {
  const name = (model || '').trim()
  if (!name) return { success: true }
  activeModelPulls.get(name)?.abort()
  return { success: true }
}

const deleteModel = async (baseUrl: string, model: string) => {
  const name = (model || '').trim()
  if (!name) return { success: false, error: '模型名称不能为空。' }
  try {
    const response = await fetch(`${normalizeOllamaBaseUrl(baseUrl)}/api/delete`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    })
    const data = await response.json().catch(() => null)
    if (!response.ok) {
      return { success: false, error: data?.error || `Ollama 删除失败: HTTP ${response.status}` }
    }
    return { success: true }
  } catch (error: any) {
    return { success: false, error: `无法连接 Ollama: ${error?.message ?? String(error)}。请确认 Ollama 已启动。` }
  }
}

export const ollamaService = {
  listModels,
  checkInstalled,
  downloadInstaller,
  cancelDownload,
  pullModel,
  cancelPullModel,
  deleteModel,
}
