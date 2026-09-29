import { effectScope, nextTick, ref } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useProviderModels } from '../useProviderModels'
import type { ListProviderModelsOptions } from '../../services/providerModels'

const scopes: ReturnType<typeof effectScope>[] = []
afterEach(() => { scopes.splice(0).forEach(scope => scope.stop()); vi.unstubAllGlobals() })
const settle = async () => { await new Promise(resolve => setTimeout(resolve, 0)); await nextTick() }
const setup = () => {
  const config = ref<ListProviderModelsOptions | null>({ protocol: 'openai-compatible', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'test-key' })
  const scope = effectScope()
  scopes.push(scope)
  const state = scope.run(() => useProviderModels(() => config.value))!
  return { config, state, scope }
}

describe('客户端模型发现状态', () => {
  it('配置对象被替换但连接信息不变时不重复请求', async () => {
    const request = vi.fn().mockImplementation(() => Promise.resolve(new Response('{"data":[]}')))
    vi.stubGlobal('fetch', request)
    const { config } = setup()
    await settle()
    config.value = { ...config.value! }
    await settle()
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('配置可用时自动获取，刷新失败保留上次列表，配置清空则重置', async () => {
    const request = vi.fn().mockResolvedValueOnce(new Response('{"data":[{"id":"new-model"}]}'))
      .mockRejectedValueOnce(new Error('offline'))
    vi.stubGlobal('fetch', request)
    const { config, state } = setup()
    await settle()
    expect(state.models.value.map(model => model.id)).toEqual(['new-model'])
    expect(state.loaded.value).toBe(true)
    await state.refresh()
    expect(state.models.value.map(model => model.id)).toEqual(['new-model'])
    expect(state.error.value).toContain('无法获取')
    config.value = null
    await nextTick()
    expect(state.models.value).toEqual([])
    expect(state.error.value).toBe('')
    expect(state.loaded.value).toBe(false)
  })

  it('切换配置或卸载后，迟到的响应不能覆盖新状态', async () => {
    let resolveOld!: (value: Response) => void
    const request = vi.fn().mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve }))
      .mockResolvedValueOnce(new Response('{"data":[{"id":"new"}]}'))
    vi.stubGlobal('fetch', request)
    const { config, state, scope } = setup()
    const oldSignal = request.mock.calls[0]![1].signal as AbortSignal
    config.value = { ...config.value!, apiKey: 'new-key' }
    await settle()
    expect(oldSignal.aborted).toBe(true)
    expect(state.models.value[0]?.id).toBe('new')
    resolveOld(new Response('{"data":[{"id":"old"}]}'))
    await settle()
    expect(state.models.value[0]?.id).toBe('new')
    scope.stop()
  })
})
