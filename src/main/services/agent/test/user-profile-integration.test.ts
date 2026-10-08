import { afterEach, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { AgentMemoryStore } from '../AgentMemoryStore'
import { aiService, type AgentStreamEvent } from '../../ai/AIService'

const roots: string[] = []
it('opens independent server-bound workspace and profile capabilities with live switches', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'three-memory-tools-')); roots.push(root)
  const user = new AgentMemoryStore(root), workspace = AgentMemoryStore.workspace(root, 'w')
  await workspace.readMaintenance()
  const realFetch = globalThis.fetch
  const events: AgentStreamEvent[] = []
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string)
    expect(body.agent.enabled_tools).toContain('workspace_memory_update')
    expect(body.agent.enabled_tools).not.toContain('user_profile_update')
    const bridge = body.workspace_memory_bridge
    const call = async (tool: string, args = {}) => (await realFetch(bridge.url, { method: 'POST', headers: { Authorization: `Bearer ${bridge.token}` }, body: JSON.stringify({ runId: body.run_id, tool, arguments: args }) })).json()
    const read = await call('workspace_memory_read')
    expect(read.success).toBe(true)
    expect((await call('workspace_memory_update', { content: 'project', expectedRevision: read.data.revision })).success).toBe(true)
    await workspace.setMaintenance(false)
    const next = await call('workspace_memory_read')
    expect((await call('workspace_memory_update', { content: 'no', expectedRevision: next.data.revision })).success).toBe(false)
    return new Response('')
  }))
  expect(await aiService.streamAgent('/unused', { input: 'hi', userProfileStore: user, workspaceMemoryStore: workspace, canUpdateWorkspaceMemory: workspace.canAutoMaintain }, event => { events.push(event) })).toEqual({ success: true })
  expect(events).toMatchObject([{ type: 'memory_updated', change: { kind: 'workspace', workspaceId: 'w' } }])
  expect((await user.read('user')).content).toBe('')
})
it('filters update schemas using live main authorization on start and continuation, never snapshot flags', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'profile-tools-policy-'))
  roots.push(root)
  const store = new AgentMemoryStore(root)
  const memory = await store.snapshot('w', 'c')
  const realFetch = globalThis.fetch
  let enabled = false
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string)
    expect(body.memory).toEqual(memory)
    expect(body.agent.enabled_tools.includes('user_profile_update')).toBe(enabled)
    expect(body.agent.enabled_tools).toContain('user_profile_read')
    const bridge = body.user_profile_bridge
    const call = async (tool: string, args = {}) => (await realFetch(bridge.url, { method: 'POST', headers: { Authorization: `Bearer ${bridge.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ runId: body.run_id, tool, arguments: args }) })).json()
    const read = await call('user_profile_read')
    expect(read.success).toBe(true)
    const update = await call('user_profile_update', { content: 'new', expectedRevision: read.data.revision })
    expect(update.success).toBe(enabled)
    return new Response('')
  }))
  for (const parentRunId of [undefined, 'old_run']) {
    expect(await aiService.streamAgent('/unused', { input: 'hi', memory, parentRunId, recoveryReason: parentRunId ? 'manual_retry' : undefined, userProfileStore: store, canUpdateUserProfile: () => enabled }, () => {})).toEqual({ success: true })
  }
  enabled = true
  expect(await aiService.streamAgent('/unused', { input: 'hi', memory, userProfileStore: store, canUpdateUserProfile: () => enabled }, () => {})).toEqual({ success: true })
})
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

it.each(['done', 'error'])('drains an in-flight memory receipt before forwarding %s', async terminal => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'profile-terminal-order-'))
  roots.push(root)
  const store = new AgentMemoryStore(root)
  const realFetch = globalThis.fetch
  const events: string[] = []
  let release!: () => void
  let entered!: () => void
  let terminalRead!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const saving = new Promise<void>(resolve => { entered = resolve })
  const readingTerminal = new Promise<void>(resolve => { terminalRead = resolve })
  const save = store.save.bind(store)
  vi.spyOn(store, 'save').mockImplementationOnce(async (...args) => {
    const saved = await save(...args)
    entered()
    await gate
    return saved
  })
  let update: Promise<unknown> | undefined
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string)
    const bridge = body.user_profile_bridge
    const call = (tool: string, args = {}) => realFetch(bridge.url, { method: 'POST',
      headers: { Authorization: `Bearer ${bridge.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ runId: body.run_id, tool, arguments: args }) })
    const read = await (await call('user_profile_read')).json()
    update = call('user_profile_update', { content: '真实保存', expectedRevision: read.data.revision }).catch(() => undefined)
    await saving
    const event = terminal === 'done'
      ? { type: 'done', runId: body.run_id, status: 'completed', answer: '完成' }
      : { type: 'error', runId: body.run_id, error: { code: 'failure', message: '失败', retryable: true } }
    return new Response(new ReadableStream({ pull(controller) {
      controller.enqueue(new TextEncoder().encode(JSON.stringify(event) + '\n'))
      controller.close()
      terminalRead()
    } }))
  }))
  const pending = aiService.streamAgent('/unused-workspace', { input: 'hi', userProfileStore: store, canUpdateUserProfile: () => true }, event => { events.push(event.type) })
  await readingTerminal
  // Let the terminal handler advance while the actual save callback is blocked.
  await new Promise(resolve => setTimeout(resolve, 0))
  const beforeRelease = [...events]
  release()
  await pending
  await update
  expect(beforeRelease).toEqual([])
  expect(events).toEqual(['memory_updated', terminal])
  expect((await new AgentMemoryStore(root).read('user')).content).toBe('真实保存')
})

for (const protocol of ['ollama', 'openai']) {
  it.each([[true, false], [false, false], [true, true], [false, true]])(`runs real Python ${protocol} tools through AIService with maintenance=%s workspace=%s`, async (enabled, workspaceScope) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'profile-e2e-'))
    roots.push(root)
    const global = new AgentMemoryStore(root)
    const store = workspaceScope ? AgentMemoryStore.workspace(root, 'workspace') : global
    const prefix = workspaceScope ? 'workspace_memory' : 'user_profile'
    const initial = await store.read('user')
    const content = '保留的长期背景。\n'.repeat(650) + '偏好英文\n过时习惯\n'
    await store.save('user', content, initial.revision)
    const memory = await global.snapshot('workspace', 'original')
    const realFetch = globalThis.fetch
    let bridgeUrl = ''
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string)
      bridgeUrl = body[`${prefix}_bridge`].url
      expect(JSON.stringify(body)).not.toContain(root)
      const cwd = path.resolve('looma-agent-service')
      const output = await new Promise<string>((resolve, reject) => {
        const child = spawn(path.join(cwd, '.venv/bin/python'), ['-m', 'test.user_profile_bridge_driver'], { cwd, env: { ...process.env, TMPDIR: os.tmpdir() } })
        let stdout = ''; let stderr = ''
        child.stdout.on('data', chunk => { stdout += chunk })
        child.stderr.on('data', chunk => { stderr += chunk })
        child.once('error', reject)
        child.once('close', code => code === 0 ? resolve(stdout) : reject(new Error(stderr + stdout)))
        child.stdin.end(JSON.stringify({ ...body, _protocol: protocol, _scope: workspaceScope ? 'workspace' : 'user' }))
      })
      return new Response(output, { headers: { 'Content-Type': 'application/x-ndjson' } })
    }))
    const events: AgentStreamEvent[] = []
    const result = await aiService.streamAgent('/unused-workspace', { input: '我偏好中文，喜欢简洁回答；请删除过时习惯', memory,
      ...(workspaceScope ? { workspaceMemoryStore: store, canUpdateWorkspaceMemory: () => enabled } : { userProfileStore: store, canUpdateUserProfile: () => enabled }),
      enabledTools: workspaceScope ? ['workspace_memory_read', 'workspace_memory_update'] : ['user_profile_read', 'user_profile_update'],
    }, event => { events.push(event) })
    expect(result).toEqual({ success: true })
    expect(events.filter(event => event.type === 'tool_result')).toHaveLength(enabled ? 2 : 1)
    expect(events.at(-1)?.type).toBe('done')
    const changes = events.filter((event): event is Extract<AgentStreamEvent, { type: 'memory_updated' }> => event.type === 'memory_updated')
    if (!enabled) {
      expect(changes).toHaveLength(0)
      expect((await store.read('user')).content).toBe(content)
      expect(await global.snapshot('workspace', 'original')).toEqual(memory)
      await expect(realFetch(bridgeUrl, { method: 'POST' })).rejects.toThrow()
      return
    }
    expect(changes).toHaveLength(1)
    expect(changes[0].change.kind).toBe(workspaceScope ? 'workspace' : 'user')
    const removed = changes[0].change.changes.filter(item => item.type === 'removed').map(item => item.text).join('\n')
    const added = changes[0].change.changes.filter(item => item.type === 'added').map(item => item.text).join('\n')
    expect(removed).toContain('偏好英文\n过时习惯')
    expect(added).toContain('偏好中文')
    expect(added).toContain('喜欢简洁回答')
    expect(JSON.stringify(changes)).not.toContain('保留的长期背景')
    const saved = await store.read('user')
    expect(saved.content).toBe(content.replace('偏好英文', '偏好中文').replace('过时习惯\n', '') + '\n喜欢简洁回答')
    const history = await store.listUserHistory()
    expect(history.entries[0].source).toBe('agent')
    expect((await store.readUserHistory(history.entries[0].id)).content).toBe(content)
    expect(await global.snapshot('workspace', 'original')).toEqual(memory)
    expect((await global.snapshot('workspace', 'new'))[workspaceScope ? 'workspace' : 'user']).toEqual(saved)
    expect(await global.read('soul')).toEqual(memory.soul)
    await expect(realFetch(bridgeUrl, { method: 'POST' })).rejects.toThrow()
  }, 60_000)
}
