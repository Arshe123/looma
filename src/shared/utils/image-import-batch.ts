import type { ImportedImage } from './tiptap-image-insertion'

type ImageImportBatchOptions = {
  sourcePaths: readonly string[]
  importImage: (sourcePath: string) => Promise<{
    success: boolean
    data?: ImportedImage
    error?: string
  }>
  setBusy: (busy: boolean, message?: string) => void
  insertImages: (images: ImportedImage[]) => void | string
  reportError: (message: string, detail: string) => void
}

/** Callers retain validation, editor lifetime checks and insertion transactions. */
export const importImageBatch = async ({
  sourcePaths,
  importImage,
  setBusy,
  insertImages,
  reportError,
}: ImageImportBatchOptions) => {
  const imported: ImportedImage[] = []
  const failures: string[] = []
  setBusy(true, sourcePaths.length > 1 ? `正在导入 ${sourcePaths.length} 张图片...` : '正在导入图片...')
  try {
    for (const sourcePath of sourcePaths) {
      const result = await importImage(sourcePath)
      if (result.success && result.data) imported.push(result.data)
      else failures.push(result.error || sourcePath)
    }
    if (imported.length > 0) {
      const insertionError = insertImages(imported)
      if (insertionError) failures.push(insertionError)
    }
    if (failures.length > 0) {
      reportError(imported.length > 0
        ? '部分图片未能导入，其余图片已插入。'
        : '图片导入失败，请确认图片仍然存在且当前笔记目录可写。', failures.join('\n'))
    }
  } catch (error) {
    reportError('图片导入失败，请稍后重试。', error instanceof Error ? error.message : String(error))
  } finally {
    setBusy(false)
  }
}
