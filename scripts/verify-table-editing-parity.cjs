// Real caret and deletion-boundary checks; never opens user notes.
const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const directory = fs.mkdtempSync(path.join(os.homedir(), '.hermes/cache/scratch/looma-table-editing-'))
app.setPath('userData', path.join(directory, 'profile'))
const wait = (ms = 100) => new Promise(resolve => setTimeout(resolve, ms))
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1450, height: 850, show: false, webPreferences: { backgroundThrottling: false } })
  const run = code => win.webContents.executeJavaScript(code)
  const cmd = (method, args = {}) => win.webContents.debugger.sendCommand(method, args)
  const errors = [], failures = []
  win.webContents.on('console-message', (_event, level, text) => { if (level >= 3) errors.push(text) })
  const fixture = async source => {
    await run(`setFixture(${JSON.stringify(source)})`); await wait(700)
    await run('cm().dispatch({selection:{anchor:0}});pm().commands.setTextSelection(1)'); await wait()
  }
  const clickCell = async (host, row, column, edge = 'start') => {
    await run(host === 'ordinary' ? 'pm().view.focus()' : 'cm().focus()')
    await wait(100)
    const point = await run(`(()=>{const rows=document.querySelectorAll('#${host} ${host === 'ordinary' ? '.tiptap tr' : '.looma-continuous-table-row'}'),cell=rows[${row}].children[${column}],r=cell.getBoundingClientRect();return{x:${edge === 'end' ? 'r.right-13' : 'r.left+13'},y:r.top+r.height/2}})()`)
    fs.appendFileSync(path.join(directory, 'clicks.jsonl'), JSON.stringify({ host, row, column, edge, point, hit: await run(`document.elementFromPoint(${point.x},${point.y})?.outerHTML.slice(0,400)`) }) + '\n')
    await cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', modifiers: 0, ...point })
    for (const type of ['mousePressed', 'mouseReleased']) await cmd('Input.dispatchMouseEvent', { type, button: 'left', modifiers: 0, buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1, ...point })
    await wait(120)
    return point
  }
  const inspect = async host => run(`(()=>{const s=getSelection(),node=s.anchorNode,el=node?.nodeType===3?node.parentElement:node,r=s.rangeCount?s.getRangeAt(0).getBoundingClientRect():null,cell=el?.closest('td,th,.looma-continuous-table-cell');return{focus:document.hasFocus(),node:node?.nodeName,text:node?.textContent,offset:s.anchorOffset,font:el?getComputedStyle(el).fontSize:null,caretColor:el?getComputedStyle(el).caretColor:null,rect:r?{x:r.x,y:r.y,height:r.height}:null,inCell:!!cell,column:cell?[...cell.parentElement.children].indexOf(cell):-1,source:${host === 'ordinary' ? 'pm().getMarkdown()' : 'model.content'},selection:${host === 'ordinary' ? '{from:pm().state.selection.from,to:pm().state.selection.to}' : '{from:cm().state.selection.main.from,to:cm().state.selection.main.to}'}}})()`)
  const key = async (keyCode, modifiers = []) => {
    const windowsVirtualKeyCode = { Backspace: 8, Tab: 9, Delete: 46, z: 90 }[keyCode]
    assert.ok(windowsVirtualKeyCode, 'known renderer key')
    const flags = modifiers.reduce((bits, name) => bits | { alt: 1, ctrl: 2, meta: 4, shift: 8 }[name], 0)
    for (const type of ['keyDown', 'keyUp']) await cmd('Input.dispatchKeyEvent', { type, key: keyCode, code: keyCode === 'z' ? 'KeyZ' : keyCode, windowsVirtualKeyCode, modifiers: flags })
    await wait(180)
  }
  const visibleCaretPixels = async result => {
    const rect = { x: Math.max(0, Math.floor(result.rect.x) - 3), y: Math.max(0, Math.floor(result.rect.y) - 3), width: 10, height: 32 }
    const frames = []
    for (let i = 0; i < 6; i++) {
      frames.push((await win.webContents.capturePage(rect)).toBitmap()); await wait(90)
    }
    await run(`window.caretProbe=document.createElement('style');caretProbe.textContent='#continuous .cm-content,#continuous .cm-content *{caret-color:transparent!important}';document.head.append(caretProbe)`)
    await wait(50)
    const hidden = (await win.webContents.capturePage(rect)).toBitmap()
    await run('caretProbe.remove()')
    return Math.max(...frames.map(frame => frame.reduce((count, value, index) => count + (value !== hidden[index] ? 1 : 0), 0)))
  }
  try {
    await win.loadURL('http://127.0.0.1:5189/src/renderer/components/editor/test/rich-text-parity.browser.html')
    for (let i = 0; i < 100 && !await run('window.ready?.()'); i++) await wait()
    await run('state.width=680;document.fonts.ready'); await wait(300)
    win.webContents.debugger.attach('1.3')
    await cmd('Emulation.setFocusEmulationEnabled', { enabled: true })
    await cmd('Page.bringToFront')
    for (const theme of ['light', 'dark']) {
    await run(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`); await wait(300)
    for (const [name, blank] of [['padded', '|  |  |  |'], ['zero', '||||'], ['text', '| 左 | 中 | 右 |']]) {
      const source = `正文\n\n${blank}\n| --- | --- | --- |\n${blank}\n${blank}\n\n末尾`
      await fixture(source)
      for (const host of ['ordinary', 'continuous']) for (let row = 0; row < 3; row++) for (let column = 0; column < 3; column++) for (const edge of ['start', 'end']) {
        await clickCell(host, row, column, edge)
        const result = await inspect(host)
        fs.appendFileSync(path.join(directory, 'carets.jsonl'), JSON.stringify({ theme, name, host, row, column, edge, ...result }) + '\n')
        try {
          assert.ok(result.inCell, 'native caret is inside clicked cell')
          assert.equal(result.column, column, 'native DOM caret belongs to the clicked column, not its neighbour')
          assert.ok(parseFloat(result.font) >= 12, 'native caret must not inherit zero-sized syntax font')
          assert.notEqual(result.caretColor, 'rgba(0, 0, 0, 0)', 'caret is visible')
          if (host === 'continuous') assert.equal(result.source, source, 'click does not alter source')
          if (host === 'continuous') assert.ok(result.rect?.height >= 12, 'native caret has visible normal-height geometry')
          if (host === 'continuous' && row === 0 && edge === 'start') {
            const pixels = await visibleCaretPixels(result)
            assert.ok(pixels > 0, 'native caret is actually painted, not just a logical source offset')
            console.log('PASS caret pixels', theme, name, column, pixels)
          }
        } catch (error) { failures.push(`${theme} ${name} ${host} ${row}:${column} ${edge}: ${error.message}`) }
      }
      if (name === 'zero') {
        await clickCell('continuous', 1, 0)
        await key('Tab')
        try {
          assert.equal((await inspect('continuous')).column, 1, 'Tab caret stays in its target zero-width cell')
          await key('Tab', ['shift'])
          assert.equal((await inspect('continuous')).column, 0, 'Shift+Tab caret stays in its target zero-width cell')
          assert.equal(await run('model.content'), source, 'Tab does not modify an existing table')
        } catch (error) { failures.push('zero Tab: ' + error.message) }
      }
      fs.writeFileSync(path.join(directory, theme + '-' + name + '.png'), (await win.webContents.capturePage()).toPNG())
    }
    }
    await run("document.documentElement.dataset.theme='light'"); await wait(300)
    for (const [name, source, row, column, edge = 'start'] of [
      ['previous-text', '正文\n\n| A | B | C |\n| --- | --- | --- |\n| 甲乙 |  | 尾 |\n\n末尾', 1, 1],
      ['previous-empty', '正文\n\n| A | B | C |\n| --- | --- | --- |\n|  |  | 尾 |\n\n末尾', 1, 1],
      ['previous-row', '正文\n\n| A | B | 甲乙 |\n| --- | --- | --- |\n|  | X | 尾 |\n\n末尾', 1, 0],
      ['text-end', '正文\n\n| A | B | C |\n| --- | --- | --- |\n| 甲乙 | X | 尾 |\n\n末尾', 1, 0, 'end'],
      ['first-empty-with-content', '正文\n\n|  |  |  |\n| --- | --- | --- |\n|  | 保留 |  |\n\n末尾', 0, 0],
    ]) {
      const results = {}
      for (const host of ['ordinary', 'continuous']) {
        await fixture(source); await clickCell(host, row, column, edge)
        const clicked = await inspect(host)
        assert.equal(clicked.column, column, 'deletion setup clicked the intended cell: ' + host + ' ' + name + ' ' + JSON.stringify(clicked))
        assert.equal(clicked.selection.from, clicked.selection.to, 'deletion setup uses a text caret, not CellSelection')
        await key('Backspace'); results[host] = await inspect(host)
      }
      console.log(name, JSON.stringify(results))
      try {
        assert.equal(await run("document.querySelectorAll('#continuous .looma-continuous-table-row').length"), 2, 'Backspace keeps all rows')
        assert.deepEqual(await run("[...document.querySelectorAll('#continuous .looma-continuous-table-row')].map(r=>r.querySelectorAll('.looma-continuous-table-cell').length)"), [3, 3], 'Backspace cannot remove a cell')
        assert.equal(results.continuous.source.split('\n')[4].split('|').length, 5, 'body delimiters survive')
        if (results.continuous.source !== source) {
          await run('cm().focus()'); await key('z', ['meta'])
          assert.equal(await run('model.content'), source, 'boundary deletion has one shared undo')
          await key('z', ['meta', 'shift'])
          assert.equal(await run('model.content'), results.continuous.source, 'boundary deletion has exact redo')
        }
        await run(`pm().commands.setContent(${JSON.stringify(results.continuous.source)}, {contentType:'markdown'})`)
        assert.equal(await run('pm().getMarkdown()'), results.ordinary.source, 'resulting table content matches ordinary editor')
      } catch (error) { failures.push(`${name}: ${error.message}`) }
    }
    const empty = '正文\n\n||||\n| --- | --- | --- |\n||||\n||||\n\n末尾'
    await fixture(empty); await clickCell('continuous', 2, 2)
    for (let step = 0; step < 8; step++) {
      await key('Backspace')
      const result = await inspect('continuous')
      assert.equal(result.source, empty, 'Backspace preserves empty cells until the first cell is reached')
      assert.equal(result.column, Math.max(0, 8 - step - 1) % 3, 'empty-cell Backspace moves through preceding cells')
      assert.ok(result.rect.height >= 12, 'caret stays visible after crossing an empty cell')
    }
    await key('Backspace')
    const deleted = '正文\n\n末尾'
    assert.equal(await run('model.content'), deleted, 'one more Backspace removes the empty block and its separator, preserving neighbouring text')
    assert.equal(await run("document.querySelectorAll('#continuous .looma-continuous-table-row').length"), 0, 'empty table disappears')
    await key('z', ['meta'])
    assert.equal(await run('model.content'), empty, 'one undo restores the entire table')
    await key('z', ['meta', 'shift'])
    assert.equal(await run('model.content'), deleted, 'redo removes exactly the table again')
    await fixture(empty); await clickCell('ordinary', 0, 0); await key('Backspace')
    assert.equal(await run("document.querySelectorAll('#ordinary .tiptap table').length"), 0, 'ordinary first-cell Backspace also deletes the empty table')
    const ordinaryDeleted = await run('pm().getMarkdown()')
    await run(`pm().commands.setContent(${JSON.stringify(deleted)}, {contentType:'markdown'})`)
    assert.equal(await run('pm().getMarkdown()'), ordinaryDeleted, 'whole-table deletion matches the ordinary rich-text result')
    const forward = '正文\n\n| A | B | C |\n| --- | --- | --- |\n| x | yz | w |\n\n末尾'
    await fixture(forward); await clickCell('continuous', 1, 0, 'end'); await key('Delete')
    assert.equal(await run('model.content'), forward.replace('| x | yz | w |', '| x | z | w |'), 'forward Delete affects next-cell text, not the separator')
    assert.equal((await inspect('continuous')).column, 1, 'forward Delete moves the caret into the next cell')
    await fixture(empty); await run('state.sourceOnly=true'); await wait(200)
    const offset = empty.indexOf('||||') + 1
    await run(`cm().focus();cm().dispatch({selection:{anchor:${offset}}})`); await key('Backspace')
    assert.equal(await run('model.content'), empty.slice(0, offset - 1) + empty.slice(offset), 'source mode still allows direct Markdown structure editing')
    await key('z', ['meta'])
    assert.equal(await run('model.content'), empty, 'source deletion shares canonical undo')
    await run('state.sourceOnly=false'); await wait(200)
    assert.deepEqual(errors, [])
    assert.deepEqual(failures, [])
    console.log('PASS actual native caret font/placement in every cell and ordinary-vs-continuous boundary Backspace')
    console.log('REPORT', directory)
    win.destroy(); app.exit(0)
  } catch (error) { console.error(error); console.error(errors); console.log('REPORT', directory); win.destroy(); app.exit(1) }
})
