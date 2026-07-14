# AI Agent API（Canonical Contract）

本文定义 Looma Renderer、Electron 主进程与 `rag-service` 之间的首版 Agent 契约，并记录当前已实现的只读 Tool Registry、有限步运行时和 Electron 转发层；正式 UI 将在后续阶段接入。

## 1. 安全默认值与领域约束

`AgentConfig` 只表达 Agent 执行策略，不再承载 `chat` / `rag` / `agent` 模式：

```json
{
  "enabled_tools": ["rag_search", "workspace_list", "workspace_search", "file_read"],
  "max_steps": 8,
  "tool_timeout_seconds": 30,
  "run_timeout_seconds": 300,
  "allow_write": false
}
```

- `max_steps`：`1..50`。
- `tool_timeout_seconds`：`1..300` 秒。
- `run_timeout_seconds`：整个 Agent 运行的累计内部等待预算，`1..1800` 秒，默认 `300` 秒。
- 首版默认开放且仅开放只读工具：`rag_search`、`workspace_list`、`workspace_search`、`file_read`。
- `file_write`、`web_search`、`terminal` 是为未来策略/注册表保留的工具类型，**不得默认开放**。
- `allow_write` 默认为 `false`；它是写操作的额外策略门槛，而不是自动启用写工具的开关。
- Agent 契约模型拒绝未知字段（`extra=forbid`），避免拼写错误或协议漂移被静默忽略。

## 2. Electron IPC

Renderer 使用以下通道；主进程负责把 HTTP NDJSON 流转发为事件：

### `agent:runStream:start`

Renderer 传入本地 `requestId`、`workspaceId` 和 `AgentRunOptions`。主进程返回 `Result<void>` 表示是否已启动，并通过 `agent:runStream:event` 推送同时包含原 `requestId` 与后端 `runId` 的事件。

### `agent:runStream:cancel`

Renderer 传入本地请求 ID：

```json
{ "requestId": "request_01..." }
```

取消按当前窗口与 `requestId` 精确作用于一个运行，并可安全重复调用。Renderer 不使用尚未返回或不可用的后端 `runId` 发起取消。

### `agent:runStream:event`

主进程向 Renderer 推送服务端事件。**所有 Agent 事件都必须带非空 `runId`**；Renderer 使用它隔离并发运行及忽略已取消运行的迟到事件。

## 3. `POST /agent/run/stream`

请求体（字段名使用 snake_case）：

```json
{
  "input": "总结当前工作区的发布流程",
  "workspace": { "workspace_path": "D:/work/demo" },
  "agent": {
    "enabled_tools": ["rag_search", "workspace_list", "workspace_search", "file_read"],
    "max_steps": 8,
    "tool_timeout_seconds": 30,
    "run_timeout_seconds": 300,
    "allow_write": false
  },
  "history": []
}
```

`input` 必填且非空；`workspace` 可选。正常应用请求**不重复发送** `ai_config` 和 `knowledge`，二者缺省时由后端从全局设置解析。诊断、测试或显式覆盖场景仍可传入：

```json
{
  "ai_config": null,
  "knowledge": null
}
```

响应媒体类型为 `application/x-ndjson`；每行是一个完整 JSON 对象并以换行结束。

## 4. Agent Decision

模型输出必须严格解析为以下二选一结构，未知 `type`、空文本、非法工具名及额外字段均拒绝。

工具调用：

```json
{
  "type": "tool_call",
  "thought_summary": "先检索发布文档",
  "tool": "rag_search",
  "arguments": { "query": "发布流程" }
}
```

最终回答：

```json
{ "type": "final", "answer": "发布流程如下……" }
```

`thought_summary` 只能是适合展示的简短步骤说明，不得包含隐藏推理链。

## 5. Tool Result 与 Agent Error

成功结果：

```json
{
  "tool": "file_read",
  "success": true,
  "summary": "已读取 README.md 前 100 行",
  "data": { "path": "README.md", "content": "..." },
  "error": null,
  "truncated": true
}
```

失败结果：

```json
{
  "tool": "rag_search",
  "success": false,
  "summary": "检索超时",
  "data": null,
  "error": {
    "code": "tool_timeout",
    "message": "工具执行超时",
    "technical_detail": "deadline exceeded after 30 seconds",
    "retryable": true
  },
  "truncated": false
}
```

`success=false` 时必须有 `error`；`success=true` 时不得携带 `error`。面向用户的稳定说明使用 `message`，内部诊断信息统一命名为 **`technical_detail`**，不得混用 `detail`、`technicalDetails` 或 `technicalDetail`。该字段可能包含敏感运行信息，Renderer 默认不直接展示。

## 6. NDJSON 事件

事件公共字段：

```json
{ "type": "timeline", "runId": "run_01..." }
```

`type` 与 `runId` 是每个事件的必需字段。事件类型如下。

### `run_started`

```json
{"type":"run_started","runId":"run_01...","startedAt":"2026-07-14T10:00:00Z"}
```

### `timeline`

表示计划/步骤状态变化；`status` 建议为 `pending`、`running`、`completed`、`failed` 或 `cancelled`。

```json
{"type":"timeline","runId":"run_01...","step":1,"stepId":"step_01...","status":"running","summary":"检索发布文档"}
```

### `tool_call`

```json
{"type":"tool_call","runId":"run_01...","step":1,"stepId":"step_01...","callId":"call_01...","tool":"rag_search","arguments":{"query":"发布流程"},"thought_summary":"先检索发布文档"}
```

### `tool_result`

```json
{"type":"tool_result","runId":"run_01...","step":1,"stepId":"step_01...","callId":"call_01...","result":{"tool":"rag_search","success":true,"summary":"找到 3 条结果","data":[],"error":null,"truncated":false}}
```

### `sources`

```json
{"type":"sources","runId":"run_01...","sources":[{"path":"docs/release.md","score":0.91,"text":"..."}]}
```

### `delta`

兼容现有与通用流客户端，`text` 和 `content` 必须同时存在且值相同：

```json
{"type":"delta","runId":"run_01...","text":"发布","content":"发布"}
```

### `approval_required`

运行时需要用户批准有副作用的动作时暂停：

```json
{"type":"approval_required","runId":"run_01...","approvalId":"approval_01...","tool":"file_write","summary":"写入 docs/release.md","arguments":{"path":"docs/release.md"}}
```

### `approval_resolved`

```json
{"type":"approval_resolved","runId":"run_01...","approvalId":"approval_01...","approved":false}
```

### `done`

```json
{"type":"done","runId":"run_01...","status":"completed","answer":"发布流程如下……"}
```

### `error`

```json
{"type":"error","runId":"run_01...","error":{"code":"agent_failed","message":"Agent 运行失败","technical_detail":"provider connection reset","retryable":true}}
```

流在 `done` 或 `error` 后结束。取消运行应通过 `timeline`/`done` 表达 `cancelled` 状态；事件生产者仍须保留原 `runId`。

## Electron IPC 边界

Renderer 不直接请求 FastAPI，也不传递 workspace 绝对路径或 AI 密钥。首版只通过 preload 暴露以下接口：

```ts
electronAPI.agent.runStream.start(requestId, workspaceId, {
  input,
  history,
  enabledTools,
  maxSteps,
  toolTimeoutSeconds,
  runTimeoutSeconds,
})
electronAPI.agent.runStream.cancel(requestId)
electronAPI.agent.runStream.onEvent(listener)
```

对应 IPC channel 为：

- `agent:runStream:start`
- `agent:runStream:cancel`
- `agent:runStream:event`

main process 根据 `workspaceId` 从已登记 workspace 中解析真实路径，并固定 `allow_write=false`。`enabledTools` 仅接受 `rag_search`、`workspace_list`、`workspace_search`、`file_read`。

活动运行按 `WebContents + requestId` 隔离；重复启动同一运行会取消旧请求，renderer 主动取消、窗口销毁和应用退出都会触发 `AbortController`。每个转发事件附带 renderer 的 `requestId` 和后端 `runId`。每个窗口最多同时运行 4 个 Agent，全局最多 32 个；输入最多 32,000 字符、历史最多 50 条且合计最多 100,000 字符，单条 NDJSON 事件最多 1,000,000 字符。

Electron main 会对事件执行最小运行时校验。未知类型、缺少 `runId` 或关键字段不合法的事件不会进入 renderer，只记录不包含事件正文的技术日志。preload 的 `onEvent` 返回只移除自身 listener 的取消订阅函数。
