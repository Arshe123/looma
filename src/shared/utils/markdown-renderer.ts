import MarkdownIt from 'markdown-it'
import taskLists from 'markdown-it-task-lists'

const markdown = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  typographer: false,
})

markdown.use(taskLists, {
  enabled: false,
  label: true,
  labelAfter: true,
})

const openExternalLinkRule = markdown.renderer.rules.link_open

markdown.renderer.rules.fence = (tokens, idx) => {
  const token = tokens[idx]
  const info = token.info ? token.info.trim() : ''
  const language = info ? info.split(/\s+/)[0] : 'text'
  const escapedLanguage = markdown.utils.escapeHtml(language || 'text')
  const escapedContent = markdown.utils.escapeHtml(token.content)

  return [
    '<div class="code-block-shell">',
    `<button type="button" class="code-block-floating-copy" aria-label="复制 ${escapedLanguage} 代码" data-language="${escapedLanguage}">`,
    `<span class="code-block-copy-language">${escapedLanguage}</span>`,
    '<span class="code-block-copy-action">点击复制</span>',
    '</button>',
    `<pre class="code-block-body"><code class="code-block-content language-${escapedLanguage}">${escapedContent}</code></pre>`,
    '</div>',
  ].join('')
}

markdown.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const token = tokens[idx]
  const targetIndex = token.attrIndex('target')
  const relIndex = token.attrIndex('rel')

  if (targetIndex < 0) {
    token.attrPush(['target', '_blank'])
  } else {
    token.attrs![targetIndex][1] = '_blank'
  }

  if (relIndex < 0) {
    token.attrPush(['rel', 'noopener noreferrer'])
  } else {
    token.attrs![relIndex][1] = 'noopener noreferrer'
  }

  return openExternalLinkRule
    ? openExternalLinkRule(tokens, idx, options, env, self)
    : self.renderToken(tokens, idx, options)
}

export const renderMarkdown = (content: string) => markdown.render(content || '')
