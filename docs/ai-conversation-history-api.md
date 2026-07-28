# AI 历史对话页面接口说明

## 页面入口

- 页面组件：`src/renderer/components/ai/AiConversationHistoryPage.vue`
- 列表组件：`src/renderer/components/ai/AiConversationHistoryPanel.vue`
- 状态管理：`src/renderer/stores/workspace.ts`
- 页面类型：Electron 本地页面，不调用 HTTP 后端接口

## 数据来源

历史对话保存在当前工作空间：

```text
<workspace>/.looma/ai-assistant/state.json
```

渲染进程通过 Preload 暴露的 `workspaceAi` IPC 接口读取和保存完整状态。

## IPC 接口

### 读取 AI 对话状态

- IPC Channel：`workspaceAi:get`
- Preload 调用：`window.electronAPI.workspaceAi.get(workspaceId)`
- Main 注册：`src/main/ipc/workspaceIpc.ts`
- 服务实现：`src/main/services/workspace/workspaceAiService.ts#getState`

参数：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `workspaceId` | `string` | 是 | 当前工作空间 ID |

返回：

```ts
Result<AiAssistantState>
```

### 保存 AI 对话状态

- IPC Channel：`workspaceAi:set`
- Preload 调用：`window.electronAPI.workspaceAi.set(workspaceId, state)`
- Main 注册：`src/main/ipc/workspaceIpc.ts`
- 服务实现：`src/main/services/workspace/workspaceAiService.ts#setState`

参数：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `workspaceId` | `string` | 是 | 当前工作空间 ID |
| `state` | `AiAssistantState` | 是 | 完整 AI 对话状态 |

返回：

```ts
Result<void>
```

## 页面使用的数据字段

| 字段 | 类型 | 用途 |
| --- | --- | --- |
| `conversation.id` | `string` | 选择、批量操作、打开对话 |
| `conversation.title` | `string` | 卡片标题、搜索 |
| `conversation.updatedAt` | `number` | 最新优先排序和卡片时间 |
| `conversation.messages` | `AiAssistantMessage[]` | 最近用户问题预览、消息数量 |
| `conversation.pinned` | `boolean?` | 置顶筛选和状态标签 |
| `conversation.favorite` | `boolean?` | 收藏筛选和状态标签 |
| `conversation.favoriteCategory` | `string?` | 收藏分类筛选 |
| `conversation.archived` | `boolean?` | 归档筛选和状态标签 |

## 页面行为

- 默认按 `updatedAt` 从新到旧排序，不再按时间段分组。
- 前端本地分页，每页 8 条；筛选或搜索变化时回到第一页并清空选择。
- 批量操作包括置顶、取消置顶、收藏、取消收藏、归档、取消归档和删除。
- 批量状态操作在 Pinia Store 中合并为一次 `workspaceAi:set` 持久化。
- 收藏分类弹窗返回 `null` 表示取消；取消时不得修改收藏状态。
- 删除操作需要浏览器确认，删除后保存完整对话状态。

## 鉴权与网络

- 无 HTTP 请求。
- 无单独登录鉴权。
- 数据范围受当前 Electron 工作空间和本地文件权限约束。
