// Real component/CSS in isolated memory; Vite --mode test on 5189.
const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const profile = fs.mkdtempSync(path.join(process.env.TMPDIR, 'looma-inline-highlight-'))
app.setPath('userData', profile)
app.setPath('sessionData', profile)
const wait = (ms = 100) => new Promise(resolve => setTimeout(resolve, ms))
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1000, height: 800, show: false, webPreferences: { backgroundThrottling: false } })
  const run = code => win.webContents.executeJavaScript(code)
  const select = async (from, to = from) => { await run(`editor().commands.setTextSelection({from:${from},to:${to}});editor().view.focus()`); await wait() }
  const measure = () => run(`(() => {
    const root=editor().view.dom, elements=[...root.querySelectorAll('.looma-inline-expanded-source')];
    const probe=document.createElement('span');probe.style.background=getComputedStyle(root).getPropertyValue('--editor-active-line-bg');document.body.append(probe);
    const expected=getComputedStyle(probe).backgroundColor;probe.remove();
    return {expected, blocks:[...root.querySelectorAll('.looma-inline-expanded-block')].map(el=>getComputedStyle(el).backgroundColor),
      active:[...root.querySelectorAll('.looma-active-line')].map(el=>getComputedStyle(el).backgroundColor),
      fragments:elements.map(el=>{const s=getComputedStyle(el),p=el.parentElement.getBoundingClientRect(); const r=document.createRange();r.selectNodeContents(el);
        return {text:el.textContent,color:s.backgroundColor,display:s.display,nested:!!el.querySelector('.looma-inline-expanded-source'),width:p.width,
          rects:[...el.getClientRects()].map(r=>({x:r.x,y:r.y,width:r.width,height:r.height})),
          textRects:[...r.getClientRects()].map(r=>({x:r.x,y:r.y,width:r.width,height:r.height}))}})}
  })()`)
  const fixture = async source => {
    await wait(200); await run(`setFixture(${JSON.stringify(source)})`); await wait(450)
    app.focus({steal:true});win.focus(); await select(1)
    for(let i=0;i<20&&!await run('document.hasFocus()');i++) await wait()
    assert.ok(await run('document.hasFocus()'))
  }
  const painted = result => {
    assert.ok(result.fragments.length)
    assert.ok(result.blocks.every(color => color === 'rgba(0, 0, 0, 0)'), 'expanded paragraph background is transparent')
    for(const f of result.fragments) {
      assert.equal(f.color,result.expected,'inline source uses actual theme color')
      assert.notEqual(f.color,'rgba(0, 0, 0, 0)')
      assert.equal(f.display,'inline');assert.equal(f.nested,false)
      assert.ok(f.rects.length)
      for(const rect of f.rects) assert.ok(f.textRects.some(t=>Math.abs(t.x-rect.x)<1&&Math.abs(t.width-rect.width)<1), 'background follows actual text line boxes')
    }
  }
  try {
    await win.loadURL('http://127.0.0.1:5189/scripts/test/note-title.html')
    for(let i=0;i<100&&!await run('window.ready?.()');i++) await wait()
    assert.ok(await run('ready()'));win.show();app.focus({steal:true});win.focus()
    await run('document.fonts.ready')
    for(const source of ['**bold**','`code`','[label](note.md#L2 "title")','**outer *inner* end**','[**粗体**](note.md)']) {
      await fixture(`a ${source} z`)
      const before=await run('JSON.stringify({doc:editor().getJSON(),events})')
      await select(6)
      const result=await measure();painted(result)
      assert.deepEqual(result.fragments.map(f=>f.text),[source])
      assert.ok(result.fragments[0].rects[0].width<result.fragments[0].width)
      await select(1)
      const collapsed=await measure();assert.equal(collapsed.fragments.length,0)
      assert.deepEqual(collapsed.active,[collapsed.expected],'ordinary active paragraph background restored')
      await select(6);await run('editor().commands.blur()');await wait()
      assert.equal((await measure()).fragments.length,0)
      assert.equal(await run('JSON.stringify({doc:editor().getJSON(),events})'),before,'display does not write doc or emit edits/saves')
    }
    console.log('PASS full source, nested single paint, actual theme color/inline text rects, paragraph suppression/restoration, blur, zero doc/events')
    await run('appearance("handwritten","light","paper",100,380)')
    const long='**'+ '折行文字 inline words '.repeat(9).trimEnd()+'**'
    await fixture(`prefix ${long} suffix`);await select(12)
    const wrapped=await measure();painted(wrapped)
    assert.equal(wrapped.fragments[0].text,long)
    assert.ok(new Set(wrapped.fragments[0].rects.map(r=>r.y)).size>2)
    assert.ok(wrapped.fragments[0].rects.some(r=>r.width<wrapped.fragments[0].width-20))
    console.log('PASS wrapped source has separate text-line boxes, not a paragraph rectangle', JSON.stringify({color:wrapped.fragments[0].color,block:wrapped.blocks,rects:wrapped.fragments[0].rects}))
    await run('appearance("handwritten","dark","paper",100,380)');await wait(250)
    painted(await measure())
    await run('appearance("handwritten","light","paper",100,380)');await wait(250)
    console.log('PASS light/dark theme variable applied to source, paragraph remains transparent')
    await fixture('a **bold** gap `code` z\n\nb [link](note.md) end')
    const end=await run('editor().state.doc.content.size-2')
    await select(4,end)
    const cross=await measure();painted(cross)
    assert.deepEqual(cross.fragments.map(f=>f.text),['**bold**','`code`','[link](note.md)'])
    assert.equal(cross.blocks.length,2)
    console.log('PASS cross-block selection highlights distinct sources, not gaps')
    await fixture('a **word** z');await select(5)
    win.webContents.debugger.attach('1.3')
    await win.webContents.debugger.sendCommand('Input.imeSetComposition',{text:'中文',selectionStart:2,selectionEnd:2});await wait()
    painted(await measure())
    assert.equal((await measure()).fragments[0].text,'**中文word**')
    await win.webContents.debugger.sendCommand('Input.insertText',{text:'中文'});await wait(250)
    win.webContents.debugger.detach();painted(await measure())
    assert.equal(await run('props.content'),'a **中文word** z')
    console.log('PASS Chromium Chinese composition maps the frozen highlight and commits once (OS candidate UI not covered)')
    await fixture('a **word** z')
    const points=await run(`(()=>{const e=editor(),a=e.view.coordsAtPos(1),b=e.view.coordsAtPos(13);return [a,b].map(r=>({x:Math.round(r.left),y:Math.round((r.top+r.bottom)/2)}))})()`)
    win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...points[0]})
    win.webContents.sendInputEvent({type:'mouseMove',button:'left',...points[1]});await wait()
    assert.equal((await measure()).fragments.length,0,'drag retains collapsed decorations')
    win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...points[1]});await wait()
    painted(await measure());console.log('PASS native drag freezes highlight until release')
    await fixture('```md\n**literal**\n```\n\n![image](missing.png)')
    await select(5);assert.equal((await measure()).fragments.length,0)
    console.log('PASS code block/image excluded')
    win.destroy();fs.rmSync(profile,{recursive:true,force:true});app.exit(0)
  } catch(error) { console.error(error);win.destroy();fs.rmSync(profile,{recursive:true,force:true});app.exit(1) }
})
