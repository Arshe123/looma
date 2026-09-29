import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

const source = readFileSync(new URL('../EditorTabs.vue', import.meta.url), 'utf8')
const external = source.split('<div v-if="tab.kind === \'external\'"')[1].split('<div v-else :data-document-tab')[0]
const ordinary = source.split('<div v-else :data-document-tab')[1].split('</template>')[0]
const classes = (markup: string) => markup.match(/(?<!:)class="([^"]*)"/)![1]

it('keeps external tab layout, state colors and controls consistent with ordinary tabs', () => {
  expect(classes(external).replace('external-document-tab ', '')).toBe(classes(ordinary))
  for (const state of ['bg-surface text-accent', 'text-text-muted hover:bg-accent-soft']) {
    expect(external).toContain(`'${state}'`)
    expect(ordinary).toContain(`'${state}'`)
  }
  expect(classes(external.split('<button')[1])).toBe(classes(ordinary.split('<button')[1]))
  expect(external).toContain("'opacity-100': externalDocuments.activeId === tab.id && !externalDocuments.dirty(tab.id)")
  expect(external).toContain('class="text-xs truncate flex-1"')
  expect(external).toContain('class="w-2 h-2 rounded-full bg-text-subtle group-hover:hidden"')
})

it('retains the external icon, label, full path and unsaved indicator', () => {
  expect(external).toContain('<FileSymlink')
  expect(external).toContain('>外部</span>')
  expect(external).toContain(':title="tab.filePath"')
  expect(external).toContain('v-if="externalDocuments.dirty(tab.id)"')
  expect(external).toContain('aria-label="未保存"')
})
