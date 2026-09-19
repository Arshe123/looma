import type { InjectionKey } from 'vue'
import type { EditorSession } from '@/renderer/stores/workspace-types'
export const externalDocumentKey: InjectionKey<boolean> = Symbol('external-document')
export interface DocumentSession {
  getSession: () => EditorSession | undefined
  saveSession: (session: Omit<EditorSession, 'updatedAt'>) => void
}
