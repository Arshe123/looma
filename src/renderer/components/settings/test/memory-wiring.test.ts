import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
const source = (file: string) => fs.readFileSync(path.resolve(file), 'utf8')
describe('memory settings wiring', () => {
  it('wires mount/unmount and a removable main-origin subscription', () => {
    const ui = source('src/renderer/components/settings/MemorySettings.vue')
    expect(ui).toContain('entry.editor.start()')
    expect(ui).toContain('entry.editor.dispose()')
    const preload = source('src/preload/index.ts')
    expect(preload).toContain("ipcRenderer.on('agentMemory:changed', handler)")
    expect(preload).toContain("ipcRenderer.removeListener('agentMemory:changed', handler)")
  })
  it('offers user-only history with escaped full preview and explicit confirmation, independent of maintenance permission', () => {
    expect(source('src/renderer/components/settings/MemorySettings.vue')).toContain('<UserProfileHistory v-if="entry.kind === \'user\'"')
    const ui = source('src/renderer/components/settings/UserProfileHistory.vue')
    expect(ui).toContain('历史版本')
    expect(ui).toContain('恢复上一版')
    expect(ui).toContain('确认恢复')
    expect(ui).toContain('{{ history.selected.content }}')
    expect(ui).not.toContain('v-html')
    expect(ui).not.toContain('autoMaintainUserProfile')
    for (const action of ['list', 'read', 'restore']) {
      expect(source('src/preload/index.ts')).toContain(`ipcRenderer.invoke('agentMemory:history:${action}'`)
    }
  })
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
