# Agent 执行过程内嵌对话：前端事件与接口需求

> 状态：已应用到生产 renderer。当前后端流式事件继续使用既有 `timeline/tool_call/tool_result/approval_required/approval_resolved` 协议；renderer 将其投影成对话内展示事件。

## 1. 页面与入口

- 组件入口：`src/renderer/components/ai/AiAssistant.vue`
- 展示位置：每条 Agent assistant 消息内部，最终回答正文之前
- 文件对比入口：点击文件审查卡片后，通过 workspace store 打开一个 Diff 系统标签页
- 当前实现：`AgentConversationFlow.vue` 将事件直接插入 assistant 消息；不再通过 `AgentTimelineDrawer.vue` 作为主要入口
- 内存事件转换：`src/renderer/components/ai/agentConversationDisplay.ts`
- Diff 页面：`src/renderer/components/ai/AgentDiffPage.vue`

## 2. 展示原则

1. 不使用独立的“执行过程”面板或一整块汇总时间线；过程内容直接位于 assistant 消息内部。
2. 按实际发生顺序展示：模型随工具调用返回的展示文本 → 实际工具调用 → 可选文件审查卡片 → 最终回答。
3. DeepSeek 原生工具调用的展示文本优先级固定为：非空 `content` → 非空 `reasoning_content` → `调用工具：<tool>`；选中的文本使用与普通 AI 回答一致的 Markdown 渲染。
4. 不展示 `timeline.summary` 产生的“接下来要执行”，也不展示独立工具返回结果卡片；工具结果只更新对应调用的完成/失败状态与耗时。
5. 单个工具操作默认只渲染一行小字：工具图标 + 操作名 + 执行耗时（运行中显示“执行中”）；不使用外层卡片。点击该行后才展开状态、说明和脱敏参数。
6. Agent 运行时只展开最近一次工具调用及其展示文本，更早调用收进“较早的 N 次工具调用”；最终回答产生后，最终回答前的全部工具信息统一收进“已完成 N 次工具调用”，默认关闭，用户可点击展开。
7. 敏感字段（API Key、Token、Cookie、Authorization、密码、私钥）必须在可信边界内脱敏后再到 renderer。
8. `file_patch` 仍只代表修改提案；实际写入必须保持 Electron Main 的 workspace/path/hash 复验与逐项审批。
9. 文件审查默认只显示文件名、相对路径、增加行数、删除行数；点击后打开前后 Diff 标签页。
10. 最终回答是事件流末尾的普通 assistant 内容，不放进过程卡片或二级抽屉。
11. 如果模型没有产生 `thought_summary`，前端不补造“思考中”占位，直接展示真实工具调用。

## 3. Renderer 内存展示事件

```ts
type AgentConversationDisplayEvent = {
  id: string
  order: number
  kind: 'thought' | 'tool_call' | 'file_review'
  stepId: string
  callId?: string
  title: string
  content?: string
  tool?: string
  argumentsPreview?: string
  durationMs?: number
  status: 'active' | 'completed' | 'error' | 'pending_approval' | 'approved' | 'rejected' | 'expired' | 'cancelled'
  createdAt: number
  fileReview?: {
    approvalId: string
    path: string
    operation: 'create' | 'update'
    diff: string
    additions: number
    deletions: number
  }
}
```

这些事件保存在 `aiAssistStore.agentDisplayEventsByMessageKey`，key 为 `conversationId:assistantMessageId`。它们不会进入工作空间 AI state 的序列化数据：

- `thought_summary` 承载 Provider 已按展示优先级选出的文本，以普通 AI Markdown 内容显示，不添加标题或图标。
- 工具参数在 renderer 再次按敏感 key 脱敏并限制深度、数组长度和总字符数。
- 后端 `tool_result` 只更新对应工具调用的状态与耗时，不创建可见结果事件，也不复制 `summary/data/observation`。
- 应用重启后使用已经持久化的 compact timeline 降级展示，只显示工具调用/审批步骤，不显示 timeline 结果内容。

## 4. 流式事件映射

当前 Agent 流应继续经 Electron preload 暴露给 renderer；前端按以下规则适配：

- `timeline(running/pending)`：继续更新 compact timeline，但不生成“接下来要执行”展示事件。
- `tool_call`：先插入 Provider 按 `content → reasoning_content → 调用工具` 规则选出的 `thought_summary`，随后插入工具名和脱敏参数；`callId` 用于幂等和结果关联。
- `tool_result`：不生成可见结果卡片；仅更新工具调用的完成/失败状态和耗时，完整 `summary/data/observation` 不进入展示事件。
- `approval_required`：生成文件审查卡片，统计 unified diff 的增加/删除行，并保持 Agent 暂停。
- `approval_resolved`：更新文件卡片和工具卡片状态；批准后仍由 Electron Main 复验并写入。
- `sources`：保留本次事件返回的全部安全来源路径、每条最多 320 字符的检索片段和可选相关度；写入 `agent-sources` timeline 步骤。
- `delta/done/error/cancel`：继续走既有最终回答、友好错误和取消确认逻辑。

## 5. 工具参数

### tool_call 示例

```json
{
  "kind": "tool_call",
  "order": 2,
  "title": "调用 workspace_search",
  "tool": "workspace_search",
  "argumentsPreview": "{\n  \\"query\\": \\"timeline|AgentTimelineDrawer\\",\n  \\"path\\": \\"src/renderer\\"\n}",
  "status": "active"
}
```

`tool_result` 仍由 renderer 接收以更新调用状态和耗时，但不渲染结果正文或独立结果卡片。

## 6. 回答末尾的 RAG 检索来源

采用已批准的 B 引用标签方案。`AgentRagSources.vue` 只在 assistant 消息停止流式生成后渲染，并位于最终 `AiMarkdown` 回答正文之后。

每条标签展示：

- `[序号]`
- 来源文件名
- 可选相关度百分比

点击标签后，在标签组下方展开安全相对路径、最多 320 字符的检索片段和“在工作区打开”入口。再次点击同一标签收起；点击其他标签切换详情。绝对路径、父目录穿越、`.looma` 路径不会传给工作区文件标签。

来源数据直接读取 assistant 消息已经持久化的 `timeline[].outputs[type=source]`，不新增 HTTP/API 接口。切换对话或重启应用后仍可恢复。完整列出本次 `sources` 事件返回的全部唯一安全来源；重复路径只展示一次，工具结果类型的 output 不会混入来源列表。

## 7. 文件审查与 Diff 标签页

### 文件审查事件

```json
{
  "kind": "file_review",
  "order": 5,
  "title": "src/renderer/components/ai/AiAssistant.vue",
  "status": "pending_approval",
  "fileReview": {
    "approvalId": "approval_01",
    "path": "src/renderer/components/ai/AiAssistant.vue",
    "operation": "update",
    "additions": 48,
    "deletions": 17,
    "diff": "@@ ..."
  }
}
```

### Diff 标签页内存 payload

```ts
type AgentDiffViewState = {
  conversationId: string
  approvalId: string
  path: string
  operation: 'create' | 'update'
  diff: string
  additions: number
  deletions: number
}
```

`agent-diff` 是运行时系统标签页：payload 保存在 workspace store 的 `activeAgentDiff`，`workspace-meta-utils.ts` 明确过滤该标签页，Diff 内容不会写入 workspace meta。页面只解析已由 Agent 主进程审批链路返回的 unified diff；它不能读取任意路径，也不能直接写文件。批准或拒绝仍调用 `resolveAgentApproval`，最终由 Electron Main 重新校验 workspace、相对路径和 before hash。

## 8. 本地持久化

工具调用通过既有 workspace AI compact timeline 写入 `.looma/ai-assistant/state.json`：

- 保留：工具名、步骤状态、开始/结束时间、执行耗时，以及脱敏后的调用参数。
- 调用参数在 renderer 中先按敏感 key 脱敏、限制深度/数组/字段/字符串长度，再限制为最多 4,000 字符的有效 JSON。
- Electron Main 写盘前再次解析 JSON、再次按敏感 key 脱敏，并执行独立的 4,000 字符上限；畸形参数内容降级为 `{}`。
- 工具调用到达时立即触发 timeline 持久化；工具完成或失败后再次保存结束状态和耗时。
- 不保留：`thought_summary`、原始工具参数、完整工具 observation/data、完整大文件内容、密钥、Authorization、Diff 运行时标签 payload。
- 重启或切换对话后，单行操作从 compact timeline 恢复；点击后读取持久化的脱敏参数。

## 9. 验收点

- Agent 运行时，步骤在对应 assistant 消息中按顺序实时出现。
- 对话切换后，事件按 `requestId -> conversationId` 写回正确消息。
- 折叠/展开不会阻断流式更新或导致自动滚动跳动。
- DeepSeek 工具调用有非空 `content` 时显示 `content`；否则显示非空 `reasoning_content`；两者都为空才显示“调用工具：xxx”。
- `timeline.summary` 不生成“接下来要执行”内容。
- 工具操作默认是“图标 + 操作名 + 耗时”的单行小字，不显示外层卡片；点击后展示脱敏参数与状态。
- 运行中只直显最近一次工具调用，更早调用默认折叠；最终回答出现后全部工具信息默认折叠且可手动展开。
- 切换对话或重启应用后，工具操作、状态、耗时和最多 4,000 字符的脱敏参数仍可恢复。
- 工具返回正文、结果摘要和独立结果卡片均不可见。
- RAG 来源只在最终回答正文之后显示为引用标签；点击后展开路径和片段，安全路径可在工作区打开。
- 切换对话或重启应用后，来源标签仍能从持久化 timeline 恢复。
- 文件卡片只展示路径与 `+N/-N`，点击打开工作区 Diff 标签页。
- Diff 标签页不能绕过 `file_patch` 审批，也不能接受任意绝对路径。
- 最终回答始终独立、直接可读。
- 取消、失败、重试、审批等待状态均可恢复且不重复插入事件。
