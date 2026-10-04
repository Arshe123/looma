import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { AgentMemoryConflictError, AgentMemoryError, AgentMemoryStore } from './AgentMemoryStore'
import { MAX_MEMORY_CHARS } from '../../../shared/types/agent-memory'

/** Run-local capability, never a workspace path or model-visible tool argument. */
export async function openUserProfileBridge(store: AgentMemoryStore, runId: string, signal?: AbortSignal, enabledTools: readonly string[] = ['user_profile_read', 'user_profile_update']) {
  const token = randomBytes(32).toString('hex')
  let closed = false
  let readRevision: string | undefined
  let queue: Promise<unknown> = Promise.resolve()
  const server = createServer((request, response) => {
    const reply = (status: number, body: unknown) => {
      response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      response.end(JSON.stringify(body))
    }
    if (closed || signal?.aborted || request.method !== 'POST' || request.url !== '/user-profile'
      || request.headers.origin || request.headers.authorization !== `Bearer ${token}`) {
      reply(403, { success: false, code: 'user_profile_denied', error: '用户画像访问未获授权。' }); return
    }
    const operation = async () => {
      let body: Record<string, unknown>
      try {
        const chunks: Buffer[] = []
        let size = 0
        for await (const chunk of request) {
          size += chunk.length
          if (size > 120_000) throw new AgentMemoryError('用户画像请求过长。')
          chunks.push(chunk)
        }
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AgentMemoryError('用户画像请求无效。')
      } catch { reply(400, { success: false, code: 'user_profile_invalid', error: '用户画像请求无效或过长。' }); return }
      if (closed || signal?.aborted || body.runId !== runId || typeof body.tool !== 'string' || !enabledTools.includes(body.tool)) {
        reply(403, { success: false, code: 'user_profile_denied', error: '用户画像运行授权已失效。' }); return
      }
      try {
        const args = body.arguments
        if (Object.keys(body).some(key => !['runId', 'tool', 'arguments'].includes(key))
          || !args || typeof args !== 'object' || Array.isArray(args)) {
          reply(400, { success: false, code: 'user_profile_invalid', error: '用户画像参数无效。' }); return
        }
        const input = args as Record<string, unknown>
        if (body.tool === 'user_profile_read' && Object.keys(input).length === 0) {
          const data = await store.read('user')
          readRevision = data.revision
          reply(200, { success: true, data }); return
        }
        if (body.tool !== 'user_profile_update' || Object.keys(input).length !== 2
          || typeof input.content !== 'string' || input.content.length > MAX_MEMORY_CHARS || input.content.includes('\0')
          || typeof input.expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(input.expectedRevision)) {
          reply(400, { success: false, code: 'user_profile_invalid', error: '用户画像参数无效，只允许更新 user.md。' }); return
        }
        if (readRevision !== input.expectedRevision) {
          reply(409, { success: false, code: 'user_profile_read_required', error: '请先读取最新用户画像，再保留无关内容进行更新。' }); return
        }
        readRevision = undefined
        const current = await store.read('user')
        // Cancellation may arrive while the preflight disk read is pending.
        // Do not begin a new save after the run capability has been revoked.
        if (closed || signal?.aborted) {
          reply(403, { success: false, code: 'user_profile_denied', error: '用户画像运行授权已失效。' }); return
        }
        if (current.revision !== input.expectedRevision) {
          reply(409, { success: false, code: 'user_profile_conflict', error: '用户画像已更新，请重新读取并合并后重试。' }); return
        }
        const data = await store.save('user', input.content, input.expectedRevision)
        reply(200, { success: true, data })
      } catch (error) {
        reply(400, { success: false, code: error instanceof AgentMemoryConflictError ? 'user_profile_conflict' : 'user_profile_storage_failed',
          error: error instanceof AgentMemoryConflictError ? error.message : '用户画像读写失败，无法确认保存；请重新读取后重试。' })
      }
    }
    queue = queue.then(operation, operation).catch(() => { response.destroy() })
  })
  server.requestTimeout = 15_000
  server.headersTimeout = 10_000
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('User profile bridge unavailable')
  const close = async () => {
    closed = true
    signal?.removeEventListener('abort', abort)
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await queue
  }
  const abort = () => { closed = true; server.closeAllConnections(); server.close() }
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) abort()
  return { config: { url: `http://127.0.0.1:${address.port}/user-profile`, token }, close }
}
