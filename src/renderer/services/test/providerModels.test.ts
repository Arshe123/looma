import { afterEach, describe, expect, it, vi } from 'vitest'
import { listProviderModels } from '../providerModels'

afterEach(() => { vi.unstubAllGlobals() })

const config = { protocol: 'openai-compatible' as const, baseUrl: 'https://api.deepseek.com', apiKey: 'test-key' }

describe('listProviderModels', () => {
  it.each([401, 403, 429, 500])('HTTP %s 返回中文错误，不泄露响应或密钥', async (status) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('secret upstream response', { status })))
    await expect(listProviderModels(config)).rejects.toThrow(/模型列表|密钥|权限|频繁/)
  })

  it.each([{}, { data: null }, { data: [{}] }, { data: [{ id: ' ' }] }, { data: [{ id: 3 }] }])('拒绝损坏的模型列表 %j', async (body) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(body))))
    await expect(listProviderModels(config)).rejects.toThrow('模型列表响应格式不正确')
  })

  it('空列表是成功响应，未知元数据不会被猜测为模型能力', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"data":[]}')))
    await expect(listProviderModels(config)).resolves.toEqual([])
  })

  it.each(['file:///etc', 'https://user:password@example.com', 'https://api.deepseek.com?x=1', 'https://api.deepseek.com/#x'])('请求前拒绝非法地址 %s', async (baseUrl) => {
    const request = vi.fn()
    vi.stubGlobal('fetch', request)
    await expect(listProviderModels({ ...config, baseUrl })).rejects.toThrow('服务地址')
    expect(request).not.toHaveBeenCalled()
  })

  it('缺少密钥时不发请求', async () => {
    const request = vi.fn()
    vi.stubGlobal('fetch', request)
    await expect(listProviderModels({ ...config, apiKey: ' ' })).rejects.toThrow('API 密钥')
    expect(request).not.toHaveBeenCalled()
  })

  it('网络错误使用中文，不回显可能含密钥的异常', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('test-key secret')))
    await expect(listProviderModels(config)).rejects.toThrow('无法获取模型列表，请检查网络、服务地址或跨域访问设置')
  })

  it('支持超时与外部取消', async () => {
    vi.stubGlobal('fetch', vi.fn((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    })))
    await expect(listProviderModels({ ...config, timeoutMs: 5 })).rejects.toThrow('获取模型列表超时')
    const controller = new AbortController()
    const pending = listProviderModels({ ...config, signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toThrow('已取消获取模型列表')
  })

  it('已取消的请求不再访问网络', async () => {
    const request = vi.fn()
    vi.stubGlobal('fetch', request)
    const controller = new AbortController()
    controller.abort()
    await expect(listProviderModels({ ...config, signal: controller.signal })).rejects.toThrow('已取消')
    expect(request).not.toHaveBeenCalled()
  })

  it('通过兼容接口读取官方模型 ID，保留原值并去重', async () => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [{ id: 'new-model', name: '新模型' }, { id: 'other-model' }, { id: 'new-model' }],
    })))
    vi.stubGlobal('fetch', request)
    await expect(listProviderModels({
      protocol: 'openai-compatible', baseUrl: 'https://api.deepseek.com/v1/', apiKey: 'test-key',
    })).resolves.toEqual([{ id: 'new-model', name: '新模型' }, { id: 'other-model', name: 'other-model' }])
    expect(request).toHaveBeenCalledWith('https://api.deepseek.com/v1/models', expect.objectContaining({
      method: 'GET', headers: { Authorization: 'Bearer test-key', Accept: 'application/json' },
      credentials: 'omit', redirect: 'error', signal: expect.any(AbortSignal),
    }))
  })
})
