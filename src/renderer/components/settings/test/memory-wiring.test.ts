import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
const source = (file: string) => fs.readFileSync(path.resolve(file), 'utf8')
describe('memory settings wiring', () => {
  it('exposes both editors through settings and the typed preload IPC', () => {
    const ui = source('src/renderer/components/settings/MemorySettings.vue')
    expect(ui).toContain('人格')
    expect(ui).toContain('用户画像')
    expect(ui).toContain('editor.save')
    expect(ui).toContain('editor.error')
    expect(source('src/renderer/components/SettingsPage.vue')).toContain('<MemorySettings')
    expect(source('src/preload/index.ts')).toContain("ipcRenderer.invoke('agentMemory:save'")
    expect(source('src/main/ipc/agentIpc.ts')).toContain("'agentMemory:save'")
  })
})
