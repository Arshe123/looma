// Start: npx vite --mode test --host 127.0.0.1 --port 5189
// Then: npx electron scripts/verify-split-writing-scroll.cjs
const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const profile = mkdtempSync(join(tmpdir(), 'looma-split-writing-'))
app.setPath('userData', profile)
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
app.whenReady().then(async () => {
 const win = new BrowserWindow({width:1200,height:800,show:false,webPreferences:{backgroundThrottling:false}})
 const run = code => win.webContents.executeJavaScript(code)
 let failed = false
 try {
  for(const side of ['source','rich']) {
   await win.loadURL('http://127.0.0.1:5189/scripts/test/split-writing-scroll.html')
   for(let i=0;i<100 && !await run('window.ready?.()');i++) await wait(100)
   await run('split()')
   for(let i=0;i<100 && !await run('!!document.querySelector(".cm-editor")');i++) await wait(100)
   await run('document.fonts.ready'); await wait(500)
   await run(`focusMiddle('${side}')`); await wait(500)
   const before = await run('positions()')
   await run('startTrace()')
   for(const text of ['甲','乙','丙','丁']) { await win.webContents.insertText(text); await wait(350) }
   const result = await run('finishTrace()')
   const ranges = before.map((v,i)=>({before:v,min:Math.min(...result.trace.map(p=>p[i])),max:Math.max(...result.trace.map(p=>p[i]))}))
   console.log(side,JSON.stringify(ranges))
   try {
    for(const range of ranges) {
     assert.ok(range.before>500, '应在长笔记中间复现')
     assert.ok(Math.abs(range.min-range.before)<=2 && Math.abs(range.max-range.before)<=2, `${side}: 输入不换行时两侧每一帧均应稳定`)
    }
    assert.ok(result.content.includes('甲乙丙丁'))
    assert.equal(result.source,result.content)
    assert.equal(result.rich,result.content)

    // Fast typing exercises the rich-text serializer's debounce as well.
    await run('startTrace()')
    for (const text of ['快','速','输','入']) {
     await win.webContents.insertText(text); await wait(20)
    }
    await wait(400)
    const fast = await run('finishTrace()')
    for (const positions of fast.trace) {
     positions.forEach((top,i)=>assert.ok(Math.abs(top-before[i])<=2, `${side}: 快速输入不应抖动`))
    }
    assert.equal(fast.source,fast.content)
    assert.equal(fast.rich,fast.content)

    // Native Return + wrapping may scroll down, never flash toward the top.
    await run('startTrace()')
    for (let i=0;i<3;i++) {
     win.webContents.sendInputEvent({type:'keyDown',keyCode:'Return'})
     win.webContents.sendInputEvent({type:'keyUp',keyCode:'Return'})
     await win.webContents.insertText('换行后的中文长句用于验证自动折行。'.repeat(5))
     await wait(350)
    }
    const wrapped = await run('finishTrace()')
    const activeIndex = side==='source'?0:1
    assert.ok(wrapped.trace.every(p=>p[activeIndex]>=before[activeIndex]-2), `${side}: 换行折行不能回跳顶部`)
    assert.equal(wrapped.source,wrapped.content)
    assert.equal(wrapped.rich,wrapped.content)

    // Both directions still follow genuine scrolling after content updates.
    for (const driver of [0,1]) {
     await wait(300)
     const previous = await run('positions()')
     await run(`panes()[${driver}].scrollTop += 240`)
     await wait(400)
     const next = await run('positions()')
     assert.ok(next[1-driver]>previous[1-driver]+50, `${side}: ${driver} 侧滚动必须带动另一侧`)
     await wait(300)
     const settled = await run('positions()')
     settled.forEach((top,i)=>assert.ok(Math.abs(top-next[i])<=2, '手动滚动后不应回弹'))
    }
    console.log(`${side}: 慢速/快速输入、换行折行、双向滚动通过`)
   } catch(error) {failed=true;console.error(error.message)}
  }
 } catch(error) {failed=true;console.error(error)}
 win.destroy();rmSync(profile,{recursive:true,force:true});app.exit(failed?1:0)
})
