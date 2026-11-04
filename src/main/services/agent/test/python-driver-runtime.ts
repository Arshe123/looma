import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
export const pythonServiceRoot = fileURLToPath(new URL('../../../../../looma-agent-service/', import.meta.url))
export const pythonDriverEnv = () => ({ ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' })

/** Test-only: reuse RAG_PYTHON/.venv conventions, never the machine-specific production fallback. */
export async function preparePythonDriver(): Promise<{ command: string, args: string[] }> {
  const explicit = process.env.RAG_PYTHON?.trim()
  const localPython = process.platform === 'win32'
    ? path.join(pythonServiceRoot, '.venv', 'Scripts', 'python.exe')
    : path.join(pythonServiceRoot, '.venv', 'bin', 'python')
  const python = explicit || (existsSync(localPython) ? localPython : undefined)
  const command = python || 'uv'
  const args = python ? [] : [
    'run', '--isolated', '--python', '3.12',
    '--with-requirements', path.join(pythonServiceRoot, 'requirements.txt'),
    'python',
  ]
  try {
    // Warm dependency caches before bridge tests; uv's isolated environment is ephemeral.
    // Import the actual driver, so a missing executable/dependency fails with its real diagnostic.
    const { stdout } = await execFileAsync(command, [...args, '-c',
      'import test.user_profile_bridge_driver; print("looma-python-driver-ready")',
    ], { cwd: pythonServiceRoot, env: pythonDriverEnv(), timeout: 180_000, windowsHide: true })
    if (stdout.trim() !== 'looma-python-driver-ready') {
      throw new Error(`Unexpected Python readiness output: ${JSON.stringify(stdout)}`)
    }
    return { command, args }
  } catch (error) {
    throw new Error(`Cannot prepare the real Python bridge driver using ${command}. Install uv/Python 3.12 or set RAG_PYTHON to an interpreter with looma-agent-service/requirements.txt installed.\n${error instanceof Error ? error.message : String(error)}`)
  }
}
