# AI Agent API（Canonical Contract）

本文定义 Looma Renderer、Electron 主进程与 `rag-service` 之间的首版 Agent 契约，并记录当前已实现的只读 Tool Registry、有限步运行时、Electron 转发层及桌面端 Renderer UI。

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

## Renderer UI 与持久化

桌面端 AI 助手采用“聊天 + 右侧时间线抽屉”结构：回答区域只显示用户消息、Assistant 回答及紧凑过程摘要；步骤、工具结果、来源卡片、友好错误和可折叠技术详情在右侧抽屉中展示。该版本不实现移动端 Bottom Sheet、移动端断点或移动端专项视图。

模式栏规则：

- `RAG` 是默认模式，沿用现有索引检查和索引缺失引导。
- `Agent` 不要求 RAG 索引存在，可以使用设置中启用的四个只读工具：`rag_search`、`workspace_list`、`workspace_search`、`file_read`。
- `Chat` 仅作为禁用的“后续开放”入口展示；当前没有独立 Chat IPC，Renderer 不得用 RAG 请求冒充普通 Chat。
- 任一 RAG 或 Agent 从异步整理历史开始到运行终止期间都禁止切换模式；准备阶段点击停止不会继续启动 IPC。Agent 运行会自动打开时间线抽屉，并可通过 `cancel(requestId)` 主动取消。

每个 Agent assistant message 可持久化以下可选字段，以兼容旧 RAG 会话：

```ts
{
  runId?: string
  mode?: 'rag' | 'agent'
  modelIdentity?: { provider: string; model: string; displayName: string }
  agentSummary?: {
    status: 'running' | 'completed' | 'cancelled' | 'error'
    toolCallCount?: number
    sourceCount?: number
    error?: { message: string; technicalDetail?: string }
  }
  timeline?: AiAssistantTimelineStep[]
}
```

`modelIdentity` 在请求开始时固化，读取历史消息时不得按当前设置回填。工具调用不创建独立聊天 bubble。持久化只保留短摘要、受限来源片段、友好错误和允许的技术详情；不得保存完整 arguments、大 observation 或隐藏 `thought_summary`。来源路径只接受工作区相对 POSIX 路径；盘符、UNC、绝对路径、URI 风格路径、包含 `..` 的路径以及任意大小写 `.looma` 路径段必须丢弃，不得通过剥离 workspace 前缀把绝对路径转换为相对路径。

Agent 事件通过 renderer 维护的 `requestId → conversationId` 映射写回原会话，因此切换会话不会误路由迟到但仍有效的事件；取消成功后清理映射、结束所有活动/等待步骤并忽略迟到事件。取消失败时保留运行映射并恢复可观察的运行状态，不能静默标记为已取消。应用重启后，遗留的 `running` 消息会恢复为“已取消/运行中断”，不会继续显示为运行中。工具失败的友好摘要与受限 `technicalDetail` 分开持久化，技术详情默认折叠展示。

## 真实服务 Smoke 验收

启动 `rag-service` 后执行：

```bash
cd rag-service
python test/e2e_agent_smoke.py
```

脚本使用当前真实聊天模型和临时 workspace，验证无索引时的 `workspace_list → file_read`、精确文本的 `workspace_search → file_read`，以及越权路径被拒绝后 run 仍能给出最终解释。服务不在默认 `http://127.0.0.1:8767` 时，通过 `LOOMA_RAG_URL` 指定地址。`rag_search` 的真实索引场景要求当前 Python 环境已安装 LlamaIndex；未安装时相关单元测试会明确标记为 skipped，不能伪报为真实索引验收通过。
