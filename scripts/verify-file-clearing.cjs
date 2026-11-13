// Build first. Real production renderer/preload/fs IPC; temporary profile and notes only.
// Self-drawn messages use their actual buttons; only window visibility is controlled.
const { app, BrowserWindow } = require('electron')
const watchMessageDialogs = require('./message-dialog-driver.cjs')
const fs = require('node:fs')
const path = require('node:path')
const { tmpdir } = require('node:os')
const { pathToFileURL } = require('node:url')
const assert = require('node:assert/strict')
const root = fs.mkdtempSync(path.join(tmpdir(), 'looma-file-clearing-'))
for (const name of ['appData', 'userData', 'sessionData']) {
  const directory = path.join(root, name)
  fs.mkdirSync(directory)
  app.setPath(name, directory)
}
delete process.env.VITE_DEV_SERVER_URL
process.env.RAG_SERVICE_URL = 'http://127.0.0.1:1'
const workspace = path.join(root, 'notes')
fs.mkdirSync(workspace)
const metadata = path.join(root, 'appData/workspace-meta/looma')
fs.mkdirSync(metadata, { recursive: true })
fs.writeFileSync(path.join(metadata, 'workspaces.json'), JSON.stringify({
  workspaces: [{ id: 'fixture', name: 'Fixture', path: workspace, createdAt: 1, lastOpenedAt: 1 }],
  order: ['fixture'], activeId: 'fixture',
}))
const cases = [
  ['rich.md', 'preview'], ['source.md', 'source'], ['split.md', 'split'],
  ['plain.txt', 'source'], ['large.md', 'preview'], ['large-source.md', 'source'],
]
for (const [name] of [...cases, ['cancel.md'], ['conflict.md']]) {
  fs.writeFileSync(path.join(workspace, name), name.startsWith('large')
    ? '# 大文件清空\n\n' + '用于验证清空的大文件正文。\n\n'.repeat(14000)
    : '# 清空验收\n\n需要主动删除的正文。')
}
const confirmations = []
const errors = []
app.on('web-contents-created', (_event, contents) => {
  contents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message) })
  watchMessageDialogs(contents, async request => {
    if (['确认清空笔记', '检测到外部修改'].includes(request.options.title)) confirmations.push(request)
    else await request.answer(request.options.cancelId)
  })
})
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(check, label) {
  for (let i = 0; i < 160; i++) { if (await check()) return; await wait(50) }
  throw new Error(`Timeout: ${label}`)
}
const watchdog = setTimeout(() => { console.error('FAIL clearing verification stalled'); app.exit(1) }, 120000)
;(async () => {
  const mainPath = path.resolve('dist-electron/index.js')
  const built = fs.readFileSync(mainPath, 'utf8')
  const constructor = /new ([A-Za-z_$][\w$]*)\(\{\s*width:/g
  assert.equal([...built.matchAll(constructor)].length, 1)
  const hidden = built.replace(constructor, 'new $1({ show: false, width:')
    .replace('import.meta.url', JSON.stringify(pathToFileURL(mainPath).href))
  const mainCopy = path.join(root, 'hidden-main.mjs')
  fs.writeFileSync(mainCopy, hidden)
  BrowserWindow.prototype.show = () => {}
  BrowserWindow.prototype.focus = () => {}
  app.focus = () => {}
  await import(pathToFileURL(mainCopy).href)
  await app.whenReady()
  await until(() => BrowserWindow.getAllWindows().length === 1, 'workspace window')
  const win = BrowserWindow.getAllWindows()[0]
  const run = code => win.webContents.executeJavaScript(code)
  await until(async () => !win.webContents.isLoading() && await run('!!document.querySelector("#app").__vue_app__?.config.globalProperties.$pinia?._s.get("workspace")?.activeWorkspaceId'), 'workspace initialized')
  assert.equal(win.isVisible(), false)
  await run('window.fixtureStore=document.querySelector("#app").__vue_app__.config.globalProperties.$pinia._s.get("workspace"); window.activeEditable=()=>[...document.querySelectorAll(".tiptap,.cm-content")].find(el=>el.getClientRects().length);void 0')
  win.webContents.debugger.attach('1.3')
  const cdp = (method, args) => win.webContents.debugger.sendCommand(method, args)
  await cdp('Emulation.setFocusEmulationEnabled', { enabled: true })
  const modifier = process.platform === 'darwin' ? 4 : 2
  async function key(key, code, windowsVirtualKeyCode, modifiers = 0) {
    for (const type of ['keyDown', 'keyUp']) await cdp('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode, modifiers })
  }
  async function saveShortcut() { await key('s', 'KeyS', 83, modifier) }
  async function open(name, mode = 'preview') {
    await run(`fixtureStore.openFileTab(${JSON.stringify(name)});void 0`)
    await until(async () => await run(`fixtureStore.activeFileRelativePath===${JSON.stringify(name)} && !!activeEditable() && !fixtureStore.openedTextFileContents[${JSON.stringify(name)}]?.isPartial`), `${name} loaded`)
    if (mode !== 'preview' && name.endsWith('.md')) {
      const title = mode === 'split' ? '分割视图' : '编辑模式'
      await run(`[...document.querySelectorAll('button[title="${title}"]')].find(el=>el.getClientRects().length).click()`)
      await until(async () => await run('!![...document.querySelectorAll(".cm-content")].find(el=>el.getClientRects().length)'), `${name} source mounted`)
    }
    await wait(250) // Finish the editor's initial deferred focus/selection restoration.
    await run('activeEditable().focus()')
  }
  async function clear(name) {
    await key('a', 'KeyA', 65, modifier)
    await key('Backspace', 'Backspace', 8)
    await until(async () => await run(`fixtureStore.openedTextFileContents[${JSON.stringify(name)}]?.content===''`), `${name} serialized empty`)
  }
  async function clean(name) {
    await until(async () => fs.readFileSync(path.join(workspace, name), 'utf8') === ''
      && await run(`!fixtureStore.isFileDirty(${JSON.stringify(name)}) && !fixtureStore.openedTextFileContents[${JSON.stringify(name)}].isSaving`), `${name} saved empty and clean`)
  }
  for (const [name, mode] of cases) {
    await open(name, mode)
    const start = confirmations.length
    await clear(name)
    await until(() => confirmations.length > start, `${name} clear confirmation`)
    await run('activeEditable().blur()')
    await saveShortcut()
    await saveShortcut()
    await wait(250)
    assert.equal(confirmations.length, start + 1, `${name}: one pending confirmation`)
    assert.equal(confirmations[start].options.title, '确认清空笔记')
    assert.notEqual(fs.readFileSync(path.join(workspace, name), 'utf8'), '', 'disk is unchanged before confirmation')
    await confirmations[start].answer(0)
    await clean(name)
    await wait(1200)
    assert.equal(confirmations.length, start + 1, `${name}: no false conflict or repeated clear dialog`)
    assert.equal(await run(`fixtureStore.openedTextFileContents[${JSON.stringify(name)}].saveError`), '')
    console.log(`PASS ${name} ${mode}: native delete, overlapping saves, one confirmation, real empty disk file and clean state`)
  }
  await open('cancel.md')
  const cancelled = confirmations.length
  await clear('cancel.md')
  await until(() => confirmations.length > cancelled, 'cancel confirmation')
  await confirmations[cancelled].answer(1)
  await until(async () => await run('!fixtureStore.openedTextFileContents["cancel.md"].isSaving'), 'cancel completed')
  await run('activeEditable().blur()')
  await wait(1200)
  assert.equal(confirmations.length, cancelled + 1, 'cancel does not loop on blur/autosave')
  assert.notEqual(fs.readFileSync(path.join(workspace, 'cancel.md'), 'utf8'), '')
  assert.equal(await run('fixtureStore.isFileDirty("cancel.md")'), true)
  await saveShortcut()
  await until(() => confirmations.length === cancelled + 2, 'explicit save retries cancelled revision')
  await confirmations[cancelled + 1].answer(0)
  await clean('cancel.md')
  console.log('PASS cancel: disk preserved, no automatic repeat, actual save shortcut explicitly retries')

  await open('conflict.md')
  const conflict = confirmations.length
  await clear('conflict.md')
  await until(() => confirmations.length > conflict, 'initial conflict-case clear confirmation')
  fs.writeFileSync(path.join(workspace, 'conflict.md'), '外部程序的新内容')
  await confirmations[conflict].answer(0)
  await until(async () => await run('fixtureStore.openedTextFileContents["conflict.md"].recoveryConflict && !fixtureStore.openedTextFileContents["conflict.md"].isSaving'), 'real conflict retained')
  assert.equal(fs.readFileSync(path.join(workspace, 'conflict.md'), 'utf8'), '外部程序的新内容')
  await saveShortcut()
  await until(() => confirmations.length === conflict + 2, 'overwrite confirmation')
  assert.equal(confirmations[conflict + 1].options.title, '检测到外部修改')
  assert.ok(!confirmations[conflict + 1].options.message.includes('关闭期间'))
  await confirmations[conflict + 1].answer(0)
  await until(() => confirmations.length === conflict + 3, 'clear external content confirmation')
  await confirmations[conflict + 2].answer(0)
  await clean('conflict.md')
  await wait(1200)
  assert.equal(confirmations.length, conflict + 3, 'approved overwrite succeeds without a confirmation loop')
  console.log('PASS real conflict: stale write blocked, approved disk version overwritten, final file empty and clean')
  assert.deepEqual(errors, [], 'no renderer console errors')
  win.webContents.debugger.detach()
  for (const window of BrowserWindow.getAllWindows()) window.destroy()
  clearTimeout(watchdog)
  console.log('PASS production main/preload/renderer file-clearing regression; isolated artifacts:', root)
  app.exit(0)
})().catch(error => { console.error(error); clearTimeout(watchdog); app.exit(1) })
