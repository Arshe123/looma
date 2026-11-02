// Isolated foreground macOS SCIM acceptance; never imports clipboard APIs.
const {app,BrowserWindow,Menu}=require('electron')
const fs=require('node:fs'),os=require('node:os'),path=require('node:path')
const {execFile}=require('node:child_process'),{promisify}=require('node:util')
const exec=promisify(execFile),wait=(ms=150)=>new Promise(r=>setTimeout(r,ms))
const dir=fs.mkdtempSync(path.join(os.homedir(),'.hermes/cache/scratch/looma-native-ime-'))
for(const p of ['appData','userData','sessionData'])app.setPath(p,path.join(dir,p))
const driver=path.join(dir,'native-input-driver')
const report={directory:dir,pid:process.pid,transport:'Swift CGEvent virtual keycode -> cghidEventTap -> current SCIM; async execFile',clipboard:'not read or written',cases:[],failures:[],screenshots:[]}
let win,initial,aborted=false
const native=async(mode,...args)=>{try {const r=await exec(driver,[mode,...args.map(String)],{timeout:10000});return JSON.parse(r.stdout)}catch(e){if(e.code===42){aborted=true;throw new Error('BLOCKED: foreground moved; stopped all native input')}throw e}}
const save=()=>fs.writeFileSync(path.join(dir,'report.json'),JSON.stringify(report,null,2))
app.whenReady().then(async()=>{
 try {
 await exec('/usr/bin/swiftc',[path.join(__dirname,'test/macos-native-input.swift'),'-o',driver],{timeout:60000})
 initial=await native('state');report.initial=initial
 if(!initial.inputSource.includes('SCIM'))throw Error('BLOCKED: current source is not SCIM; no switch attempted')
 Menu.setApplicationMenu(null)
 win=new BrowserWindow({title:'LOOMA NATIVE IME TEST — ISOLATED SYNTHETIC TEXT ONLY',width:1320,height:820,show:false,webPreferences:{backgroundThrottling:false}})
 const run=s=>win.webContents.executeJavaScript(s)
 await win.loadURL('about:blank');win.webContents.debugger.attach('1.3')
 const cdp=(method,args={})=>win.webContents.debugger.sendCommand(method,args)
 await cdp('Page.enable')
 await cdp('Page.addScriptToEvaluateOnNewDocument',{source:`{const S=WebSocket;window.WebSocket=class extends S{constructor(u,p){super(u,p);if(p==='vite-hmr')super.addEventListener('message',e=>{if(['update','full-reload','prune'].includes(JSON.parse(e.data).type))e.stopImmediatePropagation()})}};window.nativeEventConstructions=[];for(const name of ['Event','CompositionEvent']){const Original=window[name];window[name]=new Proxy(Original,{construct(target,args,newTarget){if(String(args[0]).startsWith('composition'))nativeEventConstructions.push({type:args[0],constructor:name,stack:new Error().stack});return Reflect.construct(target,args,newTarget)}})}}`})
 await win.loadURL('http://127.0.0.1:5189/src/renderer/components/editor/test/rich-text-parity.browser.html')
 for(let i=0;i<80&&!await run('window.ready?.()');i++)await wait(100)
 if(!await run('ready()'))throw Error('fixture not ready')
 await run(`document.title='LOOMA NATIVE IME TEST — ISOLATED SYNTHETIC TEXT ONLY';state.width=640;window.nativeLog=[];for(const type of ['compositionstart','compositionupdate','compositionend','beforeinput','input','keydown'])document.addEventListener(type,e=>nativeLog.push({type,data:e.data??null,inputType:e.inputType??null,key:e.key??null,isTrusted:e.isTrusted,isComposing:e.isComposing??null,host:e.target.closest('#ordinary,#continuous')?.id,time:performance.now()}),true);document.fonts.ready`)
 win.on('page-title-updated',e=>e.preventDefault());win.setTitle('LOOMA NATIVE IME TEST — ISOLATED SYNTHETIC TEXT ONLY')
 win.show();app.focus({steal:true});win.focus();await wait(800)
 const key=async text=>{if(aborted)throw Error('focus abort');const result=await native('keys',process.pid,text);await wait(260);return result}
 // Prime the OS text-input connection in a disposable plain input. This is a
 // warm-IME matrix, NOT acceptance of the first keystroke of a cold IME launch.
 await run(`window.nativeWarmup=document.createElement('input');nativeWarmup.setAttribute('aria-label','隔离输入法预热');document.body.append(nativeWarmup);nativeWarmup.focus()`)
 await key('n,i,h,a,o');await key('escape')
 report.warmup=await run('({value:nativeWarmup.value,log:nativeLog.slice(),constructors:nativeEventConstructions.slice()})')
 await run('nativeWarmup.remove();nativeLog=[];nativeEventConstructions=[]')
 const inspect=host=>run(`(()=>{const s=getSelection(),n=s.anchorNode,e=n?.nodeType===3?n.parentElement:n,c=e?.closest('td,th,.looma-continuous-table-cell'),r=s.rangeCount?s.getRangeAt(0).getBoundingClientRect():null;return{source:${host==='ordinary'?'pm().getMarkdown()':'model.content'},selection:${host==='ordinary'?'pm().state.selection.from':'cm().state.selection.main.head'},column:c?[...c.parentElement.children].indexOf(c):-1,cellText:c?.textContent,nodeText:n?.textContent,offset:s.anchorOffset,rect:r?{x:r.x,y:r.y,width:r.width,height:r.height}:null,focus:document.activeElement?.className,composing:${host==='ordinary'?'pm().view.composing':'cm().composing'},log:nativeLog.slice()}})()`)
 const screenshot=async(name)=>{const file=path.join(dir,name+'.png');fs.writeFileSync(file,(await win.webContents.capturePage()).toPNG());report.screenshots.push(file);return file}
 const glyph=async(host)=>{
  const measurement=await run(`(()=>{const s=getSelection(),n=s.anchorNode;if(!n)return null;const range=document.createRange();range.selectNodeContents(n);const r=range.getBoundingClientRect();return{x:Math.max(0,Math.floor(r.x)-2),y:Math.max(0,Math.floor(r.y)-2),width:Math.min(500,Math.ceil(r.width)+4),height:Math.ceil(r.height)+4}})()`)
  if(!measurement||measurement.width<5||measurement.height<10)return {blocked:'no measurable native composition glyph range',measurement}
  const before=(await win.webContents.capturePage(measurement)).toBitmap()
  await run(`window.glyphProbe=document.createElement('style');glyphProbe.textContent='#${host} .tiptap *,#${host} .cm-content *{color:transparent!important;text-decoration-color:transparent!important}';document.head.append(glyphProbe)`);await wait(60)
  const hidden=(await win.webContents.capturePage(measurement)).toBitmap()
  await run('glyphProbe.remove()');await wait(70)
  let changed=0;for(let i=0;i<before.length;i+=4)if(Math.abs(before[i]-hidden[i])+Math.abs(before[i+1]-hidden[i+1])+Math.abs(before[i+2]-hidden[i+2])>40)changed++
  return {measurement,changedPixels:changed}
 }
 const check=(c,condition,message)=>{c.assertions.push({pass:!!condition,message});if(!condition){c.status='fail';report.failures.push(c.name+': '+message)}}
 nativeSuite: for(const host of ['ordinary','continuous'])for(const variant of ['body','padded-middle','padded-last','zero-middle','zero-last']){
  const c={name:host+'-'+variant,status:'pass',assertions:[]};report.cases.push(c)
  try{
   const table=variant!=='body',zero=variant.startsWith('zero'),col=variant.endsWith('last')?2:1
   const blank=zero?'||||':'|  |  |  |'
   const source=table?`前邻文\n\n${blank}\n| --- | --- | --- |\n${blank}\n\n后邻文`:'前邻文后邻文\n\n保留段落'
   await run(`(async()=>{flush();await setFixture('native-test-reset');await setFixture(${JSON.stringify(source)});nativeLog=[];nativeEventConstructions=[]})()`);await wait(650)
   if(table){
    const p=await run(`(()=>{const row=document.querySelectorAll('#${host} ${host==='ordinary'?'.tiptap tr':'.looma-continuous-table-row'}')[1],cell=row.querySelectorAll('${host==='ordinary'?'td,th':'.looma-continuous-table-cell'}')[${col}],r=cell.getBoundingClientRect();return{x:r.left+18,y:r.top+r.height/2}})()`)
    for(const type of ['mousePressed','mouseReleased'])await cdp('Input.dispatchMouseEvent',{type,button:'left',buttons:type==='mousePressed'?1:0,clickCount:1,...p})
   }else await run(host==='ordinary'?'pm().commands.setTextSelection(4);pm().view.focus()':'cm().dispatch({selection:{anchor:3}});cm().focus()')
   await wait(250);c.before=await inspect(host)
   // Build an undispatched transaction solely to serialize the exact expected PM document.
   c.expectedSource=host==='ordinary'?await run("pm().storage.markdown.manager.serialize(pm().state.tr.insertText('你好').doc.toJSON())"):c.before.source.slice(0,c.before.selection)+'你好'+c.before.source.slice(c.before.selection)
   if(table)check(c,c.before.column===col,'setup DOM caret belongs to intended cell')
   await key('n,i,h,a,o');c.marked=await inspect(host);c.glyph=await glyph(host)
   c.candidateWindows=await native('windows',process.pid)
   c.markedScreenshot=await screenshot(c.name+'-candidate-open')
   const candidates=c.candidateWindows.windows.filter(w=>w.kCGWindowOwnerPID!==process.pid||w.kCGWindowLayer===20)
   c.auxiliaryWindowQualification='App-owned layer-20 captures need visual identity review; ownership alone is not proof of an OS candidate window'
   c.nativeCandidateScreenshots=[]
   for(const w of candidates){if(w.kCGWindowLayer<0)continue;const file=path.join(dir,c.name+'-ime-'+w.kCGWindowNumber+'.png');try{await exec('/usr/sbin/screencapture',['-x','-o','-l',String(w.kCGWindowNumber),file],{timeout:5000});c.nativeCandidateScreenshots.push(file);report.screenshots.push(file)}catch(e){c.candidateCaptureBlocked=String(e.stderr||e.message)}}
   check(c,c.marked.log.some(e=>e.type==='compositionstart'&&e.isTrusted),'real trusted compositionstart observed')
   check(c,c.marked.log.some(e=>e.type==='compositionupdate'&&e.isTrusted),'real trusted compositionupdate observed')
   check(c,c.glyph.changedPixels>0&&c.marked.log.some(e=>e.type==='compositionupdate'&&e.isTrusted),'native marked glyphs actually paint pixels during trusted composition')
   if(table)check(c,c.marked.column===col,'marked DOM caret remains in intended cell')
   await key('space');c.committed=await inspect(host)
   c.compositionConstructors=await run('nativeEventConstructions.slice()')
   const commitText=c.committed.log.filter(e=>e.type==='compositionend').at(-1)?.data
   c.committedText=commitText
   check(c,commitText==='你好','SCIM nihao + Space commits exactly 你好')
   check(c,c.committed.log.some(e=>e.type==='compositionend'&&e.isTrusted),'trusted native compositionend observed')
   check(c,c.committed.source===c.expectedSource,'exact committed Markdown source matches insertion only')
   if(table)check(c,c.committed.column===col,'committed native DOM caret belongs to intended cell')
   await key('undo');c.undo=await inspect(host);check(c,c.undo.source===c.before.source,'single native CmdZ restores exact source without losing neighbours')
   await key('redo');c.redo=await inspect(host);check(c,c.redo.source===c.committed.source,'native ShiftCmdZ restores exact committed source')
   await key('n,i,h,a,o');c.cancelMarked=await inspect(host);await key('escape');c.cancelled=await inspect(host)
   check(c,c.cancelled.source===c.committed.source,'Escape cancels native marked text without touching committed text')
   await key('n,i,h,a,o');await key('undo');c.compositionUndo=await inspect(host)
   check(c,c.compositionUndo.source.includes('前邻文')&&c.compositionUndo.source.includes('后邻文'),'CmdZ during composition preserves adjacent text')
   // Explicitly cancel any remaining marked text before DOM-only next setup.
   await key('escape');c.final=await inspect(host)
   await screenshot(c.name+'-final');console.log(c.status.toUpperCase(),c.name,c.committedText,c.glyph.changedPixels,'candidateWindows',candidates.length)
  }catch(e){c.status=aborted?'blocked':'fail';c.error=e.stack;report.failures.push(c.name+': '+e.message);if(aborted)break nativeSuite}
  save()
 }
 report.finalState=await native('state')
 }catch(e){report.error=e.stack;report.failures.push(e.message)}
 finally{
  for(const host of ['ordinary','continuous'])for(const variant of ['body','padded-middle','padded-last','zero-middle','zero-last'])if(!report.cases.some(c=>c.name===host+'-'+variant))report.cases.push({name:host+'-'+variant,status:'blocked',reason:aborted?'foreground changed; not attempted':'suite did not reach this case',assertions:[]})
  report.coverage={candidateWindowEvidence:report.cases.some(c=>c.nativeCandidateScreenshots?.length)?'auxiliary window images captured; identity requires separate visual review':'blocked: no positively identified SCIM candidate window captured; renderer screenshots are NOT candidate-window evidence',coldFirstKeystroke:'not accepted by this warm-IME matrix'}
  if(initial){try{report.restore=await native('restore',process.pid,initial.pid,...initial.mouse)}catch(e){report.restore={error:e.message}}}
  if(win&&!win.isDestroyed())win.destroy()
  report.exitCode=report.failures.length?1:0;save();console.log('REPORT',dir);console.log('EXIT',report.exitCode);app.exit(report.exitCode)
 }
})
