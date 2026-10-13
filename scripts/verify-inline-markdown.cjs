// Isolated real MarkdownEditor; start Vite --mode test on port 5189 first.
const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const profile = fs.mkdtempSync(path.join(process.env.TMPDIR, 'looma-inline-'))
app.setPath('userData', profile)
app.setPath('sessionData', profile)
const wait = (ms = 100) => new Promise(resolve => setTimeout(resolve, ms))
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1100, height: 850, show: false, webPreferences: { backgroundThrottling: false } })
  const run = code => win.webContents.executeJavaScript(code)
  const key = async (keyCode, modifiers = []) => {
    // macOS may leave this isolated app inactive after another test window closes.
    app.focus({ steal: true }); win.focus()
    await run('editor().view.focus()')
    await wait(30)
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
    await wait()
  }
  try {
    await win.loadURL('http://127.0.0.1:5189/scripts/test/note-title.html')
    for (let i = 0; i < 100 && !await run('window.ready?.()'); i++) await wait()
    assert.ok(await run('ready()'))
    win.show(); app.focus({ steal: true }); win.focus(); await wait(300)
    await run('setFixture("a **bold** z")'); await wait(500)
    assert.equal(await run('editor().state.doc.textContent'), 'a **bold** z')
    await run('document.fonts.ready'); await wait(400)
    await run('editor().commands.setTextSelection(2);editor().view.focus()'); await wait(300)
    const before = await run('JSON.stringify(events)')

    await key('Right')
    assert.equal(await run('editor().state.selection.from'), 3, 'native right enters opening boundary')

    assert.equal(await run('document.querySelectorAll(".looma-inline-syntax").length'), 0)
    for (let pos = 4; pos <= 12; pos++) {
      await key('Right')
      assert.equal(await run('editor().state.selection.from'), pos, 'each delimiter is a native caret stop')
    }
    assert.equal(await run('document.querySelectorAll(".looma-inline-syntax").length'), 2)
    assert.equal(await run('JSON.stringify(events)'), before, 'display changes do not emit edits/saves')
    await key('Left')
    assert.equal(await run('editor().state.selection.from'), 11)
    assert.equal(await run('document.querySelectorAll(".looma-inline-syntax").length'), 0)
    await key('Left'); await key('Backspace'); await wait(200)
    assert.equal(await run('props.content'), 'a **bold* z', 'incomplete delimiter survives serialization')
    await key('z', ['meta']); await wait(200)
    assert.equal(await run('props.content'), 'a **bold** z', 'one undo reverses only editing')
    console.log('PASS real caret boundary entry/exit, delimiter deletion, incomplete save, undo, zero display events')

    const fixture = async source => {
      win.focus()
      await wait(200)
      await run(`setFixture(${JSON.stringify(source)})`)
      await wait(350)
      await run('editor().commands.setTextSelection(1);editor().view.focus()')
      await wait(150)
    }
    for (const [source, selector] of [
      ['**bold**', 'strong'], ['*italic*', 'em'], ['~~strike~~', 's'],
      ['==高亮==', 'mark'], ['`code`', 'code'], ['`` a`b ``', 'code'],
      ['[**粗体** 引用](note.md#L2 "标题")', 'a[href]'],
      ['**outer *inner* end**', 'strong em'],
    ]) {
      await fixture(`a ${source} z`)
      assert.equal(await run('editor().state.doc.textContent'), `a ${source} z`)
      assert.ok(await run(`!!document.querySelector('.tiptap ${selector}')`), `${source} renders when inactive`)
      const saved = await run('JSON.stringify(events)')
      await run('editor().commands.setTextSelection(4)')
      await wait()
      assert.equal(await run('document.querySelectorAll(".looma-inline-syntax").length'), 0, `${source} source expands: ${await run('JSON.stringify({from:editor().state.selection.from,focused:editor().isFocused,documentFocus:document.hasFocus()})')}`)
      assert.equal(await run('JSON.stringify(events)'), saved)
      await run('editor().commands.setTextSelection(1)'); await wait()
      assert.ok(await run(`!!document.querySelector('.tiptap ${selector}')`), `${source} collapses`)
    }
    console.log('PASS all inline families, variable backticks, nested marks and links; display-only transitions')

    await fixture('a **word** z')
    await run('editor().commands.setTextSelection(11)')
    await win.webContents.insertText('普通')
    await wait(200)
    assert.equal(await run('props.content'), 'a **word**普通 z', 'format outer boundary accepts plain text')
    await run('editor().commands.setTextSelection(5)')
    await key('b', ['meta']); await wait(200)
    assert.equal(await run('props.content'), 'a word普通 z', 'configured shortcut unwraps source formatting')
    await fixture('a word z')
    await run('editor().commands.setTextSelection({from:3,to:7})')
    await key('b', ['meta']); await wait(200)
    assert.equal(await run('props.content'), 'a **word** z', 'configured shortcut writes source delimiters')
    await key('z', ['meta']); await wait(200)
    assert.equal(await run('props.content'), 'a word z', 'format shortcut is one undo')
    console.log('PASS plain boundary typing and actual configured format shortcut / undo')

    await fixture('a **粗体** [引用](note.md) z')
    await run('editor().commands.setTextSelection({from:4,to:19})')
    const copy = await run(`import('/src/shared/utils/tiptap-clipboard.ts').then(m=>m.getTiptapClipboardCopyText(editor().state))`)
    assert.equal(copy, await run('editor().state.doc.textBetween(4,19,"\\n","")'), 'cross-region copy uses the selected source')
    await key('Backspace'); await wait(200)
    const deleted = await run('props.content')
    assert.ok(deleted.length < 'a **粗体** [引用](note.md) z'.length)
    await key('z', ['meta']); await wait(200)
    assert.equal(await run('props.content'), 'a **粗体** [引用](note.md) z')
    console.log('PASS cross-region copy, deletion and undo')

    await fixture('a **word** z')
    await run('editor().commands.setTextSelection(10)')
    await key('Backspace'); await wait(200)
    const incomplete = await run('props.content')
    await run('props.saveTrigger++'); await wait(200)
    assert.equal(await run('events.saves.at(-1)'), incomplete)
    const persistedFile = path.join(profile, 'incomplete.md')
    fs.writeFileSync(persistedFile, incomplete, 'utf8')
    await fixture('other document')
    await fixture(fs.readFileSync(persistedFile, 'utf8'))
    assert.equal(await run('editor().state.doc.textContent'), incomplete)
    await run('editor().commands.setTextSelection(4)')
    await win.webContents.insertText('新')
    await run('props.saveTrigger++'); await wait(250)
    assert.equal(await run('events.saves.at(-1)'), await run('editor().state.doc.textContent'), 'explicit save flushes latest source')
    console.log('PASS incomplete source save event, temporary-file write/read/reload, latest-input flush')

    for (const [source, expected] of [
      ['a `a < b && c > d` z', 'a `a < b && c > d` z'],
      ['a &amp; [查询](https://example.com?q=1&b=2) z', 'a &amp; [查询](https://example.com?q=1&b=2) z'],
      ['a [说明][ref] z\n\n[ref]: target.md#L12 "标题"', 'a [说明](target.md#L12 "标题") z'],
    ]) {
      let persisted = source
      for (let round = 0; round < 2; round++) {
        await fixture('unrelated document')
        await fixture(persisted)
        await win.webContents.insertText('新')
        await run('props.saveTrigger++'); await wait(250)
        persisted = await run('events.saves.at(-1)')
        assert.equal(persisted, '新'.repeat(round + 1) + expected, `source survives save/reload round ${round + 1}`)
        const file = path.join(profile, 'source-roundtrip.md')
        fs.writeFileSync(file, persisted, 'utf8')
        persisted = fs.readFileSync(file, 'utf8')
      }
    }
    console.log('PASS repeated save/reload preserves entities, code, URL queries and reference-link targets/titles')

    await fixture('# Heading **bold**\n\n> Quote *italic*\n\n```md\n**literal**\n```\n\n- item ==highlight==\n\n| Col |\n| --- |\n| `cell` |')
    await run('editor().commands.blur()'); await wait()
    for (const selector of ['h1 strong','blockquote em','pre code','li mark','td code']) {
      assert.ok(await run(`!!document.querySelector('.tiptap ${selector}')`), selector)
    }
    assert.equal(await run('document.querySelector(".tiptap pre code").textContent.replace(/^\\d+/, "")'), '**literal**')
    console.log('PASS heading, quote, list and table inline rendering; fenced code unchanged')

    await fixture('a [引用](note.md#L2) z')
    await run(`window.navigations=[]; window.externals=[];
      window.addEventListener('looma:open-note-ref',e=>navigations.push(e.detail));
      window.electronAPI.app={openExternal:async url=>externals.push(url)}; void 0;`)
    const clickLink = async modifiers => {
      const point = await run(`(()=>{const r=document.querySelector('.tiptap a').getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()`)
      win.webContents.sendInputEvent({ type:'mouseDown', button:'left', clickCount:1, ...point, modifiers })
      win.webContents.sendInputEvent({ type:'mouseUp', button:'left', clickCount:1, ...point, modifiers })
      await wait(250)
    }
    const referenceSelection = await run('editor().state.selection.toJSON()')
    await clickLink([])
    assert.equal(await run('navigations.length'), 0, 'plain note-reference click edits without navigation')
    assert.notDeepEqual(await run('editor().state.selection.toJSON()'), referenceSelection, 'plain click places the caret in the reference')
    assert.equal(await run('document.querySelectorAll(".looma-inline-syntax").length'), 0, 'plain click expands source')
    for (const modifier of ['meta', 'control']) {
      await run('editor().commands.setTextSelection(1)'); await wait()
      const selection = await run('editor().state.selection.toJSON()')
      const count = await run('navigations.length')
      await clickLink([modifier])
      assert.equal(await run('navigations.length'), count + 1, `${modifier} click navigates exactly once`)
      assert.deepEqual(await run('navigations.at(-1)'), { relativePath: 'note.md', anchor: { kind: 'line', line: 2 } })
      // On macOS Control-click also invokes native context-menu selection.
      // Check caret preservation with the platform's Command navigation gesture.
      if (modifier === 'meta') {
        assert.deepEqual(await run('editor().state.selection.toJSON()'), selection, 'Command navigation preserves the caret')
        assert.equal(await run('document.querySelectorAll(".looma-inline-syntax").length'), 2, 'Command navigation does not expand source')
      }
    }
    await fixture('a [外链](https://example.com) z')
    await clickLink([])
    assert.equal(await run('externals.length'), 0)
    await run('editor().commands.setTextSelection(1)'); await wait()
    await clickLink(['control'])
    assert.deepEqual(await run('externals'), ['https://example.com'])
    assert.equal(await run('document.querySelector("[data-looma-note-ref-source-editor]")'), null)
    console.log('PASS native normal-click edit, modifier-click internal/external navigation, detached editor removed')

    await fixture('a **word** z')
    await run('editor().commands.setTextSelection(5)')
    win.webContents.debugger.attach('1.3')
    await win.webContents.debugger.sendCommand('Input.imeSetComposition', { text:'中文', selectionStart:2, selectionEnd:2 })
    await wait()
    assert.equal(await run('document.querySelectorAll(".looma-inline-syntax").length'), 0)
    await win.webContents.debugger.sendCommand('Input.insertText', { text:'中文' })
    await wait(250)
    win.webContents.debugger.detach()
    assert.equal(await run('props.content'), 'a **中文word** z', 'composition commits exactly once')
    console.log('PASS Chromium composition input; native OS candidate-window testing remains manual')

    await fixture('a **word** z')
    const dragPoints = await run(`(()=>{const e=editor(),a=e.view.coordsAtPos(1),b=e.view.coordsAtPos(13);return [{x:Math.round(a.left),y:Math.round((a.top+a.bottom)/2)},{x:Math.round(b.left),y:Math.round((b.top+b.bottom)/2)}]})()`)
    win.webContents.sendInputEvent({ type:'mouseDown', button:'left', clickCount:1, ...dragPoints[0] })
    win.webContents.sendInputEvent({ type:'mouseMove', button:'left', ...dragPoints[1] })
    await wait(200)
    assert.equal(await run('document.querySelectorAll(".looma-inline-syntax").length'), 2, 'dragging freezes the rendered geometry')
    win.webContents.sendInputEvent({ type:'mouseUp', button:'left', clickCount:1, ...dragPoints[1] })
    await wait(200)
    assert.equal(await run('editor().state.selection.empty'), false)
    assert.equal(await run('document.querySelectorAll(".looma-inline-syntax").length'), 0, 'selected syntax expands after drag release')
    console.log('PASS native drag selection without mid-gesture reflow')

    await fixture('a  z')
    await run(`editor().commands.setTextSelection(3);
      const transfer=new DataTransfer();
      transfer.setData('text/html','<p><a href="note.md" title="标题"><strong>粘贴</strong></a></p>');
      transfer.setData('text/plain','粘贴');
      editor().view.dom.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:transfer}));`)
    await wait(300)
    assert.equal(await run('props.content'), 'a [**粘贴**](note.md "标题") z', 'HTML paste becomes editable source, preserving nesting/title')
    await key('z',['meta']); await wait(200)
    assert.equal(await run('props.content'), 'a  z', 'HTML normalization remains one undo')
    console.log('PASS HTML paste preserves inline formatting as source in one undo event')
    win.destroy(); fs.rmSync(profile, { recursive: true, force: true }); app.exit(0)
  } catch (error) {
    console.error(error)
    win.destroy(); fs.rmSync(profile, { recursive: true, force: true }); app.exit(1)
  }
})
