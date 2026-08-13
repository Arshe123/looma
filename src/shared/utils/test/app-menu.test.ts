import { describe, expect, it } from 'vitest'
import { createViewMenuTemplate } from '../app-menu'

describe('application view menu', () => {
  it('does not register Electron zoom commands or their keyboard accelerators', () => {
    const roles = createViewMenuTemplate()
      .map(item => 'role' in item ? item.role : undefined)

    expect(roles).not.toContain('resetZoom')
    expect(roles).not.toContain('zoomIn')
    expect(roles).not.toContain('zoomOut')
  })
})
