// Build first; npx electron scripts/verify-continuous-recovery-stress.cjs
// Real frozen main/preload/dist, hidden windows, scratch-only files. No OS clipboard.
// LOOMA_RECOVERY_SHAPE=multiline|single2m|complex (each runs all four processes).
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { pathToFileURL } = require('node:url')
const { spawn, spawnSync } = require('node:child_process')
const { performance } = require('node:perf_hooks')
const electron = require('electron')
const children = new Set()
let failureReportPath, failureReport
let exiting = false
function killChild(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32') {
    const killed = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { encoding: 'utf8', windowsHide: true })
    if (killed.error || killed.status !== 0) {
      console.error('Child tree termination failed', child.pid, killed.error || killed.stderr)
      child.kill('SIGKILL')
    }
  } else child.kill('SIGKILL')
}
function fatal(error) {
  if (exiting) return
  exiting = true
  console.error(error?.stack || error)
  try {
    for (const child of children) {
      try { killChild(child) } catch (killError) { console.error('Could not terminate child', child.pid, killError) }
    }
    if (failureReportPath) fs.writeFileSync(failureReportPath, JSON.stringify({ ...failureReport, success: false, error: String(error?.stack || error) }, null, 2))
  } catch (reportError) { console.error('Could not write failure report', reportError) }
  finally {
    // Catch startup/report failures without Electron dialogs or a live main process.
    try { electron.app.exit(1) } finally { process.exit(1) }
  }
}
process.on('uncaughtException', fatal)
process.on('unhandledRejection', fatal)
const repo = path.resolve(__dirname, '..')
const childStage = process.env.LOOMA_RECOVERY_STAGE
const hash = value => crypto.createHash('sha256').update(value).digest('hex')
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(check, label, timeout = 35000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { if (await check()) return; await wait(25) }
  throw new Error('Timeout: ' + label)
}
async function main() {
if (!childStage) {
  fs.mkdirSync(os.tmpdir(), { recursive: true })
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'looma-recovery-stress-'))
  failureReportPath = path.join(root, 'report.json')
  const baseline = path.join(root, 'baseline')
  fs.mkdirSync(baseline)
  for (const dir of ['dist', 'dist-electron', 'resources']) fs.cpSync(path.join(repo, dir), path.join(baseline, dir), { recursive: true })
  // The build may resolve optional node externals relative to its own directory.
  fs.symlinkSync(path.join(repo, 'node_modules'), path.join(baseline, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.ok(fs.lstatSync(path.join(baseline, 'node_modules')).isSymbolicLink(), 'baseline dependency link must be a real directory link')
  fs.writeFileSync(path.join(baseline, 'package.json'), '{"type":"module"}')
  for (const dir of ['appData', 'userData', 'sessionData', 'workspace']) fs.mkdirSync(path.join(root, dir))
  const metadata = path.join(root, 'appData/workspace-meta/looma')
  fs.mkdirSync(metadata, { recursive: true })
  fs.writeFileSync(path.join(metadata, 'workspaces.json'), JSON.stringify({ workspaces: [{ id: 'fixture', name: 'Fixture', path: path.join(root, 'workspace'), createdAt: 1, lastOpenedAt: 1 }], order: ['fixture'], activeId: 'fixture' }))
  const shape = process.env.LOOMA_RECOVERY_SHAPE || 'multiline'
  assert.ok(['multiline', 'single2m', 'complex'].includes(shape), '未知冷加载夹具类型')
  const body = shape === 'single2m' ? '字'.repeat(2000000) + '\n\n'
    : shape === 'complex' ? Array.from({ length: 6000 }, (_, i) => `## 标题${i}\n\n> 引用 **粗体 *嵌套*** [链接](target.md)\n\n| A | B |\n| --- | --- |\n| 中文 | a\\|b |\n\n\`\`\`typescript\nconst value = ${i};\n\`\`\`\n\n`).join('')
      : Array.from({ length: 16000 }, (_, i) => `Paragraph ${i}: ` + '真实持久化连续编辑 text 😀 '.repeat(7) + '\n\n').join('')
  const source = '# Cold process recovery fixture\n\n' + body + 'END-SENTINEL\n'
  fs.writeFileSync(path.join(root, 'workspace/stress.md'), source)
  fs.writeFileSync(path.join(root, 'original.md'), source)
  const report = { root, baseline: { mainSha256: hash(fs.readFileSync(path.join(baseline, 'dist-electron/index.js'))), rendererIndexSha256: hash(fs.readFileSync(path.join(baseline, 'dist/index.html'))), bytes: Buffer.byteLength(source) }, stages: [], qualifications: ['Cold Electron processes, NOT cold OS disk cache; no purge/sudo.', 'CDP text input in show:false windows; not native OS/IME acceptance.', 'Concurrent-save case inserts a 650ms scheduling gate before the ORIGINAL real file:writeMarkdown listener; no filesystem/API substitute.', 'Abnormal renderer/window destruction and forced child exit; not power-loss durability.', 'Short bounded stress run; not a long-duration memory-leak certification.'] }
  report.baseline.shape = shape
  report.baseline.dependencyLinkType = process.platform === 'win32' ? 'junction' : 'dir'
  report.qualifications.push('Automated hidden-window regression only; Windows uses a real directory junction, not native desktop acceptance.')
  failureReport = report
  report.baseline.characters = source.length
  console.log('ARTIFACTS', root)
  return (async () => {
    for (const stage of ['cold', 'crash', 'recover', 'conflict']) {
      if (stage === 'conflict') fs.appendFileSync(path.join(root, 'workspace/stress.md'), '\nEXTERNAL-DISK-CHANGE\n')
      const outcome = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [__filename], { cwd: repo, env: { ...process.env, LOOMA_RECOVERY_STAGE: stage, LOOMA_RECOVERY_ROOT: root }, stdio: ['ignore', 'pipe', 'pipe'] })
        children.add(child)
        let output = ''; child.stdout.on('data', data => { output += data; process.stdout.write(data) }); child.stderr.on('data', data => { output += data; process.stderr.write(data) })
        let timedOut = false
        const timer = setTimeout(() => { timedOut = true; console.error('Stage watchdog: terminating child tree', stage, child.pid); killChild(child) }, 100000)
        child.once('error', error => { clearTimeout(timer); children.delete(child); reject(error) })
        child.once('close', (code, signal) => { clearTimeout(timer); children.delete(child); resolve({ code, signal, output, timedOut }) })
      })
      const stagePath = path.join(root, `${stage}.json`)
      const result = fs.existsSync(stagePath) ? JSON.parse(fs.readFileSync(stagePath, 'utf8')) : { stage, success: false, error: 'No stage report' }
      report.stages.push({ ...result, exitCode: outcome.code, signal: outcome.signal, timedOut: outcome.timedOut })
      fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2))
      assert.equal(result.success, true, `${stage}: ${result.error || outcome.output.slice(-2000)}`)
      assert.equal(outcome.timedOut, false, `${stage} timed out`)
      assert.equal(outcome.code, stage === 'crash' ? 73 : 0, `${stage} exit`)
    }
    report.success = true
    fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2))
    console.log('PASS real frozen production cold/progressive/save/in-flight-input/crash-draft/restart/conflict; REPORT', path.join(root, 'report.json'))
    electron.app.exit(0)
  })()
} else {
  const { app, BrowserWindow, ipcMain, dialog } = electron
  const root = process.env.LOOMA_RECOVERY_ROOT
  const started = performance.now(), cpu = process.cpuUsage()
  const result = { stage: childStage, pid: process.pid, success: false, ipc: [], samples: [], dialogs: [], errors: [] }
  failureReportPath = path.join(root, `${childStage}.json`)
  failureReport = result
  const note = path.join(root, 'workspace/stress.md')
  for (const key of ['appData', 'userData', 'sessionData']) app.setPath(key, path.join(root, key))
  delete process.env.VITE_DEV_SERVER_URL
  process.env.RAG_SERVICE_URL = 'http://127.0.0.1:1'
  BrowserWindow.prototype.show = () => {}
  BrowserWindow.prototype.showInactive = () => {}
  BrowserWindow.prototype.focus = () => {}
  app.focus = () => {}
  dialog.showMessageBox = async (...args) => { result.dialogs.push(args.at(-1)); return { response: 1, checkboxChecked: false } }
  app.on('web-contents-created', (_event, contents) => {
    require('./message-dialog-driver.cjs')(contents, async request => {
      result.dialogs.push(request.options)
      await request.answer(1)
    })
  })
  let gateNext = false, gateEntered = false, releaseGate
  const handle = ipcMain.handle.bind(ipcMain)
  ipcMain.handle = (channel, listener) => handle(channel, async (event, ...args) => {
    const item = { channel, startedMs: performance.now() - started }
    const relevant = /readTextChunk|writeMarkdown|draftRecovery/i.test(channel)
    if (relevant) result.ipc.push(item)
    if (channel === 'file:writeMarkdown') {
      item.contentSha256 = hash(args[1])
      item.expectedSha256 = typeof args[2] === 'string' ? hash(args[2]) : null
    }
    if (channel === 'file:writeMarkdown' && gateNext) {
      gateNext = false; gateEntered = true
      const gateStart = performance.now()
      await new Promise(resolve => { releaseGate = resolve })
      item.injectedGateMs = performance.now() - gateStart
      item.minimumGateDelayMs = 650
    }
    const begin = performance.now()
    try {
      const value = await listener(event, ...args)
      item.handlerMs = performance.now() - begin
      item.success = value?.success
      if (value?.errorCode) item.errorCode = value.errorCode
      if (value?.error) item.error = value.error
      return value
    }
    catch (error) { item.error = String(error); throw error }
  })
  app.on('web-contents-created', (_e, wc) => wc.on('console-message', (_event, level, message) => { if (level >= 3) result.errors.push(message) }))
  let win
  const finish = (error, code = 0) => {
    if (error) result.error = String(error.stack || error)
    result.elapsedMs = performance.now() - started; result.cpuMicroseconds = process.cpuUsage(cpu); result.mainMemory = process.memoryUsage()
    fs.writeFileSync(path.join(root, `${childStage}.json`), JSON.stringify(result, null, 2))
    for (const window of BrowserWindow.getAllWindows()) window.destroy()
    app.exit(error ? 1 : code)
  }
  const watchdog = setTimeout(() => finish(new Error('Stage watchdog')), 90000)
  return (async () => {
    const mainPath = path.join(root, 'baseline/dist-electron/index.js')
    const built = fs.readFileSync(mainPath, 'utf8'), pattern = /new ([A-Za-z_$][\w$]*)\(\{\s*width:/g
    assert.equal([...built.matchAll(pattern)].length, 1)
    const copy = path.join(root, `hidden-${childStage}.mjs`)
    fs.writeFileSync(copy, built.replace(pattern, 'new $1({ show: false, width:').replace('import.meta.url', JSON.stringify(pathToFileURL(mainPath).href)))
    const main = await import(pathToFileURL(copy).href)
    await app.whenReady()
    await until(() => BrowserWindow.getAllWindows().length, 'window')
    win = BrowserWindow.getAllWindows()[0]
    const run = code => win.webContents.executeJavaScript(code)
    await until(async () => !win.webContents.isLoading() && await run('!!document.querySelector("header")'), 'production renderer')
    // Read the actual application Pinia only; no injected/mock stores or APIs.
    await run('window.fixtureStore=document.querySelector("#app").__vue_app__.config.globalProperties.$pinia._s.get("workspace"); void 0')
    assert.equal(await run('!!fixtureStore'), true)
    result.rendererReadyMs = performance.now() - started
    win.webContents.debugger.attach('1.3')
    const cdp = (method, args) => win.webContents.debugger.sendCommand(method, args)
    await cdp('Emulation.setFocusEmulationEnabled', { enabled: true })
    await cdp('Performance.enable')
    app.emit('open-file', { preventDefault() {} }, note)
    await until(async () => {
      const state = await run('(()=>{const s=fixtureStore.openedTextFileContents["stress.md"],el=document.querySelector(".chunked-markdown-editor .cm-content");return s&&{partial:s.isPartial,length:s.content.length,mounted:!!el,domChars:el?.textContent.length}})()')
      if (state && result.samples.length < 100) result.samples.push({ ms: performance.now() - started, ...state })
      return state?.mounted
    }, 'first continuous editor DOM')
    result.firstScreenMs = performance.now() - started
    result.partialAtFirstScreen = await run('fixtureStore.openedTextFileContents["stress.md"].isPartial')
    result.firstFrame = await run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>{const el=document.querySelector(".chunked-markdown-editor .cm-content"),r=el.getBoundingClientRect();resolve({width:r.width,height:r.height,lines:el.querySelectorAll(".cm-line").length,domChars:el.textContent.length,partial:fixtureStore.openedTextFileContents["stress.md"].isPartial})})))')
    result.firstDoubleRafMs = performance.now() - started
    assert.ok(result.firstFrame.width > 0 && result.firstFrame.height > 0 && result.firstFrame.lines > 0, 'first laid-out continuous viewport')
    assert.ok(result.firstFrame.domChars < 60000, 'first-screen source DOM bounded')
    await until(async () => await run('!fixtureStore.openedTextFileContents["stress.md"].isPartial && !document.querySelector(".continuous-partial-state")'), 'automatic background full load', 50000)
    result.fullLoadMs = performance.now() - started
    assert.equal(win.isVisible(), false)
    assert.equal(await run('!!document.querySelector(".tiptap")'), false)
    const state = () => run('(()=>{const s=fixtureStore.openedTextFileContents["stress.md"];return {content:s.content,base:s.loadedContent,dirty:fixtureStore.isFileDirty("stress.md"),saving:s.isSaving,conflict:s.recoveryConflict,error:s.saveError}})()')
    const sampleHeap = async label => {
      const usage = await cdp('Runtime.getHeapUsage')
      result.samples.push({ label, ms: performance.now() - started, heapUsedBytes: usage.usedSize, heapTotalBytes: usage.totalSize, rendererMetrics: (await cdp('Performance.getMetrics')).metrics })
    }
    await sampleHeap('fully-loaded')
    const insert = async text => { await run('document.querySelector(".chunked-markdown-editor .cm-content").focus()'); await cdp('Input.insertText', { text }) }
    if (childStage === 'cold') {
      const original = fs.readFileSync(path.join(root, 'original.md'), 'utf8')
      assert.equal((await state()).content, original)
      assert.ok(result.partialAtFirstScreen || result.samples.some(s => s.partial), 'real partial state was observed')
      const t = performance.now(); await insert('FIRST-INPUT-真实')
      await until(() => fs.readFileSync(note, 'utf8').includes('FIRST-INPUT-真实'), 'autosave full file')
      result.autosaveMs = performance.now() - t
      const saved = fs.readFileSync(note, 'utf8')
      assert.equal(saved.replace('FIRST-INPUT-真实', ''), original, 'every original byte retained')
      await until(async () => !(await state()).saving, 'first save completion')
      gateNext = true
      await insert('SAVE-SNAPSHOT-A')
      await until(() => gateEntered, 'real write handler in flight')
      await insert('DURING-SAVE-B')
      await until(async () => (await state()).content.includes('DURING-SAVE-B'), 'continued native input reached real store')
      assert.equal((await state()).saving, true)
      // Freeze the following real write too: otherwise polling can miss the
      // interval between queued saves and inspect the already-saved B snapshot.
      const releaseOlderWrite = releaseGate
      gateNext = true
      gateEntered = false
      await wait(650); releaseOlderWrite()
      await until(() => gateEntered, 'following real write handler in flight')
      const after = await state()
      assert.ok(after.content.includes('DURING-SAVE-B'), 'older save completion cannot replace newer input')
      assert.ok(!after.base.includes('DURING-SAVE-B'), 'base is exactly snapshot written, not newer input')
      assert.equal(after.base, fs.readFileSync(note, 'utf8'), 'completed snapshot matches actual disk bytes')
      assert.equal(after.dirty, true)
      assert.equal(result.ipc.filter(item => item.channel === 'file:writeMarkdown').at(-1).expectedSha256, hash(after.base), 'queued save uses the completed snapshot as its CAS baseline')
      result.followingWriteSchedulingGate = true
      releaseGate()
      await until(() => fs.readFileSync(note, 'utf8').includes('DURING-SAVE-B'), 'newer input eventually saved')
      await until(async () => !(await state()).saving, 'following save completion')
      const final = fs.readFileSync(note, 'utf8')
      assert.equal(final.replace('FIRST-INPUT-真实', '').replace('SAVE-SNAPSHOT-A', '').replace('DURING-SAVE-B', ''), original)
      fs.writeFileSync(path.join(root, 'saved-baseline.md'), final)
      result.concurrentInputProtected = true
    } else if (childStage === 'crash') {
      const disk = fs.readFileSync(note, 'utf8'), t = performance.now()
      await insert('CRASH-DRAFT-真实')
      await until(async () => {
        const s = await state()
        if (!s.content.includes('CRASH-DRAFT-真实')) return false
        const draft = await run('window.electronAPI.draftRecovery.get("fixture","stress.md",fixtureStore.openedTextFileContents["stress.md"].loadedContent)')
        return draft.success && draft.data?.draft?.draftContent.includes('CRASH-DRAFT-真实')
      }, 'real durable recovery record')
      result.draftLatencyMs = performance.now() - t
      assert.equal(fs.readFileSync(note, 'utf8'), disk, 'draft exists BEFORE original autosave')
      fs.writeFileSync(path.join(root, 'expected-draft.md'), (await state()).content)
      result.success = true; clearTimeout(watchdog); finish(null, 73); return
    } else {
      const expected = fs.readFileSync(path.join(root, 'expected-draft.md'), 'utf8')
      await until(async () => (await state()).content === expected, 'exact full draft restored after cold restart')
      const recovered = await state()
      assert.equal(recovered.dirty, true)
      const disk = fs.readFileSync(note, 'utf8')
      assert.equal(recovered.base, disk)
      if (childStage === 'recover') {
        assert.equal(recovered.conflict, false)
        assert.equal(disk, fs.readFileSync(path.join(root, 'saved-baseline.md'), 'utf8'))
      } else {
        assert.equal(recovered.conflict, true)
        const response = await run('fixtureStore.saveActiveFileContent(undefined,"stress.md")')
        assert.equal(response.success, false)
        assert.ok(result.dialogs.length, 'real overwrite confirmation invoked and canceled')
        assert.equal(fs.readFileSync(note, 'utf8'), disk)
        assert.equal((await state()).content, expected)
        result.externalChangeProtected = true
      }
      result.restoredBytes = Buffer.byteLength(recovered.content)
    }
    await sampleHeap('end')
    result.rendererMetrics = (await cdp('Performance.getMetrics')).metrics
    assert.equal(win.isVisible(), false)
    assert.deepEqual(result.errors, [])
    result.success = true; clearTimeout(watchdog); console.log('PASS', childStage, 'pid', process.pid); finish()
  })().catch(error => { clearTimeout(watchdog); console.error(error); finish(error) })
}
}
// Catch even synchronous failures before either stage's asynchronous body.
Promise.resolve().then(main).catch(fatal)
