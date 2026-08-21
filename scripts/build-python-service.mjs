import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const projectRoot = path.resolve(import.meta.dirname, '..')
const serviceRoot = path.join(projectRoot, 'rag-service')
const outputRoot = path.join(projectRoot, 'build', 'python-service')
const workRoot = path.join(projectRoot, 'build', 'pyinstaller-work')
const requirements = path.join(serviceRoot, 'requirements.txt')
const entrypoint = path.join(serviceRoot, 'service_entry.py')

if (!['win32', 'darwin'].includes(process.platform)) {
  throw new Error(`当前 Python 服务打包脚本尚未支持 ${process.platform}。`)
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
  // tiktoken discovers its encodings through the tiktoken_ext namespace at
  // runtime. PyInstaller cannot infer that dynamic import, so without this the
  // frozen service reports "Unknown encoding cl100k_base. Plugins found: []".
  '--hidden-import', 'tiktoken_ext.openai_public',
  '--hidden-import', 'uvicorn.logging',
  '--hidden-import', 'uvicorn.loops.auto',
  '--hidden-import', 'uvicorn.protocols.http.auto',
  '--hidden-import', 'uvicorn.protocols.websockets.auto',
  '--hidden-import', 'uvicorn.lifespan.on',
  // llama-index-core does not require NLTK for Looma's vector-store paths,
  // but PyInstaller discovers it as an optional dependency and installs an
  // NLTK runtime hook that prevents the frozen service from starting.
  '--exclude-module', 'nltk',
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

  const executableName = process.platform === 'win32'
    ? 'looma-agent-service.exe'
    : 'looma-agent-service'
  const executable = path.join(outputRoot, 'looma-agent-service', executableName)
  if (!fs.existsSync(executable)) {
    console.error(`[python-service] 打包完成但未找到服务程序: ${executable}`)
    process.exitCode = 1
    return
  }

  const smokeTest = spawnSync(executable, ['--packaging-self-test'], {
    cwd: projectRoot,
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
  })
  if (smokeTest.error || smokeTest.status !== 0) {
    const detail = [smokeTest.stdout, smokeTest.stderr, smokeTest.error?.message]
      .filter(Boolean)
      .join('\n')
      .trim()
    console.error(`[python-service] 打包自检失败${detail ? `:\n${detail}` : '。'}`)
    process.exitCode = smokeTest.status || 1
    return
  }

  console.log(`[python-service] 已生成: ${executable}`)
})
