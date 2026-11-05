// Real components, temporary profile and memory content. Requires Vite test mode on 5189.
const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const profile = fs.mkdtempSync(path.join(process.env.TMPDIR, 'looma-ai-markdown-'))
app.setPath('userData', path.join(profile, 'profile'))
app.setPath('sessionData', path.join(profile, 'session'))
const wait = (ms = 100) => new Promise(resolve => setTimeout(resolve, ms))
const source = [
  '## 相同的 Markdown', '',
  '前 ==**重点**与 `命令`== 后，中文**🚨告警**后文。', '',
  '*斜体* 与 ~~删除线~~ 与 [外部链接](https://example.com)。', '',
  '> 引用正文', '', '- 普通列表', '  - 嵌套列表', '',
  '- [ ] 待办', '- [x] 完成', '',
  '| 列一 | 列二 | 列三 |', '| --- | --- | --- |',
  '| 中文内容 | 更多内容 | 最后一列 |', '',
  '```sh', 'echo "<dev>"', 'echo "**literal**"', '```',
].join('\n')
const code = 'echo "<dev>"\necho "**literal**"\n'
const matrix = {
  p: ['fontFamily', 'marginBottom'],
  strong: ['fontFamily', 'fontWeight', 'fontSynthesis'],
  em: ['fontStyle'],
  mark: ['color', 'backgroundColor', 'borderRadius', 'padding'],
  'p code': ['fontFamily', 'fontSize', 'color', 'backgroundColor', 'borderRadius', 'padding'],
  blockquote: ['color', 'borderLeftWidth', 'borderLeftColor', 'paddingLeft'],
  ul: ['listStyleType'],
  th: ['fontWeight', 'backgroundColor', 'padding', 'borderTopColor', 'whiteSpace'],
  td: ['backgroundColor', 'padding', 'borderTopColor', 'whiteSpace'],
  'a.looma-external-link': ['color', 'textDecorationLine', 'borderBottomStyle', 'borderBottomWidth'],
  '.code-block-shell': ['color', 'backgroundColor', 'borderRadius', 'borderTopColor'],
  '.code-block-body': ['fontFamily', 'fontSize', 'lineHeight'],
  '.code-block-content .hljs-built_in': ['color'],
  '.code-block-content .hljs-string': ['color'],
  h2: ['fontFamily', 'fontWeight', 'color'],
}
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1300, height: 1000, webPreferences: { backgroundThrottling: false } })
  const run = js => win.webContents.executeJavaScript(js)
  const send = (method, args) => win.webContents.debugger.sendCommand(method, args)
  try {
    await win.loadURL('http://127.0.0.1:5189/scripts/test/ai-markdown-parity.html')
    win.webContents.debugger.attach('1.3')
    await send('Emulation.setFocusEmulationEnabled', { enabled: true })
    await send('Page.bringToFront')
    for (let i = 0; i < 100 && !await run('window.ready?.()'); i++) await wait()
    assert.ok(await run('ready()'), 'real Tiptap mounted')
    for (const theme of ['light', 'dark']) {
      for (const width of [420, 280]) {
        await run(`setFixture(${JSON.stringify(source)}, ${width}, ${JSON.stringify(theme)})`)
        await wait(450)
        const snapshot = await run(`(() => {
          const roots = [document.querySelector('#note .tiptap'), document.querySelector('#chat .ai-markdown')]
          return roots.map(root => Object.fromEntries(Object.entries(${JSON.stringify(matrix)}).map(([selector, properties]) => {
            const el = root.querySelector(selector)
            if (!el) throw new Error('Missing '+selector+' in '+root.className)
            const style = getComputedStyle(el)
            return [selector, Object.fromEntries(properties.map(property => [property, style[property]]))]
          })))
        })()`)
        for (const selector of Object.keys(matrix)) assert.deepEqual(snapshot[1][selector], snapshot[0][selector], `${theme}/${width}: ${selector}: ${JSON.stringify(snapshot)}`)
        const geometry = await run(`(() => {
          const chat = document.querySelector('#chat'), ai = chat.querySelector('.ai-markdown'), table = ai.querySelector('table')
          return { overflow: ai.scrollWidth - chat.clientWidth, tableOverflow: table.scrollWidth - table.clientWidth,
            editable: ai.isContentEditable, gutter: !!ai.querySelector('.looma-line-number'),
            headingMarker: getComputedStyle(ai.querySelector('h2'), '::after').content,
            nestedBold: !!ai.querySelector('mark strong'), nestedCode: !!ai.querySelector('mark code'),
            checkboxes: [...ai.querySelectorAll('input[type=checkbox]')].map(el=>({checked:el.checked,disabled:el.disabled})),
          }
        })()`)
        assert.ok(geometry.overflow <= 1, `chat must not overflow: ${JSON.stringify(geometry)}`)
        assert.equal(geometry.editable, false)
        assert.equal(geometry.gutter, false)
        assert.ok(['none', 'normal', '""'].includes(geometry.headingMarker))
        assert.equal(geometry.nestedBold, true)
        assert.equal(geometry.nestedCode, true)
        assert.deepEqual(geometry.checkboxes, [{ checked: false, disabled: true }, { checked: true, disabled: true }])
        if (width === 280) assert.ok(geometry.tableOverflow > 0, 'wide table scrolls locally')
        if (process.argv.includes('--screenshots')) {
          const file = path.join(process.env.TMPDIR, `looma-ai-markdown-${theme}-${width}.png`)
          fs.writeFileSync(file, (await win.webContents.capturePage()).toPNG())
          console.log('Screenshot:', file)
        }
        console.log(`PASS ${theme}/${width}: shared computed typography, nested syntax, readonly tasks and bounded table`)
      }
    }
    const rect = await run(`(() => {
      const shell = document.querySelector('#chat .code-block-shell'); shell.scrollIntoView({block:'center'})
      const r = shell.getBoundingClientRect(); return {x:r.left+20,y:r.top+20}
    })()`)
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...rect })
    await wait(180)
    const button = await run(`(() => {const el=document.querySelector('#chat .code-block-floating-copy'),r=el.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2,opacity:getComputedStyle(el).opacity}})()`)
    assert.equal(button.opacity, '1')
    const click = { x: button.x, y: button.y, button: 'left', clickCount: 1 }
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...click })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...click })
    await wait(100)
    assert.deepEqual(await run('events.copies'), [code])
    assert.equal(await run('document.querySelector("#chat .code-block-copy-status").textContent'), '已复制')
    assert.deepEqual(await run('({updates:events.updates,saves:events.saves,edits:events.edits})'), { updates: [], saves: [], edits: 0 })
    console.log('PASS real pointer copy sends exact code to isolated clipboard sink; display creates no edits/saves')
    win.webContents.debugger.detach()
    win.destroy(); fs.rmSync(profile, { recursive: true, force: true }); app.exit(0)
  } catch (error) {
    console.error(error)
    win.destroy(); fs.rmSync(profile, { recursive: true, force: true }); app.exit(1)
  }
})
