import type { TokenizerExtension } from 'marked'

type InlineMatch = { raw: string; text: string }

/** Looma extensions only; standard emphasis/code/link grammar remains engine-owned. */
export const matchMarkdownHighlight = (source: string, start = 0, end = source.length): InlineMatch | undefined => {
  if (!source.startsWith('==', start)) return undefined
  const close = source.indexOf('=', start + 2)
  if (close <= start + 2 || close + 2 > end || !source.startsWith('==', close)) return undefined
  return { raw: source.slice(start, close + 2), text: source.slice(start + 2, close) }
}

export const matchMarkdownPunctuationStrong = (source: string, start = 0, end = source.length): InlineMatch | undefined => {
  if (!source.startsWith('**', start) || source.startsWith('***', start)) return undefined
  const close = source.indexOf('**', start + 2)
  if (close <= start + 2 || close + 2 > end || source[close - 1] === '\\' || source[close + 2] === '*') return undefined
  const text = source.slice(start + 2, close)
  const characters = Array.from(text)
  if (/\s/u.test(characters[0]) || /\s/u.test(characters[characters.length - 1])) return undefined
  if (!/[\p{P}\p{S}]/u.test(characters[0]) && !/[\p{P}\p{S}]/u.test(characters[characters.length - 1])) return undefined
  return { raw: source.slice(start, close + 2), text }
}

/** Shared by MarkdownManager and the source-backed editor's independent lexer. */
export const markdownInlineExtensions: TokenizerExtension[] = [
  {
    name: 'highlight', level: 'inline', start: source => source.indexOf('=='),
    tokenizer(source) {
      const match = matchMarkdownHighlight(source)
      return match ? { type: 'highlight', ...match, tokens: this.lexer.inlineTokens(match.text) } : undefined
    },
  },
  {
    name: 'strong', level: 'inline', start: source => source.indexOf('**'),
    tokenizer(source) {
      const match = matchMarkdownPunctuationStrong(source)
      return match ? { type: 'strong', ...match, tokens: this.lexer.inlineTokens(match.text) } : undefined
    },
  },
]
