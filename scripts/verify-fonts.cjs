// Run with: npx electron scripts/verify-fonts.cjs
// Use the application's Electron, not a newer system Chrome: their font decoders differ.
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const root = path.resolve(__dirname, '..')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'looma-font-check-'))
app.setPath('userData', path.join(temp, 'profile'))
const deadline = setTimeout(() => finish(2), 60000)
let window

function finish(code) {
  clearTimeout(deadline)
  if (window && !window.isDestroyed()) window.destroy()
  fs.rmSync(temp, { recursive: true, force: true })
  app.exit(code)
}

app.whenReady().then(async () => {
  const stylesDirectory = path.join(root, 'src/renderer/styles')
  const css = fs.readFileSync(path.join(stylesDirectory, 'fonts.css'), 'utf8')
  const cases = [
    { id: 'simple', expected: 'Source Han Sans', label: '简洁统一 · 思源黑体' },
    { id: 'literary', expected: 'Source Han Serif', label: '书卷阅读 · 思源宋体' },
    { id: 'handwritten', expected: 'LXGW WenKai', label: '柔和手写 · 霞鹜文楷' },
  ]
  const sample = '把日常，慢慢写成生活。中文 English 0123'
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><base href="${pathToFileURL(stylesDirectory + path.sep).href}"><style>${css}
  body{background:#fcfbf7;color:#363d35;padding:24px;font-family:var(--font-ui)}
  section{padding:12px;border-bottom:1px solid #dedfd3}h2{font:14px var(--font-ui)}
  p,strong{font-size:24px;line-height:1.8;margin:0}code{font-family:var(--font-code)}
  </style></head><body>${cases.map(item => `<section class="markdown-body" data-font-preset="${item.id}"><h2>${item.label}</h2><p id="${item.id}">${sample}</p><strong id="${item.id}-bold">强调文字 Bold</strong></section>`).join('')}<code id="code">const note = 123;</code></body></html>`
  const page = path.join(temp, 'fonts.html')
  fs.writeFileSync(page, html)
  window = new BrowserWindow({ show: false, width: 1100, height: 700, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } })
  const decodeErrors = []
  window.webContents.on('console-message', (_event, _level, message) => {
    if (/Failed to decode downloaded font|OTS parsing error/.test(message)) decodeErrors.push(message)
  })
  await window.loadFile(page)
  await window.webContents.executeJavaScript('document.fonts.ready.then(() => true)')
  const debuggerClient = window.webContents.debugger
  debuggerClient.attach('1.3')
  await debuggerClient.sendCommand('DOM.enable')
  await debuggerClient.sendCommand('CSS.enable')
  const nodeId = (await debuggerClient.sendCommand('DOM.getDocument')).root.nodeId
  const results = []
  for (const item of [...cases, ...cases.map(item => ({ ...item, id: item.id + '-bold' })), { id: 'code', expected: 'JetBrains Mono' }]) {
    const target = await debuggerClient.sendCommand('DOM.querySelector', { nodeId, selector: '#' + item.id })
    const { fonts } = await debuggerClient.sendCommand('CSS.getPlatformFontsForNode', { nodeId: target.nodeId })
    const passed = fonts.length > 0 && fonts.every(font => font.isCustomFont && font.familyName.includes(item.expected))
    results.push({ sample: item.id, passed, fonts })
  }
  const screenshot = path.join(os.tmpdir(), 'looma-font-verification.png')
  fs.writeFileSync(screenshot, (await window.webContents.capturePage()).toPNG())
  console.log(JSON.stringify({ electron: process.versions.electron, chrome: process.versions.chrome, decodeErrors, results, screenshot }, null, 2))
  finish(decodeErrors.length === 0 && results.every(result => result.passed) ? 0 : 1)
}).catch(error => {
  console.error(error)
  finish(2)
})
