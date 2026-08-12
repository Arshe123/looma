import { describe, expect, it } from 'vitest'
import { parseMarkdownOutline } from '@/shared/utils/markdown-outline'
import { buildOutlineTree, flattenOutlineTree, resolveOutlineExpandedIds } from '@/shared/utils/outline-tree'
import helpMarkdown from '../help.md?raw'

describe('help document outline', () => {
  it('exposes the built-in help headings to the outline parser', () => {
    const outline = parseMarkdownOutline(helpMarkdown)

    expect(outline.map((item) => item.text)).toEqual([
      'Looma 帮助文档',
      '1. 开始使用',
      '1.1 打开或新建工作空间',
      '1.2 新建第一篇笔记',
      '1.3 修改会自动保存',
      '2. 界面总览',
      '2.1 侧边栏',
      '2.2 主题',
      '2.3 标签页与状态恢复',
      '3. 笔记编辑',
      '3.1 三种视图模式',
      '3.2 富文本编辑',
      '3.3 快捷插入菜单',
      '3.4 大纲导航',
      '3.5 大文件',
      '3.6 纯文本文件',
      '4. 文件管理',
      '4.1 文件树操作',
      '4.2 拖入文件',
      '4.3 回收站',
      '5. 笔记引用',
      '5.1 插入引用',
      '5.2 链接语法',
      '5.3 悬停预览与跳转',
      '5.4 外部链接',
      '6. 图片与媒体预览',
      '7. 快捷键速查',
      '8. AI 助手与 Agent',
      '8.1 第一步：配置 AI',
      '8.2 第二步：使用 AI 助手',
      '8.3 第三步：建立知识索引（RAG）',
      '8.4 Agent 如何工作',
      '8.5 执行过程与参考来源',
      '8.6 文件修改审批',
      '8.7 中断与继续',
      '8.8 对话管理',
      '8.9 回答中的文字操作',
      '9. 数据与隐私',
      '10. 获取更新',
      '11. 常见问题',
      '11.1 为什么大纲不可用？',
      '11.2 删除的文件在哪里？',
      '11.3 AI 回答不准确怎么办？',
      '11.4 Agent 修改文件安全吗？',
      '11.5 如何反馈问题？',
    ])
    expect(outline.map((item) => item.index)).toEqual(outline.map((_, index) => index))
  })

  it('shows the subsections of first-level help sections by default', () => {
    const outline = parseMarkdownOutline(helpMarkdown)
    const expandedIds = resolveOutlineExpandedIds(outline, [], [], true, false)
    const visibleRows = flattenOutlineTree(buildOutlineTree(outline), new Set(expandedIds))

    expect(outline.filter((item) => expandedIds.includes(item.id)).map((item) => item.text)).toEqual([
      'Looma 帮助文档',
      '1. 开始使用',
      '2. 界面总览',
      '3. 笔记编辑',
      '4. 文件管理',
      '5. 笔记引用',
      '6. 图片与媒体预览',
      '7. 快捷键速查',
      '8. AI 助手与 Agent',
      '9. 数据与隐私',
      '10. 获取更新',
      '11. 常见问题',
    ])
    expect(visibleRows.slice(0, 5).map((row) => row.item.text)).toEqual([
      'Looma 帮助文档',
      '1. 开始使用',
      '1.1 打开或新建工作空间',
      '1.2 新建第一篇笔记',
      '1.3 修改会自动保存',
    ])
  })
})
