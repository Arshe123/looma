/**
 * 笔记间引用链接解析工具。
 *
 * 支持标准 Markdown 链接语法：
 *   [文字](相对路径.md)            —— 打开笔记
 *   [文字](相对路径.md#标题文本)    —— 跳转到标题（标题文本支持 URL 编码）
 *   [文字](相对路径.md#L12)        —— 跳转到第 12 行
 *   [文字](相对路径.md#L12-15)     —— 跳转到第 12~15 行（滚动起点为 12）
 *
 * 路径相对于当前笔记所在目录解析，支持 ./ 与 ../。
 */

export type NoteLinkAnchor =
  | { kind: 'heading'; text: string }
  | { kind: 'line'; line: number }
  | { kind: 'line-range'; start: number; end: number };

export interface NoteLinkRef {
  /** 相对于工作区的笔记路径（使用 / 分隔，无前导 /） */
  relativePath: string;
  /** 锚点；无 # 时为 undefined */
  anchor?: NoteLinkAnchor;
}

const LINE_ANCHOR_PATTERN = /^L(\d+)(?:-(\d+))?$/i;

const isExternalHref = (href: string) => /^(https?:|mailto:|tel:|data:|file:|ftp:)/i.test(href);

const decodeAnchorText = (raw: string) => {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
};

/** 解析 # 后的锚点文本：行号 / 行范围 / 标题。 */
export const parseNoteLinkAnchor = (raw: string): NoteLinkAnchor | undefined => {
  const text = (raw || '').trim();
  if (!text) return undefined;

  const lineMatch = text.match(LINE_ANCHOR_PATTERN);
  if (lineMatch) {
    const start = Number(lineMatch[1]);
    const end = lineMatch[2] ? Number(lineMatch[2]) : undefined;
    if (Number.isFinite(start) && start > 0) {
      if (end !== undefined && Number.isFinite(end) && end >= start) {
        return { kind: 'line-range', start, end };
      }
      return { kind: 'line', line: start };
    }
  }

  const decoded = decodeAnchorText(text);
  return decoded ? { kind: 'heading', text: decoded } : undefined;
};

/** 基于当前笔记相对路径，把 href 中的相对路径解析为工作区相对路径。 */
const resolveRelativePath = (fromRelativePath: string, hrefPath: string) => {
  const normalizedFrom = (fromRelativePath || '').split('\\').join('/');
  const baseDir = normalizedFrom.includes('/') ? normalizedFrom.slice(0, normalizedFrom.lastIndexOf('/')) : '';
  const stack = baseDir ? baseDir.split('/') : [];

  for (const segment of hrefPath.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      stack.pop();
      continue;
    }
    stack.push(segment);
  }

  return stack.join('/');
};

/**
 * 解析链接 href，判断是否为笔记间引用。
 * 非笔记链接（外部 URL、图片、纯页内锚点等）返回 null。
 */
export const parseNoteLinkHref = (href: string, fromRelativePath: string): NoteLinkRef | null => {
  if (!href || isExternalHref(href)) return null;

  const clean = href.split('\\').join('/');
  const hashIndex = clean.indexOf('#');
  const pathPart = hashIndex >= 0 ? clean.slice(0, hashIndex) : clean;
  const hashPart = hashIndex >= 0 ? clean.slice(hashIndex + 1) : '';
  if (!pathPart) return null;

  const extension = pathPart.split('.').pop()?.toLowerCase() || '';
  if (extension !== 'md' && extension !== 'txt') return null;

  const relativePath = resolveRelativePath(fromRelativePath, pathPart);
  if (!relativePath) return null;

  const anchor = hashPart ? parseNoteLinkAnchor(hashPart) : undefined;
  return { relativePath, anchor };
};

/** 笔记间引用跳转事件名（window.dispatchEvent / addEventListener）。 */
export const OPEN_NOTE_REF_EVENT = 'looma:open-note-ref'

/** 笔记间引用跳转事件 detail。 */
export interface OpenNoteRefEventDetail {
  /** 目标笔记相对工作区路径 */
  relativePath: string
  /** 锚点；无 # 时为 undefined */
  anchor?: NoteLinkAnchor
}

/** 派发笔记间引用跳转事件。 */
export const dispatchOpenNoteRef = (detail: OpenNoteRefEventDetail) => {
  window.dispatchEvent(new CustomEvent<OpenNoteRefEventDetail>(OPEN_NOTE_REF_EVENT, { detail }))
}

/** 判断 markdown 链接是否指向内部笔记（供渲染层打标使用）。 */
export const isInternalNoteHref = (href: string) => {
  if (!href || isExternalHref(href)) return false;
  const clean = href.split('\\').join('/');
  const pathPart = clean.split('#', 1)[0];
  if (!pathPart) return false;
  const extension = pathPart.split('.').pop()?.toLowerCase() || '';
  return extension === 'md' || extension === 'txt';
};

/** 标题锚点文本是否与大纲标题匹配（忽略大小写与首尾空白）。 */
export const isHeadingAnchorMatch = (anchorText: string, headingText: string) => {
  const normalize = (text: string) => (text || '').trim().replace(/\s+/g, ' ').toLowerCase();
  return Boolean(anchorText) && normalize(anchorText) === normalize(headingText);
};

/**
 * 计算从当前笔记到目标笔记的相对引用路径（供插入链接时使用）。
 * 返回的路径可直接写入 Markdown 链接的括号中，例如 ../notes/a.md。
 */
export const buildNoteRefRelativePath = (fromRelativePath: string, targetRelativePath: string) => {
  const fromAll = (fromRelativePath || '').split('\\').join('/').split('/').filter(Boolean);
  const targetAll = (targetRelativePath || '').split('\\').join('/').split('/').filter(Boolean);
  if (targetAll.length === 0) return '';

  // 只对目录部分求公共前缀（最后一个 segment 是文件名，不参与）
  const fromDir = fromAll.slice(0, -1);
  const targetDir = targetAll.slice(0, -1);
  let common = 0;
  while (common < fromDir.length && common < targetDir.length && fromDir[common] === targetDir[common]) {
    common += 1;
  }

  // 从当前文件所在目录回退到公共目录需要的层级
  const ups = fromDir.length - common;
  const parts: string[] = [];
  for (let i = 0; i < ups; i += 1) parts.push('..');
  parts.push(...targetAll.slice(common));

  return parts.join('/');
};
