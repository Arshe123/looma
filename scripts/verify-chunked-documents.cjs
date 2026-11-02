// npm run build first. Real main/preload/renderer; only isolated profile and files.
const { app, BrowserWindow, dialog } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { pathToFileURL } = require('node:url')
const { homedir } = require('node:os')
const root = fs.mkdtempSync(path.join(homedir(), '.hermes/cache/scratch/looma-chunked-documents-'))
for (const name of ['appData', 'userData', 'sessionData']) {
  const directory = path.join(root, name)
  fs.mkdirSync(directory)
  app.setPath(name, directory)
}
delete process.env.VITE_DEV_SERVER_URL
process.env.RAG_SERVICE_URL = 'http://127.0.0.1:1'
const workspace = path.join(root, 'workspace')
fs.mkdirSync(workspace)
const metadata = path.join(root, 'appData/workspace-meta/looma')
fs.mkdirSync(metadata, { recursive: true })
fs.writeFileSync(path.join(metadata, 'workspaces.json'), JSON.stringify({
  workspaces: [{ id: 'fixture', name: 'Fixture', path: workspace, createdAt: 1, lastOpenedAt: 1 }],
  order: ['fixture'], activeId: 'fixture',
}))
const source = '# 大文件隔离验收\n\n' + '超长单行正文😀'.repeat(50000)
const external = path.join(root, 'external-large.md')
const contained = path.join(workspace, 'workspace-large.md')
for (const file of [external, contained]) fs.writeFileSync(file, source)
process.argv.push(external)
dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false })
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(check, label) {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (await check()) return
    await wait(100)
  }
  throw new Error(`Timeout: ${label}`)
}
const errors = []
app.on('web-contents-created', (_event, contents) => {
  contents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message) })
})
async function verify(win, file, label) {
  const run = code => win.webContents.executeJavaScript(code)
  await until(async () => !win.webContents.isLoading() && await run('!![...document.querySelectorAll(".chunked-markdown-editor")].find(el=>el.getClientRects().length)'), `${label} chunk editor`)
  await run('window.visibleChunk=()=>[...document.querySelectorAll(".chunked-markdown-editor")].find(el=>el.getClientRects().length);void 0')
  assert.equal(await run('!![...document.querySelectorAll(".tiptap")].find(el=>el.getClientRects().length)'), false)
  assert.equal(await run('visibleChunk().querySelectorAll(".cm-editor").length'),1)
  assert.ok(await run('visibleChunk().textContent.length<60000'),'continuous view DOM is bounded')
  assert.equal(win.isVisible(), false, 'production regression must not display a window')
  await until(async () => await run('!!visibleChunk().querySelector(".cm-content")'), `${label} continuous editor mounted before click`)
  await until(async () => await run('!visibleChunk().querySelector(".continuous-partial-state")'), `${label} background full load completes without clicking`)
  win.webContents.debugger.attach('1.3')
  await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
  const point=await run('(()=>{const root=visibleChunk(),r=root.getBoundingClientRect(),line=[...root.querySelectorAll(".cm-line")].find(el=>{const q=el.getBoundingClientRect();return el.textContent.trim()&&q.top>=r.top&&q.bottom<r.bottom});if(!line)throw new Error("no visible source line");const q=line.getBoundingClientRect();return {x:q.left+5,y:(q.top+q.bottom)/2}})()')
  for(const type of ['mousePressed','mouseReleased'])await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,...point})
  await until(async()=>await run('!visibleChunk().querySelector(".continuous-partial-state")'),`${label} native click prepares full source`)
  const insert = async text => {

    await run('visibleChunk().querySelector(".cm-content").focus()')
    await win.webContents.debugger.sendCommand('Input.insertText', { text })
  }
  await insert(`${label}真实输入`)
  await until(() => fs.readFileSync(file, 'utf8').includes(`${label}真实输入`), `${label} disk autosave`)
  const saved = fs.readFileSync(file, 'utf8')
  assert.equal(saved.replace(`${label}真实输入`, ''), source, `${label} preserves every unmounted byte`)
  await run('[...document.querySelectorAll("button[title=编辑模式]")].find(el=>el.getClientRects().length).click()')
  await until(async () => await run('!!document.querySelector(".chunked-source-only .cm-content")'), `${label} source mode`)
  await insert('源码修改')
  await until(() => fs.readFileSync(file, 'utf8').includes('源码修改'), `${label} source disk autosave`)
  assert.equal(fs.readFileSync(file, 'utf8').replace(`${label}真实输入`, '').replace('源码修改', ''), source)
  win.webContents.debugger.detach()
  console.log(`PASS ${label}: production continuous editor, bounded DOM, native rich/source input and exact full-file disk autosave`)
}
const watchdog = setTimeout(() => { console.error('FAIL production document verification stalled'); app.exit(1) }, 120000)
;(async () => {
  // Test-only copy: change window visibility, not IPC, preload, renderer or fs.
  // Electron's BrowserWindow export is non-configurable; do not replace it.
  const mainPath = path.resolve('dist-electron/index.js')
  const builtMain = fs.readFileSync(mainPath, 'utf8')
  const constructor = /new ([A-Za-z_$][\w$]*)\(\{\s*width:/g
  assert.equal([...builtMain.matchAll(constructor)].length, 1)
  const hiddenMain = builtMain.replace(constructor, 'new $1({ show: false, width:')
    .replace('import.meta.url', JSON.stringify(pathToFileURL(mainPath).href))
  const mainCopy = path.join(root, 'production-main-hidden.mjs')
  fs.writeFileSync(mainCopy, hiddenMain)
  BrowserWindow.prototype.show = () => {}
  BrowserWindow.prototype.focus = () => {}
  app.focus = () => {}
  const main = await import(pathToFileURL(mainCopy).href)
  await app.whenReady()
  await until(() => BrowserWindow.getAllWindows().length === 1, 'external startup')
  const externalWindow = BrowserWindow.getAllWindows()[0]
  await verify(externalWindow, external, '外部文件')
  externalWindow.close()
  await until(() => externalWindow.isDestroyed(), 'clean external close')
  const workspaceWindow = main.createWindow('fixture')
  await until(async () => !workspaceWindow.webContents.isLoading() && await workspaceWindow.webContents.executeJavaScript('!!document.querySelector("header")'), 'workspace startup')
  app.emit('open-file', { preventDefault() {} }, contained)
  await verify(workspaceWindow, contained, '工作空间')
  assert.deepEqual(errors, [], 'production renderer errors')
  clearTimeout(watchdog)
  for (const win of BrowserWindow.getAllWindows()) win.destroy()
  console.log('PASS real production workspace and external large-document routes; isolated files:', root)
  app.exit(0)
})().catch(error => { console.error(error); clearTimeout(watchdog); app.exit(1) })
