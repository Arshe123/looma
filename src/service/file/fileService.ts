import fs from 'fs/promises';
import type { Result } from '../../common/interface/Result';

/**
 * Simple file-level lock to prevent concurrent write operations on the same file.
 */
class FileLock {
  private locks: Set<string> = new Set();

  async acquire(filePath: string): Promise<void> {
    while (this.locks.has(filePath)) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    this.locks.add(filePath);
  }

  release(filePath: string): void {
    this.locks.delete(filePath);
  }
}

const fileLock = new FileLock();

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

  async writeMarkdown(filePath: string, content: string): Promise<Result<void>> {
    try {
      await fileLock.acquire(filePath);
      await fs.writeFile(filePath, content, 'utf-8');
      return { success: true };
    } catch (error: any) {
      return { success: false, error: `Failed to write file: ${error.message}` };
    } finally {
      fileLock.release(filePath);
    }
  }
};
