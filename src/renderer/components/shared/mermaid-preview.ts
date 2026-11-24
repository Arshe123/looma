import { h, render } from 'vue'
import MermaidViewer from './MermaidViewer.vue'
import './mermaid-preview.css'

export const MERMAID_SOURCE_LIMIT = 12_000
export const isMermaidLanguage = (language: unknown) => typeof language === 'string' && language.trim().toLowerCase() === 'mermaid'

let engine: Promise<typeof import('mermaid')['default']> | undefined
let nextId = 0

function loadEngine() {
  return engine ??= import('mermaid').then(({ default: mermaid }) => {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      htmlLabels: false,
      suppressErrorRendering: true,
      maxTextSize: MERMAID_SOURCE_LIMIT,
      maxEdges: 300,
      theme: 'neutral',
    })
    return mermaid
  })
}

function attachExpandButton(host: HTMLElement, image: HTMLImageElement) {
  const doc = host.ownerDocument
  const trigger = doc.createElement('button')
  trigger.type = 'button'
  trigger.className = 'looma-mermaid-expand'
  trigger.title = '展开图表'
  trigger.setAttribute('aria-label', trigger.title)
  trigger.setAttribute('aria-haspopup', 'dialog')
  const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('aria-hidden', 'true')
  const path = doc.createElementNS(svg.namespaceURI, 'path')
  path.setAttribute('d', 'M15 3h6v6m0-6-7 7M9 21H3v-6m0 6 7-7')
  svg.append(path)
  trigger.append(svg)
  let viewer: HTMLElement | undefined
  const close = () => {
    if (!viewer) return
    const container = viewer
    viewer = undefined
    // Preview cleanup can run inside a CodeMirror update.
    queueMicrotask(() => { render(null, container); container.remove() })
  }
  trigger.addEventListener('mousedown', event => event.preventDefault())
  trigger.addEventListener('click', event => {
    event.stopPropagation()
    if (viewer || !image.naturalWidth || !image.naturalHeight) return
    trigger.focus({ preventScroll: true })
    viewer = doc.createElement('div')
    doc.body.append(viewer)
    render(h(MermaidViewer, {
      src: image.src,
      width: image.naturalWidth,
      height: image.naturalHeight,
      onClose: close,
    }), viewer)
  })
  host.append(trigger)
  return close
}

/** Mount presentation only, outside the editable/copyable code. */
export function mountMermaidPreview(host: HTMLElement, source: string | null, onResize?: () => void) {
  let cancelled = false
  let url: string | undefined
  let closeViewer: (() => void) | undefined
  const status = host.ownerDocument.createElement('span')
  status.setAttribute('role', 'status')
  host.hidden = true
  const showStatus = (message: string) => {
    status.textContent = message
    host.replaceChildren(status)
    host.hidden = false
    onResize?.()
  }
  const timer = setTimeout(async () => {
    if (!host.isConnected) return
    if (source === null || source.length > MERMAID_SOURCE_LIMIT) {
      showStatus('图表过长，已保留源码。')
      return
    }
    if (!source.trim()) {
      showStatus('图表内容为空。')
      return
    }
    try {
      // Keep note-provided configuration out of the renderer. The code itself
      // is not modified; it remains editable and can still be copied as-is.
      if (/^\s*---[\t ]*\r?\n/.test(source) || /%%\{/.test(source)) throw new Error('Diagram configuration disabled')
      const mermaid = await loadEngine()
      if (cancelled || !host.isConnected) return
      const id = `looma-diagram-${++nextId}`
      let svg: string
      try {
        ({ svg } = await mermaid.render(id, source))
      } finally {
        // Some diagram-specific failures leave Mermaid's temporary DOM behind.
        host.ownerDocument.getElementById(`d${id}`)?.remove()
      }
      if (cancelled || !host.isConnected) return
      const image = host.ownerDocument.createElement('img')
      image.className = 'looma-mermaid-image'
      image.alt = 'Mermaid 图表'
      image.draggable = false
      image.addEventListener('load', () => {
        if (cancelled) return
        closeViewer = attachExpandButton(host, image)
        onResize?.()
      }, { once: true })
      image.addEventListener('error', () => {
        if (!cancelled) showStatus('无法渲染图表，已保留源码。')
      }, { once: true })
      // SVG is loaded in image mode, not installed as live DOM. Do not bind
      // Mermaid callbacks or enable diagram links in notes or AI responses.
      url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
      image.src = url
      host.replaceChildren(image)
      host.hidden = false
      onResize?.()
    } catch {
      if (!cancelled && host.isConnected) showStatus('无法渲染图表，已保留源码。')
    }
  }, 160)
  return () => {
    cancelled = true
    clearTimeout(timer)
    closeViewer?.()
    if (url) URL.revokeObjectURL(url)
    host.replaceChildren()
    host.hidden = true
  }
}
