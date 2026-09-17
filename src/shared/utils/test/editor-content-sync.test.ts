import { describe, expect, it } from 'vitest'
import { getExternalTextChange } from '../editor-content-sync'

describe('getExternalTextChange', () => {
  it('只替换变化区间，保留未修改正文的滚动和选择锚点', () => {
    expect(getExternalTextChange('前文\n正文\n后文', '前文\n正甲文\n后文')).toEqual({ from: 4, to: 4, insert: '甲' })
    expect(getExternalTextChange('abc', 'abc')).toBeNull()
    expect(getExternalTextChange('abc', 'ac')).toEqual({ from: 1, to: 2, insert: '' })
    expect(getExternalTextChange('', '新文')).toEqual({ from: 0, to: 0, insert: '新文' })
    expect(getExternalTextChange('旧文', '')).toEqual({ from: 0, to: 2, insert: '' })
    expect(getExternalTextChange('abc', 'xyz')).toEqual({ from: 0, to: 3, insert: 'xyz' })
  })
})
