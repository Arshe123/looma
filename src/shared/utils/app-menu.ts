import type { MenuItemConstructorOptions } from 'electron'

export const createViewMenuTemplate = (): MenuItemConstructorOptions[] => [
  { role: 'reload', label: '重新加载' },
  { role: 'toggleDevTools', label: '切换开发者工具' },
  { type: 'separator' },
  { role: 'togglefullscreen', label: '切换全屏' },
]
