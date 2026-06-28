type ExternalMarkdownEditor = {
  commands: {
    setContent: (content: string, options: {
      contentType: 'markdown'
      emitUpdate: false
      errorOnInvalidContent?: boolean
    }) => boolean
  }
  options: {
    enableContentCheck?: boolean
  }
}

export const replaceExternalMarkdownContent = (
  editor: ExternalMarkdownEditor,
  content: string,
) => editor.commands.setContent(content, {
  contentType: 'markdown',
  emitUpdate: false,
  errorOnInvalidContent: editor.options.enableContentCheck,
})
