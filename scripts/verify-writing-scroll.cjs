// Start: npx vite --mode test --host 127.0.0.1 --port 5189
// Then: npx electron scripts/verify-writing-scroll.cjs
const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const profile = mkdtempSync(join(tmpdir(), 'looma-writing-scroll-'))
app.setPath('userData', profile)
const wait = () => new Promise(resolve => setTimeout(resolve, 100))
app.whenReady().then(async () => {
 const win = new BrowserWindow({width:1000,height:800,show:false,webPreferences:{backgroundThrottling:false}})
 const run = code => win.webContents.executeJavaScript(code)
 const enter = async () => {
  win.webContents.sendInputEvent({type:'keyDown',keyCode:'Return'})
  win.webContents.sendInputEvent({type:'keyUp',keyCode:'Return'})
  await wait()
 }
 const check = async label => {
  const result = await run('measure()')
  console.log(label, JSON.stringify(result))
  assert.ok(result.gap >= Math.min(result.padding, result.height / 2) - 2, `${label}: 输入行应使用底部留白`)
  assert.ok(result.gap <= Math.min(result.padding, result.height / 2) + 8, `${label}: 留白应随视口大小更新`)
  assert.ok(result.gap < result.height - 20, `${label}: 光标仍在视口内`)
  return result
 }
 try {
  for (const mode of ['rich', 'source']) {
   await win.loadURL(`http://127.0.0.1:5189/scripts/test/writing-scroll.html${mode==='source'?'?source':''}`)
   for(let i=0;i<100;i++) { if(await run('window.ready?.()')) break; await wait() }
   await run('document.fonts.ready'); await run('focusEnd()'); await wait(); await wait()
   const before = await run('measure()')
   for(let i=0;i<5;i++) await enter()
   const after = await check(`${mode}: 连续回车`)
   assert.equal(after.lines, before.lines + 5)
   for(let i=0;i<12;i++) { await win.webContents.insertText('用于测试连续输入自动折行的长句。'.repeat(8)); await wait() }
   await check(`${mode}: 自动折行`)
   const top = await run('scrollManually()'); await wait()
   assert.equal((await run('measure()')).scrollTop, top, '手动滚动不应被光标拉回')
   await run("document.querySelector('#app').style.height='240px'; focusEnd()")
   await wait(); await enter()
   await check(`${mode}: 小视口`)
  }
  win.destroy()
  rmSync(profile, {recursive:true,force:true})
  app.exit(0)
 } catch(error) {console.error(error);win.destroy();rmSync(profile,{recursive:true,force:true});app.exit(1)}
})
