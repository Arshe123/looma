import MarkdownIt from 'markdown-it'
import taskLists from 'markdown-it-task-lists'
import { isInternalNoteHref } from './note-link-ref'

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

/**
 * 包一层块级渲染规则：当 env.lineBase 为数字时，给块元素注入 data-line 属性
 * （绝对源码行号，1 起），供引用预览的行号 gutter 定位使用。
 * 表格内部（单元格段落）不编号。
 * markdown-it 对部分块 token（paragraph_open 等）没有默认规则，回退 renderToken。
 */
const withLineData = (
  rule?: (tokens: MarkdownIt.Token[], idx: number, options: MarkdownIt.Options, env: any, self: any) => string,
) =>
  (tokens: MarkdownIt.Token[], idx: number, options: MarkdownIt.Options, env: any, self: any): string => {
    const html = rule ? rule(tokens, idx, options, env, self) : self.renderToken(tokens, idx, options)
    const lineBase = env?.lineBase
    if (typeof lineBase !== 'number') return html
    const map = tokens[idx].map
    if (!map) return html
    for (let i = idx - 1; i >= 0; i--) {
      const token = tokens[i]
      if (token.type === 'table_open' || token.type === 'list_item_open') return html
      if (token.type === 'table_close' || token.type === 'list_item_close') break
    }
    const line = lineBase + map[0] + 1
    return html.replace('>', ` data-line="${line}">`)
  }

markdown.renderer.rules.paragraph_open = withLineData(markdown.renderer.rules.paragraph_open)
markdown.renderer.rules.heading_open = withLineData(markdown.renderer.rules.heading_open)
markdown.renderer.rules.list_item_open = withLineData(markdown.renderer.rules.list_item_open)
markdown.renderer.rules.hr = withLineData(markdown.renderer.rules.hr)

markdown.renderer.rules.fence = (tokens, idx, options, env) => {
  const token = tokens[idx]
  const info = token.info ? token.info.trim() : ''
  const language = info ? info.split(/\s+/)[0] : 'text'
  const escapedLanguage = markdown.utils.escapeHtml(language || 'text')
  const escapedContent = markdown.utils.escapeHtml(token.content)

  let codeBody = escapedContent
  if (typeof env?.lineBase === 'number' && token.map) {
    // fence 行 = map[0]+1，内容行从 fence+1 开始；去掉内容末尾换行产生的空行
    const parts = escapedContent.split('\n')
    if (parts.length > 1 && parts[parts.length - 1] === '') parts.pop()
    const firstLine = env.lineBase + token.map[0] + 2
    codeBody = parts
      .map((line, i) => `<span class="looma-preview-code-line" data-line="${firstLine + i}">${line}</span>`)
      .join('\n')
  }

  return [
    '<div class="code-block-shell">',
    `<button type="button" class="code-block-floating-copy" aria-label="复制 ${escapedLanguage} 代码" data-language="${escapedLanguage}">`,
    `<span class="code-block-copy-language">${escapedLanguage}</span>`,
    '<span class="code-block-copy-action">点击复制</span>',
    '</button>',
    `<pre class="code-block-body"><code class="code-block-content language-${escapedLanguage}">${codeBody}</code></pre>`,
    '</div>',
  ].join('')
}

const codeBlockRule = markdown.renderer.rules.code_block
markdown.renderer.rules.code_block = (tokens, idx, options, env, self) => {
  const html = codeBlockRule(tokens, idx, options, env, self)
  if (typeof env?.lineBase !== 'number' || !tokens[idx].map) return html
  const parts = markdown.utils.escapeHtml(tokens[idx].content).split('\n')
  if (parts.length > 1 && parts[parts.length - 1] === '') parts.pop()
  const body = parts
    .map((line, i) => `<span class="looma-preview-code-line" data-line="${env.lineBase + tokens[idx].map![0] + 1 + i}">${line}</span>`)
    .join('\n')
  return `<pre><code>${body}</code></pre>`
}

markdown.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const token = tokens[idx]
  const href = token.attrGet('href') || ''

  // 内部笔记链接：打标供点击跳转使用，不在新窗口打开
  if (isInternalNoteHref(href)) {
    token.attrPush(['class', 'looma-note-ref'])
    token.attrPush(['data-looma-note-ref', href])
    return openExternalLinkRule
      ? openExternalLinkRule(tokens, idx, options, env, self)
      : self.renderToken(tokens, idx, options)
  }

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

/**
 * 渲染 markdown 并携带源码行号信息（data-line 属性）。
 * lineBase 为内容首行在源文件中的 0 基行号。
 */
export const renderMarkdownWithLineData = (content: string, lineBase: number) =>
  markdown.render(content || '', { lineBase })
