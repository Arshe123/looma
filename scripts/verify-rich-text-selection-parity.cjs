// Compare real held-pointer selection in both production rich-text editors.
const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const directory = fs.mkdtempSync(path.join(os.homedir(), '.hermes/cache/scratch/looma-selection-parity-'))
app.setPath('userData', path.join(directory, 'profile'))
const wait = (ms = 100) => new Promise(resolve => setTimeout(resolve, ms))
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1450, height: 850, show: false, webPreferences: { backgroundThrottling: false } })
  const run = code => win.webContents.executeJavaScript(code)
  const errors = [], failures = []
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message) })
  try {
    await win.loadURL('http://127.0.0.1:5189/src/renderer/components/editor/test/rich-text-parity.browser.html')
    for (let i = 0; i < 100 && !await run('window.ready?.()'); i++) await wait()
    await run('state.width=680;document.fonts.ready'); await wait(600)

    win.webContents.debugger.attach('1.3')
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
    await win.webContents.debugger.sendCommand('Page.bringToFront')
    await run(`window.textPoint=(host,needle,end=false)=>{
      const root=document.querySelector('#'+host+' '+(host==='ordinary'?'.tiptap':'.cm-content'));
      const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT,{acceptNode:n=>n.parentElement.closest('[contenteditable="false"],.looma-line-number')?NodeFilter.FILTER_REJECT:NodeFilter.FILTER_ACCEPT});
      const nodes=[];let text='',node;while(node=walker.nextNode()){nodes.push({node,from:text.length});text+=node.textContent}
      const match=text.indexOf(needle);if(match<0)throw Error('Missing text '+host+' '+needle);
      const offset=match+(end?needle.length:0), entry=nodes.findLast(n=>n.from<=offset),range=document.createRange();
      range.setStart(entry.node,offset-entry.from);range.setEnd(entry.node,offset-entry.from);const r=range.getBoundingClientRect();
      return {x:r.left,y:(r.top+r.bottom)/2};
    };true`)
    const cases = [
      ['code', '正文\n\n```js\nconst abcdef = 1;\nconst ghijkl = 2;\nconst untouched = 3;\n```\n\n末尾', 'abcdef', 'ghijkl'],
      ['table', '正文\n\n| abcdef | other header |\n| --- | --- |\n| ghijkl | other cell |\n| untouched | last cell |\n\n末尾', 'bcdef', 'ghijk'],
      ['single-code', '正文\n\n```js\nconst abcdefghijkl = 1;\n```\n\n末尾', 'bcdef', 'ghijk'],
      ['single-cell', '正文\n\n| abcdefghijkl | other |\n| --- | --- |\n| untouched | last |\n\n末尾', 'bcdef', 'ghijk'],
    ]
    for (const theme of ['light','dark']) for (const [name, source, first, last] of cases) {
      await run(`document.documentElement.dataset.theme=${JSON.stringify(theme)};setFixture(${JSON.stringify(source)})`); await wait(700)
      const revision = await run('model.revision')
      const results = {}
      for (const host of ['ordinary','continuous']) {
        await run(`window.getSelection().removeAllRanges();cm().dispatch({selection:{anchor:0}});pm().commands.setTextSelection(1);${host === 'ordinary' ? 'pm().view.focus()' : 'cm().focus()'}`); await wait(200)
        const a = await run(`textPoint(${JSON.stringify(host)},${JSON.stringify(first)})`)
        const b = await run(`textPoint(${JSON.stringify(host)},${JSON.stringify(last)},true)`)
        // Outside the table/code shell, but within CM's source-line tail area.
        const outside = await run(`(()=>{const hostRect=document.querySelector('#${host}').getBoundingClientRect();return {x:Math.floor(hostRect.right-16),y:Math.floor(${a.y}),width:8,height:4}})()`)
        const beforeOutside = (await win.webContents.capturePage(outside)).toBitmap()
        await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',...a})
        await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',buttons:1,clickCount:1,...a})
        await wait(300)
        for(let step=1;step<=16;step++) {
          const t=step/16
          await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',button:'left',buttons:1,x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t})
          await wait(25)
        }
        results[host] = await run(`(()=>{const s=window.getSelection();if(!s.anchorNode)throw Error('Native drag missing selection: ${host} ${name}');const e=s.anchorNode.nodeType===3?s.anchorNode.parentElement:s.anchorNode,c=getComputedStyle(e,'::selection');return {selected:s.toString(),background:c.backgroundColor,color:c.color,extraLayers:document.querySelectorAll('#${host} .cm-selectionBackground').length,selectionType:${host === 'ordinary' ? 'pm().state.selection.constructor.name' : 'cm().state.selection.main.empty'},rects:[...s.getRangeAt(0).getClientRects()].map(r=>({left:r.left,top:r.top,width:r.width,height:r.height}))}})()`)
        if(name==='table') results[host].rectangle=await run(`(()=>{const cells=[...document.querySelectorAll('#${host} .selectedCell')];return {cells:cells.map(cell=>cell.textContent.replaceAll('|','').trim()),color:cells.length?getComputedStyle(cells[0],'::after').backgroundColor:null}})()`)
        results[host].outsideChanged = !(await win.webContents.capturePage(outside)).toBitmap().equals(beforeOutside)
        fs.writeFileSync(path.join(directory,`${theme}-${name}-${host}-held.png`),(await win.webContents.capturePage()).toPNG())
        await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',buttons:0,clickCount:1,...b})
        await wait(150)
      }
      console.log(JSON.stringify({theme,name,...results}))
      try {
        if (name === 'table') {
          assert.match(results.ordinary.selectionType,/^CellSelection\d*$/)
          assert.equal(results.continuous.selectionType,true,'rectangle retains one collapsed source caret')
          assert.equal(results.continuous.selected,'','rectangle has no linear native text highlight')
          assert.deepEqual(results.continuous.rectangle,results.ordinary.rectangle,'held rectangle cells and overlay color match ordinary')
          assert.deepEqual(results.continuous.rectangle.cells,['abcdef','ghijkl'])
        } else {
          assert.ok(results.ordinary.selected.includes(first),'ordinary native drag selected expected content')
          assert.ok(results.continuous.selected.includes(first),'continuous native drag selected expected content')
        }
        assert.equal(results.continuous.extraLayers,0,'rich text must not paint a second full-source-line selection behind native text')
        assert.equal(results.continuous.outsideChanged,false,'dragging must not highlight the background outside the block')
        assert.equal(results.continuous.background,results.ordinary.background,'native selection background matches ordinary rich text')
        assert.equal(results.continuous.color,results.ordinary.color,'native selected-text color matches ordinary rich text')
        assert.equal(await run('model.revision'),revision,'selection never changes source/history')
        assert.equal(await run('model.content'),source,'canonical source unchanged')
      } catch(error) { failures.push(`${theme} ${name}: ${error.message}`) }
    }
    const revision = await run('model.revision')
    await run('state.sourceOnly=true'); await wait(250)
    assert.equal(await run('document.querySelectorAll("#continuous .cm-selectionLayer").length'),1,'source mode keeps its drawn selection layer')
    await run('state.sourceOnly=false'); await wait(250)
    assert.equal(await run('document.querySelectorAll("#continuous .cm-selectionLayer").length'),0,'switching back restores native rich-text selection')
    assert.equal(await run('model.revision'),revision,'mode switch does not write source/history')
    assert.deepEqual(errors,[])
    assert.deepEqual(failures,[])
    console.log('PASS native text-selection appearance: ordinary vs continuous, code/cells, light/dark; no source-line background layer; source-mode selection preserved')
    console.log('PASS cross-cell drag: ordinary CellSelection and continuous rectangle metadata paint the same cells and overlay color')
    console.log('REPORT',directory)
    win.destroy(); app.exit(0)
  } catch(error) {console.error(error);console.error(errors);console.log('REPORT',directory);win.destroy();app.exit(1)}
})
