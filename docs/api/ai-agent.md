# Looma Agent API（第二阶段 Canonical Contract）

本文定义 Looma Renderer、Electron Main 与 `rag-service` 的唯一 AI 对话链路。产品不再公开普通 Chat 或独立 RAG 问答；RAG 索引管理继续保留，`rag_search` 作为 Agent 内部工具使用。

## 1. 架构与可信边界

```text
Renderer
  └─ agent:runStream:start
       └─ Electron Main
            └─ POST /agent/run/stream
                 └─ Python Agent Runtime
                      ├─ 只读工具
                      └─ file_patch：只生成 proposal

file_patch proposal
  └─ approval_required
       └─ Renderer 展示 diff，用户批准/拒绝
            └─ agent:approval:resolve(approvalId, approved)
                 └─ Electron Main 从可信内存读取原 proposal
                      ├─ 拒绝：不触碰磁盘
                      └─ 批准：复验路径/hash → 原子应用
                           └─ POST /agent/approvals/resolve
                                └─ Runtime 恢复
```

安全不变量：

1. Python 和 Renderer 都没有任意文件写入 API。
2. `file_patch` 只能生成文本文件 `create/update` 提案。
3. Renderer 审批时只能提交 `approvalId + approved`，不能提交路径、内容或 hash。
4. Electron Main 是唯一可信落盘边界，并保存从 Python 流收到的原始 proposal。
5. `approved=true` 只表示用户同意；只有 Electron 成功应用后才向 Python 回传 `applied=true`。
6. 每个审批绑定发起 `WebContents`、当前 Agent run、workspace 和截止时间；跨窗口、重复、过期审批均拒绝。

### 1.1 Agent 事实模型

- `AgentTask -> AgentRun[]`：长期任务可以包含多个有限 run；重试或恢复始终创建新 run。
- `AgentEvent` 是执行事实的唯一权威来源，分为 `ExecutionEvent`、`ArtifactEvent`、`RecoveryEvent`。
- `AgentState`、timeline、usage、sources 和恢复卡均由持久化事件 fold/project 得到。
- `EventSnapshot` 只加速 replay；`RuntimeCheckpoint` 只优化 continuation。删除任一缓存不能改变执行事实。
- `AgentMessage` 只保存标准模型上下文。工具调用必须保持 provider-native `tool_call_id` 配对。
- workspace assistant message 只保存兼容展示数据和 `taskId/runId` 引用；历史打开时从 Main ledger 重新 hydration。

### 1.2 continuation 可信边界

```text
Renderer 恢复卡
  └─ agent:runStream:resume(requestId, workspaceId, parentRunId)
       └─ Electron Main 读取并校验 ledger
            ├─ 拒绝仍在运行、已完成、待审批或已存在后续 run 的请求
            ├─ 去掉中断事务留下的悬空 assistant tool_call
            ├─ 在同一 AgentTask 下创建新的 AgentRun
            └─ POST /agent/run/stream
                 task_id + run_id + parent_run_id + recovery_reason
```

Renderer 不能指定新的 `taskId/runId`、工具集合、执行预算或恢复上下文。Main 从 ledger 生成这些字段，旧 run 保持只读。

## 2. Agent 配置

Agent 能力由产品固定配置，不在用户设置中暴露工具开关或步骤上限。Renderer 启动运行时不传 `enabledTools`/`maxSteps`，Electron 使用以下内置默认配置：

```json
{
  "enabled_tools": [
    "rag_search",
    "workspace_list",
    "workspace_search",
    "file_read",
    "file_patch"
  ],
  "max_steps": 8,
  "tool_timeout_seconds": 30,
  "run_timeout_seconds": 300,
  "allow_write": true
}
```

全部现有工具始终可供 Agent 选择。`allow_write=true` 只允许模型提出 `file_patch`，不允许跳过审批直接写盘；文件修改仍须逐次由用户批准。

### 2.1 DeepSeek 原生工具决策

当 `chat.provider=deepseek` 时，Python 工厂使用独立的 `DeepSeekChatProvider`。Agent 决策沿用 DeepSeek/OpenAI-compatible Chat Completions，但不再使用 JSON Output，不发送：

```json
{"response_format":{"type":"json_object"}}
```

当本轮有工具时，provider 将运行时 schema 转换为 OpenAI 原生 `tools[].function`，模型通过 `message.tool_calls` 返回调用；`function.arguments` 按 OpenAI 协议是 JSON 字符串。无需工具时，模型直接在 `message.content` 返回普通最终文本，不再包装为 Looma 自定义 `{"type":"final"...}` JSON。一轮最多接受 16 个结构化工具调用：`read`/`network` 工具由 `asyncio.gather` 并发调度，内置同步文件操作已通过 `asyncio.to_thread` 卸载到线程池；`write`/`terminal` 和文件审批保持串行，避免共享状态及副作用竞态。并发完成顺序不影响历史顺序，所有结果仍按模型原始 `tool_calls` 顺序回灌。

`deepseek-v4-*`、V4 以上 V-series 和 `deepseek-reasoner` 会发送：

```json
{"thinking":{"type":"enabled"}}
```

`deepseek-chat`、`deepseek-v3-*` 和未知别名不猜测 thinking 能力，不发送该参数。DeepSeek 返回的私有 `reasoning_content` 只在当前 Python run 的 provider 上下文中保留，并随下一条 `assistant.tool_calls` 回传；若 thinking 工具调用缺少该字段，使用单个空格作为兼容 pad。它不进入 Renderer 事件、timeline、日志、错误详情或 Electron ledger。

错误工具调用采用有界恢复：空 arguments 规范为 `{}`；常见尾随逗号、缺失闭合符和未转义控制字符可保守修复；工具名只允许在本轮动态 allowlist 中做大小写、snake_case、分隔符和精确 `Tool` 后缀修复，禁止模糊匹配到任何可执行工具。修复后仍必须经过 ToolRegistry 参数模型与权限校验。批次中的未知工具或非法参数只生成该 `tool_call_id` 对应的错误结果，不执行该项，也不会取消同批其他有效调用；超过 16 个调用或文本/XML/DSML 伪工具调用仍会进入一次有界模型纠错。工具执行结果始终保持原生配对：一条 `assistant` 可声明多个 `tool_calls`，随后每个调用各有一条 `role=tool` 且 `tool_call_id` 相同的结果，绝不把工具结果伪装成 `user`。

限制：

- `max_steps`: `1..100`，默认 `90`；每个工具调用计 1 步，同一轮并发批次中的每个调用分别计数
- `tool_timeout_seconds`: `1..300`
- `run_timeout_seconds`: `5..1800`
- 输入最多 32,000 字符
- 历史最多 200 条、序列化后总计最多 300,000 字符（包含工具调用参数和工具结果摘要）
- 单条 NDJSON 事件最多 1,000,000 字符
- patch 目标和提议内容最多 200,000 UTF-8 字节

## 3. HTTP API

### 3.1 `POST /agent/run/stream`

请求：

```json
{
  "input": "把 docs/release.md 中的版本号改为 2.0",
  "workspace": { "workspace_path": "D:/work/demo" },
  "agent": {
    "enabled_tools": ["rag_search", "workspace_list", "workspace_search", "file_read", "file_patch"],
    "max_steps": 8,
    "tool_timeout_seconds": 30,
    "run_timeout_seconds": 300,
    "allow_write": true
  },
  "history": [
    { "role": "user", "content": "配置文件在哪里？" },
    {
      "role": "assistant",
      "content": "此前调用了工具 file_read。",
      "tool_calls": [{
        "id": "history_7_1",
        "type": "function",
        "function": {
          "name": "file_read",
          "arguments": { "path": "docs/config.md" }
        }
      }]
    },
    {
      "role": "tool",
      "name": "file_read",
      "tool_call_id": "history_7_1",
      "content": "已读取 docs/config.md，共 24 行。"
    },
    { "role": "assistant", "content": "配置文件位于 docs/config.md。" }
  ]
}
```

历史 Agent 消息会按模型供应商原生协议携带完整的 `assistant.tool_calls` / `tool` 配对：包括已脱敏并持久化的调用参数、工具名称和结果摘要。中断运行留下的不完整调用不会发送，避免形成供应商不接受的悬空 tool call。远对话压缩时，这些信息会先转成可总结的文本，确保摘要仍保留工具使用事实。

这些历史记录只是模型的上下文证据，不是执行指令。Agent 是否再次调用工具，仍由当前问题、系统提示、工具 schema 和模型决策共同决定。运行时会阻止同一 run、同一工作区版本内已经成功完成或发生不可重试失败的相同工具与参数再次执行，并将该结果反馈给模型继续决策；可重试失败允许再次执行，成功写入后此前读取调用的防重记录会失效。

返回 `application/x-ndjson`。每行是一个完整事件。

#### continuation 请求

Python 同时接受 `/agent/runs/resume`；当前 Electron Main 通过相同的 `/agent/run/stream` NDJSON 执行器传入 continuation 字段：

```json
{
  "input": "请基于上次运行中已确认的事实继续完成任务；不要重复已经成功完成的操作。",
  "task_id": "task_...",
  "run_id": "run_new_...",
  "parent_run_id": "run_old_...",
  "recovery_reason": "manual_retry",
  "history": []
}
```

`run_id` 必须是新 ID，不能等于 `parent_run_id`。Runtime 首先发送 `continuation_created`，之后所有事件都属于新 run。

### 3.2 `POST /agent/approvals/resolve`

仅由 Electron Main 调用。Renderer 不直接访问该接口。

批准且已成功应用：

```json
{
  "approval_id": "approval_01...",
  "status": "approved",
  "reason": null,
  "applied": true,
  "apply_error": null
}
```

用户拒绝：

```json
{
  "approval_id": "approval_01...",
  "status": "rejected",
  "reason": "用户拒绝了文件修改",
  "applied": false,
  "apply_error": null
}
```

用户批准但 Electron 应用失败：

```json
{
  "approval_id": "approval_01...",
  "status": "approved",
  "reason": null,
  "applied": false,
  "apply_error": "文件已在审批期间发生变化，请重新生成修改提案"
}
```

状态只能为 `approved` 或 `rejected`。未知、重复或已过期的 `approval_id` 返回失败。

### 3.3 `POST /agent/summarize`

Agent 历史压缩专用端点，不是普通 Chat 入口。

```json
{
  "messages": [
    { "role": "user", "content": "..." },
    { "role": "assistant", "content": "..." }
  ],
  "max_chars": 1600
}
```

### 3.4 已删除的对话路由

以下路由不再注册：

- `POST /chat`
- `POST /chat/stream`
- `POST /rag/query`
- `POST /rag/query/stream`

`/rag/index...` 索引构建、状态、文件分块、重建和删除接口继续保留。

## 4. `file_patch` 工具

### 4.1 create 参数

```json
{
  "path": "docs/release.md",
  "operation": "create",
  "content": "# Release\n\nVersion 2.0\n"
}
```

### 4.2 update 参数

```json
{
  "path": "docs/release.md",
  "operation": "update",
  "old_text": "Version 1.0",
  "new_text": "Version 2.0"
}
```

`old_text` 必须在当前文件中唯一匹配。工具不会应用修改，而是返回：

```json
{
  "requiresApproval": true,
  "path": "docs/release.md",
  "operation": "update",
  "unified_diff": "--- a/docs/release.md\n+++ b/docs/release.md\n...",
  "expected_sha256": "64位小写十六进制摘要",
  "proposed_sha256": "64位小写十六进制摘要",
  "proposed_content": "完整的提议 UTF-8 内容"
}
```

`create` 的 `expected_sha256` 为 `null`。`proposed_content` 只保存在 Electron Main 的可信内存，不转发给 Renderer；Renderer 只接收 diff 和展示字段。

## 5. NDJSON 事件

所有事件都包含非空 `runId`。主要事件：

- `run_started`
- `timeline`
- `tool_call`
- `tool_result`
- `approval_required`
- `approval_resolved`
- `sources`
- `delta`
- `done`
- `error`

### 5.1 `approval_required`

```json
{
  "type": "approval_required",
  "runId": "run_01...",
  "step": 2,
  "stepId": "step_02...",
  "callId": "call_02...",
  "approvalId": "approval_01...",
  "tool": "file_patch",
  "proposal": {
    "path": "docs/release.md",
    "operation": "update",
    "unified_diff": "--- a/docs/release.md\n+++ b/docs/release.md\n...",
    "expected_sha256": "...",
    "proposed_sha256": "...",
    "proposed_content": "..."
  },
  "requestedAt": "2026-07-15T07:00:00Z",
  "deadlineAt": "2026-07-15T07:05:00Z"
}
```

Electron 缓存完整事件后，向 Renderer 发送的版本会清空 `proposal.proposed_content`。

### 5.2 `approval_resolved`

```json
{
  "type": "approval_resolved",
  "runId": "run_01...",
  "step": 2,
  "stepId": "step_02...",
  "callId": "call_02...",
  "approvalId": "approval_01...",
  "resolution": {
    "status": "approved",
    "reason": null,
    "applied": true,
    "apply_error": null
  }
}
```

`status` 可能为 `approved`、`rejected`、`expired` 或 `cancelled`。

### 5.3 写入失败 observation

用户批准但磁盘应用失败时，Runtime 向模型返回失败的 `file_patch` result，错误码为 `patch_apply_failed`。模型必须说明冲突或失败，不能声称文件已经写入。

## 6. Electron IPC / Preload

Renderer 可用的最小 API：

```ts
electronAPI.agent.getRun(workspaceId, runId)
electronAPI.agent.resumeRun(requestId, workspaceId, parentRunId)
electronAPI.agent.runStream.start(requestId, workspaceId, options)
electronAPI.agent.runStream.cancel(requestId)
electronAPI.agent.runStream.onEvent(listener)
electronAPI.agent.resolveApproval(approvalId, approved)
electronAPI.agent.summarizeConversation(messages, maxChars)
```

`getRun` 返回 `{ task, run, events, sources, auditIssues, recovery }`。其中：

```ts
recovery: {
  recoverable: boolean
  checkpointAvailable: boolean
  reason: string
}
```

`resumeRun` 只接受 parent run 引用；Main 生成新的 task 关联、run ID、模型上下文和执行策略。成功返回 `{ taskId, runId, parentRunId }`。

审批 IPC：

- `agent:approval:resolve`
- 参数：`approvalId: string`, `approved: boolean`
- Main 按 `event.sender` 查找审批，Renderer 不能批准其他窗口或已结束运行的 proposal。
- 进入 `resolving` 后拒绝重复点击和重放。
- 到达 `deadlineAt` 后不允许先写盘再依赖 Python 拒绝。

旧的 `rag:chat`、`rag:askStream:*` 和 `rag:summarizeConversation` IPC 已删除。RAG IPC 只保留索引管理。

## 7. Electron 文件应用规则

应用前 Main 必须重新执行：

1. 从已登记 workspace 解析根目录并 `realpath`。
2. 拒绝绝对路径、UNC、盘符路径、`..`、空路径段和 `.looma`。
3. Windows 拒绝 ADS `:`、尾随点/空格和设备名 `CON/PRN/AUX/NUL/COM1..9/LPT1..9`。
4. 检查路径链中的 symlink、junction/reparse point 和特殊文件。
5. 验证 UTF-8、NUL 字节、大小及 `proposed_sha256`。
6. `update` 重新计算当前文件 SHA-256，并与 `expected_sha256` 比较。
7. `create` 必须保证目标仍不存在；通过同目录临时文件和无覆盖原子提交防止并发覆盖。
8. 临时文件写入后 `fsync`，更新通过同目录 rename 提交。
9. 写入后再次读取并验证结果 SHA-256；失败时删除临时文件并返回 `applied=false`。

已知系统边界：能够向 Electron Main 注入代码或具有当前用户同等权限并持续竞争文件系统的恶意本地进程，不属于应用层完全可防御范围。更新操作已在提交前再次复验 hash，但 Node 路径 API 不提供原生 compare-and-swap rename。

## 8. Renderer UI

产品只显示 Agent 对话。RAG 仅出现在：

- “索引库”管理界面；
- Agent 时间线中的 `rag_search` 工具步骤。

审批采用时间线抽屉内卡片：

- 显示相对路径、操作类型和 unified diff；
- 明确提示“未批准不会写入”；
- 提交期间禁用重复操作；
- 展示拒绝、超时、hash 冲突和应用失败；
- 小屏使用全宽抽屉。

历史旧消息可以继续只读展示，但不能通过旧 RAG/Chat 链路重新发送或重新生成。

中断或取消的 Agent run 使用消息内恢复卡：

- 卡片紧邻原 assistant 执行流，不写入 assistant Markdown。
- “继续任务”只在 Main 返回 `recovery.recoverable=true` 时可用。
- 展开详情显示 checkpoint 是否通过事件前缀校验；无 checkpoint 时明确说明使用已提交事件和标准消息。
- 点击后创建新的 continuation run；旧卡片显示“已创建后续运行”，旧 run 不可修改。
- 待审批、已完成、已存在后续 run 或达到 `maxRuns` 时禁止恢复。
- 手机端卡片保持单列和可点击区域，不使用独立侧栏。

## 9. 发布验收

发布前至少验证：

- Python：proposal schema、路径边界、审批批准/拒绝/超时/取消、应用失败恢复。
- Electron：create/update、hash 冲突、内容篡改、路径穿越、`.looma`、ADS、设备名、symlink/junction、临时文件清理、跨窗口和重复审批。
- Renderer：diff 展示、按钮竞态、审批状态和 Agent-only 入口。
- E2E：`file_patch → approval_required → 用户批准 → Electron 应用 → approval_resolved → Agent 最终答复`。
- E2E 还需分别覆盖拒绝、取消、超时和 hash 冲突，并比较目标文件、工作空间外哨兵及 `.looma` 哨兵的前后 hash。
