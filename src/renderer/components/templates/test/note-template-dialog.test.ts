import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const readSource = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8')

describe('note template picker and dialog UI', () => {
  it('pins the blank note first and exposes accessible card controls', () => {
    const picker = readSource('src/renderer/components/templates/NoteTemplatePicker.vue')

    expect(picker).toContain('data-template-card="blank"')
    expect(picker).toContain('空白笔记')
    expect(picker).toContain('手动输入文件名')
    expect(picker).toContain('v-for="template in templates"')
    expect(picker.indexOf('data-template-card="blank"')).toBeLessThan(picker.indexOf('v-for="template in templates"'))
    expect(picker).toContain('@keydown="handleCardKeydown"')
    expect(picker).toContain("event.key === 'ArrowRight'")
    expect(picker).toContain("event.key === 'ArrowDown'")
    expect(picker).toContain("event.key === 'Enter'")
    expect(picker).toContain("event.key === ' '")
  })

  it('loads templates on open and instantiates a custom template only once', () => {
    const dialog = readSource('src/renderer/components/templates/NoteTemplateDialog.vue')

    expect(dialog).toContain('noteTemplatesApi.list()')
    expect(dialog).toContain('noteTemplatesApi.instantiate({')
    expect(dialog).toContain('workspaceId: props.workspaceId')
    expect(dialog).toContain('parentDirRelativePath: props.parentDirRelativePath')
    expect(dialog).toContain('if (pendingTemplateId.value) return')
    expect(dialog).toContain("emit('created', result.data.relativePath)")
    expect(dialog).toContain("emit('blank')")
    expect(dialog).toContain("emit('close')")
  })

  it('keeps the dialog open for readable load and instantiate errors', () => {
    const dialog = readSource('src/renderer/components/templates/NoteTemplateDialog.vue')
    const picker = readSource('src/renderer/components/templates/NoteTemplatePicker.vue')

    expect(dialog).toContain("loadError.value = result.error || '模板加载失败。'")
    expect(dialog).toContain("actionError.value = result.error || '创建笔记失败。'")
    expect(dialog).toContain("result.errorCode === 'TEMPLATE_NOT_FOUND'")
    expect(dialog).toContain('await loadTemplates()')
    expect(dialog).toContain(':error="loadError"')
    expect(dialog).toContain(':action-error="actionError"')
    expect(picker).toContain('@click="emit(\'retry\')"')
    expect(picker).toContain("emit('invalid', preview.detail")
    expect(dialog).toContain('@invalid="handleInvalidTemplate"')
    expect(picker).toContain('创建进行中')
  })

  it('notifies the file tree when a failed state commit leaves the file in place', () => {
    const dialog = readSource('src/renderer/components/templates/NoteTemplateDialog.vue')

    expect(dialog).toContain("result.errorCode === 'TEMPLATE_STATE_COMMIT_PARTIAL'")
    expect(dialog).toContain("emit('created', result.data.relativePath)")
  })

  it('switches management inside the same modal and handles Escape', () => {
    const dialog = readSource('src/renderer/components/templates/NoteTemplateDialog.vue')

    expect(dialog).toContain("type View = 'picker' | 'manager'")
    expect(dialog).toContain('<NoteTemplateManager')
    expect(dialog).toContain("view = 'manager'")
    expect(dialog).toMatch(/event\.key\s*[!=]==?\s*'Escape'/)
    expect(dialog).toContain('<Teleport to="body">')
  })

  it('provides create, edit, delete, and revision-aware persistence', () => {
    const manager = readSource('src/renderer/components/templates/NoteTemplateManager.vue')

    expect(manager).toContain('noteTemplatesApi.create(input, props.store.revision)')
    expect(manager).toContain('noteTemplatesApi.update(selectedId.value!, input, props.store.revision)')
    expect(manager).toContain('noteTemplatesApi.remove(selectedId.value, props.store.revision)')
    expect(manager).toContain('未命名模板')
    expect(manager).toContain("fileNameTemplate: '未命名笔记'")
    expect(manager).toContain('window.confirm')
    expect(manager).toContain('confirmDiscard')
  })

  it('reloads the remote template after a stale update instead of reusing the new revision with a stale draft', () => {
    const manager = readSource('src/renderer/components/templates/NoteTemplateManager.vue')

    expect(manager).toContain('const refreshed = await refreshStore()')
    expect(manager).toContain('const latest = refreshed.templates.find')
    expect(manager).toContain('if (latest) loadTemplate(latest)')
    expect(manager).toContain('已加载最新版本')
  })

  it('validates structured variables and previews filename and content through shared rendering', () => {
    const manager = readSource('src/renderer/components/templates/NoteTemplateManager.vue')
    const picker = readSource('src/renderer/components/templates/NoteTemplatePicker.vue')

    expect(manager).toContain('renderNoteTemplate')
    expect(manager).toContain('normalizeMarkdownFilename')
    expect(picker).toContain('normalizeMarkdownFilename')
    expect(manager).toContain('validateNoteTemplateInput')
    expect(manager).toContain('previewNow.value')
    expect(picker).toContain('previewNow.value')
    expect(manager).toContain('setInterval(refreshPreviewNow, 60_000)')
    expect(picker).toContain('setInterval(refreshPreviewNow, 60_000)')
    expect(manager).toContain('/^[A-Za-z_][A-Za-z0-9_]*$/')
    expect(manager).toContain('afterUseExpression')
    expect(manager).toContain('evaluateNoteTemplateExpression(variable.afterUseExpression, variablesRecord.value, previewNow.value)')
    expect(manager).toContain("type: 'string'")
    expect(manager).toContain("type=\"number\"")
    expect(manager).toContain("type=\"checkbox\"")
    expect(manager).toContain('文件名预览')
    expect(manager).toContain('内容预览')
    expect(manager).toContain('ddd → 周四')
    expect(manager).toContain('dddd → 星期四')
    expect(manager).toContain('E → 4')
    expect(manager).toContain('now(format)')
    expect(manager).toContain('upper(value)')
    expect(manager).toContain('lower(value)')
    expect(manager).toContain('trim(value)')
    expect(manager).toContain('pad(value, length, fill?)')
    expect(manager).toContain('replace(value, search, replacement)')
    expect(manager).toContain('只替换第一次匹配')
    expect(manager).toContain('默认使用 0 补齐')
  })

  it('supports textarea Tab indentation and dirty-discard protection', () => {
    const manager = readSource('src/renderer/components/templates/NoteTemplateManager.vue')

    expect(manager).toContain('@keydown.tab.prevent="insertTab"')
    expect(manager).toContain("message: '有未保存的修改'")
    expect(manager).toContain('isDirty')
    expect(manager.indexOf('originalSnapshot.value = snapshot()')).toBeLessThan(manager.indexOf('watch(() => props.store.revision'))
    expect(manager).toContain('aria-label="删除变量"')
  })

  it('offers save, discard, and cancel before leaving a dirty template', () => {
    const manager = readSource('src/renderer/components/templates/NoteTemplateManager.vue')

    expect(manager).toContain('window.electronAPI.app.showMessageBox')
    expect(manager).toContain("buttons: ['保存', '放弃', '取消']")
    expect(manager).toContain('await save()')
  })
})
