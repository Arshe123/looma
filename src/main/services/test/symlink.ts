import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Probe only file-link creation, in disposable fixtures. Never hide other errors.
function fileSymlinkUnavailable(): string | undefined {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'looma-file-symlink-probe-'))
  try {
    const target = path.join(root, 'target.txt')
    const link = path.join(root, 'link.txt')
    fs.writeFileSync(target, 'probe')
    try {
      fs.symlinkSync(target, link, 'file')
    } catch (error) {
      const failure = error as NodeJS.ErrnoException
      if (process.platform !== 'win32' || failure.code !== 'EPERM' || failure.syscall !== 'symlink') throw error
      return 'Windows file symlink creation returned EPERM (no symlink privilege); only file-symlink scenarios are skipped'
    }
    if (!fs.lstatSync(link).isSymbolicLink()) throw new Error('File symlink probe did not create a symbolic link')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

export const fileSymlinkSkipReason = fileSymlinkUnavailable()
if (fileSymlinkSkipReason) console.warn(`[symlink capability] ${fileSymlinkSkipReason}`)

export async function directorySymlink(target: string, link: string): Promise<void> {
  // Junctions are real Windows reparse-point links, not hardlinks or copies.
  await fs.promises.symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir')
  if (!(await fs.promises.lstat(link)).isSymbolicLink()) throw new Error('Directory fixture is not a symbolic link')
}
