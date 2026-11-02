// Production ChunkedMarkdownEditor integration; isolated in-memory workspace.
const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), os = require('node:os')
const directory = fs.mkdtempSync(path.join(os.homedir(), '.hermes/cache/scratch/looma-continuous-features-'))
app.setPath('userData', path.join(directory, 'profile'))
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1450, height: 850, webPreferences: { backgroundThrottling: false } })
  const run = code => win.webContents.executeJavaScript(code), errors = []
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message) })
  try {
    await win.loadURL('http://127.0.0.1:5189/src/renderer/components/editor/test/rich-text-parity.browser.html')
    win.webContents.debugger.attach('1.3')
    const cdp = (method, args) => win.webContents.debugger.sendCommand(method, args)
    await cdp('Emulation.setFocusEmulationEnabled', { enabled: true })
    const key = async (key, code, modifiers = 0) => { const windowsVirtualKeyCode = /^Key[A-Z]$/.test(code) ? code.charCodeAt(3) : key === 'Enter' ? 13 : 0; await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key, code, modifiers, windowsVirtualKeyCode }); await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers, windowsVirtualKeyCode }); await wait(100) }
    await run(`(async()=>{const {useWorkspaceStore}=await import('/src/renderer/stores/workspace.ts');const store=useWorkspaceStore(document.querySelector('#app').__vue_app__.config.globalProperties.$pinia);store.activeWorkspaceId='fixture';window.electronAPI.fs={listNotes:async()=>({success:true,data:['docs/目标 笔记.md']})};await setFixture('前文 ');cm().focus();cm().dispatch({selection:{anchor:model.length}})})()`)
    if (!process.argv.includes('--media')) {
      await cdp('Input.insertText', { text: '[[' })
      for (let i = 0; i < 100 && !await run(`!!(document.activeElement?.matches('input[placeholder^=搜索笔记]') && document.activeElement.closest('.absolute')?.querySelector('button'))`); i++) await wait(50)
      assert.equal(await run('document.querySelectorAll("input[placeholder^=搜索笔记]").length'), 1, 'production [[ must mount the shared picker exactly once')
      console.log('PICKER_BEFORE_ENTER', await run(`JSON.stringify({active:document.activeElement?.outerHTML?.slice(0,260),source:model.content,revision:model.revision,choices:[...document.querySelectorAll('input[placeholder^=搜索笔记]')].map(input=>input.closest('.absolute').textContent)})`))
      await key('Enter', 'Enter')
      assert.equal(await run('model.content'), '前文 [](docs/目标 笔记.md)')
      await cdp('Input.insertText', { text: '引用' }); await wait(150)
      assert.equal(await run('model.content'), '前文 [引用](docs/目标 笔记.md)')
      await key('z', 'KeyZ', 4); assert.equal(await run('model.content'), '前文 [](docs/目标 笔记.md)')
      await key('Z', 'KeyZ', 12); assert.equal(await run('model.content'), '前文 [引用](docs/目标 笔记.md)')
    }
    if (!process.argv.includes('--refs')) {
      await run(`(async()=>{await setFixture('图片前文');cm().focus();cm().dispatch({selection:{anchor:model.length}});const line=document.querySelector('#continuous .cm-line'),r=line.getBoundingClientRect();line.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:r.right-8,clientY:r.top+10}))})()`); await wait(100)
      assert.equal(await run('document.querySelector(".looma-continuous-menu-panel:not([hidden]) [data-action=image]")?.disabled'), false, 'production image menu must be enabled')
      await run('document.querySelector(".looma-continuous-menu-panel:not([hidden]) [data-action=image]").click()'); await wait(150)
      assert.equal(await run('!!document.querySelector("[aria-labelledby=insert-image-title]")'), true)
      await key('Enter', 'Enter')
      assert.equal(await run('model.content'), '图片前文![]()')
      assert.equal(await run('cm().state.selection.main.head'), '图片前文![]('.length)
      await key('z', 'KeyZ', 4); assert.equal(await run('model.content'), '图片前文')
    }
    assert.deepEqual(errors, [])
    fs.writeFileSync(path.join(directory, 'integration.png'), (await win.webContents.capturePage()).toPNG())
    console.log('PASS production host picker/template/history and real image menu/shared dialog; REPORT', directory)
    win.destroy(); app.exit(0)
  } catch (error) { console.error(error, errors, 'REPORT', directory); win.destroy(); app.exit(1) }
})
