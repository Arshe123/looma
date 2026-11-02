import MarkdownIt from 'markdown-it'
export type MarkdownReference = { href: string; title: string }
export type MarkdownReferenceIndex = ReadonlyMap<string, MarkdownReference>
const markdown = new MarkdownIt({ html: false })
export const normalizeMarkdownReference = (label: string): string => markdown.utils.normalizeReference(label)
export const decodeMarkdownInlineSource = (source: string): string => markdown.utils.unescapeAll(source)
/** Only run off the editing thread; viewports consume this immutable result. */
export function buildMarkdownReferenceIndex(source: string): MarkdownReferenceIndex {
  const env: { references?: Record<string, MarkdownReference> } = {}
  markdown.parse(source, env)
  return new Map(Object.entries(env.references ?? {}))
}
