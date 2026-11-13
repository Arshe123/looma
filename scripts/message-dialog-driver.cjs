// Observe production self-drawn dialogs and answer through their real DOM buttons.
// No renderer service, IPC, or filesystem is mocked. Callers own the response policy.
module.exports = function watchMessageDialogs(contents, onDialog) {
  let reading = false
  let lastId = null
  const timer = setInterval(async () => {
    if (reading || contents.isDestroyed() || contents.isLoadingMainFrame()) return
    reading = true
    try {
      const request = await contents.executeJavaScript(`(() => {
        const current = document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia?._s.get('messageDialog')?.current;
        const dialog = [...document.querySelectorAll('[data-message-dialog] [role="alertdialog"]')].at(-1);
        if (!current || dialog?.getAttribute('aria-label') !== current.options.title) return null;
        return {id:current.id, options:current.options};
      })()`)
      if (request && request.id !== lastId) {
        lastId = request.id
        await onDialog({
          ...request,
          answer: response => contents.executeJavaScript(`(() => {
            const current = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('messageDialog').current;
            if (current?.id !== ${JSON.stringify(request.id)}) throw new Error('Dialog request expired');
            const button = [...document.querySelectorAll('[data-message-dialog]')].at(-1)?.querySelector('[data-message-dialog-response="${Number(response)}"]');
            if (!button) throw new Error('Dialog response button missing');
            button.click();
          })()`),
        })
      }
    } catch (error) {
      // Navigation/destruction can invalidate an in-flight observation, not a test response.
      if (!contents.isDestroyed() && !contents.isLoadingMainFrame()) console.error('Message dialog driver:', error)
    } finally { reading = false }
  }, 25)
  const reset = () => { lastId = null }
  const stop = () => { clearInterval(timer) }
  contents.on('did-start-loading', reset)
  contents.once('destroyed', stop)
  return stop
}
