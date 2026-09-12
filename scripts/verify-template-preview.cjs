// Start: npx vite --mode test --host 127.0.0.1 --port 5191
// Then: npx electron scripts/verify-template-preview.cjs
const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const profile = mkdtempSync(join(tmpdir(), 'looma-template-preview-'))
app.setPath('userData', profile)
const delay = () => new Promise(resolve => setTimeout(resolve, 100))
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1050, height: 900, show: false, webPreferences: { backgroundThrottling: false } })
  const run = code => win.webContents.executeJavaScript(code)
  const requests = []
  win.webContents.session.webRequest.onBeforeRequest((details, callback) => { requests.push(details.url); callback({}) })
  try {
    await win.loadURL('http://127.0.0.1:5191/scripts/test/template-preview.html')
    for (let i = 0; i < 100 && !await run('window.ready'); i++) await delay()
    assert.ok(await run('window.ready'), '真实组件应挂载')
    await run('document.fonts.ready')
    const structure = await run(`(() => {
      const root = document.querySelector('.template-markdown-preview');
      return { title:root?.querySelector('h1')?.textContent, tags:['strong','em','s','mark','blockquote','ul','ol','table','pre code'].map(s=>!!root?.querySelector(s)), readonly:[...root.querySelectorAll('input[type=checkbox]')].every(e=>e.disabled), scripts:root.querySelectorAll('script').length, local:root.querySelector('img[src*="example.png"]')?.getAttribute('src'), text:root.textContent };
    })()`)
    assert.equal(structure.title, '预览标题')
    assert.ok(structure.tags.every(Boolean), JSON.stringify(structure)); assert.ok(structure.readonly)
    assert.equal(structure.scripts, 0); assert.equal(structure.local, undefined)
    assert.ok(!requests.some(url => url.includes('/assets/example.png')), '不得请求相对本地图片')
    assert.deepEqual(await run('testState.calls'), [])
    console.log('PASS: Markdown结构、表达式、安全转义、只读任务框、本地图片边界、零写入')
    await run(`document.querySelector('.template-markdown-preview a[href="https://example.com"]').click()`)
    await delay()
    assert.deepEqual(await run('testState.calls'), ['https://example.com'])
    await run(`document.querySelector('.template-markdown-preview a[href="note.md"]').click()`)
    assert.ok(win.webContents.getURL().includes('template-preview.html'))
    const hoverCount = await run(`(() => {
      let count = 0; const listener = () => count++;
      document.addEventListener('mouseover', listener); document.addEventListener('mouseout', listener);
      const link = document.querySelector('.template-markdown-preview a[href="note.md"]');
      link.dispatchEvent(new MouseEvent('mouseover', {bubbles:true})); link.dispatchEvent(new MouseEvent('mouseout', {bubbles:true}));
      document.removeEventListener('mouseover', listener); document.removeEventListener('mouseout', listener);
      return count;
    })()`)
    assert.equal(hoverCount, 0, '模板链接不应触发全局笔记悬浮预览')
    await run(`document.querySelector('.template-markdown-preview .code-block-floating-copy').click()`)
    await delay()
    assert.deepEqual(await run('testState.calls[1]'), { copy: 'const value = "**源码**"\n' })
    console.log('PASS: 外链系统浏览器、内部链接不导航、代码复制')
    for (const theme of ['light', 'dark']) {
      for (const palette of ['paper', 'graphite', 'ocean']) {
        for (const font of ['simple', 'literary', 'handwritten']) {
          const styles = await run(`(() => {
            document.documentElement.dataset.theme=${JSON.stringify(theme)};
            document.documentElement.classList.toggle('dark',${theme === 'dark'});
            document.documentElement.dataset.palette=${JSON.stringify(palette)};
            document.documentElement.dataset.fontPreset=${JSON.stringify(font)};
            const root=document.querySelector('.template-markdown-preview');
            const probe=document.createElement('div'); probe.style.cssText='color:var(--text-main);background:var(--panel-soft);font-family:var(--font-body)'; document.body.append(probe);
            const result={font:getComputedStyle(root).fontFamily, expectedFont:getComputedStyle(probe).fontFamily, color:getComputedStyle(root).color, expectedColor:getComputedStyle(probe).color, codeBackground:getComputedStyle(root.querySelector('pre')).backgroundColor, expectedBackground:getComputedStyle(probe).backgroundColor, italic:getComputedStyle(root.querySelector('em')).fontStyle, bullet:getComputedStyle(root.querySelector('ul')).listStyleType};
            probe.remove(); return result;
          })()`)
          assert.equal(styles.font, styles.expectedFont)
          assert.equal(styles.color, styles.expectedColor)
          assert.equal(styles.codeBackground, styles.expectedBackground)
          assert.notEqual(styles.color, styles.codeBackground)
          assert.equal(styles.italic, 'italic'); assert.equal(styles.bullet, 'disc')
        }
      }
    }
    console.log('PASS: 日夜 × 三配色 × 三字体样式有效')
    await run(`document.querySelector('.template-markdown-preview').scrollIntoView({block:'center'})`)
    await delay()
    writeFileSync(join(tmpdir(), 'looma-template-preview.png'), (await win.webContents.capturePage()).toPNG())
    win.setSize(420, 700)
    const wideContent = '# 窄屏\n\n| 宽表 |\n| --- |\n| ' + '长内容'.repeat(200) + ' |\n\n```\n' + 'long_code_'.repeat(200) + '\n```'
    await run(`setContent(${JSON.stringify(wideContent)})`)
    await delay()
    const width = await run(`({scroll:document.documentElement.scrollWidth, client:document.documentElement.clientWidth})`)
    assert.ok(width.scroll <= width.client + 1, JSON.stringify(width))
    await run(`setContent('# {{ missing }}')`)
    assert.ok(!await run(`document.querySelector('.template-markdown-preview h1')`))
    await run(`setContent('')`)
    assert.ok(await run(`document.body.textContent.includes('暂无内容')`))
    await run(`setContent('# 恢复成功')`)
    assert.equal(await run(`document.querySelector('.template-markdown-preview h1').textContent`), '恢复成功')
    assert.equal((await run('testState.calls')).length, 2)
    console.log('PASS: 窄屏长表/代码不溢出、输入更新、错误/空态/恢复、预览无持久化副作用')
    win.destroy(); rmSync(profile, { recursive: true, force: true }); app.exit(0)
  } catch (error) {
    console.error(error); win.destroy(); rmSync(profile, { recursive: true, force: true }); app.exit(1)
  }
})
