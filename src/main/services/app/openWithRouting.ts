import path from 'node:path'

export const markdownArguments = (argv: string[], cwd: string) => argv
  .filter(arg => !arg.startsWith('-') && path.extname(arg).toLowerCase() === '.md')
  .map(arg => path.resolve(cwd, arg))

export interface OpenWindowState {
  id: number
  workspacePath?: string
  opened: string[]
  openedRelativePaths?: Record<string, string>
  focusedAt: number
}
export const workspaceRelativePath = (file: string, root?: string) => {
  if (!root) return undefined
  const relative = path.relative(root, file)
  return relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)
    ? relative.split(path.sep).join('/') : undefined
}
export function chooseOpenTarget(file: string, windows: OpenWindowState[]) {
  const sorted = [...windows].sort((a, b) => b.focusedAt - a.focusedAt)
  const target = sorted.find(win => win.opened.includes(file))
    || sorted.find(win => win.workspacePath) || sorted[0]
  if (!target) return null
  const relativePath = target.openedRelativePaths?.[file] || workspaceRelativePath(file, target.workspacePath)
  return relativePath ? { owner: target.id, relativePath } : { owner: target.id }
}
