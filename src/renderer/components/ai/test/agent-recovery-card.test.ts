import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('Agent 对话错误后的交互', () => {
  it('不再展示中断恢复卡片，用户可直接通过后续消息继续', () => {
    const aiAssistant = readFileSync(
      resolve(process.cwd(), 'src/renderer/components/ai/AiAssistant.vue'),
      'utf8',
    )

    expect(aiAssistant).not.toContain('AgentRecoveryCard')
    expect(aiAssistant).not.toContain('getMessageRecovery')
    expect(aiAssistant).not.toContain('continueAgentRun')
  })
})
