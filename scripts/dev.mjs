import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs/promises'
import path from 'node:path'

const require = createRequire(import.meta.url)
const electronBinary = require('electron')

const renderer = spawn('npm', ['run', 'dev:renderer'], {
  shell: true,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: process.env,
})

let devServerUrl = null
let electron = null

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
    await new Promise((r) => setTimeout(r, 150))
  }
}

const maybeStartElectron = () => {
  if (electron || !devServerUrl) return

  const rootDir = process.cwd()
  const mainEntry = path.join(rootDir, 'dist-electron', 'index.js')
  const preloadEntry = path.join(rootDir, 'dist-electron', 'preload.cjs')

  Promise.all([waitForFile(mainEntry), waitForFile(preloadEntry)])
    .then(() => {
      electron = spawn(electronBinary, ['.'], {
        stdio: 'inherit',
        env: {
          ...process.env,
          VITE_DEV_SERVER_URL: devServerUrl,
        },
      })

      electron.on('exit', (code) => {
        if (renderer.exitCode == null) renderer.kill('SIGTERM')
        process.exit(code ?? 0)
      })
    })
    .catch((err) => {
      process.stderr.write(String(err) + '\n')
      if (renderer.exitCode == null) renderer.kill('SIGTERM')
      process.exit(1)
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

renderer.stdout.on('data', handleRendererOutput)
renderer.stderr.on('data', (buf) => {
  process.stderr.write(buf.toString())
})

renderer.on('exit', (code) => {
  if (electron && electron.exitCode == null) electron.kill('SIGTERM')
  process.exit(code ?? 0)
})

process.on('SIGINT', () => {
  if (renderer.exitCode == null) renderer.kill('SIGINT')
  if (electron && electron.exitCode == null) electron.kill('SIGINT')
})
