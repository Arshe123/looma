/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 后端 HTTP 主机地址覆盖，例如 http://192.168.1.10:8080。未设置时回退到本地默认地址。 */
  readonly VITE_API_BASE_URL?: string
}

declare module 'markdown-it-task-lists' {
  import type MarkdownIt from 'markdown-it'

  type TaskListOptions = {
    enabled?: boolean
    label?: boolean
    labelAfter?: boolean
  }

  const taskLists: MarkdownIt.PluginWithOptions<TaskListOptions>
  export default taskLists
}
