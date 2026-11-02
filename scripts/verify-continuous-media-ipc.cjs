// Build first: npm run build; npx electron scripts/verify-continuous-media-ipc.cjs
// Optional --dev-renderer uses Vite 5189 with the SAME built production main/preload.
// No OS clipboard: only file-transfer event transport is simulated. IPC/fs are real.
const electron = require('electron')
const { app, ipcMain, dialog, nativeImage } = electron
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const assert = require('node:assert/strict')
const { pathToFileURL } = require('node:url')
const repo = path.resolve(__dirname, '..')
const root = fs.mkdtempSync(path.join(os.homedir(), '.hermes/cache/scratch/looma-media-ipc-'))
for (const key of ['appData', 'userData', 'sessionData']) {
  const directory = path.join(root, key); fs.mkdirSync(directory); app.setPath(key, directory)
}
const dev = process.argv.includes('--dev-renderer')
if (dev) process.env.VITE_DEV_SERVER_URL = 'http://127.0.0.1:5189'
else delete process.env.VITE_DEV_SERVER_URL
process.env.RAG_SERVICE_URL = 'http://127.0.0.1:1'
// Hidden-window test instrumentation; all IPC handlers remain real.
const RealBrowserWindow = electron.BrowserWindow
const HiddenWindow = RealBrowserWindow
// Electron's named export is non-configurable. Preserve production IPC code,
// instrument ONLY the window options in a scratch copy of the built bundle.
// Keep import.meta.url pointed at the original so preload/resources/dist stay real.
const mainPath = path.join(repo, 'dist-electron/index.js')
const originalMain = fs.readFileSync(mainPath, 'utf8')
const constructorPattern = /new ([A-Za-z_$][\w$]*)\(\{\s*width:/g
assert.equal([...originalMain.matchAll(constructorPattern)].length, 1, 'exactly one production window constructor')
const hiddenMain = originalMain.replace(constructorPattern, 'new $1({ show: false, width:')
  .replace('import.meta.url', JSON.stringify(pathToFileURL(mainPath).href))
const scratchMain = path.join(root, 'production-main-hidden.mjs')
fs.writeFileSync(scratchMain, hiddenMain)
RealBrowserWindow.prototype.show = () => {}
RealBrowserWindow.prototype.showInactive = () => {}
RealBrowserWindow.prototype.focus = () => {}
const workspace = path.join(root, 'workspace')
const note = path.join(workspace, 'notes/media.md')
fs.mkdirSync(path.dirname(note), { recursive: true })
const source = '# Media IPC fixture\n\nStart\n\n' + 'Full-file sentinel paragraph.\n\n'.repeat(12000) + '\nEND-SENTINEL\n'
fs.writeFileSync(note, source)
const metadata = path.join(root, 'appData/workspace-meta/looma')
fs.mkdirSync(metadata, { recursive: true })
fs.writeFileSync(path.join(metadata, 'workspaces.json'), JSON.stringify({ workspaces: [{ id: 'fixture', name: 'Fixture', path: workspace, createdAt: 1, lastOpenedAt: 1 }], order: ['fixture'], activeId: 'fixture' }))
const input = path.join(root, '新图片 (ipc).png')
// Newly generated real PNG; no clipboard API involved.
const png = nativeImage.createFromBitmap(Buffer.alloc(80 * 40 * 4, 180), { width: 80, height: 40 }).toPNG()
assert.ok(png.length > 0); fs.writeFileSync(input, png)
const calls = [], errors = []
const handle = ipcMain.handle.bind(ipcMain)
ipcMain.handle = (channel, listener) => handle(channel, async (event, ...args) => {
  const result = await listener(event, ...args)
  if (/^(fs:importImage|fs:write|file:write)/.test(channel)) calls.push({ channel, args: args.map(arg => typeof arg === 'string' && arg.length > 200 ? `<${arg.length} chars>` : arg), result })
  return result
})
dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false })
app.on('web-contents-created', (_event, contents) => contents.on('console-message', (_e, level, message) => { if (level >= 3) errors.push(message) }))
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(check, label) {
  for (let i = 0; i < 200; i++) { if (await check()) return; await wait(100) }
  throw new Error('Timeout: ' + label)
}
const watchdog = setTimeout(() => { console.error('FAIL timeout; artifacts', root); app.exit(1) }, 100000)
let win
;(async () => {
  const main = await import(pathToFileURL(scratchMain).href)
  await app.whenReady()
  await until(() => HiddenWindow.getAllWindows().length > 0, 'production window')
  win = HiddenWindow.getAllWindows()[0]
  const run = code => win.webContents.executeJavaScript(code)
  win.webContents.debugger.attach('1.3')
  const cdp = (method, args) => win.webContents.debugger.sendCommand(method, args)
  await cdp('Emulation.setFocusEmulationEnabled', { enabled: true })
  await cdp('Page.bringToFront')
  assert.equal(win.isVisible(), false)
  await until(async () => !win.webContents.isLoading() && await run('!!window.electronAPI && !!document.querySelector("header")'), 'workspace renderer')
  app.emit('open-file', { preventDefault() {} }, note)
  await until(async () => await run('!!document.querySelector(".chunked-markdown-editor .cm-content") && !document.querySelector(".continuous-partial-state")'), 'fully loaded continuous editor')
  assert.equal(await run('!!document.querySelector(".tiptap")'), false)
  // Synthetic transport only: File.path names an actual newly created PNG on disk.
  await run(`(() => { const content = document.querySelector('.chunked-markdown-editor .cm-content'); content.focus(); const file = new File([], '新图片 (ipc).png', {type:'image/png'}); Object.defineProperty(file,'path',{value:${JSON.stringify(input)}}); const transfer = new DataTransfer(); transfer.items.add(file); const event = new ClipboardEvent('paste',{clipboardData:transfer,bubbles:true,cancelable:true}); content.dispatchEvent(event); if(!event.defaultPrevented) throw new Error('production media paste handler did not consume file transfer; rebuild dist'); })()`)
  await until(() => calls.some(call => call.channel === 'fs:importImage'), 'real fs:importImage handler')
  const imported = calls.find(call => call.channel === 'fs:importImage')
  assert.deepEqual(imported.args, ['fixture', 'notes/media.md', input])
  assert.equal(imported.result.success, true)
  const relative = imported.result.data.relativePath
  assert.match(relative, /^assets\/.+\.png$/)
  const asset = path.resolve(path.dirname(note), relative)
  assert.ok(asset.startsWith(path.dirname(note) + path.sep))
  assert.deepEqual(fs.readFileSync(asset), png)
  await until(() => fs.readFileSync(note, 'utf8') !== source, 'real renderer autosave to note')
  const saved = fs.readFileSync(note, 'utf8')
  const imageMatch = /!\[[^\n]*?\]\([^\n]*?\)/.exec(saved)
  assert.ok(imageMatch, 'image markdown persisted')
  assert.ok(imageMatch[0].includes(encodeURIComponent(imported.result.data.fileName).replace(/[()']/g, ch => '%' + ch.charCodeAt(0).toString(16).toUpperCase())))
  assert.equal(saved.includes('data:'), false, 'no base64/data URL in markdown (rendered img may legitimately use data URL)')
  assert.equal(saved.replace(imageMatch[0] + '\n\n', ''), source, 'every original byte survives insertion')
  console.log(`PASS ${dev ? 'Vite production components' : 'built production renderer'} → actual preload → fs:importImage → PNG assets copy; exact whole-note autosave; synthetic file-transfer transport only`)
  await until(async () => await run('!!document.querySelector(".looma-continuous-image img")?.naturalWidth'), 'imported image loaded')
  const imagePoint = await run('(()=>{const r=document.querySelector(".looma-continuous-image img").getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()')
  for (const type of ['mousePressed','mouseReleased']) await cdp('Input.dispatchMouseEvent',{type,button:'left',buttons:type==='mousePressed'?1:0,clickCount:1,...imagePoint})
  await until(async () => await run('!!document.querySelector(".looma-continuous-media-resize")'), 'production image resize handle')
  const resizePoint = await run('(()=>{const r=document.querySelector(".looma-continuous-media-resize").getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()')
  const frameGeometry = await run('(()=>{const b=document.querySelector(".looma-continuous-media-resize"),r=b.getBoundingClientRect(),image=b.parentElement.querySelector("img").getBoundingClientRect();return{right:image.right,bottom:image.bottom,hit:document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)===b}})()')
  assert.ok(Math.abs(resizePoint.x-frameGeometry.right)<2 && Math.abs(resizePoint.y-frameGeometry.bottom)<2,'resize handle follows actual image, not full scroll container')
  assert.equal(frameGeometry.hit,true,'actual resize handle is pointer-hittable')
  await cdp('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',buttons:1,clickCount:1,...resizePoint})
  await cdp('Input.dispatchMouseEvent',{type:'mouseMoved',button:'left',buttons:1,x:resizePoint.x+100,y:resizePoint.y+50})
  await wait(100)

  await cdp('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',buttons:0,clickCount:1,x:resizePoint.x+100,y:resizePoint.y+50})
  await until(() => /\{width=\d+%\}/.test(fs.readFileSync(note,'utf8')), 'pointer resize persisted through production autosave')
  const resized = fs.readFileSync(note,'utf8')
  assert.equal(resized.replace(/\{width=\d+%\}/,''),saved,'resize preserves all other source bytes')
  for(const type of ['keyDown','keyUp']) await cdp('Input.dispatchKeyEvent',{type,key:'z',code:'KeyZ',windowsVirtualKeyCode:90,modifiers:4})
  await until(() => fs.readFileSync(note,'utf8')===saved, 'one canonical undo restores image size on disk')
  console.log('PASS production pointer resize → width attribute → real full-file autosave → one canonical undo')
  // Source-mode DOM selection + CDP input separately seeds the title/60% round trip.
  await run('[...document.querySelectorAll("button[title=编辑模式]")].find(el=>el.getClientRects().length).click()')
  await until(async () => await run('!!document.querySelector(".chunked-source-only .cm-content")'), 'source mode')
  // Explicit DOM selection transport (no private CM API or model mutation).
  assert.ok(saved.startsWith(imageMatch[0]), 'fresh editor inserts at document start')
  await run(`(() => { const content=document.querySelector('.chunked-source-only .cm-content'); content.focus(); const line=[...content.querySelectorAll('.cm-line')].find(el=>el.textContent===${JSON.stringify(imageMatch[0])});if(!line)throw new Error('image source line is not mounted'); const range=document.createRange();range.selectNodeContents(line);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);document.dispatchEvent(new Event('selectionchange')); })()`)
  await wait(150)
  assert.equal(await run('window.getSelection().toString()'), imageMatch[0], 'actual native source selection')
  const titled = imageMatch[0].slice(0, -1) + ' "IPC title 保留"){width=60%}'
  await cdp('Input.insertText', { text: titled })
  await until(() => fs.readFileSync(note, 'utf8').includes(titled), 'title/width full-file autosave')
  const expected = saved.replace(imageMatch[0], titled)
  assert.equal(fs.readFileSync(note, 'utf8'), expected)
  await run('[...document.querySelectorAll("button[title=预览模式]")].find(el=>el.getClientRects().length).click()')
  await until(async () => await run('!!document.querySelector(".looma-continuous-image img")?.naturalWidth'), 'real imported PNG rendered')
  assert.equal(await run('document.querySelector(".looma-continuous-image img").title'), 'IPC title 保留')
  assert.equal(await run('document.querySelector(".looma-continuous-image").style.width'), '60%')
  // Reload the actual renderer, not an in-memory fixture, and verify file-backed restoration.
  win.webContents.reload()
  await until(async () => !win.webContents.isLoading() && await run('!!document.querySelector("header")'), 'renderer reopen')
  app.emit('open-file', { preventDefault() {} }, note)
  await until(async () => await run('!!document.querySelector(".looma-continuous-image img")?.naturalWidth && !document.querySelector(".continuous-partial-state")'), 'disk reopen with imported image')
  assert.equal(await run('document.querySelector(".looma-continuous-image img").title'), 'IPC title 保留')
  assert.equal(await run('document.querySelector(".looma-continuous-image").style.width'), '60%')
  assert.equal(fs.readFileSync(note, 'utf8'), expected)
  assert.deepEqual(fs.readFileSync(asset), png)
  assert.equal(fs.readFileSync(note, 'utf8').includes('data:'), false)
  assert.equal(win.isVisible(), false)
  assert.deepEqual(errors, [])
  console.log('PASS relative asset URL + title + width=60%; full file byte equality; actual renderer reload/reopen; no OS clipboard writes; all windows hidden')
  fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify({ main: 'built production bundle copied to scratch with show:false and original import.meta.url; no IPC replacement', inputTransport: 'synthetic File.path ClipboardEvent; DOM Range + CDP text for title/width; not OS clipboard or native resize', renderer: dev ? 'Vite 5189 (not built renderer)' : 'built production dist', root, input, note, asset, bytes: Buffer.byteLength(expected), calls: calls.map(call => ({ ...call, result: call.channel === 'fs:importImage' ? call.result : { success: call.result?.success } })), errors }, null, 2))
  console.log('REPORT', path.join(root, 'report.json'))
  clearTimeout(watchdog); for (const window of HiddenWindow.getAllWindows()) window.destroy(); app.exit(0)
})().catch(error => { console.error(error); console.error('ARTIFACTS', root, 'ERRORS', errors); clearTimeout(watchdog); for (const window of HiddenWindow.getAllWindows()) window.destroy(); app.exit(1) })
