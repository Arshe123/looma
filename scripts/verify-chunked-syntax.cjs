// Stage 3: isolated production editor, incremental syntax and real input.
const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const directory = fs.mkdtempSync(path.join(os.homedir(), '.hermes/cache/scratch/looma-chunked-syntax-'))
app.setPath('userData', path.join(directory, 'profile'))
const wait = (ms = 100) => new Promise(resolve => setTimeout(resolve, ms))
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1100, height: 850, show: true, webPreferences: { backgroundThrottling: false } })
  const run = source => win.webContents.executeJavaScript(source)
  const errors = [], timings = []
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message) })
  const until = async (source, label) => {
    for (let i = 0; i < 150; i++) { if (await run(source)) return; await wait(50) }
    throw new Error(`Timeout: ${label}`)
  }
  const focus = async () => {
    for (let i = 0; i < 30; i++) {
      app.focus({ steal: true }); win.focus(); await run('cm().focus()'); await wait(50)
      if (await run('document.hasFocus() && cm().hasFocus')) return
    }
    throw new Error('native focus unavailable')
  }
  const fixture = async source => {
    await run(`setFixture(${JSON.stringify(source)})`)
    await until(`model().length === ${source.length} && cm().state.doc.length === ${source.length}`, 'fixture applied')
    await run('start(0)'); await focus(); await wait(150)
  }
  const key = async (keyCode, modifiers = []) => {
    await focus()
    for (const type of ['keyDown', 'keyUp']) win.webContents.sendInputEvent({ type, keyCode, modifiers })
    await wait(200)
  }
  try {
    await win.loadURL('http://127.0.0.1:5189/src/renderer/components/editor/test/chunked-editor.browser.html')
    await until('window.ready?.() && !!cm()', 'production editor')
    await run('document.fonts.ready'); await focus(); win.webContents.debugger.attach('1.3')
    await run('window.targets=[];window.addEventListener("looma:open-note-ref",event=>targets.push(event.detail))')
    const long = '前文\n\n[**' + '长标签'.repeat(4000) + '**](other.md#L7 "标题")\n\n末尾'
    await fixture(long)
    await until('!!document.querySelector(".looma-continuous-link .looma-continuous-bold, .looma-continuous-bold .looma-continuous-link")', 'long nested link label')
    const revision = await run('model().revision')
    await run('select(12)'); await focus()
    await until('!!document.querySelector(".looma-continuous-expanded-source")', 'expanded long link')
    const beforeNavigation = await run('JSON.stringify(model().selection)')
    const point = await run('(()=>{const r=cm().coordsAtPos(12);return{x:r.left+1,y:(r.top+r.bottom)/2}})()')
    for (const type of ['mousePressed', 'mouseReleased']) await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, modifiers: 4, ...point })
    await until('targets.length===1', 'long expanded link navigation')
    assert.equal(await run('targets[0].relativePath'), 'other.md')
    assert.equal(await run('JSON.stringify(model().selection)'), beforeNavigation)
    assert.equal(await run('model().revision'), revision)
    assert.equal(await run('model().content'), long)
    console.log('PASS long nested label, enclosing expansion, actual Command navigation and unchanged source/selection')

    const multiline = '前文 **粗体\n续行** 后文 ==高亮\n第二行==\n\n> - 引用 **跨行\n>   格式**\n\n```md\n**字面内容**\n```'
    await fixture(multiline)
    await until('document.querySelectorAll(".looma-continuous-bold").length >= 4', 'multiline nested formats')
    assert.equal(await run('document.querySelectorAll(".looma-continuous-highlight").length'), 2)
    assert.equal(await run('model().content'), multiline)
    assert.equal(await run('document.querySelectorAll(".cm-editor").length'), 1)
    console.log('PASS cross-physical-line bold/highlight, nested block context and literal fenced content')

    const referenced = '前文 [**引用**][My Ref] [My Ref][] [My Ref] [未知][missing]\n\n[my ref]: old.md#L2 "标题"'
    await fixture(referenced)
    await until(`document.querySelectorAll(${JSON.stringify('a[data-href="old.md#L2"]')}).length >= 3`, 'worker reference index')
    const start = referenced.indexOf('old.md')
    await run(`select(${start},${start + 3})`); await focus()
    await win.webContents.debugger.sendCommand('Input.insertText', { text: 'new' })
    await until('model().content.includes("new.md#L2")', 'definition native edit')
    await until(`document.querySelectorAll(${JSON.stringify('a[data-href="new.md#L2"]')}).length >= 3`, 'fresh revision reference index')
    assert.equal(await run(`document.querySelectorAll(${JSON.stringify('a[data-href="old.md#L2"]')}).length`), 0)
    assert.equal(await run('model().content'), referenced.replace('old.md', 'new.md'))
    await key('z', ['meta'])
    assert.equal(await run('model().content'), referenced)
    console.log('PASS full/collapsed/shortcut reference definitions, unresolved literal fallback, native definition edit and undo')

    for (const [name, source] of [
      ['long-link', '前文\n\n[' + '标签'.repeat(10_000) + '](other.md#L2)\n\n末尾'],
      ['long-format', '前文\n\n**' + '正文'.repeat(10_000) + '**\n\n末尾'],
      ['nested-format', '前文\n\n**外层 *斜体 ~~删除 ==高亮==~~* 末尾**\n\n末尾'],
      ['two-million-single-line', 'x'.repeat(2_000_000)],
    ]) {
      const elapsed = await run(`(async()=>{const t=performance.now();await setFixture(${JSON.stringify(source)});start(0);await new Promise(r=>requestAnimationFrame(()=>r()));return performance.now()-t})()`)
      await until(`cm().state.doc.length===${source.length}`, name)
      await focus()
      await run('select(0)')
      const before = await run('performance.now()')
      await win.webContents.debugger.sendCommand('Input.insertText', { text: '新' })
      await until(`model().length===${source.length + 1}`, 'native input')
      const inputMs = await run('performance.now()') - before
      await key('z', ['meta'])
      assert.equal(await run('model().content'), source)
      const dom = await run('cm().contentDOM.textContent.length')
      if (source.length === 2_000_000) assert.ok(dom < 50_000, 'huge physical line remains viewport-bounded')
      timings.push({ name, rendererFirstFrameMs: elapsed, inputRoundTripMs: inputMs, sourceCharacters: source.length, domCharacters: dom })
    }
    assert.deepEqual(errors, [])
    fs.writeFileSync(path.join(directory, 'results.json'), JSON.stringify({ timings }, null, 2))
    console.log(JSON.stringify({ timings }, null, 2))
    console.log('PASS bounded long syntax, measured renderer/input round trips and exact native undo; REPORT', directory)
    win.webContents.debugger.detach(); win.destroy(); app.exit(0)
  } catch (error) { console.error(error); console.error('Renderer errors:', errors); win.destroy(); app.exit(1) }
})
