import { afterEach, expect, it, vi } from 'vitest'
import { ollamaService } from '../ollamaService'

vi.mock('electron', () => ({ app: {}, shell: {} }))
afterEach(() => { vi.unstubAllGlobals() })

it('reads only the selected model architecture context from Ollama show', async () => {
  const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({
    parameters: 'num_ctx 2048',
    model_info: { 'general.architecture': 'qwen2', 'qwen2.context_length': 32768, 'llama.context_length': 1048576 },
  })))
  vi.stubGlobal('fetch', request)
  await expect(ollamaService.getChatModelContext('http://127.0.0.1:11434/', 'example:tag')).resolves.toEqual({
    success: true, data: { contextWindowTokens: 32768 },
  })
  expect(request).toHaveBeenCalledWith('http://127.0.0.1:11434/api/show', expect.objectContaining({
    method: 'POST', body: JSON.stringify({ model: 'example:tag' }), redirect: 'error',
  }))
})

it('does not infer context from another architecture or the running allocation', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
    context_length: 2048,
    model_info: { 'general.architecture': 'qwen2', 'llama.context_length': 32768 },
  }))))
  await expect(ollamaService.getChatModelContext('http://localhost:11434', 'example')).resolves.toEqual({ success: true, data: null })
})
