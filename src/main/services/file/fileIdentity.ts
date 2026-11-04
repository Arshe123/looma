import fs from 'node:fs/promises'

export type FileIdentity = {
  dev: number | bigint
  ino: number | bigint
  birthtimeMs: number | bigint
}

export const sameFileIdentity = (left: FileIdentity, right: FileIdentity) =>
  left.dev === right.dev && left.ino === right.ino && left.birthtimeMs === right.birthtimeMs

const changedFile = () => {
  const error = new Error('目标目录或文件在创建期间发生变化') as NodeJS.ErrnoException
  error.code = 'PATH_TRAVERSAL'
  return error
}

// Windows path stat and handle stat can report different device numbers. Compare
// devices only between handles, without discarding the volume identity check.
// BigInt also preserves Windows file IDs that exceed Number.MAX_SAFE_INTEGER.
export const readRegularFileIdentity = async (filePath: string): Promise<FileIdentity> => {
  const before = await fs.lstat(filePath, { bigint: true })
  if (before.isSymbolicLink() || !before.isFile()) throw changedFile()

  const handle = await fs.open(filePath, 'r')
  try {
    const opened = await handle.stat({ bigint: true })
    const after = await fs.lstat(filePath, { bigint: true })
    if (!opened.isFile() || after.isSymbolicLink() || !after.isFile()
      || before.dev !== after.dev || before.ino !== after.ino
      || before.birthtimeNs !== after.birthtimeNs
      || opened.ino !== after.ino || opened.birthtimeNs !== after.birthtimeNs) {
      throw changedFile()
    }
    return { dev: opened.dev, ino: opened.ino, birthtimeMs: opened.birthtimeMs }
  } finally {
    await handle.close()
  }
}
