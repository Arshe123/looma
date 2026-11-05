import MarkdownIt from 'markdown-it'
import taskLists from 'markdown-it-task-lists'
import { isInternalNoteHref } from './note-link-ref'
import { normalizeMarkdownNoteLinks } from './markdown-note-links'
import { matchMarkdownHighlight, matchMarkdownPunctuationStrong } from './markdown-inline-grammar'
import type { CodeHighlightSegment } from './markdown-code-highlight'
import { findMarkdownNoteTitle, readMarkdownNoteStats, noteStatsLabel } from './note-reading-time'

export type MarkdownRenderOptions = {
  codeBlockCopy?: boolean
  highlightCode?: (source: string, language: string) => CodeHighlightSegment[]
}

const markdown = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  typographer: false,
})

// 关闭 fuzzy link 识别：避免 "Agent.md" / "test.md" 这类文件名被识别成 http:// 链接。
// 仅保留显式协议（https://、mailto: 等）的自动链接。
markdown.linkify.set({ fuzzyLink: false })

markdown.use(taskLists, {
  enabled: false,
  label: true,
  labelAfter: true,
})

// Engine adapter only: matching is shared with the editable inline lexer.
// Keep the same state for reference links and delimiter post-processing.
const inlineExtensionRule = (match: typeof matchMarkdownHighlight, tag: string, type: string) =>
  (state: any, silent: boolean): boolean => {
    if (state.level >= state.md.options.maxNesting) return false
    const start = state.pos
    const max = state.posMax
    const result = match(state.src, start, max)
    if (!result) return false
    if (!silent) {
      state.push(`${type}_open`, tag, 1)
      state.pos = start + 2
      state.posMax = start + result.raw.length - 2
      state.md.inline.tokenize(state)
      state.push(`${type}_close`, tag, -1)
    }
    state.pos = start + result.raw.length
    state.posMax = max
    return true
  }

markdown.inline.ruler.before('emphasis', 'strong_cjk_fix', inlineExtensionRule(matchMarkdownPunctuationStrong, 'strong', 'strong'))
markdown.inline.ruler.before('emphasis', 'highlight', inlineExtensionRule(matchMarkdownHighlight, 'mark', 'mark'))

markdown.core.ruler.after('inline', 'image_width', (state) => {
  for (const blockToken of state.tokens) {
    const children = blockToken.children
    if (!children) continue
    for (let index = 0; index < children.length - 1; index++) {
      const image = children[index]
      const suffix = children[index + 1]
      if (image.type !== 'image' || suffix.type !== 'text') continue
      const match = /^\{width=(\d{1,3})%\}/.exec(suffix.content)
      if (!match) continue
      const widthPercent = Number(match[1])
      if (widthPercent < 10 || widthPercent > 100) continue
      image.attrSet('style', `width: ${widthPercent}%; height: auto;`)
      suffix.content = suffix.content.slice(match[0].length)
    }
  }
})

const openExternalLinkRule = markdown.renderer.rules.link_open
const FILE_SYMLINK_ICON = '<span class="looma-link-icon looma-note-ref-icon" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m10 18 3-3-3-3"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M4 11V4a2 2 0 0 1 2-2h9l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h7"/></svg></span>'
const LINK_ICON = '<span class="looma-link-icon looma-external-link-icon" aria-hidden="true"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg></span>'

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

// Split text, not generated HTML: multiline tokens must close inside each line
// wrapper so line anchors and copied text stay intact.
const renderCodeLines = (source: string, language: string, highlightCode?: MarkdownRenderOptions['highlightCode']) => {
  const lines = ['']
  for (const segment of highlightCode ? highlightCode(source, language) : [{ text: source, classes: [] }]) {
    const classes = segment.classes.map(markdown.utils.escapeHtml).join(' ')
    segment.text.split('\n').forEach((part, index) => {
      if (index) lines.push('')
      const text = markdown.utils.escapeHtml(part)
      lines[lines.length - 1] += classes && text ? `<span class="${classes}">${text}</span>` : text
    })
  }
  return lines
}

markdown.renderer.rules.fence = (tokens, idx, options, env) => {
  const token = tokens[idx]
  const info = token.info ? token.info.trim() : ''
  const language = info ? info.split(/\s+/)[0] : 'text'
  const escapedLanguage = markdown.utils.escapeHtml(language || 'text')
  const parts = renderCodeLines(token.content, language, env?.highlightCode)

  let codeBody = parts.join('\n')
  if (typeof env?.lineBase === 'number' && token.map) {
    // fence 行 = map[0]+1，内容行从 fence+1 开始；去掉内容末尾换行产生的空行
    if (parts.length > 1 && parts[parts.length - 1] === '') parts.pop()
    const firstLine = env.lineBase + token.map[0] + 2
    codeBody = parts
      .map((line, i) => `<span class="looma-preview-code-line" data-line="${firstLine + i}">${line}</span>`)
      .join('\n')
  }

  const codeBlock = `<pre class="code-block-body"><code class="code-block-content language-${escapedLanguage}">${codeBody}</code></pre>`
  // 只读文档未接入复制交互时，不生成无样式、不可用的按钮。
  if (env?.codeBlockCopy === false) return codeBlock

  return [
    '<div class="code-block-shell">',
    `<button type="button" class="code-block-floating-copy" aria-label="复制 ${escapedLanguage} 代码" data-language="${escapedLanguage}">`,
    `<span class="code-block-copy-language">${escapedLanguage}</span>`,
    '<span class="code-block-copy-action">点击复制</span>',
    '</button>',
    codeBlock,
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
    const openTag = openExternalLinkRule
      ? openExternalLinkRule(tokens, idx, options, env, self)
      : self.renderToken(tokens, idx, options)
    return `${openTag}${FILE_SYMLINK_ICON}`
  }

  if (/^https?:/i.test(href)) token.attrPush(['class', 'looma-external-link'])

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

  const openTag = openExternalLinkRule
    ? openExternalLinkRule(tokens, idx, options, env, self)
    : self.renderToken(tokens, idx, options)
  return /^https?:/i.test(href) ? `${openTag}${LINK_ICON}` : openTag
}

export const renderMarkdown = (content: string, options: MarkdownRenderOptions = {}) =>
  markdown.render(normalizeMarkdownNoteLinks(content || ''), options)

/**
 * 渲染 markdown 并携带源码行号信息（data-line 属性）。
 * lineBase 为内容首行在源文件中的 0 基行号。
 */
export type NoteTitleMetadata = { line: number; minutes: number | null; words: number | null }

/** Determine eligibility once from the whole loaded document, never per chunk. */
export const getMarkdownNoteTitleMetadata = (content: string, isPartial: boolean): NoteTitleMetadata | null => {
  const tokens = markdown.parse(normalizeMarkdownNoteLinks(content || ''), {})
  const line = findMarkdownNoteTitle(tokens)
  return line === null ? null : { line, ...(isPartial ? { minutes: null, words: null } : readMarkdownNoteStats(tokens)) }
}

export const renderMarkdownWithLineData = (content: string, lineBase: number, noteTitle?: NoteTitleMetadata | null, options: MarkdownRenderOptions = {}) => {
  const env = { ...options, lineBase }
  const tokens = markdown.parse(normalizeMarkdownNoteLinks(content || ''), env)
  if (noteTitle) {
    const index = tokens.findIndex(token => token.type === 'heading_open' && token.tag === 'h1'
      && token.level === 0 && token.map?.[0] === noteTitle.line - lineBase)
    if (index >= 0) {
      tokens[index].attrJoin('class', 'looma-note-title')
      // A renderer-only token: it is never a Markdown/document node or source-line anchor.
      const meta = new tokens[index].constructor('html_block', '', 0)
      meta.content = `<div class="looma-note-reading-time">${noteStatsLabel(noteTitle.minutes, noteTitle.words)}</div>\n`
      tokens.splice(index + 3, 0, meta)
    }
  }
  return markdown.renderer.render(tokens, markdown.options, env)
}
