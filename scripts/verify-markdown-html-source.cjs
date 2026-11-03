// Real MarkdownEditor regression; requires Vite --mode test on port 5189.
const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const profile = fs.mkdtempSync(path.join(process.env.TMPDIR, 'looma-html-source-'))
app.setPath('userData', path.join(profile, 'profile'))
app.setPath('sessionData', path.join(profile, 'session'))
const wait = (ms = 100) => new Promise(resolve => setTimeout(resolve, ms))
const sources = [
  'tune2fs -l <dev>',
  '路径 /proc/<PID>/cgroup',
  '<dev>',
  '<custom>保留内容</custom>',
  '<div data-note="original">\n原始内容\n</div>',
  '前 <span class="custom">原文</span> 后',
  '前 <!-- 注释 --> 后',
  '未闭合 <dev',
  'a <br class="custom"> b',
  '<img src="image.png" data-custom="keep">',
  '<img alt=" src=missing">',
  '<img src="">',
  '<img src="first.png" src="second.png">',
  '前文\n\n<div>\n原文 **内容**\n</div>\n\n后文',
  '前 <客户名>、>3 秒、< 7.5、A&B 后',
  '- **`iptables` 返回码恒 255 ⇒ 二进制被替换**（dockerd 靠退出码建 DOCKER 链）',
  '- 定式链路：**`/proc/<PID>/cgroup` 取 64 位容器 ID → `docker inspect`**',
  '60~80W / 44~50℃',
  'a &amp; &lt; &#38; z',
  '命令 `tune2fs -l <dev>`',
  '```sh\ntune2fs -l <dev>\n```',
]
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1100, height: 850, webPreferences: { backgroundThrottling: false } })
  const run = code => win.webContents.executeJavaScript(code)
  const load = async source => {
    await run(`setFixture('隔离中转')`); await wait(200)
    await run(`setFixture(${JSON.stringify(source)})`); await wait(400)
    await run('editor().commands.blur(); events.saves=[]; events.updates=[]; events.edits=0')
    await wait(100)
  }
  const markdown = () => run('editor().markdown.serialize(editor().getJSON())')
  try {
    await win.loadURL('http://127.0.0.1:5189/scripts/test/note-title.html')
    win.webContents.debugger.attach('1.3')
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
    await win.webContents.debugger.sendCommand('Page.bringToFront')
    for (let i = 0; i < 100 && !await run('window.ready?.()'); i++) await wait()
    assert.ok(await run('ready()'))
    for (const source of sources) {
      await load(source)
      assert.equal((await markdown()).trimEnd(), source, `opening preserves ${JSON.stringify(source)}`)
      assert.deepEqual(await run('events'), { edits: 0, updates: [], saves: [], loads: 0 })
      for (let round = 0; round < 3; round++) {
        // Input outside the protected fragment still serializes the complete document.
        await run('editor().commands.insertContentAt(editor().state.doc.content.size, {type:"paragraph",content:[{type:"text",text:"尾部"}]}); editor().commands.setTextSelection(editor().state.doc.content.size-1); editor().view.focus(); events.saves=[]')
        await win.webContents.debugger.sendCommand('Input.insertText', { text: '编辑' })
        await wait(1400)
        const saved = await run('events.saves.at(-1)')
        assert.equal(typeof saved, 'string', 'actual native input triggers autosave')
        assert.ok(saved.startsWith(source + '\n\n'), `save preserves ${JSON.stringify(source)}: ${JSON.stringify(saved)}`)
        const target = path.join(profile, 'fixture.md')
        fs.writeFileSync(target, saved)
        const disk = fs.readFileSync(target, 'utf8')
        await load(disk)
        assert.equal((await markdown()).trimEnd(), disk.trimEnd(), 'file read/reload remains stable')
      }
      console.log('PASS source + native input/autosave/read/reload:', JSON.stringify(source))
    }
    await load('tune2fs -l <dev>')
    await run('editor().commands.setTextSelection(1 + editor().state.doc.textContent.indexOf(">")); editor().view.focus()')
    await win.webContents.debugger.sendCommand('Input.insertText', { text: 'ice' })
    await wait(1400)
    assert.equal(await run('events.saves.at(-1)'), 'tune2fs -l <device>')
    await run('editor().commands.undo()'); await wait(250)
    assert.equal(await markdown(), 'tune2fs -l <dev>')
    await run('editor().commands.redo()'); await wait(250)
    assert.equal(await markdown(), 'tune2fs -l <device>')
    console.log('PASS placeholder remains natively editable with undo/redo')
    await load('a <br> b')
    assert.equal(await run('editor().getJSON().content[0].content.filter(n=>n.type==="hardBreak").length'), 1)
    await load('<img src="image.png" alt="图" title="标题">')
    for (let round = 0; round < 3; round++) {
      const image = await run('editor().getJSON().content.find(n=>n.type==="image")?.attrs')
      assert.equal(image.src, 'image.png')
      assert.equal(image.alt, '图')
      assert.equal(image.title, '标题')
      await load(await markdown())
    }
    console.log('PASS supported HTML break/image remain structural')
    win.destroy(); fs.rmSync(profile, { recursive: true, force: true }); app.exit(0)
  } catch (error) {
    console.error(error)
    win.destroy(); fs.rmSync(profile, { recursive: true, force: true }); app.exit(1)
  }
})
