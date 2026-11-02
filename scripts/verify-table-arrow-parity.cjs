// Real CDP arrows, ordinary Tiptap as oracle; isolated in-memory fixtures only.
// npx electron scripts/verify-table-arrow-parity.cjs [--probe]
const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const directory = fs.mkdtempSync(path.join(os.homedir(), '.hermes/cache/scratch/looma-table-arrow-'))
app.setPath('userData', path.join(directory, 'profile'))
const probe = process.argv.includes('--probe')
const wait = (ms = 60) => new Promise(resolve => setTimeout(resolve, ms))
const cases = []
for (const [name, rowText] of [['padded', '|  |  |  |'], ['zero', '||||'], ['mixed', '| A中 | é👩‍💻 | 尾Z |']]) {
  const source = `前文\n\n${rowText}\n| --- | --- | --- |\n${rowText}\n${rowText}\n\n后文`
  for (let row = 0; row < 3; row++) for (let column = 0; column < 3; column++) for (const direction of ['ArrowLeft', 'ArrowRight']) {
    cases.push({ name: `${name} ${row}:${column} ${direction}`, source, row, column, edge: direction === 'ArrowLeft' ? 'start' : 'end', direction, steps: name === 'mixed' ? 4 : 3 })
  }
  for (const [row, column, direction] of [[0, 0, 'ArrowRight'], [2, 2, 'ArrowLeft']]) {
    cases.push({ name: `${name} traversal ${direction}`, source, row, column, edge: direction === 'ArrowLeft' ? 'end' : 'start', direction, steps: name === 'mixed' ? 30 : 12 })
  }
  for (const [outside, direction] of [['before', 'ArrowRight'], ['after', 'ArrowLeft']]) {
    cases.push({ name: `${name} outside-${outside} ${direction}`, source, outside, direction, steps: 4 })
  }
}
const filter = process.argv.find(arg => arg.startsWith('--filter='))?.slice('--filter='.length)
if (filter) for (let index = cases.length - 1; index >= 0; index--) if (!cases[index].name.includes(filter)) cases.splice(index, 1)
assert.ok(cases.length, 'case filter must select at least one test')
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1450, height: 850, show: false, webPreferences: { backgroundThrottling: false } })
  const run = code => win.webContents.executeJavaScript(code)
  const cmd = (method, args = {}) => win.webContents.debugger.sendCommand(method, args)
  const failures = [], errors = []
  const log = (file, value) => fs.appendFileSync(path.join(directory, file + '.jsonl'), JSON.stringify(value) + '\n')
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message) })
  const check = (condition, message, detail) => {
    if (!condition) { const failure = { message, ...detail }; failures.push(failure); log('failures', failure) }
  }
  const key = async (key, modifiers = 0) => {
    for (const type of ['keyDown', 'keyUp']) await cmd('Input.dispatchKeyEvent', { type, key, code: key, windowsVirtualKeyCode: key === 'ArrowLeft' ? 37 : 39, modifiers })
    await wait()
  }
  const fixture = async source => {
    // Ordinary update events don't update state.content: force the prop watcher.
    await cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1440, y: 810 })
    await run(`setFixture('临时重置箭头夹具')`); await wait(120)
    await run(`setFixture(${JSON.stringify(source)})`); await wait(260)
  }
  const inspect = async (host, test, step) => {
    const result = await run(`(()=>{
      const ordinary=${host === 'ordinary'},view=ordinary?pm().view:cm(),sel=ordinary?pm().state.selection:cm().state.selection.main;
      const s=getSelection(),node=s.focusNode,el=node?.nodeType===3?node.parentElement:node;
      const root=document.querySelector('#${host} '+(ordinary?'.tiptap':'.cm-content'));
      const rows=[...root.querySelectorAll(ordinary?'tr':'.looma-continuous-table-row')];
      const cell=el?.closest?.('td,th,.looma-continuous-table-cell');
      const row=cell?rows.indexOf(cell.parentElement):-1,column=cell?[...cell.parentElement.querySelectorAll(ordinary?'th,td':'.looma-continuous-table-cell')].indexOf(cell):-1;
      const source=ordinary?pm().getMarkdown():model.content,head=ordinary?sel.head:sel.head;
      let nativePosition=null;try{nativePosition=ordinary?view.posAtDOM(node,s.focusOffset):view.posAtDOM(node,s.focusOffset)}catch{}
      let offset=null,outside=null;
      if(cell&&ordinary){const r=document.createRange();r.selectNodeContents(cell);r.setEnd(node,s.focusOffset);offset=r.toString().length}
      if(!cell){const block=el?.closest?.(ordinary?'p':'.cm-line');if(block){const text=block.textContent;outside=text.includes('前文')?'before':text.includes('后文')?'after':'other';const r=document.createRange();r.selectNodeContents(block);r.setEnd(node,s.focusOffset);offset=r.toString().length}}
      let sourceCell=null,line=null;
      if(!ordinary){const l=view.state.doc.lineAt(head);line={number:l.number,from:l.from,text:l.text};if(row>=0){const pipes=[...l.text.matchAll(/\\|/g)].map(m=>m.index);const start=l.from+pipes[column]+1,end=l.from+pipes[column+1],raw=source.slice(start,end),leading=raw.length-raw.trimStart().length;const from=start+leading,to=from+raw.trim().length;offset=Math.max(0,Math.min(to-from,head-from));sourceCell={start,end,from,to,raw,rawOffset:head-start}}}
      // DOM Range.toString includes noneditable line-number widgets.
      // Retain it diagnostically; compare text offsets without UI labels.
      const domTextOffset=offset;
      if(ordinary&&!cell)offset=sel.$head.parentOffset;
      else if(!cell)offset=head-view.state.doc.lineAt(head).from;
      const fixtureSource=${JSON.stringify(test.source)},fixtureLines=fixtureSource.split('\\n');
      let sourceOffset=ordinary?null:head;
      if(ordinary&&row>=0){const n=row===0?2:row+3,start=fixtureLines.slice(0,n).reduce((a,l)=>a+l.length+1,0),text=fixtureLines[n],pipes=[...text.matchAll(/\\|/g)].map(m=>m.index),raw=text.slice(pipes[column]+1,pipes[column+1]);sourceOffset=start+pipes[column]+1+(raw.length-raw.trimStart().length)+offset}
      if(ordinary&&outside==='before')sourceOffset=offset;
      if(ordinary&&outside==='after')sourceOffset=fixtureSource.lastIndexOf('\\n')+1+offset;
      const rect=s.rangeCount?s.getRangeAt(0).getBoundingClientRect():null;
      return {source,head,sourceOffset,nativePosition,selectionType:ordinary?sel.constructor.name:'CM',collapsed:s.isCollapsed&&sel.from===sel.to,ownerHost:el?.closest?.('#ordinary,#continuous')?.id,row,column,offset,domTextOffset,outside,sourceCell,line,dom:{node:node?.nodeName,text:node?.textContent,offset:s.focusOffset},rect:rect?{x:rect.x,y:rect.y,height:rect.height}:null,semantic:{row,column,offset,outside}};
    })()`)
    log('moves', { host, test: test.name, step, ...result })
    return result
  }
  const click = async (host, test) => {
    await run(host === 'ordinary' ? 'pm().view.focus()' : 'cm().focus()')
    const point = await run(`(()=>{
      const ordinary=${host === 'ordinary'},root=document.querySelector('#${host} '+(ordinary?'.tiptap':'.cm-content'));
      let target;
      if(${!!test.outside})target=[...root.querySelectorAll(ordinary?':scope > p':'.cm-line')].find(e=>e.textContent.includes(${JSON.stringify(test.outside === 'before' ? '前文' : '后文')}));
      else target=root.querySelectorAll(ordinary?'tr':'.looma-continuous-table-row')[${test.row || 0}].querySelectorAll(ordinary?'th,td':'.looma-continuous-table-cell')[${test.column || 0}];
      target.scrollIntoView({block:'nearest'});const r=target.getBoundingClientRect();
      if(${!!test.outside})return{x:r.right-13,y:r.top+r.height/2};
      const end=${test.edge === 'end'};
      const walker=document.createTreeWalker(target,NodeFilter.SHOW_TEXT),texts=[];let n;
      const expectedText=${JSON.stringify(test.outside ? test.outside === 'before' ? '前文' : '后文' : test.name.startsWith('mixed') ? ['A中', 'é👩‍💻', '尾Z'][test.column] : '')};
      while(n=walker.nextNode())if(expectedText&&n.textContent.includes(expectedText)&&!n.parentElement.closest('.looma-line-number,.looma-continuous-table-syntax,.cm-widgetBuffer,[contenteditable="false"]'))texts.push(n);
      if(texts.length){const text=end?texts.at(-1):texts[0],range=document.createRange();range.setStart(text,end?text.length-1:0);range.setEnd(text,end?text.length:1);const b=range.getBoundingClientRect();return{x:end?b.right-0.3:b.left+0.3,y:b.top+b.height/2}}
      return{x:end?r.right-13:r.left+13,y:r.top+r.height/2};
    })()`)
    log('clicks', { host, test: test.name, point, hit: await run(`document.elementFromPoint(${point.x},${point.y})?.outerHTML.slice(0,600)`) })
    await cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
    await wait(100)
    log('clicks', { host, test: test.name, hoverHit: await run(`document.elementFromPoint(${point.x},${point.y})?.outerHTML.slice(0,600)`) })
    for (const type of ['mousePressed', 'mouseReleased']) await cmd('Input.dispatchMouseEvent', { type, ...point, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 })
    await wait(100)
    // The table toolbar overlaps the preceding text. Click paragraph blank
    // space to obtain its real end caret; use real keys for the following start.
    if (test.outside === 'after') { await key('ArrowLeft'); await key('ArrowLeft') }
    const initial = await inspect(host, test, 'setup')
    assert.equal(initial.ownerHost, host, 'setup: native selection in intended host')
    assert.ok(initial.collapsed, 'setup: text caret, not CellSelection: ' + JSON.stringify(initial))
    if (host === 'ordinary') assert.match(initial.selectionType, /^_?TextSelection$/, 'setup must not mistake CellSelection for a caret')
    if (!test.outside) {
      assert.equal(initial.row, test.row); assert.equal(initial.column, test.column)
      const length = test.name.startsWith('mixed') ? [2, 7, 2][test.column] : 0
      assert.equal(initial.offset, test.edge === 'end' ? length : 0, 'setup hits requested text edge, not a nearby character')
    } else {
      assert.equal(initial.outside, test.outside)
      assert.equal(initial.offset, test.outside === 'before' ? 2 : 0, 'setup is exactly at the paragraph/table boundary')
    }
    return initial
  }
  const execute = async (host, test) => {
    await fixture(test.source)
    const initial = await click(host, test), sequence = [initial]
    for (let step = 1; step <= test.steps; step++) {
      await key(test.direction)
      const result = await inspect(host, test, step)
      check(result.source === initial.source, 'arrow must not modify host source', { host, test: test.name, step })
      check(await run('model.content') === test.source, 'canonical fixture source unchanged', { host, test: test.name, step })
      check(result.ownerHost === host && result.collapsed, 'arrow keeps a native text caret in host', { host, test: test.name, step })
      check(result.head === result.nativePosition, 'native DOM position matches editor source position', { host, test: test.name, step, head: result.head, nativePosition: result.nativePosition })
      sequence.push(result)
    }
    return sequence
  }
  try {
    await win.loadURL('http://127.0.0.1:5189/src/renderer/components/editor/test/rich-text-parity.browser.html')
    for (let i = 0; i < 100 && !await run('window.ready?.()'); i++) await wait(100)
    assert.ok(await run('window.ready?.()'), 'real paired components ready')
    win.webContents.debugger.attach('1.3')
    await cmd('Emulation.setFocusEmulationEnabled', { enabled: true })
    await run('state.width=680;document.fonts.ready'); await wait(100)
    const baselines = []
    // Finish and report the entire ordinary oracle before running any CM assertion.
    for (const test of cases) {
      const sequence = await execute('ordinary', test)
      baselines.push(sequence)
      console.log('ORDINARY', test.name, JSON.stringify(sequence.map(s => ({ ...s.semantic, pos: s.head }))))
    }
    console.log('ORDINARY BASELINE COMPLETE', cases.length, 'cases; REPORT', directory)
    if (!probe) {
      for (let index = 0; index < cases.length; index++) {
        const test = cases[index], actual = await execute('continuous', test), expected = baselines[index]
        for (let step = 0; step < actual.length; step++) {
          check(JSON.stringify(actual[step].semantic) === JSON.stringify(expected[step].semantic), 'ordinary/continuous arrow semantic parity', { test: test.name, step, expected: expected[step].semantic, actual: actual[step].semantic, sourcePosition: actual[step].head, sourceCell: actual[step].sourceCell })
        }
        if (test.name.includes('padded') && !test.outside) console.log('CONTINUOUS', test.name, JSON.stringify(actual.map(s => ({ ...s.semantic, pos: s.head, raw: s.sourceCell?.rawOffset }))))
      }
    }
    if (!probe) {
      const source = '前文\n\n|  |  |  |\n| --- | --- | --- |\n|  |  |  |\n\n后文', at = source.indexOf('|  |  |  |') + 4
      await fixture(source); await run('state.sourceOnly=true'); await wait(150)
      await run(`cm().dispatch({selection:{anchor:${at}}});cm().focus()`)
      await key('ArrowRight')
      assert.equal(await run('cm().state.selection.main.head'), at + 1, 'source mode retains ordinary per-character movement through padding')
      assert.equal(await run('model.content'), source)
      await run('state.sourceOnly=false'); await wait(150)
      const test = { name: 'padded Shift guard', source, row: 0, column: 1, edge: 'start' }
      await fixture(source); await click('continuous', test)
      await key('ArrowRight', 8)
      assert.equal(await run('cm().state.selection.main.empty'), false, 'Shift+Arrow extends selection instead of using plain-arrow cell navigation')
      assert.equal(await run('model.content'), source)
      console.log('PASS source-only per-character arrows and Shift selection guard')
    }
    check(errors.length === 0, 'no renderer errors', { errors })
    fs.writeFileSync(path.join(directory, 'summary.json'), JSON.stringify({ probe, cases: cases.length, failures: failures.length, errors, directory }, null, 2))
    if (failures.length) {
      console.error('RED', failures.length, 'assertions; first failures:', JSON.stringify(failures.slice(0, 8), null, 2))
      console.error('FAILURE LOG', path.join(directory, 'failures.jsonl'))
    } else console.log(probe ? 'PASS ordinary probe (CM parity not asserted)' : 'PASS real ordinary/continuous arrow parity')
    console.log('REPORT', directory)
    win.destroy(); app.exit(failures.length ? 1 : 0)
  } catch (error) {
    log('failures', { fatal: error.stack }); console.error(error); console.error('FAILURE LOG', path.join(directory, 'failures.jsonl')); console.log('REPORT', directory)
    win.destroy(); app.exit(1)
  }
})
