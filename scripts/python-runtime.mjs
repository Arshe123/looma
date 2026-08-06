import path from 'node:path'

export const resolveRagPython = ({
  platform = process.platform,
  projectRoot,
  env = process.env,
  existsSync,
}) => {
  const explicit = env.RAG_PYTHON?.trim()
  if (explicit) return explicit

  const virtualEnvPython = platform === 'win32'
    ? path.join(projectRoot, 'rag-service', '.venv', 'Scripts', 'python.exe')
    : path.join(projectRoot, 'rag-service', '.venv', 'bin', 'python')
  if (existsSync(virtualEnvPython)) return virtualEnvPython

  return platform === 'win32' ? 'E:\\anaconda3\\python.exe' : 'python3'
}
