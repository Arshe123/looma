import { createDocument } from '@tiptap/core'

type ExternalMarkdownEditor = {
  storage: {
    markdown: {
      parser: {
        parse: (content: string) => unknown
      }
    }
  }
  schema: unknown
  options: {
    parseOptions?: unknown
    enableContentCheck?: boolean
  }
  state: {
    doc: {
      content: {
        size: number
      }
    }
    tr: {
      replaceWith: (from: number, to: number, content: unknown) => ExternalMarkdownEditor['state']['tr']
      setMeta: (key: string, value: unknown) => ExternalMarkdownEditor['state']['tr']
    }
  }
  view: {
    dispatch: (transaction: ExternalMarkdownEditor['state']['tr']) => void
  }
}

type CreateDocument = typeof createDocument

export const replaceExternalMarkdownContent = (
  editor: ExternalMarkdownEditor,
  content: string,
  createDoc: CreateDocument = createDocument,
) => {
  const parsedContent = editor.storage.markdown.parser.parse(content)
  const document = createDoc(parsedContent as any, editor.schema as any, editor.options.parseOptions as any, {
    errorOnInvalidContent: editor.options.enableContentCheck,
  })
  const transaction = editor.state.tr
    .replaceWith(0, editor.state.doc.content.size, document)
    .setMeta('preventUpdate', true)
    .setMeta('addToHistory', false)

  editor.view.dispatch(transaction)
}
