import path from 'node:path'

const locks = new Set<string>()

const normalizeLockKey = (filePath: string) => {
  const resolved = path.resolve(filePath)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

export const withFileWriteLock = async <T>(filePath: string, operation: () => Promise<T>): Promise<T> => {
  const key = normalizeLockKey(filePath)
  while (locks.has(key)) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  locks.add(key)
  try {
    return await operation()
  } finally {
    locks.delete(key)
  }
}
