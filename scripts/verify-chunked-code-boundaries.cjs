// Read-only real note reproduction; never writes the input or uses its directory for output.
const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const input=process.argv[2]
if(!input||!path.isAbsolute(input))throw new Error('请提供只读复现 Markdown 文件的绝对路径')
const bytes=fs.readFileSync(input),source=bytes.toString('utf8')
const hash=value=>crypto.createHash('sha256').update(value).digest('hex')
const before=hash(bytes)
const directory=fs.mkdtempSync(path.join(os.homedir(),'.hermes/cache/scratch/looma-code-boundaries-'))
app.setPath('userData',path.join(directory,'profile'))
const wait=(ms=100)=>new Promise(resolve=>setTimeout(resolve,ms))
app.whenReady().then(async()=>{
 const win=new BrowserWindow({width:1100,height:850,show:true,webPreferences:{backgroundThrottling:false}})
 const run=code=>win.webContents.executeJavaScript(code),errors=[],report=[]
 win.webContents.on('console-message',(_event,level,message)=>{if(level>=3)errors.push(message)})
 const until=async code=>{for(let i=0;i<120;i++){if(await run(code))return;await wait(50)}throw new Error('边界渲染超时: '+code)}
 const scroll=async line=>{await run(`chunk().scrollToLine(${line})`);await wait(200)}
 const style=async(line)=>run(`(()=>{const el=document.querySelector('[data-code-line="${line}"]');if(!el)return null;const s=getComputedStyle(el);return {line:${line},classes:el.className,top:s.borderTopWidth,bottom:s.borderBottomWidth,paddingTop:s.paddingTop,paddingBottom:s.paddingBottom}})()`)
 try{
  await win.loadURL('http://127.0.0.1:5189/src/renderer/components/editor/test/chunked-editor.browser.html')
  await until('window.ready?.()&&!!cm()');await run(`setFixture(${JSON.stringify(source)})`);await wait(500)
  for(const [first,last] of [[56,120],[124,127],[135,167]]){
   await scroll(first)
   await until(`!!document.querySelector('[data-code-line="${first}"].looma-code-block-start')`)
   const head=await style(first);assert.equal(head.top,'1px');assert.ok(parseFloat(head.paddingTop)>0)
   if(last-first>10){
    const middle=(first+last)>>1;await scroll(middle)
    await until(`!!document.querySelector('[data-code-line="${middle}"]')`)
    const inside=await style(middle);assert.ok(!inside.classes.includes('looma-code-block-start')&&!inside.classes.includes('looma-code-block-end'),'viewport does not invent caps')
   }
   await scroll(last)
   await until(`!!document.querySelector('[data-code-line="${last}"].looma-code-block-end')`)
   const tail=await style(last);assert.equal(tail.bottom,'1px');assert.ok(parseFloat(tail.paddingBottom)>0)
   report.push({first,last,head,tail})
  }
  assert.equal(hash(await run('model().content')),before,'display keeps canonical source unchanged')
  assert.equal(hash(fs.readFileSync(input)),before,'input file remains byte-for-byte unchanged')
  assert.equal(await run('events.pending'),0,'display creates no edit/save state')
  assert.deepEqual(errors,[])
  fs.writeFileSync(path.join(directory,'report.json'),JSON.stringify({sha256:before,blocks:report},null,2))
  console.log('PASS real input ranges 56–120, 124–127, 135–167: complete shell caps, insets, viewport middle, no source writes')
  console.log('UNCHANGED_SHA256',before);console.log('REPORT',directory)
  win.destroy();fs.rmSync(path.join(directory,'profile'),{recursive:true,force:true});app.exit(0)
 }catch(error){console.error(error);console.error(errors);win.destroy();app.exit(1)}
})
