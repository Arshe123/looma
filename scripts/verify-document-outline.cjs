// Called by verify-open-with.cjs against real production windows and temporary files.
const fs = require('node:fs/promises')
const path = require('node:path')
const assert = require('node:assert/strict')

module.exports = async function verifyDocumentOutline({ win, root, app, until, wait, workspace = false, dialogs, setResponse }) {
  const run = code => win.webContents.executeJavaScript(code)
  const tag = workspace ? 'Workspace' : 'Editor'
  let file = path.join(root, `${tag}-outline.md`)
  let empty = path.join(root, `${tag}-empty.md`)
  await fs.writeFile(file, '# Outline root\n\n## Section\n\n' + 'Long paragraph for scrolling.\n\n'.repeat(140) + '## Jump destination\n\nLast body\n')
  await fs.writeFile(empty, '没有标题的正文')
  file = await fs.realpath(file)
  empty = await fs.realpath(empty)
  const ws = `document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('workspace')`
  if (workspace) {
    // Setup a real system tab; all ordering below still uses DOM drag handlers.
    await run(`${ws}.openSystemTab('help')`)
    await run(`document.querySelector('[title="打开大纲"]')?.click()`)
  }
  app.emit('open-file', { preventDefault() {} }, file)
  const active = `Array.from(document.querySelectorAll('[data-external-document]')).find(el => el.style.display !== 'none')`
  const outline = `document.querySelector('.auxiliary-panel')`
  await until(async () => await run(`${outline}?.innerText.includes('Jump destination')`), `${tag} external outline`)
  assert.equal(await run(`${outline}.innerText.includes('AI 助手')`), false)
  if (!workspace) {
    assert.equal(await run(`getComputedStyle(${outline}).position`), 'relative')
    const [w, h] = win.getSize()
    win.setSize(950, h)
    await wait(200)
    assert.equal(await run(`getComputedStyle(${outline}).position`), 'relative', 'editor-only outline must remain in layout at narrow widths')
    assert.equal(await run(`${ws}.activeWorkspaceId`), null, 'no workspace restoration in pure editor')
    await run(`(() => {
      const handle = ${outline}.querySelector('[title="拖动调整辅助面板宽度"]');
      const x = handle.getBoundingClientRect().x;
      handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: x }));
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: x - 1000 }));
      window.dispatchEvent(new PointerEvent('pointerup'));
    })()`)
    await wait(100)
    assert.ok(await run(`document.querySelector('.workspace-document').getBoundingClientRect().width >= 360`), 'resident resizer reserves document width')
    assert.ok(await run(`Number(localStorage.getItem('looma.auxiliaryWidth')) <= 562`), 'resized width persisted')
    // Restore the same handle to its ordinary width for editor-mode checks.
    await run(`(() => {
      const handle = ${outline}.querySelector('[title="拖动调整辅助面板宽度"]');
      const x = handle.getBoundingClientRect().x;
      const width = ${outline}.getBoundingClientRect().width;
      handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: x }));
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: x + width - 360 }));
      window.dispatchEvent(new PointerEvent('pointerup'));
    })()`)
    win.setSize(w, h)
  }
  if (!win.webContents.debugger.isAttached()) win.webContents.debugger.attach('1.3')
  await wait(400) // Editor initial focus and fonts must settle before selection.
  await run(`(() => { const h = ${active}.querySelector('.tiptap h1'); const r = document.createRange(); r.selectNodeContents(h); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r); h.closest('.tiptap').focus(); })()`)
  await win.webContents.debugger.sendCommand('Input.insertText', { text: ' live edit' })
  await until(async () => await run(`${outline}.innerText.includes('Outline root live edit')`), 'live edited heading')
  const clickHeading = text => run(`Array.from(${outline}.querySelectorAll('button')).find(b => b.textContent.trim() === ${JSON.stringify(text)}).click()`)
  for (const [mode, selectors] of [
    ['预览模式', ['.tiptap-preview-container']],
    ['编辑模式', ['.cm-scroller']],
    ['分割视图', ['.cm-scroller', '.tiptap-preview-container']],
  ]) {
    await run(`${active}.querySelector('[title="${mode}"]')?.click()`)
    await until(async () => await run(`${JSON.stringify(selectors)}.every(s => !!${active}.querySelector(s))`), `${mode} mounted`)
    await wait(400)
    await clickHeading('Section')
    await wait(350)
    await clickHeading('Jump destination')
    await until(async () => await run(`${JSON.stringify(selectors)}.every(s => ${active}.querySelector(s).scrollTop > 1000)`), `${tag} ${mode} actual outline scrolling`)
  }
  // Save collapse only on this external document, then switch away and back.
  await run(`${outline}.querySelector('[title="Outline root live edit"] button').click()`)
  await until(async () => await run(`!${outline}.innerText.includes('Jump destination')`), 'collapsed root')
  app.emit('open-file', { preventDefault() {} }, empty)
  await until(async () => await run(`${outline}.innerText.includes('当前 Markdown 文件暂无标题。')`), 'Chinese empty heading state')
  app.emit('open-file', { preventDefault() {} }, file)
  await until(async () => await run(`${outline}.innerText.includes('Outline root live edit') && !${outline}.innerText.includes('Jump destination')`), 'external expansion restored')
  await run(`${outline}.querySelector('[title="Outline root live edit"] button').click()`)
  await until(async () => await run(`${outline}.innerText.includes('Jump destination')`), 'root expanded')
  const titles = () => run(`Array.from(document.querySelectorAll('[data-document-tab]')).map(el => el.title)`)
  const drag = async (from, to, animated = true) => {
    await run(`(() => {
      const els = Array.from(document.querySelectorAll('[data-document-tab]'));
      const source = els[${from}], target = els[${to}], container = source.parentElement;
      const dt = new DataTransfer(), rect = container.getBoundingClientRect();
      const x = rect.left - container.scrollLeft + target.offsetLeft + target.offsetWidth / 2 + (${to} > ${from} ? 1 : -1);
      const y = rect.top + rect.height / 2;
      window.__tabDragProbe = { source, target, container, dt, x, y };
      source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
      target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }));
    })()`)
    if (from !== to) {
      const moving = await run(`new Promise(resolve => requestAnimationFrame(() => {
        const tabs = Array.from(document.querySelectorAll('[data-document-tab]'));
        resolve(tabs.some(el => el.getAnimations().some(animation => animation.transitionProperty === 'transform')));
      }))`)
      assert.equal(moving, animated, `${tag} reorder uses transform animation unless reduced motion is enabled`)
    }
    const stable = await run(`(async () => {
      const { source, target, container, dt, x, y } = window.__tabDragProbe;
      const order = () => Array.from(container.children).map(el => el.dataset.documentTab).join('|');
      const expected = order();
      let stable = true;
      for (let frame = 0; frame < 20; frame++) {
        await new Promise(requestAnimationFrame);
        // Alternate actual hit testing with the displaced node, as native drag
        // events may still target it while its FLIP transform is in flight.
        const hit = frame % 2 ? document.elementFromPoint(x, y) || container : target;
        hit.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }));
        await Promise.resolve();
        if (order() !== expected) stable = false;
      }
      source.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
      delete window.__tabDragProbe;
      return stable;
    })()`)
    assert.equal(stable, true, 'stationary pointer never reverses ordering during or after animation')
    assert.equal(await run(`Array.from(document.querySelectorAll('[data-document-tab]')).every(el => getComputedStyle(el).transform === 'none')`), true, 'tabs settle without residual transforms')
  }
  let before = await titles()
  await drag(before.indexOf(file), 0)
  let expected = [file, ...before.filter(t => t !== file)]
  assert.deepEqual(await titles(), expected, 'external dragged across ordinary/external tabs')
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  await drag(0, 1, false)
  await drag(1, 0, false)
  assert.deepEqual(await titles(), expected, 'reduced motion preserves sorting')
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] })
  if (workspace) {
    const normalIndex = expected.indexOf('inside.md')
    assert.ok(normalIndex > 0)
    await drag(normalIndex, 0)
    expected = ['inside.md', ...expected.filter(t => t !== 'inside.md')]
    assert.deepEqual(await titles(), expected, 'normal dragged across external tab')
    const systemTitle = await run(`Array.from(document.querySelectorAll('[data-document-tab]')).find(el => el.dataset.documentTab.includes('help')).title`)
    await drag(expected.indexOf(systemTitle), 0)
    expected = [systemTitle, ...expected.filter(t => t !== systemTitle)]
    assert.deepEqual(await titles(), expected, 'system tab dragged through external tabs')
    const ordinaryIds = await run(`Array.from(document.querySelectorAll('[data-document-tab]')).filter(el => !el.classList.contains('external-document-tab')).map(el => el.dataset.documentTab)`)
    await until(async () => {
      const metadata = JSON.parse(await fs.readFile(path.join(root, 'workspace', '.looma', 'workspace.json'), 'utf8'))
      return JSON.stringify(metadata.tabs.map(t => t.id)) === JSON.stringify(ordinaryIds)
    }, 'ordinary visual relative order persisted')
    const metadataText = await fs.readFile(path.join(root, 'workspace', '.looma', 'workspace.json'), 'utf8')
    const externalIds = await run(`Array.from(document.querySelectorAll('.external-document-tab')).map(el => el.dataset.documentTab)`)
    for (const id of externalIds) assert.ok(!metadataText.includes(id), 'external identity excluded from all metadata')
    assert.ok(!metadataText.includes(file) && !metadataText.includes(empty))
    await run(`document.querySelector('[data-document-tab][title="inside.md"]').click()`)
    await until(async () => await run(`!!document.querySelector('.tiptap-preview-container')`), 'normal retained editor')
    await until(async () => await run(`${outline}.innerText.includes('Workspace file') && !${outline}.innerText.includes('Outline root')`), 'normal outline restored')
    // A global heading event must not scroll the retained ordinary editor.
    await run(`document.querySelector('.tiptap-preview-container').scrollTop = 0`)
    app.emit('open-file', { preventDefault() {} }, file)
    await until(async () => await run(`${outline}.innerText.includes('Jump destination')`), 'external outline restored')
    await clickHeading('Jump destination')
    await wait(300)
    assert.equal(await run(`Array.from(document.querySelectorAll('.tiptap-preview-container')).filter(el => !el.closest('[data-external-document]')).every(el => el.scrollTop === 0)`), true, 'no stale workspace editor jump')
  }
  before = await titles()
  await drag(before.indexOf(empty), before.indexOf(file))
  expected = [...before]
  expected.splice(expected.indexOf(empty), 1)
  expected.splice(before.indexOf(file), 0, empty)
  assert.deepEqual(await titles(), expected, 'external-only relative sorting')
  await until(async () => (await fs.readFile(file, 'utf8')).includes('live edit'), 'outline fixture saved')
  // Close-left/right/others must use exactly the mixed DOM order and stop at cancel.
  await fs.writeFile(file, '# Changed for cancel')
  await run(`${active}.querySelector('.cm-content').focus()`)
  await win.webContents.debugger.sendCommand('Input.insertText', { text: 'cancel dirty' })
  await until(async () => await run(`!!${active}.querySelector('[role="alert"]')`), 'dirty conflict retained')
  setResponse(2)
  for (const mode of ['关闭左侧标签页', '关闭其他标签页', '关闭右侧标签页']) {
    let order = await titles()
    await drag(order.indexOf(file), 0)
    order = await titles()
    await drag(order.indexOf(empty), mode === '关闭右侧标签页' ? 0 : 1)
    const snapshot = await titles()
    const count = dialogs.length
    await run(`Array.from(document.querySelectorAll('[data-document-tab]')).find(el => el.title === ${JSON.stringify(empty)}).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 200, clientY: 80 }))`)
    await run(`Array.from(document.querySelectorAll('button')).find(el => el.textContent.trim() === ${JSON.stringify(mode)}).click()`)
    await until(() => dialogs.length > count, `${mode} dirty confirmation`)
    await wait(100)
    assert.deepEqual(await titles(), snapshot, `${mode} cancel stops mixed batch`)
  }
  setResponse(1)
  for (const filename of [file, empty]) {
    await run(`Array.from(document.querySelectorAll('.external-document-tab')).find(el => el.title === ${JSON.stringify(filename)}).querySelector('button').click()`)
    await until(async () => !(await titles()).includes(filename), 'fixture tab closed')
  }
  if (workspace) await run(`${ws}.closeTab(${ws}.tabs.find(t => t.kind === 'system' && t.page === 'help').id)`)
  win.webContents.debugger.detach()
  console.log(`PASS ${tag}: ${workspace ? 'mixed/system drag DOM order and metadata isolation' : 'external drag DOM order and resident resizer'}, cancellable close-left/right/others, live outline, isolated expansion, Chinese empty state, rich/source/split click scrolling`)
}
