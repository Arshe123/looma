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

限制：

- `max_steps`: `1..50`
- `tool_timeout_seconds`: `1..300`
- `run_timeout_seconds`: `5..1800`
- 输入最多 32,000 字符
- 历史最多 50 条、总计最多 100,000 字符
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
  "history": []
}
```

返回 `application/x-ndjson`。每行是一个完整事件。

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
electronAPI.agent.runStream.start(requestId, workspaceId, options)
electronAPI.agent.runStream.cancel(requestId)
electronAPI.agent.runStream.onEvent(listener)
electronAPI.agent.resolveApproval(approvalId, approved)
electronAPI.agent.summarizeConversation(messages, maxChars)
```

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

## 9. 发布验收

发布前至少验证：

- Python：proposal schema、路径边界、审批批准/拒绝/超时/取消、应用失败恢复。
- Electron：create/update、hash 冲突、内容篡改、路径穿越、`.looma`、ADS、设备名、symlink/junction、临时文件清理、跨窗口和重复审批。
- Renderer：diff 展示、按钮竞态、审批状态和 Agent-only 入口。
- E2E：`file_patch → approval_required → 用户批准 → Electron 应用 → approval_resolved → Agent 最终答复`。
- E2E 还需分别覆盖拒绝、取消、超时和 hash 冲突，并比较目标文件、工作空间外哨兵及 `.looma` 哨兵的前后 hash。
