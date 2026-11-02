// Read-only production audit; writes only generated fixtures/artifacts under scratch.
// Run serially after integration: npx electron scripts/verify-continuous-performance.cjs
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const assert = require('node:assert/strict')
const base = process.env.LOOMA_PERF_URL || 'http://127.0.0.1:5189'
const root = path.resolve(__dirname, '..')
const scratch = fs.mkdtempSync(path.join(os.homedir(), '.hermes/cache/scratch/looma-continuous-performance-'))
for (const name of ['appData', 'userData', 'sessionData']) { const dir = path.join(scratch, name); fs.mkdirSync(dir); app.setPath(name, dir) }
const hash = value => crypto.createHash('sha256').update(value).digest('hex')
const tracked = [...new Set(['src/renderer/components/editor/MarkdownEditor.vue', 'src/renderer/workers/chunked-note-metadata.worker.ts', ...fs.readdirSync(path.join(root,'src/renderer/components/editor')).filter(file=>/\.(vue|ts)$/.test(file)).map(file=>'src/renderer/components/editor/'+file), ...fs.readdirSync(path.join(root,'src/shared/utils')).filter(file=>/^(chunked-document|markdown-|note-reading-time)/.test(file)&&file.endsWith('.ts')).map(file=>'src/shared/utils/'+file)])]
const hashes = () => Object.fromEntries(tracked.map(file => [file, hash(fs.readFileSync(path.join(root, file)))]))
const result = { createdAt: new Date().toISOString(), artifactDirectory: scratch, platform: process.platform, versions: process.versions, preliminary: true, sourceBefore: hashes(), limitations: ['Hidden Electron + Chromium focus emulation, not native OS input.', 'In-memory fixture mount is not cold disk-open latency.', 'Export writes below are harness fsync writes, NOT production main/preload saves.', 'Worker observed latency includes queue, computation, cloning and delivery; not pure compute.', 'Short stress is not long-duration endurance; no native Windows or installation checks.'], cases: [], failures: [] }
const save = () => fs.writeFileSync(path.join(scratch, 'results.json'), JSON.stringify(result, null, 2))
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
let win
const run = code => win.webContents.executeJavaScript(code)
const frame = 'await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'
async function stage(name, operation) {
  try { const data = await operation(); result.cases.push({ name, status: 'pass', ...data }); console.log('PASS', name, JSON.stringify(data)); save(); return data }
  catch (error) { result.failures.push({ name, error: String(error), stack: error.stack }); console.error('FAIL', name, error); save(); return null }
}
async function until(code, label) { for(let i=0;i<200;i++){if(await run(code))return;await wait(50)}throw Error('Timeout '+label) }
const fixtures = {
  multiline: '# 多行性能夹具\n\n' + Array.from({length:16000}, (_,i)=>`第${i}行 正文 **格式** 与 中文😀\n`).join(''),
  single2m: '单'.repeat(2000000),
  ascii2m: 'a'.repeat(2000000),
  formatted2m: '**' + '字'.repeat(2000000) + '**',
  formattedAscii2m: '**' + 'a'.repeat(2000000) + '**',
  complex: '# 复杂性能夹具\n\n'+Array.from({length:1600},(_,i)=>`## 标题${i}\n\n> - **粗体 *嵌套*** [链接](note.md#L3)\n>   继续正文\n\n| A | B |\n|---|---|\n| 中文 | \\| |\n\n\`\`\`javascript\nconst value${i} = "中文"; // 注释\n\`\`\`\n\n[ref${i}]: target${i}.md "标题"\n\n引用 [ref${i}]\n\n`).join(''),
}
for (const [name, text] of Object.entries(fixtures)) fs.writeFileSync(path.join(scratch, name+'.md'), text)
const watchdog = setTimeout(()=>{result.failures.push({name:'watchdog',error:'180s timeout'});save();if(win&&!win.isDestroyed())win.destroy();app.exit(1)},180000)
app.whenReady().then(async()=>{
  win = new BrowserWindow({ width:1150, height:820, show:false, webPreferences:{backgroundThrottling:false} })
  win.webContents.on('console-message', (_event, level, message)=>{ if(level>=3){(result.rendererErrors ||= []).push(message.slice(0,700));save()} })
  // Establish a renderer first: CDP emulation on initial about:blank can stall.
  await win.loadURL(base+'/src/renderer/components/editor/test/chunked-editor.browser.html')
  win.webContents.debugger.attach('1.3')
  await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true})
  await win.webContents.debugger.sendCommand('Page.enable')
  await win.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument',{source:`
    window.perfWorkers=[];window.perfLongTasks=[];window.perfHmr=[];
    const OriginalWorker=window.Worker;
    window.Worker=class extends OriginalWorker {
      constructor(...args){super(...args);this.probePending=new Map();this.probeUrl=String(args[0]);this.addEventListener('message',event=>{const p=this.probePending.get(event.data.requestId);if(p){p.replyMs=performance.now()-p.start;p.metadata=event.data.metadata;p.references=event.data.references?.size;this.probePending.delete(event.data.requestId)}})}
      postMessage(data,...args){const p={url:this.probeUrl,requestId:data.requestId,revision:data.revision,chars:data.content?.length,start:performance.now()};window.perfWorkers.push(p);this.probePending.set(data.requestId,p);const t=performance.now();super.postMessage(data,...args);p.postSyncMs=performance.now()-t}
    };
    try{new PerformanceObserver(list=>window.perfLongTasks.push(...list.getEntries().map(e=>({start:e.startTime,duration:e.duration})))).observe({entryTypes:['longtask']})}catch{}
  `})
  await win.loadURL(base+'/src/renderer/components/editor/test/chunked-editor.browser.html')
  await until('window.ready?.() && !!cm()', 'real component')
  await run(`(async()=>{await document.fonts.ready; window.perfUpdates=[];const push=events.updates.push;events.updates.push=function(...values){window.perfUpdates.push({time:performance.now(),chars:values[0]?.length});return push.apply(this,values)};
    const prototype=Object.getPrototypeOf(model()), getter=Object.getOwnPropertyDescriptor(prototype,'content');window.perfFlatten=[];
    Object.defineProperty(prototype,'content',{configurable:true,get(){const cold=this.snapshot===undefined,t=performance.now(),text=getter.get.call(this);window.perfFlatten.push({revision:this.revision,cold,ms:performance.now()-t,chars:text.length});return text}});
    window.perfModules={...(await import('/src/shared/utils/chunked-document.ts')),...(await import('/src/shared/utils/markdown-note-links.ts')),...(await import('/src/shared/utils/markdown-renderer.ts'))};
    window.perfParser=(await import('/node_modules/@codemirror/lang-markdown/dist/index.js')).markdownLanguage.parser;
    const hot=await import('/src/renderer/components/editor/MarkdownEditor.vue');
    void hot;${frame};return true})()`)
  await stage('setup-hidden-focus',async()=>{
    await run('start(0)');assert.equal(await run('document.hasFocus() && cm().hasFocus'),true)
    return {show:win.isVisible(),hasFocus:await run('document.hasFocus()'),rendererMemory:await run('performance.memory ? {used:performance.memory.usedJSHeapSize,total:performance.memory.totalJSHeapSize}:null')}
  })
  for (const [name,source] of Object.entries(fixtures)) {
    await stage(name+'-disk-read', async()=>{const file=path.join(scratch,name+'.md'),t=performance.now(),bytes=fs.readFileSync(file),ms=performance.now()-t;assert.equal(hash(bytes),hash(source));return {bytes:bytes.length,ms,sha256:hash(bytes),cache:'generated-file/warm OS cache; not cold storage'} })
    await stage(name+'-parse-and-model',async()=>run(`(()=>{const source=${JSON.stringify(source)}, t=performance.now();const document=new perfModules.ChunkedDocument(source);const modelIndexMs=performance.now()-t;const p=performance.now();const tree=perfParser.parse(source);const parserFullMs=performance.now()-p;const n=performance.now();const normalized=perfModules.normalizeMarkdownNoteLinks(source);return {chars:source.length,modelIndexMs,parserFullMs,normalizationMs:performance.now()-n,normalizedChars:normalized.length,treeLength:tree.length,chunks:document.chunks.length}})()`))
    await stage(name+'-ui',async()=>{
      const opening=await run(`(async()=>{const t=performance.now();await setFixture(${JSON.stringify(source)});${frame};return {firstTwoRafMs:performance.now()-t,...stats(),clientHeight:cm().scrollDOM.clientHeight,scrollHeight:cm().scrollDOM.scrollHeight}})()`)
      assert.equal(opening.length,source.length);assert.equal(opening.editorViews,1);assert.ok(opening.clientHeight>0)
      await wait(800)
      const position = source.startsWith('# ') ? source.indexOf('\n') : 0
      await run(`(async()=>{start(${position});${frame};window.perfFlatten=[];window.perfUpdates=[];window.perfWorkers=[];window.inputStart=performance.now()})()`)
      const begin=performance.now()
      await win.webContents.debugger.sendCommand('Input.insertText',{text:'输入😀'})
      const input=await run(`(async()=>{${frame};return {inputToTwoRafMs:performance.now()-inputStart,length:model().length,selection:model().selection}})()`)
      input.cdpRoundTripMs=performance.now()-begin
      assert.equal(input.length,source.length+'输入😀'.length)
      await until('perfUpdates.length>0','debounced publish')
      const published=await run('({publishAfterInputMs:perfUpdates[0].time-inputStart,flatten:perfFlatten.slice(),updates:perfUpdates.slice()})')
      await wait(1000)
      const worker=await run('perfWorkers.slice()')
      const exported=await run('(()=>{const t=performance.now(),text=chunk().flushPendingMarkdownEmit();return {text,flushMs:performance.now()-t}})()')
      assert.equal(hash(exported.text),hash(source.slice(0,position)+'输入😀'+source.slice(position)))
      const t=performance.now(),fd=fs.openSync(path.join(scratch,name+'-export.md'),'w')
      fs.writeFileSync(fd,exported.text);fs.fsyncSync(fd);fs.closeSync(fd)
      const writeFsyncMs=performance.now()-t
      assert.equal(hash(fs.readFileSync(path.join(scratch,name+'-export.md'))),hash(exported.text))
      const exactSave=await run('events.saves.at(-1)===model().content')
      assert.equal(exactSave,true,'component autosave event must contain complete source')
      const tail=await run(`(async()=>{await scrollLine(Math.min(12000,model().text.lines));${frame};const v=cm(),line=Math.min(12000,model().text.lines),r=v.coordsAtPos(model().offsetForLine(line)),pane=v.scrollDOM.getBoundingClientRect();return {targetLine:line,scrollTop:v.scrollDOM.scrollTop,targetRect:r?{top:r.top,bottom:r.bottom}:null,paneTop:pane.top,paneBottom:pane.bottom}})()`)
      const scrollSetupValid=!!tail.targetRect&&tail.targetRect.top>=tail.paneTop-10&&tail.targetRect.top<tail.paneBottom
      return {opening,input,published,worker,export:{flushMs:exported.flushMs,writeFsyncMs,bytes:Buffer.byteLength(exported.text),sha256:hash(exported.text),componentAutosaveExact:exactSave},scroll:{...tail,setupValid:scrollSetupValid},longTasks:await run('perfLongTasks.splice(0)'),metrics:app.getAppMetrics().map(p=>({type:p.type,cpu:p.cpu,memory:p.memory}))}
    })
  }
  await stage('bounded-model-1000-edit-history',async()=>run(`(()=>{const source=${JSON.stringify(fixtures.complex)},doc=new perfModules.ChunkedDocument(source),times=[],t=performance.now();for(let i=0;i<1000;i++){const pos=(i*104729)%doc.length,s=performance.now();doc.replace(pos,pos,'文');times.push(performance.now()-s)}const editsMs=performance.now()-t, edited=doc.content,u=performance.now();let undos=0;while(doc.undo())undos++;const undoMs=performance.now()-u,undoExact=doc.content===source,r=performance.now();let redos=0;while(doc.redo())redos++;times.sort((a,b)=>a-b);return {edits:1000,undos,redos,editsMs,undoMs,redoMs:performance.now()-r,undoExact,redoExact:doc.content===edited,editP50Ms:times[500],editP95Ms:times[950],editMaxMs:times.at(-1),revision:doc.revision,retainedChangesExpiry:doc.changesSince(0)===null}})()`)).then(data=>{if(data){assert.equal(data.undos,1000);assert.equal(data.redos,1000);assert.equal(data.undoExact,true);assert.equal(data.redoExact,true)}})
  await stage('three-mode-shared-ui-history',async()=>{
    const modeSource='前文\n\n共享模式文档\n\n后文'
    await run(`setFixture(${JSON.stringify(modeSource)})`);await wait(100)
    await run('window.sharedIdentity=model();start(0)');await win.webContents.debugger.sendCommand('Input.insertText',{text:'A'})
    const switches=[]
    for(const title of ['编辑模式','分割视图','预览模式']){
      await run(`window.modeStart=performance.now();document.querySelector('button[title="${title}"]').click()`)
      const ready = title === '编辑模式' ? '!!pane(true)' : title === '分割视图' ? '!!pane(true)&&!!pane(false)' : '!!pane(false)'
      await until(ready, 'mode component mounted: ' + title)
      const timing=await run(`({mode:${JSON.stringify(title)},ms:performance.now()-modeStart,sameModel:model()===sharedIdentity,editors:document.querySelectorAll('.cm-editor').length})`)
      assert.equal(timing.sameModel,true);switches.push(timing)
    }
    await run('start(0)');await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyDown',key:'z',code:'KeyZ',modifiers:4});await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyUp',key:'z',code:'KeyZ',modifiers:4})
    assert.equal(await run(`model().content===${JSON.stringify(modeSource)}`),true)
    return {switches,globalUndo:true}
  })
  await stage('ui-100-input-undo-redo-and-dual-pane',async()=>{
    const source='正文历史压力\n\n'+('连续文本\n'.repeat(200))
    await run(`setFixture(${JSON.stringify(source)})`);await run(`(async()=>{start(0);${frame}})()`)
    const t=performance.now(),samples=[]
    for(let i=0;i<100;i++){const s=performance.now();await win.webContents.debugger.sendCommand('Input.insertText',{text:'文'});samples.push(performance.now()-s)}
    const inputTotalMs=performance.now()-t
    assert.equal(await run(`model().content===${JSON.stringify('文'.repeat(100)+source)}`),true)
    const key=async(redo=false)=>{const p={key:redo?'Z':'z',code:'KeyZ',windowsVirtualKeyCode:90,modifiers:redo?12:4};await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyDown',...p});await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyUp',...p})}
    const u=performance.now();for(let i=0;i<100;i++)await key();const undoMs=performance.now()-u
    result.stressDiagnostics={phase:'after-100-undo',...(await run(`(()=>{const expected=${JSON.stringify(source)},actual=model().content;let first=0;while(first<Math.min(expected.length,actual.length)&&actual[first]===expected[first])first++;return {expectedLength:expected.length,length:actual.length,firstMismatch:first,prefix:actual.slice(0,130),revision:model().revision,selection:model().selection,focused:cm().hasFocus}})()`))};save()
    assert.equal(await run(`model().content===${JSON.stringify(source)}`),true)
    const r=performance.now();for(let i=0;i<100;i++)await key(true);const redoMs=performance.now()-r
    result.redoDiagnostics=await run(`(()=>{const expected=${JSON.stringify('文'.repeat(100)+source)},actual=model().content;let first=0;while(first<Math.min(expected.length,actual.length)&&actual[first]===expected[first])first++;return {expectedLength:expected.length,length:actual.length,firstMismatch:first,prefix:actual.slice(0,130),revision:model().revision,focused:cm().hasFocus}})()`);save()
    assert.equal(await run(`model().content===${JSON.stringify('文'.repeat(100)+source)}`),true)
    await run(`document.querySelector('button[title="分割视图"]').click()`)
    await until('!!pane(true)&&!!pane(false)', 'dual pane component refs')
    await run('pane(true).startEditing(0)')
    await win.webContents.debugger.sendCommand('Input.insertText',{text:'左'})
    await run(`(async()=>{${frame};pane(false).startEditing(0)})()`)
    await win.webContents.debugger.sendCommand('Input.insertText',{text:'右'})
    await run(`(async()=>{${frame}})()`)
    assert.equal(await run(`model().content===${JSON.stringify('右左'+'文'.repeat(100)+source)}`),true)
    const panesAgree=await run(`(()=>{const roots=[...document.querySelectorAll('.cm-editor')];return roots.length===2&&roots.every(root=>cm().constructor.findFromDOM(root).state.doc.eq(model().text))})()`)
    assert.equal(panesAgree,true)
    await key();await key();assert.equal(await run(`model().content===${JSON.stringify('文'.repeat(100)+source)}`),true)
    samples.sort((a,b)=>a-b)
    return {inputs:100,undos:100,redos:100,inputTotalMs,undoMs,redoMs,inputCdpP50Ms:samples[50],inputCdpP95Ms:samples[95],dualPaneExact:true,panesAgree,note:'Short real-UI stress; CDP call latency is not per-input paint latency.'}
  })
  await stage('external-store-fixture-conflict-and-inflight',async()=>{
    const probe=await run(`(async()=>{const {useExternalDocumentsStore}=await import('/src/renderer/stores/externalDocuments.ts');const store=useExternalDocumentsStore(document.querySelector('#app').__vue_app__.config.globalProperties.$pinia);let disk='base',writes=0,release,hold=false,confirm=1;
      window.electronAPI.externalDocuments={draft:async()=>{},readCurrent:async()=>disk,save:async(id,content,expected)=>{if(hold)await new Promise(r=>release=r);if(disk!==expected)throw Error('fixture conflict');writes++;disk=content}};
      window.electronAPI.app.showMessageBox=async()=>({response:confirm});
      store.open({id:'perf-fixture',filePath:'/isolated-fixture.md',content:'base',baseContent:'base'});store.update('perf-fixture','local');disk='external';
      const conflictRejected=await store.save('perf-fixture')===false;const conflictPreserved=disk==='external'&&store.documents[0].content==='local';const cancelled=await store.save('perf-fixture',true)===false&&disk==='external';confirm=0;const explicitOverwrite=await store.save('perf-fixture',true);hold=true;store.update('perf-fixture','snapshot');const saving=store.save('perf-fixture');while(!release)await new Promise(r=>setTimeout(r,1));store.update('perf-fixture','newer');hold=false;release();await saving;
      return {conflictRejected,conflictPreserved,cancelled,explicitOverwrite,inflightPreserved:store.documents[0].content==='newer'&&store.documents[0].baseContent==='snapshot'&&disk==='snapshot',dirty:store.dirty('perf-fixture'),writes,boundary:'real renderer store, isolated in-memory API; NOT production IPC/file-service conflict test'}})()`)
    for(const key of ['conflictRejected','conflictPreserved','cancelled','explicitOverwrite','inflightPreserved','dirty'])assert.equal(probe[key],true,key)
    return probe
  })
  result.sourceAfter=hashes();result.sourceChanged=Object.keys(result.sourceBefore).filter(key=>result.sourceBefore[key]!==result.sourceAfter[key]);
  result.preliminary=true;result.limitations.push('Concurrent integration work: final stable build must rerun this script serially, even when monitored hashes are unchanged.')
  result.completedAt=new Date().toISOString();save();console.log('ARTIFACT',path.join(scratch,'results.json'));clearTimeout(watchdog);win.destroy();app.exit(result.failures.length?1:0)
}).catch(error=>{result.failures.push({name:'harness',error:String(error),stack:error.stack});save();console.error(error,'ARTIFACT',path.join(scratch,'results.json'));clearTimeout(watchdog);if(win&&!win.isDestroyed())win.destroy();app.exit(1)})
