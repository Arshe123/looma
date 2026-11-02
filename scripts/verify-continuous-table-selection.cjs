// Real held-pointer ordinary oracle and production continuous-editor wiring.
// Hidden isolated profile; clipboard events use in-memory DataTransfer, never OS clipboard.
const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const directory = fs.mkdtempSync(path.join(os.homedir(), '.hermes/cache/scratch/looma-table-selection-'))
app.setPath('userData', path.join(directory, 'profile'))
const wait = (ms = 100) => new Promise(resolve => setTimeout(resolve, ms))
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1450, height: 850, show: false, webPreferences: { backgroundThrottling: false } })
  const errors=[]
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message) })
  const run = code => win.webContents.executeJavaScript(code)
  const baseSource = 'Before\n\n| alpha | bravo | charlie |\n| --- | --- | --- |\n| delta | echo | foxtrot |\n| golf | hotel | india |\n\nAfter'
  const source = process.argv.includes('--rich') ? baseSource.replace('alpha','**alpha**').replace('echo','a\\|b').replace('hotel','hotel<br>H') : baseSource
  try {
    await win.loadURL('about:blank')
    win.webContents.debugger.attach('1.3')
    const cdp = (name, args) => win.webContents.debugger.sendCommand(name,args)
    await cdp('Page.enable')
    // Freeze this isolated test page against concurrent agents' Vite reloads.
    // All modules still load from the real server; only live HMR messages stop.
    await cdp('Page.addScriptToEvaluateOnNewDocument',{source:`{
      const NativeSocket=window.WebSocket;
      window.WebSocket=class extends NativeSocket {
        constructor(url,protocols){super(url,protocols);if(protocols==='vite-hmr')super.addEventListener('message',event=>{if(['update','full-reload','prune'].includes(JSON.parse(event.data).type))event.stopImmediatePropagation()})}
      }
    }`})
    await win.loadURL('http://127.0.0.1:5189/src/renderer/components/editor/test/rich-text-parity.browser.html')

    for (let i = 0; i < 100 && !await run('window.ready?.()'); i++) await wait()
    await cdp('Emulation.setFocusEmulationEnabled', { enabled: true })
    await cdp('Page.bringToFront')
    const reset=async()=>{await run(`(async()=>{flush();await setFixture('temporary fixture');await setFixture(${JSON.stringify(source)})})()`);await wait(450)}
    await run('state.width=680');await reset()
    const point = (host, row, col) => run(`(()=>{const cells=document.querySelectorAll('#${host} ${host==='ordinary'?'tr':'.looma-continuous-table-row'}')[${row}].querySelectorAll('${host==='ordinary'?'th,td':'.looma-continuous-table-cell'}');const r=cells[${col}].getBoundingClientRect();return {x:r.left+18,y:r.top+r.height/2}})()`)
    const dragPoints = async (start,end,held) => {
      await cdp('Input.dispatchMouseEvent',{type:'mouseMoved',...start})
      await cdp('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',buttons:1,clickCount:1,...start})
      for(let i=1;i<=12;i++) {await cdp('Input.dispatchMouseEvent',{type:'mouseMoved',button:'left',buttons:1,x:start.x+(end.x-start.x)*i/12,y:start.y+(end.y-start.y)*i/12});await wait(20)}
      await wait(70)
      if (held) await held()
      await cdp('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',buttons:0,clickCount:1,...end});await wait(100)
    }
    const drag=async(host,a,b,held)=>dragPoints(await point(host,...a),await point(host,...b),held)
    const key=async(key,code,text,modifiers=0)=>{
      await cdp('Input.dispatchKeyEvent',{type:'keyDown',key,code,text,modifiers})
      await cdp('Input.dispatchKeyEvent',{type:'keyUp',key,code,modifiers});await wait(130)
    }
    await run(`window.cellText = value => value.replace(/\\\\\\|/g,'|').replace(/<br\\s*\\/?\\s*>/gi,'').replace(/\\|/g,'').replace(/\\*\\*/g,'').trim();true`)
    const cells=host=>run(`Array.from(document.querySelectorAll('#${host} ${host==='ordinary'?'th,td':'.looma-continuous-table-cell'}'),c=>cellText(c.textContent))`)
    const snapshot=host=>run(`({type:${host==='ordinary'?'pm().state.selection.constructor.name':'"metadata"'},selected:[...document.querySelectorAll('#${host} .selectedCell')].map(c=>cellText(c.textContent)),color:getComputedStyle(document.querySelector('#${host} .selectedCell'),'::after').backgroundColor})`)
    const ordinary={}
    for(const [name,a,b] of [['forward',[0,0],[2,1]],['reverse',[2,1],[0,0]],['row',[1,0],[1,2]]]) {
      await reset();await drag('ordinary',a,b)
      const baseline=await snapshot('ordinary')
      assert.match(baseline.type,/^CellSelection\d*$/)
      ordinary[name]={...baseline,a,b}
      const clipboardEvent=async(type,plain='',html='')=>run(`(()=>{const d=new DataTransfer();if(${JSON.stringify(plain)})d.setData('text/plain',${JSON.stringify(plain)});if(${JSON.stringify(html)})d.setData('text/html',${JSON.stringify(html)});const e=new ClipboardEvent(${JSON.stringify(type)},{clipboardData:d,bubbles:true,cancelable:true});pm().view.dom.dispatchEvent(e);return {claimed:e.defaultPrevented,text:d.getData('text/plain'),html:d.getData('text/html')}})()`)
      ordinary[name].copy=await clipboardEvent('copy')
      ordinary[name].cut=await clipboardEvent('cut');await wait(100);ordinary[name].cutCells=await cells('ordinary')
      await reset();await drag('ordinary',a,b);ordinary[name].paste=await clipboardEvent('paste','X');await wait(100);ordinary[name].pasteCells=await cells('ordinary')
      await reset();await drag('ordinary',a,b);ordinary[name].gridPaste=await clipboardEvent('paste','P\tQ\nR\tS','<table><tbody><tr><td><p>P</p></td><td><p>Q</p></td></tr><tr><td><p>R</p></td><td><p>S</p></td></tr></tbody></table>');await wait(100);ordinary[name].gridCells=await cells('ordinary')
      console.log('ORDINARY_CLIPBOARD',name,JSON.stringify(ordinary[name]))
      await reset();await drag('ordinary',a,b)
      await key('X','KeyX','X');ordinary[name].typed=await cells('ordinary')
      await reset();await drag('ordinary',a,b);await key('Backspace','Backspace');ordinary[name].cleared=await cells('ordinary')
      console.log('ORDINARY',name,JSON.stringify(ordinary[name]))
    }
    if(process.argv.includes('--probe')) {console.log('PASS ordinary real CellSelection baseline',directory);return}
    await reset()
    await run(`(async()=>{window.tableSelectionModule=await import('/src/renderer/components/editor/test/continuous-table-selection.browser.ts');tableSelectionModule.install(cm());return true})()`)
    assert.equal(await run('cm().state.field(tableSelectionModule.continuousTableSelectionState,false)!==undefined'),true,'rectangle extension must be mounted in the production host')
    await run(`window.downstreamCopies=0;cm().dom.addEventListener('copy',()=>window.downstreamCopies++)`)
    const selected=()=>run('tableSelectionModule.getContinuousTableSelection(cm().state)')
    for(const theme of ['light','dark']) for(const [name,oracle] of Object.entries(ordinary)) {
      await reset();await run(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`)
      await drag('ordinary',oracle.a,oracle.b);const normal=await snapshot('ordinary')
      await drag('continuous',oracle.a,oracle.b,async()=>{
        const held=await snapshot('continuous')
        assert.deepEqual(held.selected,oracle.selected,`rectangle is painted while pointer is held: ${JSON.stringify({held:held.selected,oracle:oracle.selected})}`)
        assert.equal(held.color,normal.color)
        assert.equal(await run('window.getSelection().toString()'),'','rectangle does not leave a linear DOM selection')
        fs.writeFileSync(path.join(directory,`${theme}-${name}-held.png`),(await win.webContents.capturePage()).toPNG())
      })
      const actual=await snapshot('continuous')
      assert.ok(await selected());assert.deepEqual(actual.selected,oracle.selected);assert.equal(actual.color,normal.color)
      assert.deepEqual(await run('({ranges:cm().state.selection.ranges.length,empty:cm().state.selection.main.empty})'),{ranges:1,empty:true})
      assert.equal(await run('model.content'),source,'selection does not write the canonical source')
      fs.writeFileSync(path.join(directory,`${theme}-${name}.png`),(await win.webContents.capturePage()).toPNG())
      const copy=await run(`(()=>{const d=new DataTransfer();const e=new ClipboardEvent('copy',{clipboardData:d,bubbles:true,cancelable:true});cm().contentDOM.dispatchEvent(e);return {claimed:e.defaultPrevented,text:d.getData('text/plain'),html:d.getData('text/html')}})()`)
      assert.deepEqual(copy,oracle.copy,'copy matches real ordinary head-cell payload without HTML')
      assert.equal(await run('downstreamCopies'),0,'rectangle claims copy before downstream handlers')
      await key('X','KeyX','X');assert.deepEqual(await cells('continuous'),oracle.typed,'typed head cell and clearing match ordinary')
      assert.equal(await selected(),null)
      await key('z','KeyZ',undefined,4);assert.equal(await run('model.content'),source,'one canonical undo restores all selected cells')
      await key('y','KeyY',undefined,4);assert.deepEqual(await cells('continuous'),oracle.typed,`canonical redo restores the rectangle replacement: ${JSON.stringify(await run('({content:model.content,selection:cm().state.selection.toJSON(),focus:cm().hasFocus,composing:cm().composing})'))}`)
      await key('z','KeyZ',undefined,4);assert.equal(await run('model.content'),source)
      await drag('continuous',oracle.a,oracle.b);assert.ok(await selected(),'rectangle survives undo and a fresh drag');await key('Backspace','Backspace')
      assert.deepEqual(await cells('continuous'),oracle.cleared,`clear matches ordinary rectangle ${theme}/${name}: ${JSON.stringify({cells:await cells('continuous'),selection:await selected(),source:await run('model.content')})}`)
      assert.ok(await selected(),'clear retains cell metadata')
      await key('z','KeyZ',undefined,4);assert.equal(await run('model.content'),source,'one undo restores complete structure')
      await drag('continuous',oracle.a,oracle.b)
      const cut=await run(`(()=>{const d=new DataTransfer();const e=new ClipboardEvent('cut',{clipboardData:d,bubbles:true,cancelable:true});cm().contentDOM.dispatchEvent(e);return {claimed:e.defaultPrevented,text:d.getData('text/plain'),html:d.getData('text/html')}})()`)
      if(JSON.stringify(cut)!==JSON.stringify(oracle.cut)) console.log('CUT_DIFFERENCE',JSON.stringify({cut,oracle:oracle.cut}))
      assert.equal(JSON.stringify(cut),JSON.stringify(oracle.cut),'cut payload matches native ordinary serializer (not custom copy)')
      assert.deepEqual(await cells('continuous'),oracle.cutCells)
      await key('z','KeyZ',undefined,4);assert.equal(await run('model.content'),source)
      for (const html of ['', '<table><tbody><tr><td><p>P</p></td><td><p>Q</p></td></tr><tr><td><p>R</p></td><td><p>S</p></td></tr></tbody></table>']) {
        await drag('continuous',oracle.a,oracle.b)
        await run(`(()=>{const d=new DataTransfer();d.setData('text/plain',${JSON.stringify(html?'P\tQ\nR\tS':'X')});d.setData('text/html',${JSON.stringify(html)});cm().contentDOM.dispatchEvent(new ClipboardEvent('paste',{clipboardData:d,bubbles:true,cancelable:true}))})()`)
        assert.deepEqual(await cells('continuous'),html?oracle.gridCells:oracle.pasteCells,'paste tiles/truncates from top-left like ordinary')
        await key('z','KeyZ',undefined,4);assert.equal(await run('model.content'),source,'paste is one canonical undo')
      }
    }
    {
      await reset();await drag('ordinary',[0,0],[2,1])
      const expectedSource=await run(`(async()=>{const {getTiptapSelectionDocument}=await import('/src/shared/utils/tiptap-clipboard.ts');const {serializeMarkdownAst}=await import('/src/shared/utils/markdown-rich-text.ts');return serializeMarkdownAst({getJSON:()=>getTiptapSelectionDocument(pm().state),markdown:pm().markdown})})()`)
      await run(`window.menuCopy='';Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>{window.menuCopy=value},read:async()=>[{types:['text/html'],getType:async()=>new Blob(['<table><tr><td>P</td><td>Q</td></tr><tr><td>R</td><td>S</td></tr></table>'],{type:'text/html'})}]}})`)
      await drag('continuous',[0,0],[2,1])
      const action=async id=>{
        const p=await point('continuous',1,0)
        await run(`(()=>{const cell=document.elementFromPoint(${p.x},${p.y});cell.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:${p.x},clientY:${p.y}}))})()`)
        await wait(100);assert.ok(await selected(),'right-click preserves a rectangle even away from its head cell')
        const button=await run(`(()=>{const b=document.querySelector('.looma-continuous-menu-panel:not([hidden]) [data-action="${id}"]');if(!b||b.disabled)throw Error('unavailable rectangle menu action: ${id}');const r=b.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()`)
        await cdp('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',buttons:1,clickCount:1,...button})
        await cdp('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',buttons:0,clickCount:1,...button});await wait(150)
      }
      await action('copy');assert.equal(await run('menuCopy'),ordinary.forward.copy.text,'menu copy matches native ordinary head-cell copy')
      await action('copy-source');assert.equal(await run('menuCopy'),expectedSource,'menu source copy retains the ordinary rectangular table structure')
      await action('paste');assert.deepEqual(await cells('continuous'),ordinary.forward.gridCells,'menu HTML paste uses the same rectangle tiling as native paste')
      await key('z','KeyZ',undefined,4);assert.equal(await run('model.content'),source,'menu paste is one canonical undo')
      await reset();await drag('continuous',[0,0],[2,1])
      await run('window.savedContinuousView=cm();state.active=false');await wait(150)
      await run('state.active=true');await wait(200)
      assert.equal(await run('cm()===savedContinuousView'),true,'KeepAlive retains the same continuous EditorView')
      assert.equal(await selected(),null,'deactivation clears rectangle metadata before reactivation')
      assert.equal(await run('model.content'),source,'lifecycle cleanup does not modify source')
      await reset()
    }
    // Same-cell held pointer must remain native text selection, not rectangle metadata.
    await reset()
    const textPoint=offset=>run(`(()=>{const r=cm().coordsAtPos(${offset});return {x:r.left,y:(r.top+r.bottom)/2}})()`)
    await dragPoints(await textPoint(source.indexOf('alpha')+1),await textPoint(source.indexOf('alpha')+4))
    assert.equal(await selected(),null);assert.equal(await run('window.getSelection().toString()'),'lph')
    await run(`cm().contentDOM.dispatchEvent(new ClipboardEvent('copy',{clipboardData:new DataTransfer(),bubbles:true,cancelable:true}))`)
    assert.equal(await run('downstreamCopies'),1,'native same-cell text copy is not claimed')
    await reset()
    await drag('continuous',[0,0],[2,1])
    await run(`(()=>{const data=new DataTransfer();data.items.add(new File(['unsupported'],'sample.pdf',{type:'application/pdf'}));cm().contentDOM.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}))})()`)
    assert.equal(await run('model.content'),source,'unsupported file paste must not silently clear a rectangle')
    await reset()
    // Readonly retains selection/copy while writes are consumed.
    await run('tableSelectionModule.setReadOnly(cm(),true)');assert.equal(await run('cm().state.readOnly'),true)
    await drag('continuous',[0,0],[2,1]);await key('Backspace','Backspace');await key('X','KeyX','X')
    assert.equal(await run('model.content'),source)
    assert.ok(await selected(),'readonly edits preserve copyable rectangle metadata')
    await run('tableSelectionModule.setReadOnly(cm(),false)')
    // Cancel/blur clean both metadata and highlights.
    for(const event of ['pointercancel','blur']) {
      await drag('continuous',[0,0],[2,1],async()=>{
        assert.ok(await selected())
        await run(event==='blur'?'window.dispatchEvent(new Event("blur"))':'document.dispatchEvent(new PointerEvent("pointercancel"))');await wait()
      })
      assert.equal(await selected(),null);assert.equal(await run('document.querySelectorAll("#continuous .selectedCell").length'),0)
    }
    await drag('continuous',[0,0],[2,1]);await run('state.sourceOnly=true');await wait(300)
    assert.equal(await selected(),null);assert.equal(await run('model.content'),source)
    await run('state.sourceOnly=false');await wait(300)
    await drag('continuous',[0,0],[2,1]);assert.ok(await selected())
    await run('document.querySelector("#app").__vue_app__.unmount()')
    await wait();assert.equal(await run('document.querySelectorAll("#continuous .selectedCell").length'),0)
    assert.deepEqual(errors,[])
    console.log('PASS 6 held-pointer ordinary/continuous light-dark rectangle cases; reverse/row/header; canonical clear/type/undo/redo; same-cell native; clipboard claim/cut/paste; readonly/source/held-cancel/held-blur/unmount',directory)
    console.log('PASS production host and ordinary clipboard oracle: copy=head-only/no HTML; cut=native linear text+rectangular HTML; paste=plain fill/HTML grid tile+truncate; real context actions and KeepAlive cleanup.')
  } catch(error) {console.error(error);console.error(errors);console.log('REPORT',directory);process.exitCode=1}
  finally {win.destroy();app.exit(process.exitCode||0)}
})
