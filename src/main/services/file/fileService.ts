import fs from 'fs/promises';
import type { Result } from '../../../shared/types/Result';
import { withFileWriteLock } from './fileWriteLock';

export interface TextFileChunk {
  content: string;
  offset: number;
  nextOffset: number;
  totalBytes: number;
  done: boolean;
}

const MAX_TEXT_CHUNK_BYTES = 1024 * 1024;

const getCompleteUtf8Length = (buffer: Buffer, requestedLength: number, reachedEnd: boolean) => {
  if (reachedEnd || requestedLength <= 0) return requestedLength;

  let sequenceStart = requestedLength - 1;
  while (sequenceStart >= 0 && (buffer[sequenceStart] & 0xc0) === 0x80) sequenceStart -= 1;
  if (sequenceStart < 0) return requestedLength;

  const lead = buffer[sequenceStart];
  const sequenceLength = lead < 0x80 ? 1 : lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  const sequenceEnd = sequenceStart + sequenceLength;
  if (sequenceEnd <= requestedLength) return requestedLength;
  return sequenceEnd <= buffer.length ? sequenceEnd : sequenceStart;
};

export const fileService = {
  async readMarkdown(filePath: string): Promise<Result<string>> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return { success: true, data: content };
    } catch (error: any) {
      return { success: false, error: `Failed to read file: ${error.message}` };
    }
  },

  async readTextChunk(filePath: string, offset = 0, length = 256 * 1024): Promise<Result<TextFileChunk>> {
    const safeOffset = Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
    const safeLength = Number.isSafeInteger(length)
      ? Math.min(Math.max(length, 1), MAX_TEXT_CHUNK_BYTES)
      : 256 * 1024;
    let handle: Awaited<ReturnType<typeof fs.open>> | null = null;

    try {
      handle = await fs.open(filePath, 'r');
      const stats = await handle.stat();
      const start = Math.min(safeOffset, stats.size);
      const bytesToRead = Math.min(safeLength + 3, stats.size - start);
      const buffer = Buffer.allocUnsafe(bytesToRead);
      const { bytesRead } = await handle.read(buffer, 0, bytesToRead, start);
      const requestedBytes = Math.min(safeLength, bytesRead);
      const reachedEnd = start + requestedBytes >= stats.size;
      const completeLength = getCompleteUtf8Length(buffer, requestedBytes, reachedEnd);
      const nextOffset = start + completeLength;

      return {
        success: true,
        data: {
          content: buffer.subarray(0, completeLength).toString('utf8'),
          offset: start,
          nextOffset,
          totalBytes: stats.size,
          done: nextOffset >= stats.size,
        },
      };
    } catch (error: any) {
      return { success: false, error: `Failed to read file chunk: ${error.message}` };
    } finally {
      await handle?.close().catch(() => {});
    }
  },

  async readFileBase64(filePath: string): Promise<Result<string>> {
    try {
      const content = await fs.readFile(filePath, 'base64');
      const ext = filePath.split('.').pop()?.toLowerCase();
      let mimeType = 'application/octet-stream';
      
      if (ext) {
        const mimeMap: Record<string, string> = {
          'png': 'image/png',
          'jpg': 'image/jpeg',
          'jpeg': 'image/jpeg',
          'gif': 'image/gif',
          'webp': 'image/webp',
          'svg': 'image/svg+xml',
          'mp4': 'video/mp4',
          'webm': 'video/webm',
          'ogg': 'video/ogg'
        };
        mimeType = mimeMap[ext] || mimeType;
      }
      
      return { success: true, data: `data:${mimeType};base64,${content}` };
    } catch (error: any) {
      return { success: false, error: `Failed to read file: ${error.message}` };
    }
  },

  async getFileStats(filePath: string): Promise<Result<{ size: number }>> {
    try {
      const stats = await fs.stat(filePath);
      return { success: true, data: { size: stats.size } };
    } catch (error: any) {
      return { success: false, error: `Failed to read file stats: ${error.message}` };
    }
  },

  async writeMarkdown(filePath: string, content: string, expectedContent?: string): Promise<Result<void>> {
    return withFileWriteLock(filePath, async () => {
      try {
        if (expectedContent !== undefined) {
          const current = await fs.readFile(filePath, 'utf-8');
          if (current !== expectedContent) {
            return {
              success: false,
              error: '文件已被 Agent 或其他程序修改，已阻止旧编辑器内容覆盖磁盘。',
              errorCode: 'FILE_CHANGED_ON_DISK',
            };
          }
        }
        await fs.writeFile(filePath, content, 'utf-8');
        return { success: true };
      } catch (error: any) {
        return { success: false, error: `Failed to write file: ${error.message}` };
      }
    });
  }
};
