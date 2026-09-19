import { expect, it, vi } from 'vitest'
import { closeDocumentTabs } from '../document-tab-closing'
it('closes a combined normal/external snapshot in visual order and stops on cancellation', async () => {
  const close = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false)
  const tabs = ['normal', 'external-a', 'external-b'].map(id => ({ id, dirty: false, close: () => close(id) }))
  expect(await closeDocumentTabs(tabs, 'normal', 'all')).toBe(false)
  expect(close.mock.calls).toEqual([['normal'], ['external-a']])
})
it('applies right/other/saved to external tabs without bypassing their close guard', async () => {
  const closed: string[] = []
  const tabs = ['normal', 'external-a', 'external-b'].map(id => ({ id, dirty: id === 'external-a', close: async () => { closed.push(id); return true } }))
  await closeDocumentTabs(tabs, 'external-a', 'right')
  expect(closed).toEqual(['external-b'])
  closed.length = 0
  await closeDocumentTabs(tabs, 'external-a', 'other')
  expect(closed).toEqual(['normal', 'external-b'])
  closed.length = 0
  await closeDocumentTabs(tabs, '', 'saved')
  expect(closed).toEqual(['normal', 'external-b'])
})
