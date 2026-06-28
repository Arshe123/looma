# AI 设置页接口说明

## 页面位置

- 页面组件：`src/renderer/components/settings/AiSettings.vue`
- 打开入口：工作区 AI 侧栏顶部“AI 设置”按钮，或设置页中的 AI 分组
- 顶部区域：对话上下文策略

## 当前数据来源

AI 设置页通过 Electron preload 暴露的本地设置接口读写：

- `window.electronAPI.appSettings.get()`：读取应用设置
- `window.electronAPI.appSettings.set(settings)`：保存完整应用设置
- 渲染层 Store：`src/renderer/stores/settings.ts`
- 设置归一化与默认值：`src/shared/utils/app-settings.ts`

这些设置目前持久化在本机应用配置文件中，不直接请求远端 HTTP 后端。

## 对话上下文策略字段

页面现在展示两个设置项：上下文策略、对话轮数。

`AppSettings.ai.conversationContext`：

```ts
{
  strategy: 'sliding_window' | 'summary'
  recentTurns: number
  summaryMaxMessages: number
  summaryMaxChars: number
}
```

默认值：

```json
{
  "strategy": "summary",
  "recentTurns": 6,
  "summaryMaxMessages": 24,
  "summaryMaxChars": 1200
}
```

页面可选策略：

| 策略 | 值 | 行为 |
| --- | --- | --- |
| 滑动窗口（固定对话轮数加入对话历史） | `sliding_window` | 只把最近设置轮数的 user/assistant 消息原样放入 RAG `history`，更早对话不发送。 |
| 摘要总结（超过一定轮数进行总结） | `summary` | 最近设置轮数原样放入 `history`；超过设置轮数后调用 LLM 总结更早对话，并把摘要作为 system 消息加入上下文。 |

说明：

- `recentTurns` 显示为“对话轮数”，用户可自行设置。
- `summaryMaxMessages`、`summaryMaxChars` 仍作为内部参数保留默认值，当前不在设置页展示。
- 兼容旧配置：`enable_distant_summary: false` 会迁移为 `strategy: 'sliding_window'`；旧的 `summary_max_messages`、`summary_max_chars` 仍可读取。

## 自动压缩流程

AI 助手发起提问时，`src/renderer/components/ai/AiAssistant.vue` 会按策略构造 `/rag/query/stream` 的 `history`：

1. 统计当前会话中第几次用户对话，用户轮数序号按 `role: "user"` 消息计数。
2. 如果策略是 `sliding_window`：
   - 不调用 LLM 总结。
   - 只携带最近设置轮数的原始 user/assistant 对话。
3. 如果策略是 `summary`：
   - 从最近一次系统摘要里解析“已总结至第 N 次用户对话”。
   - 如果当前用户轮数与 N 的差值没有超过设置轮数，不触发新摘要；请求 history 使用“上一版摘要 + 摘要后新增对话”。
   - 如果当前输入将成为第 `N + 1` 次未总结用户对话，插入 system 消息：`系统：正在压缩早期对话，请稍候...`。
   - 本次会保留“最大对话轮数的 1/4”作为最近原文对话，其余新增对话进入摘要。例如设置最大对话轮数为 100，用户输入第 101 条对话时触发，已有 m1-m100 中压缩 m1-m75，保留 m76-m100。
   - 发送给 LLM 的内容是“上一版摘要 + 本次需要压缩的新增对话”，不会重复发送已经总结过且仍在摘要内的旧对话。
   - 完成后把 system 消息更新为：`系统：已压缩早期对话（已总结至第 N 次用户对话，保留最近 K 轮）`，并展示 LLM 生成的 Markdown 摘要。
4. 触发摘要成功后的当前请求 history 由“新摘要 system 消息 + 保留的最近 1/4 原文对话”组成。
5. 下一次再次超过设置轮数时，会去除已经总结过的对话，只把“上一版摘要 + 上次摘要后新增且不属于保留尾部的对话”交给 LLM 生成新版摘要，并记录新的用户轮数位置。

## Electron 接口

### `window.electronAPI.rag.summarizeConversation(messages, maxChars)`

参数：

```ts
messages: Array<{
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  name?: string
}>
maxChars: number
```

返回：

```ts
Promise<Result<{ answer: string }>>
```

主进程 IPC：

- Channel：`rag:summarizeConversation`
- 入口：`src/main/index.ts`
- 服务方法：`src/main/services/ai/AIService.ts#summarizeConversation`
- 后端请求：`POST /chat`

## RAG 查询请求示例

```json
{
  "question": "继续解释上面的方案",
  "workspace": {
    "workspace_path": "E:/example-workspace"
  },
  "history": [
    {
      "role": "system",
      "content": "对话摘要（已总结至第 12 次用户对话）：\n## 关键信息\n..."
    },
    {
      "role": "user",
      "content": "最近第 1 轮问题"
    },
    {
      "role": "assistant",
      "content": "最近第 1 轮回答"
    }
  ],
  "request_stats": {
    "history_messages": 3,
    "history_token_estimate": 640,
    "question_token_estimate": 12,
    "total_token_estimate": 652,
    "recent_turns": 6,
    "distant_summary_enabled": true,
    "distant_summary_messages": 10
  }
}
```

## 后端接口

当前复用已有 RAG 服务接口：

- `POST /chat`：用于 LLM 生成早期对话摘要，不检索知识库。
- `POST /rag/query`
- `POST /rag/query/stream`

`request_stats` 中的上下文策略统计字段为可选字段，仅用于观测和时间线展示，不影响回答生成逻辑。
