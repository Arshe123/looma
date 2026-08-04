import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { app } from 'electron'

let serviceProcess: ChildProcess | null = null
let stopping = false

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

const canListen = (port: number) => new Promise<boolean>((resolve) => {
  const server = net.createServer()
  server.once('error', () => resolve(false))
  server.once('listening', () => server.close(() => resolve(true)))
  server.listen(port, '127.0.0.1')
})

const findAvailablePort = async (preferred = 8765) => {
  for (let port = preferred; port < preferred + 50; port += 1) {
    if (await canListen(port)) return port
  }
  throw new Error(`无法在 ${preferred}-${preferred + 49} 范围内找到可用的本地端口。`)
}

const waitForHealth = async (baseUrl: string, child: ChildProcess, timeoutMs = 20_000) => {
  const startedAt = Date.now()
  let lastError = '服务尚未响应'
  while (Date.now() - startedAt < timeoutMs) {
    if (child.exitCode != null) {
      throw new Error(`内置 Python 服务已提前退出，退出码 ${child.exitCode}。`)
    }
    try {
      const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1_000) })
      if (response.ok) return
      lastError = `HTTP ${response.status}`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await wait(150)
  }
  throw new Error(`等待内置 Python 服务启动超时：${lastError}`)
}

const executableName = process.platform === 'win32'
  ? 'looma-agent-service.exe'
  : 'looma-agent-service'

export const startBundledRagService = async () => {
  if (!app.isPackaged || process.env.RAG_SERVICE_EXTERNAL === '1') return
  if (serviceProcess && serviceProcess.exitCode == null) return

  const port = await findAvailablePort(Number(process.env.RAG_SERVICE_PORT) || 8765)
  const baseUrl = `http://127.0.0.1:${port}`
  const executable = path.join(process.resourcesPath, 'looma-agent-service', executableName)
  if (!fs.existsSync(executable)) {
    throw new Error(`安装包缺少内置 Python 服务：${executable}`)
  }

  process.env.RAG_SERVICE_URL = baseUrl
  process.env.RAG_SERVICE_PORT = String(port)
  process.env.LOOMA_SETTINGS_PATH = path.join(app.getPath('appData'), 'workspace-meta', 'looma', 'settings.json')

  const child = spawn(executable, [], {
    cwd: path.dirname(executable),
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  serviceProcess = child
  child.stdout?.on('data', data => console.info(`[python-service] ${data.toString().trimEnd()}`))
  child.stderr?.on('data', data => console.error(`[python-service] ${data.toString().trimEnd()}`))
  child.once('error', error => console.error(`[python-service] 启动失败：${error.message}`))
  child.once('exit', code => {
    if (code && !stopping) console.error(`[python-service] 异常退出，退出码 ${code}`)
    if (serviceProcess === child) serviceProcess = null
  })

  try {
    await waitForHealth(baseUrl, child)
  } catch (error) {
    if (serviceProcess === child) serviceProcess = null
    if (child.exitCode == null) child.kill('SIGKILL')
    throw error
  }
  console.info(`[python-service] 内置服务已就绪：${baseUrl}`)
}

export const stopBundledRagService = async () => {
  stopping = true
  const child = serviceProcess
  serviceProcess = null
  if (!child || child.exitCode != null) return

  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
  child.kill('SIGTERM')
  await Promise.race([exited, wait(2_000)])
  if (child.exitCode == null) child.kill('SIGKILL')
}
