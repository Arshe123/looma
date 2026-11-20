// Real ordinary/continuous editor copy paths; isolated in-memory clipboard only.
// Start Vite --mode test on 127.0.0.1:5189 before running this script.
const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const directory = fs.mkdtempSync(path.join(os.homedir(), '.hermes/cache/scratch/looma-rich-copy-'))
app.setPath('userData', path.join(directory, 'profile'))
const wait = (ms = 80) => new Promise(resolve => setTimeout(resolve, ms))
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1500, height: 850, webPreferences: { backgroundThrottling: false } })
  const run = code => win.webContents.executeJavaScript(code)
  try {
    await win.loadURL('http://127.0.0.1:5189/src/renderer/components/editor/test/rich-text-parity.browser.html')
    win.webContents.debugger.attach('1.3')
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
    for (let i = 0; i < 100 && !await run('window.ready?.()'); i++) await wait()
    assert.equal(await run('ready()'), true)
    await run(`Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.copied=text}}});true`)
    const source = '前 **粗体** *斜体* ~~删除~~ ==高亮== [**链接**](note.md) 与 \u0060**代码**\u0060 后'
    const expected = '前 粗体 斜体 删除 高亮 链接 与 **代码** 后'
    const reset = async text => {
      await run(`(async()=>{flush();await setFixture('重置');await setFixture(${JSON.stringify(text)})})()`)
      await wait(450)
    }
    const select = host => run(host === 'ordinary'
      ? 'pm().commands.selectAll();pm().view.focus();true'
      : 'cm().dispatch({selection:{anchor:0,head:model.length}});cm().focus();true')
    const menu = async (host, action, atSelection = false) => {
      await run(`(()=>{const root=${host === 'ordinary' ? 'pm().view.dom' : 'cm().contentDOM'},r=${atSelection ? host === 'ordinary' ? 'pm().view.coordsAtPos(pm().state.selection.from)' : 'cm().coordsAtPos(cm().state.selection.main.from)' : "root.querySelector('p,.cm-line').getBoundingClientRect()"};root.querySelector('p,.cm-line').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:r.left+2,clientY:(r.top+r.bottom)/2}))})()`)
      await wait()
      const selector = host === 'ordinary' ? '#ordinary [data-looma-editor-context-menu]' : '.looma-continuous-menu-panel'
      if (action === 'copy-source') {
        const badge = await run(`(()=>{const button=document.querySelector(${JSON.stringify(selector + ' [data-action="copy-source"]')}),label=button?.firstElementChild,hint=button?.lastElementChild;
          return {text:hint?.textContent,expected:window.copySourceHint??'⌘ + Shift + C',visible:!!hint&&getComputedStyle(hint).display!=='none'&&hint.getBoundingClientRect().width>0,
          separated:!!label&&!!hint&&label.getBoundingClientRect().right<=hint.getBoundingClientRect().left}})()`)
        assert.equal(badge.text, badge.expected, `${host}: source copy menu shows current configured shortcut`)
        assert.equal(badge.visible && badge.separated, true, `${host}: shortcut badge is visible to the right of the label`)
      }
      assert.equal(await run(`(()=>{const button=document.querySelector(${JSON.stringify(selector + ' [data-action="' + action + '"]')});if(!button||button.disabled)return false;button.click();return true})()`), true)
      await wait()
      return run('copied')
    }
    for (const host of ['ordinary', 'continuous']) {
      await reset(source)
      await select(host)
      const before = await run('JSON.stringify({source:model.content,doc:pm().getJSON(),events})')
      const copied = await run(`(()=>{const data=new DataTransfer(),event=new ClipboardEvent('copy',{bubbles:true,cancelable:true,clipboardData:data});${host === 'ordinary' ? 'pm().view.dom' : 'cm().contentDOM'}.dispatchEvent(event);return {claimed:event.defaultPrevented,text:data.getData('text/plain')}})()`)
      assert.deepEqual(copied, { claimed: true, text: expected }, `${host}: native copy receiver`)
      assert.equal(await menu(host, 'copy'), expected, `${host}: actual context copy action`)
      await select(host)
      assert.equal(await menu(host, 'copy-source'), source, `${host}: explicit source copy is unchanged`)
      await wait(180)
      assert.equal(await run('JSON.stringify({source:model.content,doc:pm().getJSON(),events})'), before, `${host}: copy does not edit, save or rewrite the document`)
      console.log('PASS', host, 'native copy, menu copy, source copy, zero document/save changes')
    }
    await reset(source)
    await select('ordinary')
    await run('window.copied=null')
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'c', code: 'KeyC', windowsVirtualKeyCode: 67, modifiers: 4 })
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'c', code: 'KeyC', windowsVirtualKeyCode: 67, modifiers: 4 })
    await wait()
    assert.equal(await run('copied'), expected, 'real Command+C uses the shared plain-text path')
    console.log('PASS real Command+C; clipboard writes intercepted in isolated renderer')
    await reset('**开头**\n\n中间\n\n[结尾](note.md)')
    for (const host of ['ordinary', 'continuous']) {
      const result = await run(`(()=>{
        if(${host === 'ordinary'}){let start,end;pm().state.doc.descendants((n,p)=>{if(n.isText&&n.text.includes('头'))start=p+n.text.indexOf('头');if(n.isText&&n.text.includes('尾'))end=p+n.text.indexOf('尾')+1});pm().commands.setTextSelection({from:start,to:end})}
        else cm().dispatch({selection:{anchor:3,head:model.content.indexOf('尾')+1}})
        const data=new DataTransfer();${host === 'ordinary' ? 'pm().view.dom' : 'cm().contentDOM'}.dispatchEvent(new ClipboardEvent('copy',{bubbles:true,cancelable:true,clipboardData:data}));return data.getData('text/plain')
      })()`)
      assert.equal(result, '头\n中间\n结尾', `${host}: cross-block partial inline selection`)
    }
    console.log('PASS cross-block partial selections in both real editors')
    for (const [text, first, last, expected] of [
      ['**加粗**123*斜体*123', '加粗', '斜体', '**加粗**123*斜体*'],
      ['**加粗**', '加粗', '加粗', '**加粗**'],
      ['==高亮==', '高亮', '高亮', '==高亮=='],
      ['[**链接**](note.md "标题")', '链接', '链接', '[**链接**](note.md "标题")'],
      ['==*嵌套*==', '嵌套', '嵌套', '==*嵌套*=='],
    ]) {
      await reset(text)
      for (const host of ['ordinary', 'continuous']) {
        for (const reverse of [false, true]) {
          await run(`(()=>{const from=${text.indexOf(first)},to=${text.indexOf(last) + last.length};
            if(${host === 'ordinary'}){let start;pm().state.doc.descendants((n,p)=>{if(n.isText&&start===undefined)start=p});pm().commands.setTextSelection({from:start+${reverse ? 'to' : 'from'},to:start+${reverse ? 'from' : 'to'}});pm().view.focus()}
            else{cm().dispatch({selection:{anchor:${reverse ? 'to' : 'from'},head:${reverse ? 'from' : 'to'}}});cm().focus()}})()`)
          const before = await run('JSON.stringify({source:model.content,doc:pm().getJSON(),events})')
          assert.equal(await menu(host, 'copy-source', true), expected, `${host}: complete selected source ${text}, reverse=${reverse}`)
          if (text === '**加粗**' && !reverse) {
            for (const [platform, modifiers] of [['darwin', 12], ['win32', 10]]) {
              await run(`window.electronAPI.platform=${JSON.stringify(platform)};window.copied=null;true`)
              await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'C', code: 'KeyC', windowsVirtualKeyCode: 67, modifiers })
              await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'C', code: 'KeyC', windowsVirtualKeyCode: 67, modifiers })
              await wait()
              assert.equal(await run('copied'), expected, `${host}: ${platform} source shortcut completes hidden delimiters`)
            }
            await run(`window.electronAPI.platform='darwin';true`)
          }
          await wait(180)
          assert.equal(await run('JSON.stringify({source:model.content,doc:pm().getJSON(),events})'), before, `${host}: completing clipboard source never changes document/save`)
        }
      }
    }
    console.log('PASS inline-edge source menus and Command/Ctrl+Shift+C: single, mixed, nested, links, highlight, both directions, no edits')
    await reset('**加粗**')
    await run(`(async()=>{const {useSettingsStore}=await import('/src/renderer/stores/settings.ts');useSettingsStore().settings.editor.appShortcuts.copySource.key='K';window.copySourceHint='⌘ + Shift + K'})()`)
    for (const host of ['ordinary', 'continuous']) {
      await select(host)
      assert.equal(await menu(host, 'copy-source'), '**加粗**', `${host}: custom shortcut badge keeps source action working`)
    }
    console.log('PASS ordinary/continuous menu shortcut badges: default and custom binding, visible right-side layout')
    console.log('PASS rich-text copy regression', directory)
    win.destroy(); app.exit(0)
  } catch (error) {
    console.error(error); win.destroy(); app.exit(1)
  }
}).catch(error => { console.error(error); app.exit(1) })
