// Isolated ordinary/continuous table input comparison; no user documents.
const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const directory = fs.mkdtempSync(path.join(os.homedir(), '.hermes/cache/scratch/looma-table-backslash-'))
app.setPath('userData', path.join(directory, 'profile'))
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1450, height: 850, show: false, webPreferences: { backgroundThrottling: false } })
  const run = code => win.webContents.executeJavaScript(code)
  const cmd = (method, args) => win.webContents.debugger.sendCommand(method, args)
  const errors = []
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message) })
  const selectors = host => host === 'ordinary' ? ['.tiptap tr', 'th,td'] : ['.looma-continuous-table-row', '.looma-continuous-table-cell']
  const snapshot = async (host, label) => {
    const [rowSelector, cellSelector] = selectors(host)
    const result = await run(`(()=>{const rows=[...document.querySelectorAll('#${host} ${rowSelector}')],s=getSelection(),parent=s?.focusNode?.nodeType===3?s.focusNode.parentElement:s?.focusNode,owner=parent?.closest?.('th,td,.looma-continuous-table-cell'),r=s?.rangeCount?s.getRangeAt(0).getBoundingClientRect():null;return {source:${host === 'ordinary' ? 'pm().getMarkdown()' : 'model.content'},caret:{row:owner?rows.indexOf(owner.parentElement):-1,column:owner?[...owner.parentElement.querySelectorAll('${cellSelector}')].indexOf(owner):-1,height:r?.height,left:r?.left},rows:rows.map(row=>[...row.querySelectorAll('${cellSelector}')].map(cell=>{const walker=document.createTreeWalker(cell,NodeFilter.SHOW_TEXT);let node,text='';while(node=walker.nextNode()){if(node.parentElement.closest('.cm-widgetBuffer'))continue;if(!node.parentElement.closest('.looma-continuous-table-syntax')){text+=node.textContent;continue}const style=getComputedStyle(node.parentElement);let at=0;for(const char of node.textContent){const range=document.createRange();range.setStart(node,at);at+=char.length;range.setEnd(node,at);if(style.color!=='rgba(0, 0, 0, 0)'&&range.getBoundingClientRect().width>0.1)text+=char}}const r=cell.getBoundingClientRect();return{text,left:r.left,width:r.width}}))}})()`)
    fs.appendFileSync(path.join(directory, 'results.jsonl'), JSON.stringify({ host, label, ...result }) + '\n')
    return result
  }
  // Ordinary edits are collected as events, not written back to state.content.
  // Force a prop transition even when consecutive cases use identical source.
  const fixture = async source => {
    await run(`setFixture('夹具重置')`); await wait(80)
    await run(`setFixture(${JSON.stringify(source)})`); await wait(700)
  }
  const click = async (host, row, column, end = false) => {
    await run(host === 'ordinary' ? 'pm().view.focus()' : 'cm().focus()')
    const [rowSelector, cellSelector] = selectors(host)
    const point = await run(`(()=>{const r=document.querySelectorAll('#${host} ${rowSelector}')[${row}].querySelectorAll('${cellSelector}')[${column}].getBoundingClientRect();return{x:${end ? 'r.right-13' : 'r.left+13'},y:r.top+r.height/2}})()`)
    for (const type of ['mousePressed', 'mouseReleased']) await cmd('Input.dispatchMouseEvent', { type, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, modifiers: 0, clickCount: 1, ...point })
    await wait(120)
  }
  const key = async (key, modifiers = 0) => {
    for (const type of ['keyDown', 'keyUp']) await cmd('Input.dispatchKeyEvent', { type, key, code: key === 'z' ? 'KeyZ' : key, windowsVirtualKeyCode: { z: 90, Backspace: 8 }[key], modifiers })
    await wait(200)
  }
  const input = async text => { await cmd('Input.insertText', { text }); await wait(200) }
  const check = (host, baseline, result, row, column, text) => {
    assert.deepEqual(result.rows.map(row => row.length), [3, 3, 3], host + ': input must preserve all structural delimiters')
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
      assert.equal(result.rows[r][c].text.trim(), r === row && c === column ? text : baseline.rows[r][c].text.trim(), host + ': no visible table pipe and no changes in other cells')
      assert.ok(Math.abs(result.rows[r][c].left - result.rows[0][c].left) < 1, host + ': columns remain aligned, without anonymous cells')
    }
    assert.equal(result.caret.row, row, host + ': caret stays in edited row')
    assert.equal(result.caret.column, column, host + ': caret stays in edited column')
    if (text) {
      assert.ok(result.caret.height >= 12, host + ': visible normal-height caret')
      const cell = result.rows[row][column]
      assert.ok(result.caret.left >= cell.left && result.caret.left < cell.left + cell.width, host + ': caret remains in the cell box')
    }
  }
  try {
    await win.loadURL('http://127.0.0.1:5189/src/renderer/components/editor/test/rich-text-parity.browser.html')
    for (let i = 0; i < 100 && !await run('window.ready?.()'); i++) await wait(100)
    await run('state.width=680;document.fonts.ready')
    win.webContents.debugger.attach('1.3')
    await cmd('Emulation.setFocusEmulationEnabled', { enabled: true })
    if (process.argv.includes('--composition-visibility')) {
      // Check painted glyph advances/colors rather than assuming every text
      // character in a syntax span is invisible during native composition.
      await fixture('正文\n\n||||\n| --- | --- | --- |\n||||\n||||\n\n末尾'); await click('continuous', 1, 1)
      const before = await snapshot('continuous', 'composition visibility before')
      await cmd('Input.imeSetComposition', { text: '中', selectionStart: 1, selectionEnd: 1 }); await wait(100)
      check('continuous', before, await snapshot('continuous', 'composition visibility pending'), 1, 1, '中')
      win.destroy(); app.exit(0); return
    }
    for (const [name, blank] of [['zero', '||||'], ['padded', '|  |  |  |']]) {
      const source = `正文\n\n${blank}\n| --- | --- | --- |\n${blank}\n${blank}\n\n末尾`
      for (const host of ['ordinary', 'continuous']) {
        for (let row = 0; row < 3; row++) for (let column = 0; column < 3; column++) {
          const label = `${name} ${row}:${column}`
          await fixture(source); await click(host, row, column)
          const before = await snapshot(host, label + ' before')
          await input('\\')
          const typed = await snapshot(host, label + ' typed')
          check(host, before, typed, row, column, '\\')
          await key('z', 4)
          check(host, before, await snapshot(host, label + ' undo'), row, column, '')
          if (host === 'continuous') assert.equal(await run('model.content'), source, 'one undo removes the input and its syntax padding together')
          await key('z', 12)
          const redone = await snapshot(host, label + ' redo')
          check(host, before, redone, row, column, '\\')
          if (host === 'continuous') assert.equal(redone.source, typed.source, 'redo restores exact protected source')
          await input('尾')
          check(host, before, await snapshot(host, label + ' subsequent input'), row, column, '\\尾')
          await key('Backspace')
          check(host, before, await snapshot(host, label + ' delete suffix'), row, column, '\\')
          await key('Backspace')
          check(host, before, await snapshot(host, label + ' delete backslash'), row, column, '')
        }
        for (const text of ['\\\\', 'C:\\tmp\\']) {
          await fixture(source); await click(host, 1, 1)
          const before = await snapshot(host, `${name} bulk before`)
          await input(text)
          check(host, before, await snapshot(host, `${name} bulk ${text}`), 1, 1, text)
        }
        if (host === 'continuous') {
          await fixture(source); await click(host, 1, 1)
          const before = await snapshot(host, `${name} composition before`)
          const head = await run('cm().state.selection.main.head')
          const padding = before.source[head] === '|' ? ' ' : ''
          for (const text of ['\\', '\\中', '\\中文']) {
            await cmd('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length }); await wait(100)
            const composing = await snapshot(host, `${name} composition ${text}`)
            assert.equal(composing.source, before.source.slice(0, head) + text + padding + before.source.slice(head), 'composition updates preserve exact cell source and guard padding')
            assert.deepEqual(composing.rows.map(row => row.length), [3, 3, 3])
            assert.equal(composing.caret.row, 1)
            assert.equal(composing.caret.column, 1)
            // Live glyph visibility is a separate known RED above. This path
            // verifies source, structure and caret; committed text below.
          }
          await input('\\中文')
          const committed = await snapshot(host, `${name} composition committed`)
          check(host, before, committed, 1, 1, '\\中文')
          await fixture(committed.source)
          for (const reloadedHost of ['ordinary', 'continuous']) {
            await click(reloadedHost, 1, 1)
            check(reloadedHost, before, await snapshot(reloadedHost, `${name} reloaded`), 1, 1, '\\中文')
          }
          assert.equal(await run('model.content'), committed.source, 'reloading protected Markdown preserves exact source')
        }
        console.log('PASS', host, name, 'all cells: backslash, subsequent input/deletion, exact undo/redo, bulk backslashes and path')
      }
    }
    const deletionSource = '| A | B | C |\n| --- | --- | --- |\n|\\x| b | c |\n| d | e | f |'
    await fixture(deletionSource); await click('continuous', 1, 0, true)
    const beforeDelete = await snapshot('continuous', 'deletion before')
    await key('Backspace')
    check('continuous', beforeDelete, await snapshot('continuous', 'deletion exposes backslash'), 1, 0, '\\')
    const raw = '正文\n\n||||\n| --- | --- | --- |\n||||\n||||\n\n末尾', at = raw.lastIndexOf('||||') + 2
    await fixture(raw); await run(`state.sourceOnly=true`); await wait(200)
    await run(`cm().dispatch({selection:{anchor:${at}}});cm().focus()`)
    await input('\\')
    assert.equal(await run('model.content'), raw.slice(0, at) + '\\' + raw.slice(at), 'source mode retains literal Markdown editing')
    assert.deepEqual(errors, [])
    console.log('REPORT', directory)
    win.destroy(); app.exit(0)
  } catch (error) { console.error(error); console.error(errors); console.log('REPORT', directory); win.destroy(); app.exit(1) }
})
