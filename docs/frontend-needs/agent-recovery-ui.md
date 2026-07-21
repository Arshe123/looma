# Agent 恢复 UI：前端接口需求（预览阶段）

> 状态：静态预览对应的前端需求；生产接口以实现和 E2E 验证结果为准。

## 1. 获取运行恢复状态

建议调用：`window.electronAPI.agent.getRun(workspaceId, runId)`

返回字段：

```ts
{
  task: AgentTask | null
  run: AgentRun
  events: AgentEvent[]
  sources: AgentSource[]
  auditIssues: Array<{
    code: string
    runId?: string
    callId?: string
    detail: string
  }>
}
```

前端只从 `events + sources` 投影状态、timeline、usage、approval 和恢复信息，不读取旧 timeline 作为事实源。

## 2. 创建后续运行

建议 IPC/API：`agent:runStream:resume`

请求：

```ts
{
  workspaceId: string
  taskId: string
  parentRunId: string
  recoveryReason: 'interrupted' | 'approval_resolved' | 'retry' | 'manual'
}
```

返回：

```ts
{
  taskId: string
  runId: string
  parentRunId: string
}
```

约束：

- 必须创建新的有限 `AgentRun`。
- 旧 run 保持只读。
- Main 必须验证 checkpoint、ledger audit 和 workspace 归属。
- checkpoint 无效时允许用事件和标准 Message 重建上下文，但要明确降低恢复效率。

## 3. 结束任务

建议 IPC/API：`agent:task:close`

```ts
{ workspaceId: string; taskId: string; reason?: string }
```

## 4. 展示状态映射

- 有可用 checkpoint 且 audit 通过：显示“继续任务”。
- checkpoint 缺失但事件完整：显示“从已确认事实继续”。
- 有待审批 artifact：先进入审批，不允许直接继续。
- 有 hash 冲突：禁止应用，展示冲突说明。
- audit 失败或旧数据无法恢复：只允许“重新发起任务”或“结束任务”。
