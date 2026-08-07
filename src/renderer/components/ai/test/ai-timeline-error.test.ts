import { describe, expect, it } from 'vitest'
import { formatAiRuntimeError } from '../aiTimeline'

describe('formatAiRuntimeError', () => {
  it('fallback 文案用于未知错误', () => {
    expect(formatAiRuntimeError('some unknown error', '建立索引失败。')).toEqual({
      message: 'some unknown error',
      technicalDetail: 'some unknown error',
    })
  })

  it('把 terminated 断流错误映射为 Ollama 未运行的友好提示', () => {
    const result = formatAiRuntimeError('fetch failed: terminated', '建立索引失败。')

    expect(result.message).toContain('向量模型服务')
    expect(result.message).toContain('Ollama')
    expect(result.technicalDetail).toBe('fetch failed: terminated')
  })

  it('把 502 bad gateway 映射为向量模型服务不可用提示', () => {
    const result = formatAiRuntimeError('RAG 服务连接失败: Server error 502 Bad Gateway', '建立索引失败。')

    expect(result.message).toContain('向量模型服务')
    expect(result.message).toContain('Ollama')
  })

  it('把 connection refused 映射为本地服务未启动提示', () => {
    const result = formatAiRuntimeError('connect ECONNREFUSED 127.0.0.1:11434', '建立索引失败。')

    expect(result.message).toContain('无法连接本地 AI 服务')
    expect(result.message).toContain('Ollama')
  })

  it('把 CUDA 显存不足错误映射为显存提示', () => {
    const result = formatAiRuntimeError('CUDA out of memory. Tried to allocate 512 MiB', '建立索引失败。')

    expect(result.message).toContain('显存不足')
  })

  it('保留中文错误信息原样返回', () => {
    const result = formatAiRuntimeError('本地模型服务暂时无法响应。请确认 Ollama 已安装并正在运行。', '建立索引失败。')

    expect(result.message).toBe('本地模型服务暂时无法响应。请确认 Ollama 已安装并正在运行。')
  })

  it('处理非字符串非 Error 输入', () => {
    const result = formatAiRuntimeError(null, '建立索引失败。')

    expect(result.message).toBe('建立索引失败。')
  })
})
