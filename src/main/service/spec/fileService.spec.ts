import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { fileService } from '../fileService'

describe('fileService', () => {
  it('returns the file size in bytes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'with-you-file-service-'))
    const filePath = join(dir, 'image.png')

    try {
      await writeFile(filePath, Buffer.from([1, 2, 3, 4, 5]))

      const result = await (fileService as any).getFileStats(filePath)

      expect(result).toEqual({
        success: true,
        data: { size: 5 },
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
