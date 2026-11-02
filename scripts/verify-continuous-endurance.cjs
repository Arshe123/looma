// Hidden, isolated, fixed-build endurance. No user notes or system clipboard.
// Run: npx electron scripts/verify-continuous-endurance.cjs
// Optional LOOMA_ENDURANCE_MS >= 600000; shorter runs are diagnostic only.
const {app,BrowserWindow}=require('electron')
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),assert=require('node:assert/strict')
const {pathToFileURL}=require('node:url')
const root=path.resolve(__dirname,'..'),scratch=fs.mkdtempSync(path.join(os.homedir(),'.hermes/cache/scratch/looma-continuous-endurance-'))
for(const name of ['appData','userData','sessionData']){fs.mkdirSync(path.join(scratch,name));app.setPath(name,path.join(scratch,name))}
app.commandLine.appendSwitch('js-flags','--expose-gc')
app.commandLine.appendSwitch('disable-renderer-backgrounding')
const duration=Number(process.env.LOOMA_ENDURANCE_MS||600000)
const report={artifactDirectory:scratch,startedAt:new Date().toISOString(),durationRequestedMs:duration,budgets:{jsHeapMiB:384,rendererRssMiB:800,totalAppRssMiB:1400,domNodes:12000,postGcGrowthMiB:64},limitations:['Fixed standalone build of actual production MarkdownEditor and ChunkedDocument, not production main/preload disk persistence.','Hidden Electron with Chromium focus emulation; not native macOS/Windows input.','Ten minutes is not multi-hour endurance. CPU/load samples include concurrent work; CDP round-trip is not input-to-paint latency.','History stores inverse ChangeSets/effects/selections, NOT whole-document snapshots per event. Controlled replacements deliberately retain inverse text.','Forced GC samples are diagnostic and not normal application GC behavior.'],stages:[],samples:[],failures:[]}
const file=path.join(scratch,'results.json'),save=()=>fs.writeFileSync(file,JSON.stringify(report,null,2)),hash=s=>crypto.createHash('sha256').update(s).digest('hex'),wait=ms=>new Promise(r=>setTimeout(r,ms))
let win,watchdog,ended=false
function finish(error){if(ended)return;ended=true;if(error)report.failures.push({error:String(error),stack:error.stack});report.completedAt=new Date().toISOString();report.exitCode=report.failures.length?1:0;save();console.log('FINAL',JSON.stringify({exitCode:report.exitCode,report:file,wallMs:report.enduranceWallMs,failures:report.failures}));clearTimeout(watchdog);if(win&&!win.isDestroyed())win.destroy();app.exit(report.exitCode)}
const run=code=>win.webContents.executeJavaScript(code)
async function sample(label){
 await win.webContents.debugger.sendCommand('HeapProfiler.collectGarbage')
 const heap=await win.webContents.debugger.sendCommand('Runtime.getHeapUsage'),dom=await win.webContents.debugger.sendCommand('Memory.getDOMCounters')
 const metrics=app.getAppMetrics().map(p=>({pid:p.pid,type:p.type,cpu:p.cpu.percentCPUUsage,rssMiB:p.memory.workingSetSize/1024}))
 const state=await run('enduranceStats()')
 const s={label,elapsedMs:report.enduranceStart?Date.now()-report.enduranceStart:0,heapMiB:heap.usedSize/1048576,heapTotalMiB:heap.totalSize/1048576,dom,metrics,loadAverage:os.loadavg(),...state};report.samples.push(s);save();console.log('SAMPLE',JSON.stringify(s))
 assert.ok(s.heapMiB<report.budgets.jsHeapMiB,'heap budget');assert.ok(dom.nodes<report.budgets.domNodes,'DOM budget');assert.ok(metrics.filter(p=>p.type==='Tab').every(p=>p.rssMiB<report.budgets.rendererRssMiB),'renderer RSS budget');assert.ok(metrics.reduce((a,p)=>a+p.rssMiB,0)<report.budgets.totalAppRssMiB,'app RSS budget')
 const stable=report.samples.filter(p=>p.label==='steady');if(stable.length>=5){const recent=stable.slice(-5);assert.ok(!(recent.every((p,i)=>!i||p.heapMiB>recent[i-1].heapMiB+2)&&recent.at(-1).heapMiB-recent[0].heapMiB>32),'sustained heap growth protection');assert.ok(stable.at(-1).heapMiB-stable[0].heapMiB<report.budgets.postGcGrowthMiB,'post-GC growth budget')}
 return s
}
async function key(redo=false){const p={key:redo?'Z':'z',code:'KeyZ',windowsVirtualKeyCode:90,modifiers:process.platform==='darwin'?(redo?12:4):(redo?10:2)};await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyDown',...p});await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyUp',...p})}
async function stage(name,fn){const t=Date.now(),data=await fn();report.stages.push({name,wallMs:Date.now()-t,...data});save();console.log('STAGE',name,JSON.stringify(data))}
app.whenReady().then(async()=>{
 watchdog=setTimeout(()=>finish(Error('bounded watchdog 14 minutes')),840000)
 // Compile once: no dev server or HMR can change the running baseline.
 const {build}=await import('vite'),vue=(await import('@vitejs/plugin-vue')).default,tailwind=(await import('@tailwindcss/vite')).default
 const input=path.join(root,'scripts/test/continuous-endurance.html'),out=path.join(scratch,'fixed-build')
 const sourceFiles=[];function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())walk(p);else if(/\.(vue|ts|css)$/.test(e.name))sourceFiles.push(p)}}walk(path.join(root,'src'))
 report.sourceBefore=Object.fromEntries(sourceFiles.map(p=>[path.relative(root,p),hash(fs.readFileSync(p))]));save()
 await build({root,configFile:false,base:'./',mode:'test',logLevel:'error',plugins:[vue(),tailwind()],resolve:{alias:{'@':path.join(root,'src')}},build:{outDir:out,emptyOutDir:true,minify:false,rollupOptions:{input}}})
 report.sourceChangedDuringBuild=sourceFiles.filter(p=>report.sourceBefore[path.relative(root,p)]!==hash(fs.readFileSync(p))).map(p=>path.relative(root,p))
 report.fixedEntry=path.join(out,'scripts/test/continuous-endurance.html');report.fixedEntrySha256=hash(fs.readFileSync(report.fixedEntry));save()
 win=new BrowserWindow({width:1100,height:820,show:false,focusable:false,webPreferences:{backgroundThrottling:false}})
 win.webContents.on('console-message',(_e,level,message)=>{if(level>=3){(report.rendererErrors||=[]).push(message.slice(0,500));save()}})
 await win.loadFile(report.fixedEntry);win.webContents.debugger.attach('1.3');await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true})
 for(let i=0;i<300&&!(await run('window.ready?.()&&!!cm()'));i++)await wait(50)
 assert.equal(await run('!!cm()'),true);assert.equal(win.isVisible(),false)
 await run('start(0)');await sample('mounted')
 await stage('controlled-large-inverse-text',async()=>{
  const data=await run(`(async()=>{await setFixture('large baseline\\n\\n'+('中文正文 **格式**\\n\\n'.repeat(24000)));start(0);window.largeOriginal=model().content;return {chars:model().length}})()`)
  const before=await sample('before-large')
  for(let i=0;i<8;i++){
   await run(`(()=>{const v=cm(),n=Math.min(240000,v.state.doc.length-20),text=${i}===7?'':(('替换'+${i}+' 正文\\n\\n').repeat(26000));v.dispatch({changes:{from:10,to:10+n,insert:text},userEvent:'input'});})()`)
   await sample('large-'+i)
  }
  const retained=await run('enduranceStats()')
  await run('window.largeEdited=model().content')
  for(let i=0;i<8;i++)await key()
  assert.equal(await run('model().content===largeOriginal'),true,'large undo byte exact')
  for(let i=0;i<8;i++)await key(true)
  assert.equal(await run('model().content===largeEdited'),true,'large redo byte exact')
  await run('window.largeOriginal=null;window.largeEdited=null')
  return {...data,beforeHeapMiB:before.heapMiB,retained,largeEdits:8,undoRedoExact:true}
 })
 await stage('history-depth-1200',async()=>{
  await run(`setFixture('# 长时夹具\\n\\n'+('正文 **格式** 与中文😀\\n\\n'.repeat(18000)))`);await run('start(0)');await sample('before-history')
  const result=await run(`(()=>{const d=model(),t=performance.now();window.historyBase=d.content;for(let i=0;i<1200;i++){const v=cm();v.dispatch({changes:{from:0,insert:'文'},userEvent:'input'})}return {dispatch1200Ms:performance.now()-t,...enduranceStats()}})()`)
  await sample('history-1200');await run('window.historyEdited=model().content')
  for(let i=0;i<1000;i++)await key()
  assert.equal(await run("model().content==='文'.repeat(200)+historyBase"),true,'1000 deep undo exact')
  for(let i=0;i<1000;i++)await key(true)
  assert.equal(await run('model().content===historyEdited'),true,'1000 redo exact')
  await run('window.historyBase=null;window.historyEdited=null');return {...result,undos:1000,redos:1000,exact:true}
 })
 report.enduranceStart=Date.now();save();let cycles=0,inputs=0,undos=0,redos=0,nextSample=0;const timings=[]
 while(Date.now()-report.enduranceStart<duration){
  const t=performance.now();await run('start(0)');
  await win.webContents.debugger.sendCommand('Input.insertText',{text:'长时😀'});inputs++
  assert.equal(await run("model().slice(0,4)==='长时😀'"),true)
  await key();undos++;assert.notEqual(await run('model().slice(0,4)'),'长时😀')
  await key(true);redos++;assert.equal(await run("model().slice(0,4)==='长时😀'"),true)
  // One additional actual undo bounds document size while retaining/reusing history.
  await key();undos++;timings.push(performance.now()-t);cycles++
  if(Date.now()-report.enduranceStart>=nextSample){await sample('steady');nextSample+=15000}
  await wait(Math.max(0,500-(performance.now()-t)))
 }
 report.enduranceWallMs=Date.now()-report.enduranceStart
 timings.sort((a,b)=>a-b);await stage('ten-minute-real-input-undo-redo',async()=>({cycles,inputs,undos,redos,wallMs:report.enduranceWallMs,cycleCdpP50Ms:timings[Math.floor(timings.length*.5)],cycleCdpP95Ms:timings[Math.floor(timings.length*.95)],cycleMaxMs:timings.at(-1),concurrentCpu:report.samples.filter(p=>p.label==='steady').map(p=>({elapsedMs:p.elapsedMs,loadAverage:p.loadAverage,metrics:p.metrics}))}))
 const final=await sample('final');assert.ok(report.enduranceWallMs>=600000,'acceptance requires actual >=10 minutes');assert.equal(win.isVisible(),false)
 report.final=final;report.fixedEntryUnchanged=report.fixedEntrySha256===hash(fs.readFileSync(report.fixedEntry));assert.equal(report.fixedEntryUnchanged,true);finish()
}).catch(finish)
