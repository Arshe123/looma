// Run with Vite test mode on 5189. Real MainContent/EditorTabs and CSS,
// memory-only documents/IPC and an isolated profile; never touches user notes.
const { app, BrowserWindow } = require('electron')
const watchMessageDialogs = require('./message-dialog-driver.cjs')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const profile = fs.mkdtempSync(path.join(process.env.TMPDIR, 'looma-tab-close-'))
app.setPath('userData', profile)
app.setPath('sessionData', profile)
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1100, height: 850, show: false, webPreferences: { backgroundThrottling: false } })
  const run = code => win.webContents.executeJavaScript(code)
  try {
    await win.loadURL('http://127.0.0.1:5189/scripts/test/note-ref-navigation.html')
    win.webContents.debugger.attach('1.3')
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
    for (let i = 0; i < 100 && !await run('window.ready?.()'); i++) await wait(100)
    assert.ok(await run('window.ready?.()'), 'real editor mounted')
    await run(`(async () => {
      const vueUrl = performance.getEntriesByType('resource').find(entry => new URL(entry.name).pathname.endsWith('/vue.js')).name;
      const { h, render } = await import(vueUrl);
      const { default: DialogHost } = await import('/src/renderer/components/ConfirmationDialog.vue');
      const host = document.createElement('div'); document.body.append(host);
      const vnode = h(DialogHost); vnode.appContext = document.querySelector('#app').__vue_app__._context;
      render(vnode, host);
    })()`)
    await run(`
      window.electronAPI.workspaceMeta = { set: async () => ({ success: true }) };
      window.electronAPI.externalDocuments = { close: async () => {} };
      window.dialogResponse = 2;
      window.dialogs = 0;
      window.externalStore = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('externalDocuments');
      void 0;
    `)
    watchMessageDialogs(win.webContents, async request => {
      const response = await run('dialogs++; dialogResponse')
      if (response !== null) await request.answer(response)
    })
    const seed = async (name, count) => {
      const content = '# Test\n\n' + 'Body paragraph with ordinary text.\n\n'.repeat(count)
      await run(`(() => {
        const name = ${JSON.stringify(name)}, content = ${JSON.stringify(content)};
        files[name] = content;
        store.openedTextFileContents[name] = { content, loadedContent: content, isLoading: false, isPartial: false, isLoadingMore: false, loadRequestId: ${count} };
        store.openFileTab(name);
      })()`)
      for (let i = 0; i < 100 && !await run(`document.querySelector('.tiptap')?.querySelectorAll('p').length >= ${count}`); i++) await wait(100)
      assert.ok(await run(`document.querySelector('.tiptap')?.querySelectorAll('p').length >= ${count}`), 'long fixture rendered as actual paragraphs')
      await run('document.fonts.ready')
      await wait(350)
    }
    const closeAtFrame = async (id, confirming = false) => {
      const result = await run(`new Promise(resolve => {
        const tab = document.querySelector('[data-document-tab=' + ${JSON.stringify(JSON.stringify(id))} + ']');
        const siblings = [...tab.parentElement.children].filter(el => el !== tab && el.dataset.documentTab);
        const start = performance.now();
        ${confirming ? "document.querySelector('[data-message-dialog-response=\"1\"]').click();" : "tab.querySelector('button').click();"}
        const handlerMs = performance.now() - start;
        requestAnimationFrame(() => resolve({
          handlerMs, frameMs: performance.now() - start, removed: !tab.isConnected,
          siblingsStable: siblings.every(el => el.isConnected && document.querySelector('[data-document-tab=' + JSON.stringify(el.dataset.documentTab) + ']') === el),
        }));
      })`)
      console.log('CLOSE', id, JSON.stringify(result))
      assert.equal(result.removed, true, 'closed tab must disappear by the first frame, not wait for hover color transition')
      assert.equal(result.siblingsStable, true, 'remaining tab nodes must not remount')
    }
    for (const count of [100, 1500]) {
      await seed(`close-${count}.md`, count)
      await closeAtFrame(`file:close-${count}.md`)
    }
    // Background/system/external tabs share the same transition group.
    await run("store.openSystemTab('help'); store.activateTab('file:old/deep/prior.md')")
    await wait(350)
    const systemId = await run("store.tabs.find(tab => tab.kind === 'system' && tab.page === 'help').id")
    await closeAtFrame(systemId)
    await run("externalStore.open({id:'external:close',filePath:'/outside/close.md',content:'',baseContent:''});void 0")
    await wait(350)
    await closeAtFrame('external:close')
    // Cancellation must keep the exact dirty tab, rather than optimistically removing it.
    await seed('dirty.md', 2)
    await run("store.openedTextFileContents['dirty.md'].content += 'unsaved'; void 0")
    await wait(50)
    await run("document.querySelector('[data-document-tab=\"file:dirty.md\"] button').click()")
    await wait(100)
    assert.equal(await run('dialogs'), 1)
    assert.equal(await run("!!document.querySelector('[data-document-tab=\"file:dirty.md\"]')"), true)
    assert.equal(await run("store.isFileDirty('dirty.md')"), true)
    await run('dialogResponse = null; document.querySelector(\'[data-document-tab="file:dirty.md"] button\').click()')
    for (let i = 0; i < 100 && !await run('!!document.querySelector("[data-message-dialog-response]")'); i++) await wait(20)
    assert.equal(await run('!!document.querySelector("[data-message-dialog-response]")'), true, 'discard waits for actual confirmation')
    // Measure from the user's discard choice, not the earlier request to close.
    await closeAtFrame('file:dirty.md', true)
    // Drag FLIP and ordinary hover colors are intentionally retained.
    for (const name of ['drag-a.md', 'drag-b.md', 'drag-c.md']) await seed(name, 1)
    const move = await run(`new Promise(resolve => {
      const source = document.querySelector('[data-document-tab="file:drag-a.md"]');
      const target = document.querySelector('[data-document-tab="file:drag-c.md"]');
      const container = source.parentElement, rect = container.getBoundingClientRect(), dt = new DataTransfer();
      const x = rect.left - container.scrollLeft + target.offsetLeft + target.offsetWidth / 2 + 1;
      source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
      container.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x }));
      requestAnimationFrame(() => resolve({ moving: !!container.querySelector('.editor-tab-move'), hoverProperty: getComputedStyle(source).transitionProperty }));
    })`)
    assert.equal(move.moving, true, 'drag reorder still uses FLIP move animation')
    assert.ok(move.hoverProperty.includes('color'), 'color transition retained')
    await run("document.querySelector('[data-document-tab=\"file:drag-a.md\"]').dispatchEvent(new DragEvent('dragend', {bubbles:true}))")
    await wait(250)
    assert.equal(await run("[...document.querySelectorAll('[data-document-tab]')].some(el => el.style.transform)"), false)
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    })
    await seed('reduced-motion.md', 1)
    await closeAtFrame('file:reduced-motion.md')
    console.log('PASS first-frame removal, stable siblings, real 100/1500-paragraph editors, system/external tabs, dirty cancel/discard, drag animation, reduced motion')
    win.destroy()
    fs.rmSync(profile, { recursive: true, force: true })
    app.exit(0)
  } catch (error) {
    console.error(error)
    win.destroy()
    fs.rmSync(profile, { recursive: true, force: true })
    app.exit(1)
  }
})
