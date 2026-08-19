import type { JSONContent } from '@tiptap/core'
import { marked } from 'marked'

type MarkdownAstEditor = {
  getJSON: () => JSONContent
  markdown?: {
    serialize: (document: JSONContent) => string
  }
}

// 任何 Unicode 标点/符号,出现在 ** 开标记右侧或闭标记左侧时会让 CommonMark emphasis 判定失败。
// 中文写作里既会用到 CJK 标点(“”（），。),也会用到英文标点(" ' ( ) , . : ; ! ?),
// 因此这里使用 \p{P} (标点) + \p{S} (符号) 完整覆盖,不再局限于 CJK 范围。
const isBoundaryPunctCp = (cp: number): boolean =>
  /[\p{P}\p{S}]/u.test(String.fromCodePoint(cp))

// Tiptap 富文本路径走 @tiptap/markdown (内部用 marked 单例), 不走 markdown-renderer.ts。
// marked 默认 strong tokenizer 同样拒绝标点边界的 **...**。
// 给 marked 单例注册一个同名 inline tokenizer: 仅当开标记右侧或闭标记左侧是标点/符号时接管,
// 其他情形返回 undefined 让默认 strong tokenizer 处理, 不重复消费。
marked.use({
  extensions: [
    {
      name: 'strong',
      level: 'inline',
      start(src: string) {
        const match = src.match(/\*\*/)
        return match ? match.index : -1
      },
      tokenizer(src: string) {
        if (!src.startsWith('**')) return undefined
        const afterOpenCp = src.codePointAt(2) ?? 0x20

        let pos = 2
        // eslint-disable-next-line no-cond-assign
        while ((pos = src.indexOf('**', pos)) !== -1) {
          if (pos === 2) {
            pos += 2
            continue
          }
          const beforeCloseCp = src.codePointAt(pos - 1) ?? 0x20
          if (!isBoundaryPunctCp(afterOpenCp) && !isBoundaryPunctCp(beforeCloseCp)) {
            return undefined
          }
          const innerText = src.slice(2, pos)
          return {
            type: 'strong',
            raw: src.slice(0, pos + 2),
            text: innerText,
            tokens: this.lexer.inlineTokens(innerText),
          }
        }
        return undefined
      },
    },
  ],
})

export const serializeMarkdownAst = (editor: MarkdownAstEditor): string => {
  if (!editor.markdown) throw new Error('Markdown serializer is not initialized.')
  return editor.markdown.serialize(editor.getJSON())
}

const isFenceLine = (line: string) => /^\s*(`{3,}|~{3,})/.exec(line)?.[1]
const isStandaloneImageLine = (line: string) =>
  /^[\t ]*!\[[^\]\r\n]*\]\([^\r\n]*\)[\t ]*(?:\r?\n)?$/.test(line)

export const prepareMarkdownForRichText = (markdown: string) => {
  const lines = markdown.match(/.*(?:\r?\n|$)/g)?.filter(Boolean) || []
  let fence: string | null = null

  return lines.map((line, index) => {
    const marker = isFenceLine(line)
    if (marker) {
      if (!fence) fence = marker[0]
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null
      return line
    }

    const nextLine = lines[index + 1]
    if (!fence && nextLine && nextLine.trim() && isStandaloneImageLine(line)) {
      return line.endsWith('\r\n') ? `${line}\r\n` : line.endsWith('\n') ? `${line}\n` : `${line}\n\n`
    }
    return line
  }).join('')
}
