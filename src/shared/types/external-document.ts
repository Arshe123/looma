export interface ExternalDocumentData {
  id: string
  filePath: string
  content: string
  baseContent: string
}
export type OpenDocumentRequest = { kind: 'external'; document: ExternalDocumentData } | { kind: 'workspace'; relativePath: string }
export interface ExternalDocumentsAPI {
  ready: (workspaceId: string | null, openedPaths: string[]) => Promise<void>
  onOpen: (listener: (request: OpenDocumentRequest) => void) => () => void
  save: (id: string, content: string, expectedContent: string) => Promise<void>
  draft: (id: string, content: string, baseContent: string) => Promise<void>
  close: (id: string) => Promise<void>
  readCurrent: (id: string) => Promise<string>
}
