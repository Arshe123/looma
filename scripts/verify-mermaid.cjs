// Real editor components, in-memory notes; requires Vite test mode on port 5189.
const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const profile = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'looma-mermaid-'))
app.setPath('userData', profile)
app.on('window-all-closed', () => {})
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const note = '前文\n\n```mermaid\nflowchart LR\n  A[开始] --> B[结束]\n```\n\n```js\nconst x = 1\n```\n\n后文'
const invalid = note.replace('flowchart LR\n  A[开始] --> B[结束]', 'not a diagram')
const loaded = 'document.querySelector("img.looma-mermaid-image")?.naturalWidth > 0'
const onlyDiagram = `(() => {
  const isVisible = el => el.getClientRects().length > 0;
  const text = [...document.querySelectorAll('.code-block-body, .cm-line')].filter(isVisible).map(el => el.textContent).join(' ');
  return { mermaidSource: text.includes('flowchart LR') || text.includes('A[开始]') || text.includes('not a diagram'), jsSource: text.includes('const x = 1') };
})()`

async function verifyTiptapBackspace(run, until, send, atEnd) {
  const fence = note.split('\n\n')[1]
  await run(`setFixture(${JSON.stringify(atEnd ? fence : `${fence}\n\n后文`)})`)
  await until('document.querySelector("#note img.looma-mermaid-image")?.naturalWidth > 0', 'diagram before Backspace')
  await run(`(() => {
    const view = editor().view;
    const afterCode = view.state.doc.firstChild.nodeSize;
    const next = view.state.doc.nodeAt(afterCode);
    if (next?.type.name !== 'paragraph' || next.content.size) {
      editor().commands.insertContentAt(afterCode, { type: 'paragraph' });
    }
    editor().commands.setTextSelection(afterCode + 1);
    view.focus();
    const imageSelector = '#note img.looma-mermaid-image';
    const original = document.querySelector(imageSelector);
    const height = original.getBoundingClientRect().height;
    window.diagramFrames = [];
    const sample = () => {
      const image = document.querySelector(imageSelector);
      diagramFrames.push(image === original && image.getBoundingClientRect().height === height);
      if (diagramFrames.length < 12) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  })()`)
  const backspace = async () => {
    for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
  }
  await backspace()
  await until('diagramFrames.length === 12', 'sample Backspace frames')
  const state = await run(`(() => {
    const { doc, selection } = editor().state;
    const blocks = [];
    doc.forEach(node => blocks.push([node.type.name, node.textContent]));
    return { blocks, selection: selection.toJSON(), stable: diagramFrames.every(Boolean), visualSelection: !!document.querySelector('#note .code-block-shell.ProseMirror-selectednode'), caretCollapsed: getSelection().isCollapsed };
  })()`)
  assert.deepEqual(state, {
    blocks: [['codeBlock', 'flowchart LR\n  A[开始] --> B[结束]'], ...(atEnd ? [] : [['paragraph', '后文']])],
    selection: { type: 'node', anchor: 0 }, stable: true, visualSelection: true, caretCollapsed: false,
  }, `first Backspace removes only the empty paragraph and selects the unchanged diagram: ${JSON.stringify(state)}`)
  await backspace()
  assert.equal((await run('editor().getMarkdown()')).trim(), atEnd ? '' : '后文', 'second Backspace removes only the selected diagram')
  await until(`events.updates.at(-1)?.trim() === ${JSON.stringify(atEnd ? '' : '后文')}`, 'deletion finishes serializing before replacing the fixture')
}

app.whenReady().then(async () => {
  try {
    const backspaceOnly = process.argv.includes('--backspace')
    for (const chunked of backspaceOnly ? [false] : [false, true]) {
      const win = new BrowserWindow({ show: false, width: 1200, height: 950, webPreferences: { backgroundThrottling: false } })
      win.webContents.on('console-message', (_event, level, message) => { if (level >= 3) console.error(message) })
      try {
        const run = js => win.webContents.executeJavaScript(js)
        const until = async (js, label) => {
          for (let i = 0; i < 100; i++) {
            if (await run(js)) return
            await wait(80)
          }
          assert.fail(`${chunked ? 'continuous' : 'Tiptap'}: ${label}; ${await run('[...document.querySelectorAll(".looma-mermaid-preview")].map(el => el.outerHTML).join(" ")')}`)
        }
        const fixture = chunked ? 'src/renderer/components/editor/test/chunked-editor.browser.html' : 'scripts/test/ai-markdown-parity.html'
        await win.loadURL(`http://127.0.0.1:5189/${fixture}`)

        await until(chunked ? 'window.ready?.() && !!cm()' : 'window.ready?.()', 'editor mounted')
        if (backspaceOnly) {
          const debug = win.webContents.debugger
          debug.attach('1.3')
          await debug.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
          await debug.sendCommand('Page.bringToFront')
          for (const atEnd of [false, true]) {
            await verifyTiptapBackspace(run, until, (...args) => debug.sendCommand(...args), atEnd)
          }
          console.log('PASS Tiptap: Mermaid Backspace')
          continue
        }
        const initialSource = chunked ? await run('model().content') : ''
        await run('events.updates.length = 0')
        await run(`setFixture(${JSON.stringify(note)})`)

        await until(loaded, 'valid Mermaid fence loads as an image')
        if (!chunked) await until('document.querySelector("#chat img.looma-mermaid-image")?.naturalWidth > 0', 'AI response loads diagram')
        assert.deepEqual(await run(onlyDiagram), { mermaidSource: false, jsSource: true }, 'hide only Mermaid source')
        if (chunked) await until(`(() => {
          const diagram = document.querySelector('.looma-continuous-mermaid');
          return diagram.getBoundingClientRect().bottom <= diagram.nextElementSibling.getBoundingClientRect().top;
        })()`, 'diagram fits above the next line')
        assert.equal(await run('document.querySelectorAll("img.looma-mermaid-image").length'), chunked ? 1 : 2, 'ordinary code never renders as a diagram')
        assert.equal(await run('document.querySelectorAll("button[aria-label=\'展开图表\']").length'), chunked ? 1 : 2)
        const shells = chunked ? ['.looma-continuous-mermaid'] : ['#note .code-block-shell', '#chat .code-block-shell']
        win.webContents.debugger.attach('1.3')
        await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
        await win.webContents.debugger.sendCommand('Page.bringToFront')
        const mouse = args => win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', args)
        const plainGaps = await run(`(() => {
          const code = [...document.querySelectorAll('.code-block-body:not([hidden]), .looma-code-line')].filter(el => el.textContent.includes('const x = 1'));
          return code.map(el => el.matches('pre') ? parseFloat(getComputedStyle(el).paddingTop)
            : el.getBoundingClientRect().top - el.previousElementSibling.getBoundingClientRect().top);
        })()`)
        assert.equal(plainGaps.length, chunked ? 1 : 2)
        assert.ok(plainGaps.every(gap => gap < 20), `ordinary code has no reserved toolbar row: ${plainGaps}`)
        for (const selector of shells) {
          const layout = `(() => {
            const shell = document.querySelector(${JSON.stringify(selector)});
            const frame = shell.getBoundingClientRect();
            const image = shell.querySelector('img').getBoundingClientRect();
            return [frame.height, image.top - frame.top];
          })()`
          const controls = `(() => [...document.querySelector(${JSON.stringify(selector)}).querySelectorAll('.code-block-floating-copy, .looma-mermaid-expand')].map(el => {
            const style = getComputedStyle(el);
            return [style.opacity, style.pointerEvents];
          }))()`
          await mouse({ type: 'mouseMoved', x: 5, y: 850 })
          await until(`${controls}.every(([opacity, pointer]) => opacity === '0' && pointer === 'none')`, 'controls are hidden and not hit-testable off hover')
          const unhovered = await run(layout)
          assert.ok(unhovered[1] < 20, 'diagram has no reserved toolbar row')
          const button = await run(`(() => {
            const shell = document.querySelector(${JSON.stringify(selector)});
            const frame = shell.getBoundingClientRect();
            const copy = shell.querySelector('.code-block-floating-copy').getBoundingClientRect();
            const expand = shell.querySelector('button[aria-label="展开图表"]').getBoundingClientRect();
            window.expandTrigger = shell.querySelector('button[aria-label="展开图表"]');
            return { copy: copy.left - frame.left, expand: frame.right - expand.right, x: expand.x + expand.width / 2, y: expand.y + expand.height / 2, shellWidth: frame.width, positioning: getComputedStyle(shell).position };
          })()`)
          assert.ok(button.copy >= 0 && button.copy < 20, `copy is in the upper-left corner: ${selector} ${JSON.stringify(button)}`)
          assert.ok(button.expand >= 0 && button.expand < 20, `expand is in the upper-right corner: ${selector} ${JSON.stringify(button)}`)
          const { x, y } = button
          await mouse({ type: 'mouseMoved', x, y })
          await until(`${controls}.every(([opacity, pointer]) => opacity === '1' && pointer === 'auto')`, 'both floating controls appear on hover')
          assert.deepEqual(await run(layout), unhovered, 'hover does not move or resize the diagram')
          for (const type of ['mousePressed', 'mouseReleased']) await mouse({ type, x, y, button: 'left', clickCount: 1 })
          await until('document.querySelector(".mermaid-viewer[open] img")?.naturalWidth > 0', 'diagram opens in viewer')
          assert.ok(await run(`document.querySelector('.mermaid-viewer').matches(':modal')`))
          const geometry = `(() => {
            const canvas = document.querySelector('.mermaid-viewer-canvas').getBoundingClientRect();
            const image = document.querySelector('.mermaid-viewer img').getBoundingClientRect();
            return { x: canvas.x + canvas.width / 2, y: canvas.y + canvas.height / 2, left: image.left, top: image.top, width: image.width };
          })()`
          const before = await run(geometry)
          await mouse({ type: 'mouseWheel', x: before.x, y: before.y, deltaY: -240, deltaX: 0 })
          await until(`${geometry}.width > ${before.width}`, 'wheel zooms the image')
          const zoomed = await run(geometry)
          assert.ok(Math.abs((before.left - before.x) / before.width - (zoomed.left - zoomed.x) / zoomed.width) < 0.01, 'wheel zoom anchors at the pointer')
          await mouse({ type: 'mousePressed', x: zoomed.x, y: zoomed.y, button: 'left', clickCount: 1 })
          await until('document.querySelector(".mermaid-viewer-canvas").classList.contains("is-dragging")', 'pointer starts a drag')
          await mouse({ type: 'mouseMoved', x: zoomed.x + 70, y: zoomed.y + 40, buttons: 1 })
          await until(`${geometry}.left > ${zoomed.left + 60} && ${geometry}.top > ${zoomed.top + 30}`, 'drag pans the image')
          await mouse({ type: 'mouseReleased', x: zoomed.x + 70, y: zoomed.y + 40, button: 'left', clickCount: 1 })
          await run(`document.querySelector('button[aria-label="适应画布"]').click()`)
          await until(`Math.abs(${geometry}.width - ${before.width}) < 1 && Math.abs(${geometry}.left - ${before.left}) < 1`, 'fit restores the initial size and position')
          await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
          await until('!document.querySelector(".mermaid-viewer[open]") && document.activeElement === expandTrigger', 'Escape closes and restores focus')
        }
        const source = chunked ? 'model().content' : 'editor().getMarkdown()'
        assert.equal((await run(source)).trim(), note)
        // setFixture flushes the old model before replacing its content.
        const updates = await run('events.updates')
        assert.ok(updates.length === 0 || (chunked && updates.length === 1 && updates[0] === initialSource), 'no document update from rendering')
        assert.deepEqual(await run('[events.saves.length, events.edits ?? events.pending]'), [0, 0])
        await run(`setFixture(${JSON.stringify(invalid)})`)
        await until('document.querySelector(".looma-mermaid-preview")?.textContent.includes("无法渲染图表")', 'invalid Mermaid fence shows fallback')
        assert.deepEqual(await run(onlyDiagram), { mermaidSource: false, jsSource: true }, 'invalid syntax must not reveal source')
        assert.equal(await run('document.querySelector("img.looma-mermaid-image")'), null)
        assert.equal(await run('document.querySelector("button[aria-label=\'展开图表\']")'), null)
        assert.equal((await run(source)).trim(), invalid)
        await run(`setFixture(${JSON.stringify(note)})`)
        await until(loaded, 'fixing the source restores the image')
        if (chunked) {
          await run('document.querySelector(\'button[title="分割视图"]\').click()')
          await until('document.querySelector(".chunked-source-only .cm-content")?.textContent.includes("flowchart LR")', 'source is visible in the left pane')
          await until(loaded, 'right pane still renders the diagram')
          assert.equal(await run('document.querySelectorAll(".chunked-source-only .looma-mermaid-preview").length'), 0)
          assert.equal(await run('model().content'), note)
        }

        console.log(`PASS ${chunked ? 'continuous editor' : 'Tiptap and AI'}: diagram only, intact source, invalid syntax and recovery`)
      } finally { win.destroy() }
    }
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  } finally { fs.rmSync(profile, { recursive: true, force: true }) }
  app.exit(process.exitCode || 0)
})
