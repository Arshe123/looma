export interface ExternalDocumentData {
  id: string
  filePath: string
  content: string
  baseContent: string
}
export type OpenDocumentRequest = { kind: 'external'; document: ExternalDocumentData } | { kind: 'workspace'; relativePath: string }
export interface DocumentHandoff { token: string; workspaceId: string; relativePath?: string; document: ExternalDocumentData }
export interface ExternalDocumentsAPI {
  onHandoff: (listener: (request: DocumentHandoff) => void) => () => void
  claim: (token: string, error?: string) => Promise<ExternalDocumentData | null>
  transfer: (workspaceId: string, id: string, content: string, baseContent: string) => Promise<void>
  ready: (workspaceId: string | null, openedPaths: string[]) => Promise<void>
  onOpen: (listener: (request: OpenDocumentRequest) => void) => () => void
  save: (id: string, content: string, expectedContent: string) => Promise<void>
  draft: (id: string, content: string, baseContent: string) => Promise<void>
  close: (id: string) => Promise<void>
  readCurrent: (id: string) => Promise<string>
}
