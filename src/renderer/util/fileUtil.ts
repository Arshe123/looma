import { FileText, Image, Video, FileType2 } from 'lucide-vue-next'

export const getIconForFile = (filename: string) => {
  const ext = filename.split('.').pop()?.toLowerCase()
  if (ext === 'md') return FileText
  if (ext === 'txt') return FileType2
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext || '')) return Image
  if (['mp4', 'webm', 'ogg'].includes(ext || '')) return Video
  return FileText
}