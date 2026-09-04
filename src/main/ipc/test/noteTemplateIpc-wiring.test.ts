import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const readSource = (file: string) => readFileSync(resolve(process.cwd(), file), 'utf8')

describe('note template IPC wiring', () => {
  it('registers the main-process IPC and exposes the typed preload bridge', () => {
    const main = readSource('src/main/index.ts')
    const preload = readSource('src/preload/index.ts')
    const types = readSource('src/preload/types.ts')

    expect(main).toContain("import './ipc/noteTemplateIpc';")
    expect(preload).toContain('noteTemplates: {')
    expect(preload).toContain("ipcRenderer.invoke('noteTemplates:instantiate'")
    expect(types).toContain('noteTemplates: {')
    expect(types).toContain('instantiate:')
  })

  it('validates unknown mutation arguments before calling the service', () => {
    const ipc = readSource('src/main/ipc/noteTemplateIpc.ts')

    expect(ipc).toContain('const isExpectedRevision')
    expect(ipc).toContain('TEMPLATE_INVALID_REQUEST')
    expect(ipc).toContain("typeof id !== 'string'")
    expect(ipc).not.toContain('input as never')
  })
})
