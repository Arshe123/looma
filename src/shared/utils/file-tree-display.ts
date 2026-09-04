export type FileTreeRowVisualState = 'selected' | 'selected-inactive' | 'active-inactive' | 'drop' | 'none'

type FileTreeRowVisualStateInput = {
  relativePath: string
  selectedPaths: string[]
  activeFileRelativePath: string
  fileTreeFocused: boolean
  isDirectory: boolean
  isDropTarget: boolean
}

export const getFileTreeRowVisualState = ({
  relativePath,
  selectedPaths,
  activeFileRelativePath,
  fileTreeFocused,
  isDirectory,
  isDropTarget,
}: FileTreeRowVisualStateInput): FileTreeRowVisualState => {
  if (isDropTarget) return 'drop'

  const isSelected = selectedPaths.includes(relativePath)
  const isActiveFile = !isDirectory && activeFileRelativePath === relativePath

  if (isSelected) return fileTreeFocused ? 'selected' : 'selected-inactive'
  if (isActiveFile) return 'active-inactive'
  return 'none'
}
