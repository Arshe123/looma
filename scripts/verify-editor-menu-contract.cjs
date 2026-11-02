// Compare actual menus and held-button interactions, not just shared component imports.
const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const directory = fs.mkdtempSync(path.join(os.homedir(), '.hermes/cache/scratch/looma-menu-contract-'))
app.setPath('userData', path.join(directory, 'profile'))
const wait = (ms=100) => new Promise(resolve=>setTimeout(resolve,ms))
app.whenReady().then(async()=>{
 const win=new BrowserWindow({width:1500,height:850,show:true,webPreferences:{backgroundThrottling:false}})
 const run=code=>win.webContents.executeJavaScript(code)
 const errors=[],failures=[]
 win.webContents.on('console-message',(_event,level,message)=>{if(level>=3)errors.push(message)})
 const until=async(code)=>{for(let i=0;i<45;i++){if(await run(code))return;await wait(40)}throw new Error('Timeout: '+code)}
 const check=async(name,fn)=>{try{await fn();console.log('PASS',name)}catch(error){failures.push({name,message:error.message});console.error('FAIL',name,error.message)}}
 const point=selector=>run(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(el.closest('.looma-continuous-menu-panel'))el.scrollIntoView({block:'nearest'});const r=el.getBoundingClientRect();return{x:r.left+Math.min(20,r.width/2),y:r.top+r.height/2}})()`)
 const mouse=(type,p,button='right')=>win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type,...p,button,buttons:type==='mouseReleased'?0:button==='right'?2:1,clickCount:1})
 const close=async()=>{await run('document.body.dispatchEvent(new PointerEvent("pointerdown",{bubbles:true}));document.body.dispatchEvent(new MouseEvent("click",{bubbles:true}));cm().contentDOM.blur()');await wait(60)}
 const focus=async()=>{for(let i=0;i<25;i++){app.focus({steal:true});win.focus();await run('cm().focus()');await wait(40);if(await run('document.hasFocus() && cm().hasFocus'))return}throw new Error('fixture lacks native focus')}
 const fixture=async source=>{await close();await run(`setFixture(${JSON.stringify(source)})`);await wait(500);await focus()}
 const context=async(selector)=>{await close();await focus();const p=await point(selector);await mouse('mousePressed',p);await mouse('mouseReleased',p);await wait(120)}
 const ordinaryMenu='#ordinary [data-looma-editor-context-menu] [role=menu]'
 const largeMenu='.looma-continuous-menu-panel:not([hidden]) [role=menu]'
 const ids=selector=>run(`[...document.querySelectorAll(${JSON.stringify(selector+' [data-action]')})].map(el=>el.dataset.action)`)
 try{
  await win.loadURL('http://127.0.0.1:5189/src/renderer/components/editor/test/rich-text-parity.browser.html')
  await until('window.ready?.()');await run('document.fonts.ready');win.webContents.debugger.attach('1.3')
  await check('plain context menu matches ordinary actions and disabled source-copy entry',async()=>{
   await fixture('正文\n\n最后一行')
   await context('#ordinary .tiptap p');await until(`!!document.querySelector(${JSON.stringify(ordinaryMenu)})`)
   const expected=await ids(ordinaryMenu)
   await context('#continuous .cm-line');await until(`!!document.querySelector(${JSON.stringify(largeMenu)})`)
   assert.deepEqual(await ids(largeMenu),expected)
   assert.equal(await run('document.querySelector(".looma-continuous-menu-panel [data-action=copy-source]").disabled'),true)
  })
  await check('last line and its trailing whitespace open the custom context menu',async()=>{
   for(const source of ['正文\n\n末行','正文\n\n']){
    await fixture(source);await run('cm().focus();cm().dispatch({selection:{anchor:model.length}})');await wait(80)
    const p=await run('(()=>{const r=cm().coordsAtPos(model.length);return{x:r.right+60,y:(r.top+r.bottom)/2}})()')
    await mouse('mousePressed',p);await mouse('mouseReleased',p);await wait(100)
    assert.ok(await run('!!document.querySelector(".looma-continuous-menu-panel:not([hidden]) [role=menu]")'),'source end '+JSON.stringify(source))
   }
  })
  const table='| A | B |\n| --- | --- |\n| one | two |'
  await check('table context menu exactly matches ordinary actions',async()=>{
   await fixture(table)
   await context('#ordinary td');await until(`!!document.querySelector(${JSON.stringify(ordinaryMenu)})`)
   const expected=await ids(ordinaryMenu)
   await context('#continuous .looma-continuous-table-row:not(.looma-continuous-table-header) .looma-continuous-table-cell')
   await until(`!!document.querySelector(${JSON.stringify(largeMenu)})`)
   assert.deepEqual(await ids(largeMenu),expected)
  })
  await check('held right-button move and release selects a table action exactly once',async()=>{
   await fixture(table)
   const p=await point('#continuous .looma-continuous-table-row:not(.looma-continuous-table-header) .looma-continuous-table-cell')
   await close();await mouse('mousePressed',p)
   await until(`!!document.querySelector(${JSON.stringify(largeMenu)})`)
   const before=await run('model.revision'),target=await point('.looma-continuous-menu-panel [data-action=rowAfter]')
   await mouse('mouseMoved',target);await wait(180);await mouse('mouseReleased',target);await wait(200)
   assert.equal(await run('model.revision'),before+1)
   assert.equal(await run('document.querySelectorAll(".looma-continuous-table-row").length'),3)
  })
  await check('a stationary right-button release never activates a clamped menu item',async()=>{
   win.setSize(1500,380);await fixture(table)
   const before=await run('model.revision')
   const p=await point('#continuous .looma-continuous-table-row:not(.looma-continuous-table-header) .looma-continuous-table-cell')
   await mouse('mousePressed',p);await wait(200);await mouse('mouseReleased',p);await wait(120)
   assert.equal(await run('model.revision'),before)
   assert.ok(await run('!!document.querySelector(".looma-continuous-menu-panel:not([hidden]) [role=menu]")'))
   win.setSize(1500,850);await wait(100)
  })
  await check('table picker has exactly one visual shell, no empty quick-menu wrapper',async()=>{
   await fixture('');app.focus({steal:true});win.focus();await run('cm().focus();cm().dispatch({selection:{anchor:0}})');
   await until('!!document.querySelector("[data-looma-continuous-menu-plus]:not([hidden])")')
   const p=await point('[data-looma-continuous-menu-plus]');await mouse('mousePressed',p,'left');await mouse('mouseReleased',p,'left');await wait(100)
   const t=await point('.looma-continuous-menu-panel [data-action=table]');await mouse('mousePressed',t,'left');await mouse('mouseReleased',t,'left');await wait(100)
   assert.ok(await run('!!document.querySelector(".looma-continuous-menu-panel .table-size-picker")'))
   assert.equal(await run(`document.querySelector(${JSON.stringify('.looma-continuous-menu-panel [aria-label="快速插入菜单"]')})`),null)
  })
  await check('opening a row menu does not synchronously scroll its first item before positioning',async()=>{
   await fixture('');app.focus({steal:true});win.focus();await run('cm().focus()')
   await until('!!document.querySelector("[data-looma-continuous-menu-plus]:not([hidden])")')
   await run(`window.menuScrolls=0;window.originalScroll=HTMLElement.prototype.scrollIntoView;HTMLElement.prototype.scrollIntoView=function(...args){if(this.closest('.looma-continuous-menu-panel'))menuScrolls++;return originalScroll.apply(this,args)};void 0`)
   const p=await point('[data-looma-continuous-menu-plus]');await mouse('mousePressed',p,'left');await mouse('mouseReleased',p,'left');await wait(80)
   const scrolls=await run('menuScrolls');await run('HTMLElement.prototype.scrollIntoView=originalScroll;void 0')
   assert.equal(scrolls,0,'opening must not force scroll/layout before overlay placement')
  })
  await check('row-menu latency is measured on a large in-memory document',async()=>{
   const source=Array.from({length:1600},(_,i)=>`段落 ${i} **正文**\n\n`).join('')
   await fixture(source)
   const timings=await run(`(async()=>{const values=[];cm().focus();for(let i=0;i<5;i++){const line=cm().state.doc.line(2+i*2);const start=performance.now();cm().dispatch({selection:{anchor:line.from}});await new Promise((resolve,reject)=>{const sample=()=>{const el=document.querySelector('[data-looma-continuous-menu-plus]');if(el&&!el.hidden){values.push(performance.now()-start);resolve()}else if(performance.now()-start>1500)reject(new Error('row menu did not appear'));else requestAnimationFrame(sample)};requestAnimationFrame(sample)});}return values})()`)
   console.log('ROW_MENU_MS',JSON.stringify(timings));assert.ok(timings.every(ms=>ms<100),'row menu paint budget: '+JSON.stringify(timings))
  })
  assert.deepEqual(errors,[])
  if(failures.length)throw new Error(JSON.stringify(failures,null,2))
  console.log('REPORT',directory);win.destroy();app.exit(0)
 }catch(error){console.error(error);console.error('Renderer errors',errors);win.destroy();app.exit(1)}
})
