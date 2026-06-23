import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'

const rootDir = process.cwd()

const tscJs = path.join(rootDir, 'node_modules', 'typescript', 'bin', 'tsc')
const tsconfigPath = path.join(rootDir, 'tsconfig.preload.json')

const run = (cmd, args) =>
  new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: 'inherit' })
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`Command failed: ${cmd} ${args.join(' ')}`))))
  })

await run(process.execPath, [tscJs, '-p', tsconfigPath])

const outDir = path.join(rootDir, 'dist-electron')
const cjsPath = path.join(outDir, 'preload.cjs')
const candidateJsPaths = [
  path.join(outDir, 'preload.js'),
  path.join(outDir, 'index.js'),
]

await fs.mkdir(outDir, { recursive: true })
try {
  await fs.rm(cjsPath, { force: true })
} catch {}

let emittedJsPath = null
for (const candidate of candidateJsPaths) {
  try {
    await fs.access(candidate)
    emittedJsPath = candidate
    break
  } catch {}
}

if (!emittedJsPath) {
  throw new Error(`Preload build output not found. Checked: ${candidateJsPaths.join(', ')}`)
}

await fs.rename(emittedJsPath, cjsPath)

