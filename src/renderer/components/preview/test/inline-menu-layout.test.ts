import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { getOverlayPositionAtLineNumber } from '@/shared/utils/tiptap-line-numbers'

const source = () => readFileSync(resolve('src/renderer/components/preview/InlineMenu.vue'), 'utf8')

describe('inline menu reading gutter', () => {
  it('observes both capped content and the outer pane, closes stale panels without focusing, and disconnects', () => {
    const component = source()
    expect(component).toContain('resizeObserver = new ResizeObserver(handleLayoutResize)')
    expect(component).toContain('resizeObserver.observe(editorDom)')
    // EditorContent attaches the editor DOM asynchronously; the menu root is already mounted.
    expect(component).toContain('ref="menuContainerRef"')
    expect(component).toContain("const container = menuContainerRef.value?.closest('.overflow-y-auto')")
    expect(component).toContain('if (container) resizeObserver.observe(container)')
    const handler = component.match(/const handleLayoutResize = \(\) => \{([\s\S]*?)\n\}/)?.[1] ?? ''
    expect(handler).toContain('panelVisible.value = false')
    expect(handler).toContain('tablePickerVisible.value = false')
    expect(handler).toContain('updatePosition()')
    expect(handler).not.toContain('.focus(')
    const teardown = component.split('onBeforeUnmount(() => {')[1] ?? ''
    expect(teardown).toContain('resizeObserver?.disconnect()')
    expect(teardown).toContain('resizeObserver = null')
  })
  it('uses the centered editor and rem-sized gutter when the current block has no visible anchor box', () => {
    const component = source()
    // CSS gutter: left .5rem, width 2.25rem, independent of content font zoom.
    expect(component).toContain('const rootFontSize = parseFloat(getComputedStyle(document.documentElement).fontSize)')
    expect(component).toContain('left: editorDom.getBoundingClientRect().left + 0.5 * rootFontSize')
    expect(component).toContain('width: 2.25 * rootFontSize')
    expect(component).toContain('lineNumberRect && lineNumberRect.width > 0')
    expect(component).not.toContain('left: 26 - 12')

    // The existing coordinate converter must also work with the synthetic gutter rect.
    expect(getOverlayPositionAtLineNumber({
      lineNumberRect: { top: 220, left: 418, width: 36, height: 24 },
      containerRect: { top: 100, left: 100 }, scrollTop: 40, scrollLeft: 7, overlaySize: 24,
    })).toEqual({ top: 160, left: 331 })
  })
})
