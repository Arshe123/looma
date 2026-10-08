import type { WebContents } from 'electron'

// Main-owned identity, never inferred from a renderer URL or the global last-opened ID.
const workspaces = new WeakMap<WebContents, string | null>()

export function registerWindowWorkspace(sender: WebContents, workspaceId: string | null) {
  workspaces.set(sender, workspaceId)
  sender.once('destroyed', () => workspaces.delete(sender))
}

export function getWindowWorkspace(sender: WebContents): string | null | undefined {
  return sender && !sender.isDestroyed() ? workspaces.get(sender) : undefined
}

// Called only after the normal workspace-switch service has validated the target.
export function setWindowWorkspace(sender: WebContents, workspaceId: string | null) {
  if (getWindowWorkspace(sender) === undefined) return false
  workspaces.set(sender, workspaceId)
  return true
}
