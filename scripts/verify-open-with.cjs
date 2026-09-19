// Build first: npm run build. Uses only temporary appData/userData/files.
const { app, BrowserWindow, dialog } = require('electron')
const fs = require('node:fs/promises')
const syncFs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const assert = require('node:assert/strict')
const { pathToFileURL } = require('node:url')
const root = syncFs.mkdtempSync(path.join(os.tmpdir(), 'looma-open-with-'))
for (const name of ['appData', 'userData', 'sessionData']) {
  const dir = path.join(root, name)
  syncFs.mkdirSync(dir)
  app.setPath(name, dir)
}
delete process.env.VITE_DEV_SERVER_URL
// Never contact a developer's running AI service from this isolated fixture.
process.env.RAG_SERVICE_URL = 'http://127.0.0.1:1'
const workspace = path.join(root, 'workspace')
syncFs.mkdirSync(workspace)
const contained = path.join(workspace, 'inside.md')
syncFs.writeFileSync(contained, '# Workspace file')
const metadata = path.join(root, 'appData', 'workspace-meta', 'looma')
syncFs.mkdirSync(metadata, { recursive: true })
syncFs.writeFileSync(path.join(metadata, 'workspaces.json'), JSON.stringify({ workspaces: [{ id: 'fixture', name: 'Fixture', path: workspace, createdAt: 1, lastOpenedAt: 1 }], order: ['fixture'], activeId: 'fixture' }))
const file = path.join(root, '外部 note.md')
const second = path.join(root, 'second.md')
syncFs.writeFileSync(file, '# Initial\n\nOriginal body')
syncFs.writeFileSync(second, '# Second')
process.argv.push(file)
const dialogs = []
let response = 2
dialog.showMessageBox = async (...args) => { dialogs.push(args.at(-1)); return { response, checkboxChecked: false } }
const errors = []
app.on('web-contents-created', (_event, contents) => {
  contents.on('console-message', (_e, level, message) => { if (level >= 3) errors.push(message) })
})
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(check, label) {
  for (let i = 0; i < 150; i++) { if (await check()) return; await wait(100) }
  throw new Error(`Timed out: ${label}`)
}
async function main() {
  const mainModule = await import(pathToFileURL(path.resolve('dist-electron/index.js')).href)
  await app.whenReady()
  await until(() => BrowserWindow.getAllWindows().length, 'window')
  const win = BrowserWindow.getAllWindows()[0]
  const run = code => win.webContents.executeJavaScript(code)
  await until(async () => !win.webContents.isLoading() && await run('!!document.querySelector(".tiptap")'), 'real MarkdownEditor')
  assert.match(win.webContents.getURL(), /editorOnly=1/)
  assert.equal(BrowserWindow.getAllWindows().length, 1)
  assert.equal(await run('!!document.querySelector(".external-document-tab")'), true)
  assert.equal(await run('document.querySelector(".external-document-tab").title'), await fs.realpath(file))
  assert.equal(await run('!!document.querySelector(".auxiliary-panel")'), false)
  console.log('PASS cold argv opens editor-only real MarkdownEditor and external tag/path')
  win.webContents.debugger.attach('1.3')
  await run('document.querySelector(".tiptap").focus()')
  await win.webContents.debugger.sendCommand('Input.insertText', { text: '自动保存' })
  await until(async () => (await fs.readFile(file, 'utf8')).includes('自动保存'), 'rich text autosave to original')
  assert.equal(syncFs.existsSync(path.join(root, '.looma')), false)
  console.log('PASS real rich-text input autosaves original; no source .looma')
  // Actual Electron open-file event path, not renderer fixture injection.
  app.emit('open-file', { preventDefault() {} }, second)
  await until(async () => await run('document.querySelectorAll(".external-document-tab").length === 2'), 'second file')
  app.emit('open-file', { preventDefault() {} }, file)
  await wait(300)
  assert.equal(await run('document.querySelectorAll(".external-document-tab").length'), 2)
  const visible = 'Array.from(document.querySelectorAll("[data-external-document]")).find(el => el.style.display !== "none")'
  await run(`${visible}.querySelector('[title="分割视图"]').click()`)
  await until(async () => await run(`!!${visible}.querySelector('.cm-content')`), 'split source editor')
  await run(`${visible}.querySelector('.cm-content').focus()`)
  await win.webContents.debugger.sendCommand('Input.insertText', { text: '源码保存' })
  await until(async () => (await fs.readFile(file, 'utf8')).includes('源码保存'), 'source autosave')
  console.log('PASS warm open-file, duplicate deduplication, split mode and source autosave')
  // Disk change must not be overwritten by a later editor autosave.
  await fs.writeFile(file, '# Changed externally')
  await run(`${visible}.querySelector('.cm-content').focus()`)
  await win.webContents.debugger.sendCommand('Input.insertText', { text: '冲突草稿' })
  await until(async () => await run(`!!${visible}.querySelector('[role="alert"]')`), 'conflict alert')
  assert.equal(await fs.readFile(file, 'utf8'), '# Changed externally')
  response = 2
  win.close()
  await until(() => dialogs.some(item => item.message === '保存外部文件的更改？'), 'close confirmation')
  await wait(300)
  assert.equal(win.isDestroyed(), false)
  assert.equal(await run('document.querySelectorAll(".external-document-tab").length'), 2)
  console.log('PASS external-change protection and cancel-close preserves editor')
  response = 1
  win.close()
  await until(() => win.isDestroyed(), 'discard close')
  const drafts = await fs.readdir(path.join(root, 'userData', 'external-document-drafts'))
  assert.equal(drafts.filter(name => name.endsWith('.json')).length, 0)
  assert.equal(await fs.readFile(file, 'utf8'), '# Changed externally')
  assert.equal(errors.length, 0, errors.join('\n'))
  console.log('PASS discard closes without overwriting disk, no normal-closed draft restoration, no renderer errors')
  const wsWin = mainModule.createWindow('fixture')
  const wsRun = code => wsWin.webContents.executeJavaScript(code)
  await until(async () => !wsWin.webContents.isLoading() && await wsRun('!!window.electronAPI && !!document.querySelector("header")'), 'workspace window')
  // Delivery while renderer initialization is still underway must queue safely.
  app.emit('second-instance', {}, ['electron', contained, second], root)
  await until(async () => await wsRun('document.querySelectorAll(".external-document-tab").length === 1'), 'workspace external delivery')
  assert.equal(await wsRun('document.querySelector(".external-document-tab").title'), await fs.realpath(second))
  assert.equal(await wsRun('!!document.querySelector("[draggable=true][title=\\"inside.md\\"]")'), true)
  app.emit('open-file', { preventDefault() {} }, contained)
  await until(async () => await wsRun('!!document.querySelector(".tiptap") && document.body.innerText.includes("Workspace file")'), 'contained normal editor')
  assert.equal(await wsRun('document.querySelectorAll(".external-document-tab").length'), 1)
  console.log('PASS queued second-instance delivery: contained file normal tab, external file distinct tab in workspace window')
  app.emit('open-file', { preventDefault() {} }, second)
  await wait(250)
  const id = await wsRun('document.querySelector("[data-external-document]").dataset.externalDocument')
  await wsRun(`window.electronAPI.externalDocuments.draft(${JSON.stringify(id)}, '# Crash recovery fixture', '# Second')`)
  wsWin.destroy() // Simulated renderer/window loss: no orderly close/cleanup.
  app.emit('open-file', { preventDefault() {} }, second)
  await until(() => BrowserWindow.getAllWindows().length === 1, 'recovery window')
  const recovered = BrowserWindow.getAllWindows()[0]
  await until(async () => !recovered.webContents.isLoading() && await recovered.webContents.executeJavaScript('document.body.innerText.includes("Crash recovery fixture")'), 'recovered dirty draft')
  assert.equal(await fs.readFile(second, 'utf8'), '# Second')
  assert.equal(await recovered.webContents.executeJavaScript('!!document.querySelector("[aria-label=未保存]")'), true)
  response = 2
  await recovered.webContents.executeJavaScript(`document.querySelector('.external-document-tab').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 200, clientY: 80 }));`)
  await until(async () => await recovered.webContents.executeJavaScript(`Array.from(document.querySelectorAll('button')).some(el => el.textContent.includes('关闭全部标签页'))`), 'external tab context menu')
  await recovered.webContents.executeJavaScript(`Array.from(document.querySelectorAll('button')).find(el => el.textContent.includes('关闭全部标签页')).click()`)
  await wait(250)
  assert.equal(await recovered.webContents.executeJavaScript('document.querySelectorAll(".external-document-tab").length'), 1)
  app.quit()
  await wait(500)
  assert.equal(recovered.isDestroyed(), false)
  response = 1
  recovered.close()
  await until(() => recovered.isDestroyed(), 'recovery discard')
  assert.equal((await fs.readdir(path.join(root, 'userData', 'external-document-drafts'))).filter(name => name.endsWith('.json')).length, 0)
  console.log('PASS crash draft recovery is dirty without overwriting disk; application quit cancellation and discard cleanup')
}
main().then(() => { app.exit(0) }).catch(error => { console.error(error); console.error('PROFILE', root, 'RENDERER ERRORS', errors); app.exit(1) })
