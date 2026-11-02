// Real empty-cell typing; in-memory note and isolated Electron profile.
const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const directory = fs.mkdtempSync(path.join(os.homedir(), '.hermes/cache/scratch/looma-empty-table-'))
app.setPath('userData', path.join(directory, 'profile'))
const wait = (ms = 100) => new Promise(resolve => setTimeout(resolve, ms))
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1100, height: 850, show: false, webPreferences: { backgroundThrottling: false } })
  const run = code => win.webContents.executeJavaScript(code)
  const errors = []
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message) })
  try {
    await win.loadURL('http://127.0.0.1:5189/src/renderer/components/editor/test/chunked-editor.browser.html')
    for (let i=0;i<100 && !await run('window.ready?.() && !!cm()');i++) await wait()
    await run('document.fonts.ready')
    win.webContents.debugger.attach('1.3')
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true})
    await win.webContents.debugger.sendCommand('Page.bringToFront')

    const shape = async label => {
      const data=await run(`(()=>{const rows=[...document.querySelectorAll('.looma-continuous-table-row')],s=getSelection(),cell=(s?.focusNode?.nodeType===3?s.focusNode.parentElement:s?.focusNode)?.closest?.('.looma-continuous-table-cell'),r=s?.rangeCount?s.getRangeAt(0).getBoundingClientRect():null;return {source:model().content,selection:model().selection,caret:{row:cell?rows.indexOf(cell.parentElement):-1,column:cell?Number(cell.dataset.tableColumn):-1,head:cm().state.selection.main.head,assoc:cm().state.selection.main.assoc,rect:r?{left:r.left,top:r.top,height:r.height}:null},rows:rows.map(row=>({text:row.textContent,html:row.innerHTML,cells:[...row.querySelectorAll('.looma-continuous-table-cell')].map(el=>{const r=el.getBoundingClientRect();return {text:el.textContent,left:r.left,width:r.width}})}))}})()`)
      fs.appendFileSync(path.join(directory,'diagnostics.jsonl'),JSON.stringify({label,...data})+'\n')
      fs.writeFileSync(path.join(directory,'latest.png'),(await win.webContents.capturePage()).toPNG())
      assert.equal(data.rows.length,3,`${label}: row count`)
      assert.deepEqual(data.rows.map(row=>row.cells.length),[3,3,3],`${label}: input must not split cells into extra boxes`)
      for (const row of data.rows) for (let column=0;column<3;column++) {
        assert.ok(Math.abs(row.cells[column].left-data.rows[0].cells[column].left)<1,`${label}: each source column stays aligned across rows`)
        if(column)assert.ok(Math.abs(row.cells[column].left-row.cells[column-1].left-row.cells[column-1].width)<=1,`${label}: no anonymous blank cell may appear between source cells`)
      }
      return data
    }
    const caretInCell = (data,row,column,label) => {
      assert.equal(data.caret.row,row,`${label}: rendered caret stays in the edited row`)
      assert.equal(data.caret.column,column,`${label}: rendered caret stays in the edited cell, not the next cell`)
      const box=data.rows[row].cells[column]
      assert.ok(data.caret.rect && data.caret.rect.left>=box.left && data.caret.rect.left<box.left+box.width,`${label}: painted caret is within the edited cell box`)
      assert.ok(data.caret.rect.height>=12,`${label}: caret remains visible after input`)
    }
    const key = async (keyCode,modifiers=[]) => {
      win.webContents.sendInputEvent({type:'keyDown',keyCode,modifiers})
      win.webContents.sendInputEvent({type:'keyUp',keyCode,modifiers})
      await wait(150)
    }
    for (const [name,blank] of [['padded','|  |  |  |'],['zero-width','||||']]) {
    const source = `前言\n\n${blank}\n| --- | --- | --- |\n${blank}\n${blank}\n\n末尾`
    await run(`setFixture(${JSON.stringify(source)})`); await wait(800)
    await run('start(0);cm().focus()'); await wait(200)
    await shape(name+' empty')
    const cases=Array.from({length:9},(_,index)=>[Math.floor(index/3),index%3,index===0?'abc **粗体**':index===4?'中文':index===8?'123':'x'])
    for (const [row,column,text] of cases) {
      const point=await run(`(()=>{const cell=document.querySelectorAll('.looma-continuous-table-row')[${row}].querySelectorAll('.looma-continuous-table-cell')[${column}],r=cell.getBoundingClientRect();return {x:r.left+15,y:r.top+r.height/2}})()`)
      for(const type of ['mousePressed','mouseReleased'])await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,...point})
      await wait(150)
      for(const char of text) {
        const before=await run('({source:model().content,anchor:cm().state.selection.main.from,head:cm().state.selection.main.to})')
        await win.webContents.debugger.sendCommand('Input.insertText',{text:char});await wait(180)
        const data=await shape(`${name} type ${row}:${column} ${char}`)
        assert.equal(data.source,before.source.slice(0,before.anchor)+char+before.source.slice(before.head),'native input changes only caret range')
        caretInCell(data,row,column,`${name} after typing ${char}`)
      }
      assert.equal(await run(`model().content.split(String.fromCharCode(10))[${row===0?2:row+3}].split('|')[${column+1}].trim()`),text,'typing stays in the clicked source cell')
      const typed=await run('model().content')
      for(const char of [...text].reverse()) {
        const before=await run('({source:model().content,head:cm().state.selection.main.head})')
        await key('Backspace')
        const data=await shape(`${name} delete ${row}:${column} ${char}`)
        assert.equal(data.source,before.source.slice(0,before.head-char.length)+before.source.slice(before.head),'Backspace deletes only the typed character')
        caretInCell(data,row,column,`${name} after deleting ${char}`)
      }
      assert.equal(await run(`model().content.split(String.fromCharCode(10))[${row===0?2:row+3}].split('|')[${column+1}].trim()`),'','deleting content restores the empty cell')
      const empty=await run('model().content')
      await key('z',['meta']);caretInCell(await shape(name+' undo'),row,column,name+' undo')
      assert.notEqual(await run('model().content'),empty,'undo restores deleted content')
      await key('z',['meta','shift']);caretInCell(await shape(name+' redo'),row,column,name+' redo')
      assert.equal(await run('model().content'),empty,'redo preserves exact source and empty-cell layout')
      assert.notEqual(typed,empty)
    }
    console.log('PASS',name,'native empty-cell click/type/delete, nested formatting, aligned geometry, exact source and undo/redo')
    for(let row=0;row<3;row++)for(let column=0;column<3;column++) {
    await run(`setFixture(${JSON.stringify(source)})`);await wait(80)
    const point=await run(`(()=>{const r=document.querySelectorAll('.looma-continuous-table-row')[${row}].querySelectorAll('.looma-continuous-table-cell')[${column}].getBoundingClientRect();return{x:r.left+15,y:r.top+r.height/2}})()`)
    for(const type of ['mousePressed','mouseReleased'])await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,...point})
    await wait(100)
    const before=await run('({source:model().content,head:cm().state.selection.main.head})')
    for(const text of ['中','中文']) {
      await win.webContents.debugger.sendCommand('Input.imeSetComposition',{text,selectionStart:text.length,selectionEnd:text.length})
      await wait(100);caretInCell(await shape(`${name} composition ${row}:${column} ${text}`),row,column,name+' composition '+text)
    }
    await win.webContents.debugger.sendCommand('Input.insertText',{text:'中文'})
    await wait(200);caretInCell(await shape(`${name} composition committed ${row}:${column}`),row,column,name+' composition committed')
    assert.equal(await run('model().content'),before.source.slice(0,before.head)+'中文'+before.source.slice(before.head),'composition commits into the clicked cell without changing delimiters')
    }
    console.log('PASS',name,'Chromium composition update/commit preserves source-cell layout and offsets')
    }
    assert.deepEqual(errors,[])
    console.log('PASS empty table native click/typing keeps one visual box per source cell')
    console.log('REPORT',directory)
    win.destroy();app.exit(0)
  } catch(error) {console.error(error);console.error(errors);console.log('REPORT',directory);win.destroy();app.exit(1)}
})
