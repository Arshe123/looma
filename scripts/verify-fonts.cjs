// Run with: npx electron scripts/verify-fonts.cjs
// Use the application's Electron, not a newer system Chrome: their font decoders differ.
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const root = path.resolve(__dirname, '..')
const scratch = path.join(os.homedir(), '.hermes/cache/scratch')
fs.mkdirSync(scratch, { recursive: true })
const temp = fs.mkdtempSync(path.join(scratch, 'looma-font-check-'))
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
  const stylesheet = fs.readFileSync(path.join(stylesDirectory, 'style.css'), 'utf8')
  const synthesis = stylesheet.match(/\.markdown-body\s*\{[^}]*font-synthesis:[^}]*\}/s)[0]
  const githubCss = fs.readFileSync(path.join(root, 'node_modules/github-markdown-css/github-markdown.css'), 'utf8')
  const cases = [
    { id: 'simple', expected: 'Source Han Sans', label: '简洁统一 · 思源黑体' },
    { id: 'literary', expected: 'Source Han Serif', label: '书卷阅读 · 思源宋体' },
    { id: 'handwritten', expected: 'LXGW WenKai', label: '柔和手写 · 霞鹜文楷' },
  ]
  const sample = '把日常，慢慢写成生活。中文 English 0123'
  const variants = [
    { suffix: '', tag: text => text, weight: '400', style: 'normal' },
    { suffix: '-bold', tag: text => `<strong>${text}</strong>`, weight: '700', style: 'normal' },
    { suffix: '-italic', tag: text => `<em>${text}</em>`, weight: '400', style: 'oblique 16deg' },
    { suffix: '-both', tag: text => `<strong><em>${text}</em></strong>`, weight: '700', style: 'oblique 16deg' },
    { suffix: '-reverse', tag: text => `<em><strong>${text}</strong></em>`, weight: '700', style: 'oblique 16deg' },
  ]
  const samples = cases.flatMap(item => variants.map(variant => ({ ...item, ...variant, id: item.id + variant.suffix })))
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><base href="${pathToFileURL(stylesDirectory + path.sep).href}"><style>${css}\n${githubCss}\n:root{font-synthesis:none}\n${synthesis}
  body{background:#fcfbf7;color:#363d35;padding:24px;font-family:var(--font-ui)}
  section{padding:12px;border-bottom:1px solid #dedfd3}h2{font:14px var(--font-ui)}
  p,strong{font-size:24px;line-height:1.8;margin:0}code{font-family:var(--font-code)}
  </style></head><body>${cases.map(item => `<section class="markdown-body" data-font-preset="${item.id}"><h2>${item.label}</h2>${variants.map(variant => `<p>${variant.tag(`<span id="${item.id + variant.suffix}">${sample}</span>`)}</p>`).join('')}</section>`).join('')}<code id="code">const note = 123;</code></body></html>`
  const page = path.join(temp, 'fonts.html')
  fs.writeFileSync(page, html)
  window = new BrowserWindow({ show: false, width: 1100, height: 1100, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } })
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
  for (const item of [...samples, { id: 'code', expected: 'JetBrains Mono', weight: '400', style: 'normal' }]) {
    const target = await debuggerClient.sendCommand('DOM.querySelector', { nodeId, selector: '#' + item.id })
    const { fonts } = await debuggerClient.sendCommand('CSS.getPlatformFontsForNode', { nodeId: target.nodeId })
    const computed = await window.webContents.executeJavaScript(`(() => {
      const style = getComputedStyle(document.getElementById(${JSON.stringify(item.id)}))
      return { weight: style.fontWeight, style: style.fontStyle, synthesis: style.fontSynthesis }
    })()`)
    const passed = fonts.length > 0 && fonts.every(font => font.isCustomFont && font.familyName.includes(item.expected))
      && computed.weight === item.weight && computed.style === item.style
      && (item.weight !== '700' || computed.synthesis === 'weight style')
    results.push({ sample: item.id, passed, computed, fonts })
  }
  const screenshots = []
  for (const item of cases) {
    await window.webContents.executeJavaScript(`document.querySelector('[data-font-preset="${item.id}"]').scrollIntoView()`)
    const screenshot = path.join(scratch, `looma-font-${item.id}.png`)
    fs.writeFileSync(screenshot, (await window.webContents.capturePage()).toPNG())
    screenshots.push(screenshot)
  }
  // Prove the static Medium is actually emboldened, not merely computed as 700.
  const withSynthesis = (await window.webContents.capturePage()).toPNG()
  await window.webContents.executeJavaScript(`document.getElementById('handwritten-bold').parentElement.style.fontSynthesis = 'style'`)
  const withoutSynthesis = (await window.webContents.capturePage()).toPNG()
  const syntheticBoldChangesPixels = !withSynthesis.equals(withoutSynthesis)
  console.log(JSON.stringify({ electron: process.versions.electron, chrome: process.versions.chrome, decodeErrors, results, screenshots, syntheticBoldChangesPixels }, null, 2))
  finish(decodeErrors.length === 0 && syntheticBoldChangesPixels && results.every(result => result.passed) ? 0 : 1)
}).catch(error => {
  console.error(error)
  finish(2)
})
