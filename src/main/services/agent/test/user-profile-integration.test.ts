import { afterEach, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { AgentMemoryStore } from '../AgentMemoryStore'
import { aiService, type AgentStreamEvent } from '../../ai/AIService'

const roots: string[] = []
afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })))
})
it('closes the run capability even when the Agent service request fails', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'profile-stream-failure-'))
  roots.push(root)
  const realFetch = globalThis.fetch
  let bridgeUrl = ''
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    bridgeUrl = JSON.parse(init.body as string).user_profile_bridge.url
    throw new Error('service unavailable')
  }))
  const result = await aiService.streamAgent('/unused-workspace', { input: '中文', userProfileStore: new AgentMemoryStore(root) }, () => {})
  expect(result.success).toBe(false)
  expect(bridgeUrl).toMatch(/^http:\/\/127\.0\.0\.1:/)
  await expect(realFetch(bridgeUrl, { method: 'POST' })).rejects.toThrow()
})

for (const protocol of ['ollama', 'openai']) {
  it(`runs real Python ${protocol} tools through AIService into the durable main store`, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'profile-e2e-'))
    roots.push(root)
    const store = new AgentMemoryStore(root)
    const initial = await store.read('user')
    const content = '保留的长期背景。\n'.repeat(650) + '偏好英文\n过时习惯\n'
    await store.save('user', content, initial.revision)
    const memory = await store.snapshot('workspace', 'original')
    const realFetch = globalThis.fetch
    let bridgeUrl = ''
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string)
      bridgeUrl = body.user_profile_bridge.url
      expect(JSON.stringify(body)).not.toContain(root)
      const cwd = path.resolve('looma-agent-service')
      const output = await new Promise<string>((resolve, reject) => {
        const child = spawn(path.join(cwd, '.venv/bin/python'), ['-m', 'test.user_profile_bridge_driver'], { cwd, env: { ...process.env, TMPDIR: os.tmpdir() } })
        let stdout = ''; let stderr = ''
        child.stdout.on('data', chunk => { stdout += chunk })
        child.stderr.on('data', chunk => { stderr += chunk })
        child.once('error', reject)
        child.once('close', code => code === 0 ? resolve(stdout) : reject(new Error(stderr + stdout)))
        child.stdin.end(JSON.stringify({ ...body, _protocol: protocol }))
      })
      return new Response(output, { headers: { 'Content-Type': 'application/x-ndjson' } })
    }))
    const events: AgentStreamEvent[] = []
    const result = await aiService.streamAgent('/unused-workspace', { input: '我偏好中文，喜欢简洁回答；请删除过时习惯', memory, userProfileStore: store, enabledTools: ['user_profile_read', 'user_profile_update'] }, event => { events.push(event) })
    expect(result).toEqual({ success: true })
    expect(events.filter(event => event.type === 'tool_result')).toHaveLength(2)
    expect(events.at(-1)?.type).toBe('done')
    const saved = await new AgentMemoryStore(root).read('user')
    expect(saved.content).toBe(content.replace('偏好英文', '偏好中文').replace('过时习惯\n', '') + '\n喜欢简洁回答')
    expect(await store.snapshot('workspace', 'original')).toEqual(memory)
    expect((await store.snapshot('workspace', 'new')).user).toEqual(saved)
    expect(await store.read('soul')).toEqual(memory.soul)
    await expect(realFetch(bridgeUrl, { method: 'POST' })).rejects.toThrow()
  }, 60_000)
}
