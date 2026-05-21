/// <reference types="vite/client" />

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
