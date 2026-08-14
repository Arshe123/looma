import { spawn } from 'node:child_process'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { preloadOutputCandidates, resolvePreloadOutput } from './preload-output.mjs'

const rootDir = process.cwd()

const tscJs = path.join(rootDir, 'node_modules', 'typescript', 'bin', 'tsc')
const tsconfigPath = path.join(rootDir, 'tsconfig.preload.json')
const outDir = path.join(rootDir, 'dist-electron')
const cjsPath = path.join(outDir, 'preload.cjs')

const run = (cmd, args) =>
  new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: 'inherit' })
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`Command failed: ${cmd} ${args.join(' ')}`))))
  })

await fs.mkdir(outDir, { recursive: true })
await Promise.all([
  fs.rm(cjsPath, { force: true }),
  fs.rm(path.join(outDir, 'preload'), { recursive: true, force: true }),
  fs.rm(path.join(outDir, 'shared'), { recursive: true, force: true }),
  ...preloadOutputCandidates(outDir).map(candidate => fs.rm(candidate, { force: true })),
])

await run(process.execPath, [tscJs, '-p', tsconfigPath])

const emittedJsPath = resolvePreloadOutput(outDir, fsSync.existsSync)

if (!emittedJsPath) {
  throw new Error(`Preload build output not found. Checked: ${preloadOutputCandidates(outDir).join(', ')}`)
}

await fs.rename(emittedJsPath, cjsPath)

