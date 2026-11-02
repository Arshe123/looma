// Isolated DOM clipboard receiver. Never reads/writes Electron/system clipboard.
// Requires Vite --mode test at 127.0.0.1:5189.
const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const scratch = fs.mkdtempSync(path.join(os.homedir(), '.hermes/cache/scratch/looma-continuous-clipboard-'))
app.setPath('userData', path.join(scratch, 'profile'))
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1200, height: 800, webPreferences: { backgroundThrottling: false } })
  const remote = []
  win.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    if (/^https?:/.test(details.url) && !details.url.startsWith('http://127.0.0.1:5189/')) {
      remote.push(details.url); callback({ cancel: true })
    } else callback({})
  })
  try {
    await win.loadURL('http://127.0.0.1:5189/src/renderer/components/editor/test/rich-text-parity.browser.html')
    win.webContents.debugger.attach('1.3')
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
    const result = await win.webContents.executeJavaScript(`(async () => {
      const api = await import('/src/renderer/components/editor/continuousMarkdownClipboard.ts')
      if (typeof api.continuousClipboardHtmlToMarkdown !== 'function') throw new Error('HTML-to-Markdown adapter is missing')
      const html = '<h2>标题</h2><p><strong>粗 <em>嵌套</em></strong> <a href="notes/a.md#标题" title="引用">链接</a> <s>删除</s> <mark>亮</mark></p><ul><li>一级<ul><li>二级</li></ul></li></ul><table><tr><th>甲</th><th>乙</th></tr><tr><td><strong>值</strong></td><td>2</td></tr></table><pre><code class="language-js">const x = 1 &lt; 2;</code></pre><img src="assets/a.png" alt="图" title="图片">'
      const markdown = api.continuousClipboardHtmlToMarkdown(html, document)
      const hostile = '<script>window.__clipboardExecuted=true</script><iframe src="https://invalid.example/frame"></iframe><img src="https://invalid.example/image" onload="window.__clipboardExecuted=true"><p onclick="alert(1)"><a href="javascript:alert(1)">安全文字</a><strong>保留</strong></p><object data="https://invalid.example/object"></object><style>@import "https://invalid.example/css";</style>'
      const sanitized = api.continuousClipboardHtmlToMarkdown(hostile, document)
      const { getSchema } = await import('/node_modules/.vite/deps/@tiptap_core.js')
      const { DOMParser } = await import('/node_modules/.vite/deps/@tiptap_pm_model.js')
      const template = document.createElement('template'); template.innerHTML = html
      const debug = DOMParser.fromSchema(pm().schema).parse(template.content).toJSON()
      const anchor = template.content.querySelector('a'); const linkRules = pm().schema.marks.link.spec.parseDOM.map(rule => ({tag:rule.tag, attrs:rule.getAttrs?.(anchor), href:anchor.getAttribute('href')}))
      let embeddedImageRejected = false
      try { api.continuousClipboardHtmlToMarkdown('<img src="data:image/png;base64,AAAA" alt="截图">', document) }
      catch (error) { embeddedImageRejected = /图片.*导入/.test(String(error)) }
      return { markdown, sanitized, executed: !!window.__clipboardExecuted, embeddedImageRejected, debug, linkRules }
    })()`)
    console.log(JSON.stringify(result))
    assert.match(result.markdown, /## 标题/)
    assert.match(result.markdown, /\*\*粗 \*嵌套\*\*\*/)
    assert.match(result.markdown, /\[链接\]\(notes\/a\.md#标题 "引用"\)/)
    assert.match(result.markdown, /~~删除~~/)
    assert.match(result.markdown, /==亮==/)
    assert.match(result.markdown, /一级/)
    assert.match(result.markdown, /二级/)
    assert.match(result.markdown, /\|.*甲.*\|.*乙.*\|/)
    assert.match(result.markdown, /```js\nconst x = 1 < 2;\n```/)
    assert.match(result.markdown, /!\[图\]\(assets\/a\.png "图片"\)/)
    assert.doesNotMatch(result.sanitized, /javascript:|iframe|script|onclick|onload|@import|object/i)
    assert.match(result.sanitized, /安全文字/)
    assert.equal(result.executed, false)
    assert.equal(result.embeddedImageRejected, true, 'HTML image data must be imported, never written into Markdown')
    const native = await win.webContents.executeJavaScript(`(async()=>{
      await setFixture('原生剪贴板重置');await setFixture('原文');cm().focus();cm().dispatch({selection:{anchor:0,head:model.length}})
      const data=new DataTransfer();data.setData('text/plain','回退文本');data.setData('text/html','<h2>原生标题</h2><p><strong>原生粗体</strong></p>')
      cm().contentDOM.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}))
      await new Promise(resolve=>setTimeout(resolve,100))
      const source=model.content
      cm().dispatch({selection:{anchor:0,head:model.length}})
      const receiver=new DataTransfer();cm().contentDOM.dispatchEvent(new ClipboardEvent('copy',{bubbles:true,cancelable:true,clipboardData:receiver}))
      state.sourceOnly=true;await new Promise(resolve=>setTimeout(resolve,50))
      const raw=new DataTransfer();cm().contentDOM.dispatchEvent(new ClipboardEvent('copy',{bubbles:true,cancelable:true,clipboardData:raw}))
      return {source,plain:receiver.getData('text/plain'),raw:raw.getData('text/plain')}
    })()`)
    assert.equal(native.source, '## 原生标题\n\n**原生粗体**', 'real host native paste must use the HTML adapter')
    assert.equal(native.plain, '原生标题\n**原生粗体**')
    assert.equal(native.raw, native.source, 'source mode must preserve literal Markdown')
    const menu = await win.webContents.executeJavaScript(`(async()=>{
      state.sourceOnly=false;await new Promise(resolve=>setTimeout(resolve,100));cm().dispatch({selection:{anchor:0,head:model.length}})
      let copied='';Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{copied=text},readText:async()=> '回退文本',read:async()=>[{types:['text/plain','text/html'],getType:async type=>new Blob([type==='text/html'?'<p><em>菜单粘贴</em></p>':'回退文本'],{type})}]}})
      const action=async id=>{const line=document.querySelector('#continuous .cm-line'),r=line.getBoundingClientRect();line.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:r.left+24,clientY:r.top+10}));await new Promise(resolve=>setTimeout(resolve,50));const button=document.querySelector('.looma-continuous-menu-panel:not([hidden]) [data-action="'+id+'"]');if(!button)throw Error('missing menu '+id);button.click();await new Promise(resolve=>setTimeout(resolve,100))}
      await action('copy');const plain=copied
      await action('copy-source');const raw=copied
      await action('paste')
      const pasted=model.content,structural=[]
      const {getTiptapSelectionDocument}=await import('/src/shared/utils/tiptap-clipboard.ts')
      const {serializeMarkdownAst}=await import('/src/shared/utils/markdown-rich-text.ts')
      for(const [source,word] of [['## 标题其余','标题'],['\u0060\u0060\u0060js\\nconst value = 1\\n\u0060\u0060\u0060','value']]){
        await setFixture('结构选区重置');await setFixture(source);await new Promise(resolve=>setTimeout(resolve,200))
        let position=null;pm().state.doc.descendants((node,at)=>{if(position===null&&node.isText&&node.text.includes(word))position=at+node.text.indexOf(word)})
        pm().commands.setTextSelection({from:position,to:position+word.length})
        const expected=serializeMarkdownAst({getJSON:()=>getTiptapSelectionDocument(pm().state),markdown:pm().markdown})
        const from=source.indexOf(word);cm().dispatch({selection:{anchor:from,head:from+word.length}})
        await action('copy-source');structural.push({expected,actual:copied})
      }
      return {plain,raw,pasted,structural}
    })()`)
    assert.equal(menu.plain, native.plain, 'context copy and native copy must share semantics')
    assert.equal(menu.raw, native.source)
    assert.equal(menu.pasted, '*菜单粘贴*', 'context paste must use HTML when available')
    for (const selection of menu.structural) assert.equal(selection.actual, selection.expected, 'source-copy must retain the same structural context as ordinary Tiptap')
    await win.loadURL('http://127.0.0.1:5189/src/renderer/components/editor/test/chunked-editor.browser.html')
    const crossViewport=await win.webContents.executeJavaScript(`(async()=>{
      for(let i=0;i<100&&!window.ready?.();i++)await new Promise(resolve=>setTimeout(resolve,50))
      const paragraphs=Array.from({length:6000},(_,index)=>'正文 '+index+' 跨视口完整内容😀 不可丢失的末尾校验')
      window.largeClipboardSource='## 跨视口标题\\n\\n'+paragraphs.join('\\n\\n')+'\\n\\n## 末尾标题'
      await setFixture(largeClipboardSource);await new Promise(resolve=>setTimeout(resolve,200))
      cm().focus();cm().dispatch({selection:{anchor:0,head:model().length}})
      const copy=()=>{const data=new DataTransfer();const event=new ClipboardEvent('copy',{bubbles:true,cancelable:true,clipboardData:data});cm().contentDOM.dispatchEvent(event);if(!event.defaultPrevented)throw Error('large-copy receiver not claimed');return data.getData('text/plain')}
      const plain=copy(),expected='跨视口标题\\n'+paragraphs.join('\\n')+'\\n末尾标题'
      const renderedCharacters=document.querySelector('.chunked-markdown-editor').textContent.length
      document.querySelector('button[title="编辑模式"]').click()
      for(let i=0;i<100&&!document.querySelector('.chunked-source-only .cm-content');i++)await new Promise(resolve=>setTimeout(resolve,50))
      cm().focus();cm().dispatch({selection:{anchor:0,head:model().length}})
      const raw=copy(),data=new DataTransfer();data.setData('text/plain','跨视口替换全部')
      cm().contentDOM.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}))
      return {plainExact:plain===expected,sourceExact:raw===largeClipboardSource,characters:largeClipboardSource.length,renderedCharacters,replacedExactly:model().content==='跨视口替换全部'}
    })()`)
    assert.equal(crossViewport.plainExact,true,'rich copy includes every unmounted paragraph')
    assert.equal(crossViewport.sourceExact,true,'source copy preserves the complete canonical Markdown')
    assert.ok(crossViewport.renderedCharacters<60000,'copy does not require mounting all text')
    assert.equal(crossViewport.replacedExactly,true,'cross-viewport selection is replaced completely')
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyDown',key:'z',code:'KeyZ',windowsVirtualKeyCode:90,modifiers:4})
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyUp',key:'z',code:'KeyZ',windowsVirtualKeyCode:90,modifiers:4})
    assert.equal(await win.webContents.executeJavaScript('model().content===largeClipboardSource'),true,'one canonical undo restores every unmounted byte')
    assert.deepEqual(remote, [])
    console.log('PASS cross-viewport copy/replace/one undo',JSON.stringify(crossViewport))
    console.log(JSON.stringify({ ok: true, html: result, remoteRequests: remote.length, scratch }))
    win.destroy(); app.exit(0)
  } catch (error) {
    console.error(error); win.destroy(); app.exit(1)
  }
}).catch(error => { console.error(error); app.exit(1) })
