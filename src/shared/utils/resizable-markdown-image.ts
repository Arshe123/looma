import Image from '@tiptap/extension-image'
import { formatMarkdownImage } from './tiptap-image-insertion'

const WIDTH_IMAGE_PATTERN = /^!\[([^\]]*)\]\((\S+?)(?:\s+["']([^"']*)["'])?\)\{width=(\d{1,3})%\}/

export const ResizableMarkdownImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      widthPercent: {
        default: null,
        rendered: false,
      },
    }
  },

  parseMarkdown: (token, helpers) => helpers.createNode('image', {
    src: token.href,
    title: token.title,
    alt: token.text,
    widthPercent: token.widthPercent,
  }),

  renderMarkdown: node => formatMarkdownImage({
    alt: node.attrs?.alt ?? '',
    src: node.attrs?.src ?? '',
    title: node.attrs?.title ?? undefined,
    widthPercent: typeof node.attrs?.widthPercent === 'number'
      ? node.attrs.widthPercent
      : undefined,
  }),

  markdownTokenizer: {
    name: 'resizableImage',
    level: 'inline',
    start: (src: string) => src.indexOf('!['),
    tokenize(src) {
      const match = WIDTH_IMAGE_PATTERN.exec(src)
      if (!match) return undefined
      const widthPercent = Number(match[4])
      if (widthPercent < 10 || widthPercent > 100) return undefined
      return {
        type: 'image',
        raw: match[0],
        href: match[2],
        title: match[3] || null,
        text: match[1],
        widthPercent,
      }
    },
  },
})