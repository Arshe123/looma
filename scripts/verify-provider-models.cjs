// Start: npx vite --mode test --host 127.0.0.1 --port 5193 --strictPort
// Then: npx electron scripts/verify-provider-models.cjs
const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const profile = mkdtempSync(join(tmpdir(), 'looma-model-discovery-'))
app.setPath('userData', profile)
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1100, height: 1000, webPreferences: { backgroundThrottling: false } })
  const run = code => win.webContents.executeJavaScript(code)
  const until = async expression => {
    for (let i = 0; i < 100; i++) { if (await run(expression)) return; await wait(50) }
    throw new Error(`Condition did not become true: ${expression}`)
  }
  try {
    await win.loadURL('http://127.0.0.1:5193/scripts/test/provider-models.html')
    await until('window.ready && document.body.textContent.includes("找到 2 个模型")')
    assert.deepEqual(await run('requests'), [{ url: 'https://api.deepseek.com/v1/models', method: 'GET' }])
    await run('clickText("saved-model")')
    await until('document.body.textContent.includes("fixture-new-model")')
    assert.ok(await run('document.body.textContent.includes("saved-model")'), 'saved selection is preserved')
    await run('clickText("fixture-new-model")')
    await until('store.aiSettings.chat.model === "fixture-new-model"')
    await wait(100)
    assert.equal(await run('requests.length'), 1, 'selecting model must not refetch')
    console.log('PASS automatic fetch, API options, selected model preservation, selection persistence, no redundant fetch')

    await run('mode="error";clickText("刷新模型列表")')
    await until('document.querySelector("[role=alert]")?.textContent.includes("API 密钥无效")')
    await run('clickText("fixture-new-model")')
    await until('document.body.textContent.includes("fixture-other-model")')
    assert.equal(await run('store.aiSettings.chat.model'), 'fixture-new-model')
    await run('clickText("fixture-other-model")')
    await until('store.aiSettings.chat.model === "fixture-other-model"')
    console.log('PASS refresh errors in Chinese; previous list and selection remain usable')

    await run('mode="empty";clickText("刷新模型列表")')
    await until('document.body.textContent.includes("接口未返回可用模型")')
    await run('clickText("fixture-other-model")')
    await until("document.querySelector('input[placeholder=\"搜索模型，或输入自定义模型名...\"]') !== null")
    await run(`(() => { const input=document.querySelector('input[placeholder="搜索模型，或输入自定义模型名..."]');input.value='manual-model';input.dispatchEvent(new Event('input',{bubbles:true})); })()`)
    await run('tick()')
    await run('clickText("使用当前名称")')
    await until('store.aiSettings.chat.model === "manual-model"')
    console.log('PASS empty list handling and custom model selection')

    const switchProvider = async provider => {
      await run(`(() => { const select=document.querySelectorAll('select')[1];select.value=${JSON.stringify(provider)};select.dispatchEvent(new Event('change',{bubbles:true})); })()`)
      await until(`store.aiSettings.chat.provider === ${JSON.stringify(provider)}`)
    }
    const endpoints = {
      openai: 'https://api.openai.com/v1/models',
      qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1/models',
      custom: 'https://compatible.example.test/v1/models',
    }
    await run('mode="success"')
    for (const [provider, endpoint] of Object.entries(endpoints)) {
      const before = await run('requests.length')
      await switchProvider(provider)
      await until('document.body.textContent.includes("找到 1 个模型")')
      assert.equal(await run('requests.length'), before + 1)
      assert.equal(await run('requests.at(-1).url'), endpoint)
      await run(`clickText('${provider}-saved-model')`)
      await until(`document.body.textContent.includes('fixture-${provider}-model')`)
      assert.ok(await run('!document.body.textContent.includes("fixture-new-model")'), 'old provider list cleared')
      await run(`clickText('fixture-${provider}-model')`)
      await until(`store.aiSettings.chat.model === 'fixture-${provider}-model'`)
      await wait(100)
      assert.equal(await run('requests.length'), before + 1, 'selection must not refetch')
      await run('clickText("刷新模型列表")')
      await until(`requests.length === ${before + 2} && document.body.textContent.includes('找到 1 个模型')`)
      console.log(`PASS ${provider}: configured endpoint, auto-fetch, selection, refresh, no stale list`)
    }
    await run('mode="unsupported";clickText("刷新模型列表")')
    await until('document.querySelector("[role=alert]")?.textContent.includes("未找到模型列表接口")')
    assert.equal(await run('store.aiSettings.chat.model'), 'fixture-custom-model')
    const beforeMissingKey = await run('requests.length')
    await run(`(() => { const input=document.querySelector('input[type=password]');input.value='';input.dispatchEvent(new Event('change',{bubbles:true})); })()`)
    await until('store.aiSettings.chat.apiKey === ""')
    await wait(100)
    assert.equal(await run('requests.length'), beforeMissingKey, 'missing key must not fetch')
    assert.ok(await run('[...document.querySelectorAll("button")].find(b => b.textContent.includes("刷新模型列表")).disabled'))
    await switchProvider('ollama')
    await until('localRequests.length > 0')
    assert.ok(await run('!document.body.textContent.includes("刷新模型列表")'))
    assert.equal(await run('requests.length'), beforeMissingKey, 'Ollama still uses existing IPC')
    console.log('PASS unsupported endpoint, missing key, Ollama local path preserved')
    win.destroy(); app.quit()
  } catch (error) { console.error(error); app.exit(1) }
}).finally(() => { rmSync(profile, { recursive: true, force: true }) })
