import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'

const require = createRequire(import.meta.url)
const electronBinary = require('electron')
const pythonBinary = process.env.RAG_PYTHON || 'E:\\anaconda3\\python.exe'
let devServerUrl = null
let electron = null
let renderer = null
let ragService = null
let shuttingDown = false

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const isRunning = (child) => child && child.exitCode == null && !child.killed

const forceKillProcessTree = (child) => {
  if (!child?.pid || process.platform !== 'win32') return Promise.resolve()
  return new Promise((resolve) => {
    const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    })
    killer.on('exit', () => resolve())
    killer.on('error', () => resolve())
  })
}

const stopChild = async (child, signal = 'SIGTERM') => {
  if (!isRunning(child)) return

  const exited = new Promise((resolve) => {
    child.once('exit', () => resolve())
  })

  try {
    child.kill(signal)
  } catch {}

  await Promise.race([exited, wait(2500)])
  if (isRunning(child)) {
    await forceKillProcessTree(child)
  }
}

const shutdown = async (code = 0, signal = 'SIGTERM') => {
  if (shuttingDown) return
  shuttingDown = true

  await Promise.all([
    stopChild(electron, signal),
    stopChild(renderer, signal),
    stopChild(ragService, signal),
  ])

  process.exit(code)
}

const canListenOnPort = (port) => new Promise((resolve) => {
  const server = net.createServer()
  server.once('error', () => resolve(false))
  server.once('listening', () => {
    server.close(() => resolve(true))
  })
  server.listen(port, '127.0.0.1')
})

const parsePreferredRagPort = () => {
  const explicitPort = Number(process.env.RAG_SERVICE_PORT)
  if (Number.isInteger(explicitPort) && explicitPort > 0) return explicitPort

  if (process.env.RAG_SERVICE_URL) {
    try {
      const urlPort = Number(new URL(process.env.RAG_SERVICE_URL).port)
      if (Number.isInteger(urlPort) && urlPort > 0) return urlPort
    } catch {}
  }

  return 8765
}

const findAvailablePort = async (preferredPort) => {
  for (let port = preferredPort; port < preferredPort + 50; port += 1) {
    if (await canListenOnPort(port)) return port
  }
  throw new Error(`Unable to find an available RAG service port starting at ${preferredPort}`)
}

const resolveNpmRunner = () => {
  const npmCliCandidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].filter(Boolean)

  const npmCli = npmCliCandidates.find((candidate) => fsSync.existsSync(candidate))
  if (npmCli) {
    return {
      command: process.execPath,
      args: [npmCli, 'run', 'dev:renderer'],
    }
  }

  if (process.platform === 'win32') {
    throw new Error(`Unable to find npm CLI. Checked: ${npmCliCandidates.join(', ')}`)
  }

  return {
    command: 'npm',
    args: ['run', 'dev:renderer'],
  }
}

const ragPort = await findAvailablePort(parsePreferredRagPort())
const ragServiceUrl = `http://127.0.0.1:${ragPort}`
process.stdout.write(`[rag] starting on ${ragServiceUrl}\n`)

ragService = spawn(pythonBinary, ['-m', 'uvicorn', 'main:app', '--host', '127.0.0.1', '--port', String(ragPort)], {
  cwd: path.join(process.cwd(), 'rag-service'),
  stdio: ['ignore', 'pipe', 'pipe'],
  env: {
    ...process.env,
    RAG_SERVICE_URL: ragServiceUrl,
    RAG_SERVICE_PORT: String(ragPort),
  },
  windowsHide: true,
})

ragService.stdout.on('data', (buf) => {
  process.stdout.write(`[rag] ${buf.toString()}`)
})

ragService.stderr.on('data', (buf) => {
  process.stderr.write(`[rag] ${buf.toString()}`)
})

ragService.on('exit', (code) => {
  if (shuttingDown || code === 0) return
  process.stderr.write(`[rag] exited with code ${code}. Check Python dependencies in rag-service/requirements.txt.\n`)
  shutdown(code ?? 1).catch((err) => {
    process.stderr.write(String(err) + '\n')
    process.exit(code ?? 1)
  })
})

ragService.on('error', (err) => {
  if (shuttingDown) return
  process.stderr.write(`[rag] failed to start: ${err.message}\n`)
  shutdown(1).catch(() => process.exit(1))
})

try {
  const npmRunner = resolveNpmRunner()
  renderer = spawn(npmRunner.command, npmRunner.args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
    windowsHide: true,
  })
} catch (err) {
  process.stderr.write(`[renderer] failed to resolve npm: ${err?.message ?? String(err)}\n`)
  shutdown(1).catch(() => process.exit(1))
}

const waitForFile = async (filePath, timeoutMs = 15000) => {
  const start = Date.now()
  for (;;) {
    try {
      await fs.access(filePath)
      return
    } catch {}
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timeout waiting for ${filePath}`)
    }
    await wait(150)
  }
}

const maybeStartElectron = () => {
  if (electron || !devServerUrl) return

  const rootDir = process.cwd()
  const mainEntry = path.join(rootDir, 'dist-electron', 'index.js')
  const preloadEntry = path.join(rootDir, 'dist-electron', 'preload.cjs')

  Promise.all([waitForFile(mainEntry), waitForFile(preloadEntry)])
    .then(() => {
      if (shuttingDown) return
      electron = spawn(electronBinary, ['.'], {
        stdio: 'inherit',
        env: {
          ...process.env,
          VITE_DEV_SERVER_URL: devServerUrl,
          RAG_SERVICE_URL: ragServiceUrl,
          RAG_SERVICE_PORT: String(ragPort),
        },
        windowsHide: true,
      })

      electron.on('exit', (code) => {
        if (shuttingDown) return
        shutdown(code ?? 0).catch((err) => {
          process.stderr.write(String(err) + '\n')
          process.exit(code ?? 1)
        })
      })

      electron.on('error', (err) => {
        if (shuttingDown) return
        process.stderr.write(`[electron] failed to start: ${err.message}\n`)
        shutdown(1).catch(() => process.exit(1))
      })
    })
    .catch((err) => {
      process.stderr.write(String(err) + '\n')
      shutdown(1).catch(() => process.exit(1))
    })
}

const handleRendererOutput = (buf) => {
  const text = buf.toString()
  process.stdout.write(text)

  if (!devServerUrl) {
    const match = text.match(/(http:\/\/localhost:\d+\/?)/)
    if (match?.[1]) {
      devServerUrl = match[1].endsWith('/') ? match[1] : `${match[1]}/`
      maybeStartElectron()
    }
  }
}

renderer?.stdout.on('data', handleRendererOutput)
renderer?.stderr.on('data', (buf) => {
  process.stderr.write(buf.toString())
})

renderer?.on('exit', (code) => {
  if (shuttingDown) return
  shutdown(code ?? 0).catch((err) => {
    process.stderr.write(String(err) + '\n')
    process.exit(code ?? 1)
  })
})

renderer?.on('error', (err) => {
  if (shuttingDown) return
  process.stderr.write(`[renderer] failed to start: ${err.message}\n`)
  shutdown(1).catch(() => process.exit(1))
})

process.on('SIGINT', () => {
  shutdown(0, 'SIGINT').catch(() => process.exit(1))
})

process.on('SIGTERM', () => {
  shutdown(0, 'SIGTERM').catch(() => process.exit(1))
})

process.on('uncaughtException', (err) => {
  process.stderr.write(String(err) + '\n')
  shutdown(1).catch(() => process.exit(1))
})

process.on('unhandledRejection', (err) => {
  process.stderr.write(String(err) + '\n')
  shutdown(1).catch(() => process.exit(1))
})
