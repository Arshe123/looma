// Chromium composition glyphs/history, not native OS input-method acceptance.
const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const directory = fs.mkdtempSync(path.join(os.homedir(), '.hermes/cache/scratch/looma-composition-glyphs-'))
app.setPath('userData', path.join(directory, 'profile'))
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1450, height: 850, show: false, webPreferences: { backgroundThrottling: false } })
  const run = code => win.webContents.executeJavaScript(code), cmd = (method, args) => win.webContents.debugger.sendCommand(method, args)
  const errors = []
  win.webContents.on('console-message', (_event, level, text) => { if (level >= 3) errors.push(text) })
  try {
    await win.loadURL('http://127.0.0.1:5189/src/renderer/components/editor/test/rich-text-parity.browser.html')
    for (let i = 0; i < 100 && !await run('window.ready?.()'); i++) await wait(100)
    win.webContents.debugger.attach('1.3'); await cmd('Emulation.setFocusEmulationEnabled', { enabled: true })
    for (const preset of ['simple', 'literary', 'handwritten']) for (const theme of ['light', 'dark']) for (const blank of ['||||', '|  |  |  |']) {
      const source = `正文\n\n${blank}\n| --- | --- | --- |\n${blank}\n${blank}\n\n末尾`
      await run(`setFixture('重置组合输入夹具')`); await wait(80)
      await run(`document.documentElement.dataset.fontPreset=${JSON.stringify(preset)};document.documentElement.dataset.theme=${JSON.stringify(theme)};setFixture(${JSON.stringify(source)})`); await wait(200)
      await run('document.fonts.ready;cm().focus()')
      const point = await run(`(()=>{const r=document.querySelectorAll('#continuous .looma-continuous-table-row')[1].querySelectorAll('.looma-continuous-table-cell')[1].getBoundingClientRect();return{x:r.left+13,y:r.top+r.height/2}})()`)
      for (const type of ['mousePressed', 'mouseReleased']) await cmd('Input.dispatchMouseEvent', { type, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, modifiers: 0, clickCount: 1, ...point })
      await wait(100)
      const before = await run('({source:model.content,head:cm().state.selection.main.head})')
      const finalText = '中文Aé👩‍💻'
      for (const text of ['中', '中文A😀', finalText]) {
        await cmd('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length }); await wait(100)
        const result = await run(`(()=>{const cell=document.querySelectorAll('#continuous .looma-continuous-table-row')[1].querySelectorAll('.looma-continuous-table-cell')[1],walker=document.createTreeWalker(cell,NodeFilter.SHOW_TEXT),glyphs=[];let node;while(node=walker.nextNode()){if(node.parentElement.closest('.cm-widgetBuffer'))continue;const style=getComputedStyle(node.parentElement);for(const {segment:char,index:at} of new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(node.textContent)){const range=document.createRange();range.setStart(node,at);range.setEnd(node,at+char.length);const rect=range.getBoundingClientRect();glyphs.push({char,width:rect.width,height:rect.height,color:style.color,spacing:style.letterSpacing,font:style.fontFamily})}}return{source:model.content,html:cell.innerHTML,glyphs,rows:[...document.querySelectorAll('#continuous .looma-continuous-table-row')].map(row=>row.querySelectorAll('.looma-continuous-table-cell').length)}})()`)
        fs.appendFileSync(path.join(directory, 'glyphs.jsonl'), JSON.stringify({ preset, theme, blank, text, ...result }) + '\n')
        const visible = result.glyphs.filter(glyph => glyph.width > 0.1 && glyph.color !== 'rgba(0, 0, 0, 0)').map(glyph => glyph.char).join('')
        assert.equal(visible.trim(), text, 'live composition glyphs must be visible and syntax pipe must stay invisible')
        assert.deepEqual(result.rows, [3, 3, 3])
        assert.equal(result.source, before.source.slice(0, before.head) + text + before.source.slice(before.head))
        if (preset === 'handwritten' && blank === '||||' && text === finalText) {
          const clip = await run(`(()=>{const r=document.querySelectorAll('#continuous .looma-continuous-table-row')[1].querySelectorAll('.looma-continuous-table-cell')[1].getBoundingClientRect();return{x:Math.floor(r.x),y:Math.floor(r.y),width:Math.ceil(r.width),height:Math.ceil(r.height)}})()`)
          await run(`window.glyphProbe=document.createElement('style');glyphProbe.textContent='#continuous .cm-content,#continuous .cm-content *{caret-color:transparent!important}';document.head.append(glyphProbe)`)
          await wait(60)
          const painted = await win.webContents.capturePage(clip)
          fs.writeFileSync(path.join(directory, `${theme}-live-glyphs.png`), painted.toPNG())
          await run(`glyphProbe.textContent+='#continuous .cm-content,#continuous .cm-content *{-webkit-text-fill-color:transparent!important}'`)
          await wait(60)
          const hidden = (await win.webContents.capturePage(clip)).getBitmap(), pixels = painted.getBitmap()
          await run('glyphProbe.remove()')
          let changed = 0
          for (let i = 0; i < pixels.length; i += 4) if (Math.abs(pixels[i] - hidden[i]) + Math.abs(pixels[i + 1] - hidden[i + 1]) + Math.abs(pixels[i + 2] - hidden[i + 2]) > 12) changed++
          assert.ok(changed > 8, 'live composition must paint actual text pixels, not only report valid geometry')
          fs.appendFileSync(path.join(directory, 'glyphs.jsonl'), JSON.stringify({ theme, actualGlyphPixels: changed }) + '\n')
        }
      }
      await cmd('Input.insertText', { text: finalText }); await wait(200)
      assert.equal(await run('model.content'), before.source.slice(0, before.head) + finalText + before.source.slice(before.head))
      fs.writeFileSync(path.join(directory, `${preset}-${theme}-${blank.length}.png`), (await win.webContents.capturePage()).toPNG())
      for (const [key, modifiers, expected] of [['z', 4, before.source], ['Z', 12, before.source.slice(0, before.head) + finalText + before.source.slice(before.head)]]) {
        for (const type of ['keyDown', 'keyUp']) await cmd('Input.dispatchKeyEvent', { type, key, code: 'KeyZ', windowsVirtualKeyCode: 90, modifiers })
        await wait(120)
        assert.equal(await run('model.content'), expected, 'one undo/redo must cover all phonetic composition updates and the final commit')
      }
    }
    assert.deepEqual(errors, [])
    console.log('PASS composition glyph visibility, geometry, exact source and single-step composition undo/redo in light/dark padded/zero tables')
    console.log('REPORT', directory); win.destroy(); app.exit(0)
  } catch (error) { console.error(error); console.error(errors); console.log('REPORT', directory); win.destroy(); app.exit(1) }
})
