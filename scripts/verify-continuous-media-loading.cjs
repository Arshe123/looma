// Production component: real loopback image loads, failure and late completion.
// Isolated profile/fixtures; never touches system clipboard or user notes.
const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http')
const directory = fs.mkdtempSync(path.join(os.homedir(), '.hermes/cache/scratch/looma-media-loading-'))
app.setPath('userData', path.join(directory, 'profile'))
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
app.whenReady().then(async () => {
  const pending = [], errors = []
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="80"><rect width="160" height="80" fill="green"/></svg>'
  const server = http.createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    if (request.url === '/deferred.svg') { response.setHeader('Content-Type', 'image/svg+xml'); pending.push(response); return }
    response.setHeader('Content-Type', request.url === '/valid.svg' ? 'image/svg+xml' : 'image/png')
    response.end(request.url === '/valid.svg' ? svg : Buffer.from('invalid image bytes'))
  })
  const win = new BrowserWindow({ show: false, width: 1450, height: 850, webPreferences: { backgroundThrottling: false } })
  const run = code => win.webContents.executeJavaScript(code)
  const until = async (predicate, label) => { for (let i = 0; i < 100; i++) { if (await predicate()) return; await wait(50) } throw Error('Timeout: ' + label) }
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message) })
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const base = 'http://127.0.0.1:' + server.address().port
    await win.loadURL('http://127.0.0.1:5189/src/renderer/components/editor/test/rich-text-parity.browser.html')
    win.webContents.debugger.attach('1.3')
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
    await until(() => run('!!window.ready?.()'), 'production components')
    const source = `![网络](${base}/valid.svg)\n\n![网络失效](${base}/invalid.png)\n\n![本地缺失](assets/missing.png)`
    await run(`setFixture(${JSON.stringify(source)})`)
    await until(() => run('document.querySelector("#continuous .looma-continuous-image img")?.naturalWidth===160'), 'real network image loaded')
    await until(() => run('document.querySelectorAll("#continuous .looma-continuous-image")[2]?.textContent.includes("无法加载图片")'), 'missing local image Chinese fallback')
    await until(() => run('document.querySelectorAll("#continuous .looma-continuous-image")[1]?.textContent.includes("无法加载图片")'), 'invalid network image Chinese fallback')
    assert.equal(await run('model.content'), source, 'load/failure is display only')
    await run(`setFixture(${JSON.stringify(`![稍后](${base}/deferred.svg)`)})`)
    await until(() => pending.length > 0, 'deferred real image request')
    await run('setFixture("替换后的正文")')
    const revision = await run('model.revision')
    for (const response of pending) response.end(svg)
    await wait(250)
    assert.equal(await run('model.content'), '替换后的正文')
    assert.equal(await run('model.revision'), revision, 'late load cannot write source or history')
    assert.equal(await run('document.querySelectorAll("#continuous .looma-continuous-image").length'), 0, 'destroyed image cannot reappear')
    assert.deepEqual(errors, [])
    console.log('PASS production remote image, invalid/local-missing Chinese fallback, late completion after widget removal; canonical source/history unchanged; REPORT', directory)
    win.destroy(); server.close(); app.exit(0)
  } catch (error) { console.error(error, errors, 'REPORT', directory); win.destroy(); server.close(); app.exit(1) }
})
