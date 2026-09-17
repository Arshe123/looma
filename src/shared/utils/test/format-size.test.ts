import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { scaleFileSize } from '../format-size'
import { describe, expect, it } from 'vitest'

// Execute the real local formatter without mounting unrelated stores/IPC.
const loadFormatter = (path: string, name: string, dependencies = {}) => {
  const source = readFileSync(new URL(`../../../renderer/components/${path}`, import.meta.url), 'utf8')
  const declaration = source.match(new RegExp(`const ${name} = \\([\\s\\S]*?\\n}`))?.[0]
  if (!declaration) throw new Error(`Missing formatter: ${path}:${name}`)
  const { outputText } = ts.transpileModule(`${declaration}\nreturn ${name}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  })
  return new Function(...Object.keys(dependencies), outputText)(...Object.values(dependencies))
}

// Frozen pre-extraction implementations are the compatibility oracle.
const oldDownload = (bytes: number) => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`
}
const oldMedia = (bytes: number) => {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  if (unitIndex === 0) return `${value} ${units[unitIndex]}`
  return `${value.toFixed(1).replace(/\.0$/, '')} ${units[unitIndex]}`
}
const oldTrash = (item: { size: number; isDirectory: boolean }) => {
  if (item.isDirectory) return '—'
  const size = item.size
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`
  return `${(size / 1024 / 1024 / 1024).toFixed(1)} GB`
}
const oldRag = (size?: number) => {
  if (!Number.isFinite(size)) return '—'
  const value = size as number
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}
const oldUpdate = (bytes?: number) => {
  if (!bytes || bytes < 1) return ''
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

const inputs = [
  undefined, null, NaN, Infinity, -Infinity, -1024, -1, -0, 0, 0.1, 0.5, 1, 10,
  1023.5, 1024, 1024.5, 1536, 9.95 * 1024, 10 * 1024, 10.5 * 1024,
  ...[2, 3, 4, 5].flatMap(power => [1024 ** power - 1, 1024 ** power, 1024 ** power + 1]),
  Number.MAX_SAFE_INTEGER, Number.MAX_VALUE,
]

const verifyUiFormats = (dependencies = { scaleFileSize }) => {
  for (const [path, name, oracle] of [
    ['AppMessages.vue', 'formatBytes', oldDownload],
    ['preview/MediaPreview.vue', 'formatFileSize', oldMedia],
    ['rag/RagIndexPage.vue', 'formatFileSize', oldRag],
    ['update/UpdateModal.vue', 'formatBytes', oldUpdate],
  ] as const) {
    it(`${path} preserves placeholders, precision, unit limits and invalid inputs`, () => {
      const format = loadFormatter(path, name, dependencies)
      for (const input of inputs) {
        expect(format(input), `${path}: ${String(input)}`).toBe(oracle(input as number))
      }
    })
  }
  it('FileTree preserves directory placeholders and all file size outputs', () => {
    const format = loadFormatter('FileTree.vue', 'formatTrashSize', dependencies)
    for (const size of inputs) {
      for (const isDirectory of [false, true]) {
        const item = { size: size as number, isDirectory }
        expect(format(item), `trash: ${String(size)}, directory: ${isDirectory}`).toBe(oldTrash(item))
      }
    }
  })
}

describe('file size shared conversion', () => {
  it('scales base-1024 values within the requested unit range', async () => {
    const { scaleFileSize } = await import('../format-size')
    expect(scaleFileSize(1536, 'GB')).toEqual({ value: 1.5, unit: 'KB' })
    expect(scaleFileSize(1024 ** 4, 'GB')).toEqual({ value: 1024, unit: 'GB' })
    expect(scaleFileSize(1, 'MB', 'KB')).toEqual({ value: 1 / 1024, unit: 'KB' })
    expect(scaleFileSize(1024 ** 4, 'TB')).toEqual({ value: 1, unit: 'TB' })
    expect(scaleFileSize(0.5, 'MB')).toEqual({ value: 0.5, unit: 'B' })
    expect(scaleFileSize(-1, 'GB')).toEqual({ value: -1, unit: 'B' })
    expect(scaleFileSize(NaN, 'GB')).toEqual({ value: NaN, unit: 'GB' })
    expect(scaleFileSize(Infinity, 'MB')).toEqual({ value: Infinity, unit: 'MB' })
  })
})

describe('file size UI compatibility', () => {
  verifyUiFormats()
})
