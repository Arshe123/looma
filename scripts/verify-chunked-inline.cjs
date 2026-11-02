// Real continuous-editor inline editing; Vite --mode test on port 5189.
const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const profile = fs.mkdtempSync(path.join(os.homedir(), '.hermes/cache/scratch/looma-chunked-inline-'))
app.setPath('userData', profile)
app.setPath('sessionData', profile)
const wait = (ms = 150) => new Promise(resolve => setTimeout(resolve, ms))
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1100, height: 850, show: true, webPreferences: { backgroundThrottling: false } })
  const run = code => win.webContents.executeJavaScript(code)
  const errors = []
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message) })
  const focus = async () => {
    for (let i = 0; i < 30; i++) {
      app.focus({ steal: true }); win.focus(); await run('cm().focus()'); await wait(60)
      if (await run('document.hasFocus() && cm().hasFocus')) return
    }
    throw new Error('isolated editor did not gain focus')
  }
  const key = async (keyCode, modifiers = []) => {
    await focus()
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
    await wait()
  }
  const fixture = async source => {
    await run(`setFixture(${JSON.stringify(source)})`); await wait(1100)
    await run('start(0)'); await focus(); await wait()
  }
  const expanded = () => run('[...document.querySelectorAll(".looma-continuous-expanded-source")].map(el=>el.textContent).join("")')
  const snapshot = () => run('JSON.stringify({source:model().content,revision:model().revision,events:{pending:events.pending,updates:events.updates.length,saves:events.saves.length,loads:events.loads}})')
  try {
    await win.loadURL('http://127.0.0.1:5189/src/renderer/components/editor/test/chunked-editor.browser.html')
    for (let i = 0; i < 100 && !await run('window.ready?.() && !!cm()'); i++) await wait(80)
    assert.ok(await run('window.ready?.() && !!cm()'))
    await run('document.fonts.ready'); await focus()
    for (const inline of ['**bold**', '*斜体*', '~~删除~~', '==高亮==', '`代码`', '`` a`b ``', '[**粗体** 标签](other.md#L7 "标题")', '**外层 *内层* 文字**']) {
      const source = `a ${inline} z **别处**`
      await fixture(source)
      const before = await snapshot()
      for (const offset of [2, 3, 2 + inline.length]) {
        await run(`select(${offset})`); await focus(); await wait()
        assert.equal(await expanded(), inline, `entering ${inline} at ${offset} expands its entire source: ${await run('JSON.stringify({selection:model().selection,focused:cm().hasFocus,html:cm().contentDOM.innerHTML})')}`)
      }
      await run('select(0)'); await wait()
      assert.equal(await expanded(), '')
      assert.equal(await snapshot(), before, 'selection-only expansion must not write source/history or save')
    }
    console.log('PASS inline families, nested outer expansion, boundaries, collapse and zero source/save writes')

    await fixture('a **bold** z')
    await run('select(1)'); await key('Right')
    assert.equal(await run('model().selection.head'), 2, 'one native arrow enters the source boundary')
    assert.equal(await expanded(), '**bold**')
    await key('Right')
    assert.equal(await run('model().selection.head'), 3, 'expanded delimiter is an individual caret stop')
    await key('Right'); await key('Backspace'); await wait(200)
    assert.equal(await run('model().content'), 'a *bold** z', 'Backspace removes only one expanded delimiter')
    await key('z', ['meta'])
    assert.equal(await run('model().content'), 'a **bold** z')
    await run('select(11)'); await key('Backspace')
    assert.equal(await run('model().content'), 'a **bold**z', 'outside deletion preserves hidden syntax')
    await key('z', ['meta'])
    assert.equal(await run('model().content'), 'a **bold** z')
    console.log('PASS native boundary arrows, delimiter/adjacent deletion and undo')

    const link = '[**粗体** 标签](other.md#L7 "标题")'
    await fixture(`a ${link} z`)
    await run('window.targets=[];window.addEventListener("looma:open-note-ref",e=>targets.push(e.detail));void 0')
    win.webContents.debugger.attach('1.3')
    const click = async (offset, modifiers = 0) => {
      await focus()
      const point = await run(`(()=>{const r=cm().coordsAtPos(${offset});return {x:r.left+1,y:(r.top+r.bottom)/2}})()`)
      for (const type of ['mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, modifiers, ...point })
      await wait(250)
    }
    const beforeClick = await snapshot()
    await click(6)
    assert.equal(await expanded(), link, 'ordinary native link click expands source')
    assert.equal(await run('targets.length'), 0)
    assert.equal(await snapshot(), beforeClick)
    const selection = await run('JSON.stringify(model().selection)')
    await click(6, 4)
    assert.equal(await run('targets.length'), 1)
    assert.equal(await run('JSON.stringify(model().selection)'), selection, 'Command click on expanded source preserves caret')
    await run('select(0)'); await wait()
    const collapsedSelection = await run('JSON.stringify(model().selection)')
    await click(6, 4)
    assert.equal(await run('targets.length'), 2)
    assert.equal(await expanded(), '', 'Command click on rendered link does not expand source')
    assert.equal(await run('JSON.stringify(model().selection)'), collapsedSelection)
    console.log('PASS ordinary click edits; Command click navigates once with source collapsed or expanded')

    await fixture('a **outer *inner* end** z')
    await run('select(6)'); await wait()
    const color = await run('getComputedStyle(document.querySelector(".looma-continuous-expanded-source")).backgroundColor')
    assert.notEqual(color, 'rgba(0, 0, 0, 0)')
    assert.equal(await run('document.querySelectorAll(".looma-continuous-expanded-source").length'), 1, 'nested source paints only once')
    assert.equal(await run('getComputedStyle(document.querySelector(".cm-line")).backgroundColor'), 'rgba(0, 0, 0, 0)', 'paragraph background stays transparent')
    await win.webContents.debugger.sendCommand('Input.imeSetComposition', { text: '中文', selectionStart: 2, selectionEnd: 2 })
    await wait(100)
    await win.webContents.debugger.sendCommand('Input.insertText', { text: '中文' })
    await wait(250)
    assert.equal(await run('model().content'), 'a **ou中文ter *inner* end** z')
    await key('z', ['meta'])
    assert.equal(await run('model().content'), 'a **outer *inner* end** z')
    console.log('PASS nested range-only background and Chromium composition commit/undo')

    const wrapped = '**' + '长格式片段用于验证折行背景只覆盖文字。'.repeat(12) + '**'
    await fixture(`前文 ${wrapped} 后文 ==另一个格式==`)
    await run('document.querySelector("#app").style.width="440px";select(8)'); await focus(); await wait(250)
    assert.equal(await expanded(), wrapped)
    assert.ok(await run('document.querySelector(".looma-continuous-expanded-source").getClientRects().length > 1'), 'wrapped source paints individual text-line boxes')
    assert.ok(await run('!!document.querySelector(".looma-continuous-highlight")'), 'unrelated source stays rendered')
    await run('document.querySelector("#app").style.width="1100px"')
    console.log('PASS wrapped local highlight without whole-paragraph source or unrelated-format expansion')

    await fixture('a **bold** z')
    const points = await run('(()=>{const a=cm().coordsAtPos(0),b=cm().coordsAtPos(12);return [a,b].map(r=>({x:r.left+1,y:(r.top+r.bottom)/2}))})()')
    const beforeDrag = await snapshot()
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...points[0] })
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', button: 'left', buttons: 1, ...points[1] })
    await wait()
    assert.equal(await expanded(), '', 'drag freezes the collapsed display until release')
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', ...points[1] })
    await wait(250)
    assert.equal(await expanded(), '**bold**')
    assert.equal(await snapshot(), beforeDrag)
    await run('cm().contentDOM.blur()'); await wait(250)
    assert.equal(await expanded(), '', 'blur clears expanded source')
    console.log('PASS native drag display freeze/release, source unchanged and blur cleanup')
    assert.deepEqual(errors, [])
    win.webContents.debugger.detach()
    win.destroy(); fs.rmSync(profile, { recursive: true, force: true }); app.exit(0)
  } catch (error) {
    console.error(error); console.error('Renderer errors:', errors)
    win.destroy(); fs.rmSync(profile, { recursive: true, force: true }); app.exit(1)
  }
})
