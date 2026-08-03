# AI 历史对话接口与本地交互

## 页面入口

- 页面组件：`src/renderer/components/ai/AiConversationHistoryPage.vue`
- 列表组件：`src/renderer/components/ai/AiConversationHistoryPanel.vue`
- 页面类型：Electron Renderer 本地系统标签页 `ai-history`

## 后端接口

本次焦点问题修复不新增、不修改网络接口。历史对话元数据仍通过现有 Electron IPC 持久化到当前工作空间：

| 用途 | Renderer 调用 | IPC/服务 | 数据 |
| --- | --- | --- | --- |
| 读取历史对话 | `workspaceAi.get(workspaceId)` | `workspaceAiService` | `AiAssistantState` |
| 保存标题、收藏、置顶、归档和删除结果 | `workspaceAi.set(workspaceId, state)` | `workspaceAiService` | 完整 `AiAssistantState` |

## 本地交互契约

### 文本输入

编辑标题、首次收藏、修改分类和批量收藏调用：

```ts
workspaceStore.requestTextInput(title, defaultValue, placeholder)
```

约束：

- 文本对话框、确认对话框、命令面板互斥；
- 点击遮罩空白区域必须取消并卸载全屏层；
- 输入框失焦后按 Escape 仍必须取消；
- 关闭后不得残留 `fixed inset-0` 命中层。

### 删除确认

删除单个或批量删除历史对话调用：

```ts
workspaceStore.requestConfirmation({
  title,
  message,
  confirmText: '删除',
  danger: true,
})
```

不再调用 Renderer 的 `window.confirm()`，避免 Electron/Windows 关闭原生确认框后窗口输入焦点损坏。

## 回归验证

- `src/renderer/stores/test/workspace-dialog-state.test.ts`
  - 弹层互斥；
  - Promise 确认/取消结果；
  - 后发确认请求取消旧请求；
  - 遮罩自关闭契约；
  - 历史对话不再使用 `window.confirm()`。
