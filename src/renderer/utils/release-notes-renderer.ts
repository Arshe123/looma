import { renderMarkdown } from '@/shared/utils/markdown-renderer'

const HTML_TAG_PATTERN = /<\/?(?:a|b|blockquote|br|code|del|details|div|em|h[1-6]|hr|i|li|ol|p|pre|s|strong|summary|table|tbody|td|th|thead|tr|ul)(?:\s[^<>]*?)?\s*\/?\s*>/i

const ALLOWED_TAGS = new Set([
  'a',
  'b',
  'blockquote',
  'br',
  'code',
  'del',
  'details',
  'div',
  'em',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'i',
  'li',
  'ol',
  'p',
  'pre',
  's',
  'strong',
  'summary',
  'table',
  'tbody',
  'td',
  'th',
  'thead',
  'tr',
  'ul',
])

const BLOCKED_TAGS = new Set([
  'button',
  'embed',
  'form',
  'iframe',
  'input',
  'link',
  'math',
  'meta',
  'object',
  'script',
  'style',
  'svg',
  'textarea',
])

const isSafeExternalHref = (href: string) => /^https?:\/\//i.test(href.trim())

/**
 * electron-updater 在部分平台返回 HTML，而 GitHub API 返回 Markdown。
 * HTML 路径只保留发布说明所需的排版标签，并移除全部来源属性。
 */
const sanitizeReleaseNotesHtml = (content: string): string => {
  if (typeof DOMParser === 'undefined') return renderMarkdown(content)

  const document = new DOMParser().parseFromString(content, 'text/html')

  const sanitizeChildren = (parent: ParentNode) => {
    for (const node of Array.from(parent.childNodes)) {
      if (node.nodeType === Node.COMMENT_NODE) {
        node.remove()
        continue
      }
      if (!(node instanceof Element)) continue

      const tag = node.tagName.toLowerCase()
      if (BLOCKED_TAGS.has(tag)) {
        node.remove()
        continue
      }

      sanitizeChildren(node)

      if (!ALLOWED_TAGS.has(tag)) {
        node.replaceWith(...Array.from(node.childNodes))
        continue
      }

      const href = tag === 'a' ? node.getAttribute('href')?.trim() || '' : ''
      for (const attribute of Array.from(node.attributes)) node.removeAttribute(attribute.name)

      if (tag === 'a' && isSafeExternalHref(href)) {
        node.setAttribute('href', href)
        node.setAttribute('target', '_blank')
        node.setAttribute('rel', 'noopener noreferrer')
        node.classList.add('looma-update-external-link')
      }
    }
  }

  sanitizeChildren(document.body)
  return document.body.innerHTML
}

export const renderReleaseNotes = (content: string): string => {
  if (!content) return ''
  return HTML_TAG_PATTERN.test(content)
    ? sanitizeReleaseNotesHtml(content)
    : renderMarkdown(content)
}

