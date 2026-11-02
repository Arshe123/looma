// Real held-left-button selection, isolated in-memory source and profile.
const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const directory = fs.mkdtempSync(path.join(os.homedir(), '.hermes/cache/scratch/looma-drag-'))
app.setPath('userData', path.join(directory, 'profile'))
const wait = (ms = 100) => new Promise(resolve => setTimeout(resolve, ms))
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1100, height: 850, show: false, webPreferences: { backgroundThrottling: false } })
  const run = code => win.webContents.executeJavaScript(code)
  const errors = []
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message) })
  try {
    await win.loadURL('http://127.0.0.1:5189/src/renderer/components/editor/test/chunked-editor.browser.html')
    for (let i = 0; i < 100 && !await run('window.ready?.() && !!cm()'); i++) await wait()
    await run('document.fonts.ready')

    win.webContents.debugger.attach('1.3')
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
    await win.webContents.debugger.sendCommand('Page.bringToFront')
    await run(`(async()=>{window.selectionApi=await import('/src/renderer/components/editor/test/continuous-table-selection.browser.ts');window.dragSnapshot=()=>({anchor:cm().state.selection.main.anchor,head:cm().state.selection.main.head,dom:window.getSelection().toString(),rectangle:selectionApi.getContinuousTableSelection(cm().state),cells:[...document.querySelectorAll('.selectedCell')].map(cell=>cell.textContent.replaceAll('|','').trim())});return true})()`)
    const cases = [
      ['plain', '前言\n\nabcdef ghijkl\nmnopqr stuvwx\n\n尾部', 'bcdef', 'stuvw'],
      ['table', '前言\n\n| abcdef | ghijkl |\n| --- | --- |\n| mnopqr | stuvwx |\n\n尾部', 'bcdef', 'stuvw'],
      ['fenced code', '前言\n\n```js\nconst abcdef = 1;\nconst ghijkl = 2;\n```\n\n尾部', 'abcdef', 'ghijkl'],
      ['indented code', '前言\n\n    const abcdef = 1;\n    const ghijkl = 2;\n\n尾部', 'abcdef', 'ghijkl'],
      ['single cell', '| abcdefghijkl | other |\n| --- | --- |\n| value | text |', 'bcdef', 'ghijk'],
      ['single code line', '```js\nconst abcdefghijkl = 1;\n```', 'bcdef', 'ghijk'],
    ]
    const failures = []
    for (const [name, source, start, end, theme, reverse] of cases.flatMap(test => ['light', 'dark'].flatMap(theme => [false, true].map(reverse => [...test, theme, reverse])))) {
      const label = `${theme} ${name} ${reverse ? 'reverse' : 'forward'}`
      await run(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`)
      await run(`setFixture(${JSON.stringify(source)})`); await wait(700)
      await run('start(0);cm().focus()'); await wait(200)
      const first = source.indexOf(start), last = source.indexOf(end) + end.length
      const from = reverse ? last : first, to = reverse ? first : last
      const points = await run(`(()=>{const a=cm().coordsAtPos(${from}),b=cm().coordsAtPos(${to});return [{x:a.left,y:(a.top+a.bottom)/2},{x:b.left,y:(b.top+b.bottom)/2}]})()`)
      const revision = await run('model().revision')
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...points[0] })
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', buttons: 1, clickCount: 1, ...points[0] })
      await wait(350)
      for (let step = 1; step <= 15; step++) {
        const t = step / 15
        await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', button: 'left', buttons: 1, x: points[0].x + (points[1].x - points[0].x) * t, y: points[0].y + (points[1].y - points[0].y) * t })
        await wait(35)
      }
      const held = await run('dragSnapshot()')
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', buttons: 0, clickCount: 1, ...points[1] })
      await wait(200)
      const released = await run('dragSnapshot()')
      const rect = await run(`(()=>{const a=cm().coordsAtPos(${first}),b=cm().coordsAtPos(${first + 3});return {x:Math.ceil(a.left),y:Math.ceil(a.top),width:Math.max(1,Math.floor(b.left-a.left)),height:Math.max(1,Math.floor(a.bottom-a.top))}})()`)
      const selectedPixels = (await win.webContents.capturePage(rect)).toBitmap()
      await run('window.selectionLayer=document.querySelector(".cm-selectionLayer");if(selectionLayer)selectionLayer.style.visibility="hidden";window.selectionProbe=document.createElement("style");selectionProbe.textContent="html body #app .cm-editor .cm-content::selection,html body #app .cm-editor .cm-content *::selection {background:transparent !important}.looma-table-rectangle-selection .selectedCell::after{background:transparent!important}";document.head.append(selectionProbe)')
      await wait(100)
      const hiddenPixels = (await win.webContents.capturePage(rect)).toBitmap()
      await run('if(selectionLayer)selectionLayer.style.visibility="";selectionProbe.remove()')
      let visibleSelectionBytes = 0
      for (let i = 0; i < selectedPixels.length; i++) if (selectedPixels[i] !== hiddenPixels[i]) visibleSelectionBytes++
      console.log(JSON.stringify({ label, from, to, held, released, visibleSelectionBytes }))
      try {
        if(name==='table') {
          assert.ok(held.rectangle,`${label}: cross-cell drag uses rectangle metadata`)
          assert.equal(held.anchor,held.head,`${label}: no hidden linear source selection`)
          assert.equal(held.dom,'')
          assert.deepEqual(held.cells,['abcdef','ghijkl','mnopqr','stuvwx'])
          assert.equal(held.rectangle.head.column,reverse?0:1)
          assert.deepEqual(released,held,`${label}: release retains the exact rectangle`)
        } else {
          assert.equal(held.anchor, from, `${label}: held drag retains anchor`)
          assert.equal(held.head, to, `${label}: held drag extends selection`)
          assert.equal(released.anchor, from, `${label}: release retains anchor`)
          assert.equal(released.head, to, `${label}: release retains selection`)
        }
        assert.ok(visibleSelectionBytes > 50, `${label}: selection highlight must actually paint over block background (${visibleSelectionBytes} changed bytes)`)
        assert.equal(await run('model().content'), source, `${label}: source unchanged`)
        assert.equal(await run('model().revision'), revision, `${label}: no edit/history revision`)
      } catch (error) { failures.push(error.message) }
    }
    assert.deepEqual(errors, [])
    assert.deepEqual(failures, [])
    console.log('PASS held left drag: light/dark, forward/reverse, single/multi-line cells/code; unchanged source/history')
    win.destroy(); app.exit(0)
  } catch (error) { console.error(error); console.error(errors); win.destroy(); app.exit(1) }
})
