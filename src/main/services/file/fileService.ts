import fs from 'fs/promises';
import type { Result } from '../../../shared/types/Result';
import { withFileWriteLock } from './fileWriteLock';

export const fileService = {
  async readMarkdown(filePath: string): Promise<Result<string>> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return { success: true, data: content };
    } catch (error: any) {
      return { success: false, error: `Failed to read file: ${error.message}` };
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
