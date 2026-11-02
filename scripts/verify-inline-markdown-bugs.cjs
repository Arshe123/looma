// Isolated real editor regression; requires Vite --mode test on port 5189.
const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const profile = fs.mkdtempSync(path.join(process.env.TMPDIR, 'looma-inline-bugs-'))
app.setPath('userData', profile)
app.setPath('sessionData', profile)
const wait = (ms = 150) => new Promise(resolve => setTimeout(resolve, ms))
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1100, height: 850, show: false, webPreferences: { backgroundThrottling: false } })
  const run = code => win.webContents.executeJavaScript(code)
  const key = async keyCode => {
    app.focus({ steal: true }); win.focus()
    await run('editor().view.focus()'); await wait(30)
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode })
    await wait(250)
  }
  const fixture = async source => {
    await run(`setFixture(${JSON.stringify(source)})`); await wait(500)
    await run('editor().commands.setTextSelection(1); editor().view.focus()'); await wait()
  }
  try {
    await win.loadURL('http://127.0.0.1:5189/scripts/test/note-title.html')
    for (let i = 0; i < 100 && !await run('window.ready?.()'); i++) await wait()
    assert.ok(await run('ready()'))
    win.show(); app.focus({ steal: true }); win.focus(); await wait(400)

    const bold = '后续我在**🚨监控告警-海南监测系统-一期&二期**群 @ 她说明了排查结论'
    await fixture(bold)
    assert.equal(await run('document.querySelector(".tiptap strong")?.textContent'), '🚨监控告警-海南监测系统-一期&二期')
    assert.equal(await run('editor().state.doc.textContent'), bold)
    console.log('PASS emoji-boundary bold renders without changing source')

    const note = '[**症候群监测信息子系统**](../医渡云相关信息.md#6.%20症候群监测信息子系统)'
    for (const link of [note, '[前 **粗体** 后](note.md)', '[**粗 *斜* 体**](note.md)', '[**外链**](https://example.com)', '[同名](note.md)[同名](note.md)']) {
      await fixture(`a ${link} z`)
      const count = await run(`Array.from(document.querySelectorAll('.tiptap a')).filter(a => {
        const before = getComputedStyle(a, '::before');
        return a.getClientRects().length && before.content !== 'none' && before.display !== 'none';
      }).length`)
      assert.equal(count, link === '[同名](note.md)[同名](note.md)' ? 2 : 1, `${link} has exactly one icon per link`)
      assert.equal(await run('editor().state.doc.textContent'), `a ${link} z`)
    }
    console.log('PASS nested and adjacent links have one icon per reference')

    if (!process.argv.includes('--icons-only')) {
      for (const link of [note, '[引用](https://example.com)', '**粗体**', '*斜体*', '~~删除~~', '==高亮==', '`代码`']) {
        for (const right of ['右', '。', ' ', '🚨', 'e\u0301']) {
          const source = `a ${link}${right}侧 **其他** z`
          await fixture(source)
          const from = 1 + 'a '.length + link.length
          await run(`editor().commands.setTextSelection(${from + right.length})`)
          await key('Backspace')
          assert.equal(await run('editor().state.doc.textContent'), `a ${link}侧 **其他** z`, `Backspace removes only ${JSON.stringify(right)} after ${link}`)
          assert.equal(await run('props.content'), `a ${link}侧 **其他** z`)
          await run('editor().commands.undo()'); await wait(250)
          assert.equal(await run('editor().state.doc.textContent'), source, 'one undo restores exact source')
          await run('editor().commands.redo()'); await wait(250)
          assert.equal(await run('editor().state.doc.textContent'), `a ${link}侧 **其他** z`)
        }
        const source = `a 左${link} z`
        await fixture(source)
        await run('editor().commands.setTextSelection(3)')
        await key('Delete')
        assert.equal(await run('editor().state.doc.textContent'), `a ${link} z`, 'forward Delete preserves the following inline source')
      }
      await fixture(`a ${note}右侧文字 z`)
      await run(`editor().commands.setTextSelection(${1 + 'a '.length + note.length + 3})`)
      await key('Backspace')
      assert.equal(await run('editor().state.doc.textContent'), `a ${note}右侧字 z`, 'deleting farther-right text preserves the reference')
      await fixture(`a ${note}右侧文字 z`)
      const selected = 1 + 'a '.length + note.length
      await run(`editor().commands.setTextSelection({from:${selected},to:${selected + 1}})`)
      await key('Backspace')
      assert.equal(await run('editor().state.doc.textContent'), `a ${note}侧文字 z`, 'selected adjacent text deletes without damaging the reference')
      console.log('PASS real Backspace/Delete preserve adjacent source, Unicode graphemes, serialization and undo/redo')
    }
    win.destroy(); fs.rmSync(profile, { recursive: true, force: true }); app.exit(0)
  } catch (error) {
    console.error(error)
    win.destroy(); fs.rmSync(profile, { recursive: true, force: true }); app.exit(1)
  }
})
