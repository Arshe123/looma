import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const projectRoot = path.resolve(import.meta.dirname, '..')
const serviceRoot = path.join(projectRoot, 'rag-service')
const outputRoot = path.join(projectRoot, 'build', 'python-service')
const workRoot = path.join(projectRoot, 'build', 'pyinstaller-work')
const requirements = path.join(serviceRoot, 'requirements.txt')
const entrypoint = path.join(serviceRoot, 'service_entry.py')

if (process.platform !== 'win32') {
  throw new Error('当前 Python 服务打包脚本只配置了 Windows 目标，请在对应平台补充并验证 PyInstaller 产物。')
}

fs.rmSync(outputRoot, { recursive: true, force: true })
fs.rmSync(workRoot, { recursive: true, force: true })
fs.mkdirSync(outputRoot, { recursive: true })
fs.mkdirSync(workRoot, { recursive: true })

const args = [
  'run',
  '--isolated',
  '--python', '3.12',
  '--with', 'pyinstaller==6.16.0',
  '--with-requirements', requirements,
  'pyinstaller',
  '--noconfirm',
  '--clean',
  '--onedir',
  '--name', 'looma-agent-service',
  '--distpath', outputRoot,
  '--workpath', workRoot,
  '--specpath', workRoot,
  '--paths', serviceRoot,
  '--collect-data', 'llama_index.core',
  '--copy-metadata', 'llama-index-core',
  '--hidden-import', 'uvicorn.logging',
  '--hidden-import', 'uvicorn.loops.auto',
  '--hidden-import', 'uvicorn.protocols.http.auto',
  '--hidden-import', 'uvicorn.protocols.websockets.auto',
  '--hidden-import', 'uvicorn.lifespan.on',
  entrypoint,
]

const child = spawn('uv', args, {
  cwd: projectRoot,
  stdio: 'inherit',
  windowsHide: true,
})

child.on('error', (error) => {
  console.error(`[python-service] 无法启动 uv: ${error.message}`)
  process.exitCode = 1
})

child.on('exit', (code) => {
  if (code !== 0) {
    process.exitCode = code ?? 1
    return
  }

  const executable = path.join(outputRoot, 'looma-agent-service', 'looma-agent-service.exe')
  if (!fs.existsSync(executable)) {
    console.error(`[python-service] 打包完成但未找到服务程序: ${executable}`)
    process.exitCode = 1
    return
  }
  console.log(`[python-service] 已生成: ${executable}`)
})
