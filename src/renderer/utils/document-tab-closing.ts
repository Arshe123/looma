export type DocumentTabCloseMode = 'one' | 'left' | 'right' | 'other' | 'saved' | 'all'
type ClosableTab = { id: string; dirty: boolean; close: () => Promise<boolean> }

export async function closeDocumentTabs(tabs: ClosableTab[], target: string, mode: DocumentTabCloseMode) {
  const snapshot = [...tabs]
  const index = snapshot.findIndex(tab => tab.id === target)
  if (!['saved', 'all'].includes(mode) && index < 0) return false
  const selected = snapshot.filter((tab, i) => {
    switch (mode) {
      case 'one': return i === index
      case 'left': return i < index
      case 'right': return i > index
      case 'other': return i !== index
      case 'saved': return !tab.dirty
      case 'all': return true
    }
  })
  for (const tab of selected) if (!await tab.close()) return false
  return true
}
