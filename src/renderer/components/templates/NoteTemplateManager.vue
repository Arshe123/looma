<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { ArrowLeft, FilePlus2, Plus, Save, Trash2, X } from 'lucide-vue-next'
import { renderMarkdown } from '@/shared/utils/markdown-renderer'
import 'github-markdown-css/github-markdown-light.css'
import {
  evaluateNoteTemplateExpression,
  normalizeMarkdownFilename,
  renderNoteTemplate,
  validateNoteTemplateInput,
} from '@/shared/utils/note-template'
import {
  getNoteTemplatesApi,
  type UiNoteTemplate,
  type UiNoteTemplateInput,
  type UiNoteTemplateStore,
  type UiNoteTemplateVariable,
} from './note-template-ui-types'

const props = defineProps<{ store: UiNoteTemplateStore }>()
const emit = defineEmits<{
  updated: [store: UiNoteTemplateStore]
  back: []
  close: []
}>()

type TemplateVariable = UiNoteTemplateVariable
type Draft = {
  name: string
  fileNameTemplate: string
  contentTemplate: string
  variables: TemplateVariable[]
}

const selectedId = ref<string | null>(null)
const isNew = ref(false)
const pending = ref(false)
const errorText = ref('')
const originalSnapshot = ref('')
const contentTextarea = ref<HTMLTextAreaElement | null>(null)
const previewNow = ref(new Date())
const refreshPreviewNow = () => { previewNow.value = new Date() }
let previewTimer: ReturnType<typeof setInterval> | undefined
const draft = reactive<Draft>({ name: '', fileNameTemplate: '', contentTemplate: '', variables: [] })
const reservedVariableNames = new Set(['now', 'upper', 'lower', 'trim', 'pad', 'replace', 'true', 'false'])
const noteTemplatesApi = getNoteTemplatesApi()

const expressionErrorText = (result: ReturnType<typeof evaluateNoteTemplateExpression>) => {
  if (!('error' in result)) return ''
  return `${result.error.message}（位置 ${result.error.position + 1}）`
}

const renderErrorText = (result: ReturnType<typeof renderNoteTemplate>) => {
  if (!('error' in result)) return ''
  return `${result.error.message}（位置 ${result.error.position + 1}）`
}

const renderResultText = (result: ReturnType<typeof renderNoteTemplate>) => {
  if ('value' in result) return result.value
  return renderErrorText(result)
}

const cloneVariable = (variable: TemplateVariable): TemplateVariable => ({ ...variable })
const snapshot = () => JSON.stringify({
  name: draft.name,
  fileNameTemplate: draft.fileNameTemplate,
  contentTemplate: draft.contentTemplate,
  variables: draft.variables,
})

const assignDraft = (value: Draft) => {
  draft.name = value.name
  draft.fileNameTemplate = value.fileNameTemplate
  draft.contentTemplate = value.contentTemplate
  draft.variables.splice(0, draft.variables.length, ...value.variables.map(cloneVariable))
}

const loadTemplate = (template: UiNoteTemplate) => {
  selectedId.value = template.id
  isNew.value = false
  errorText.value = ''
  assignDraft(template)
  originalSnapshot.value = snapshot()
}

const clearDraft = () => {
  selectedId.value = null
  isNew.value = false
  assignDraft({ name: '', fileNameTemplate: '', contentTemplate: '', variables: [] })
  originalSnapshot.value = snapshot()
}

const isDirty = computed(() => isNew.value || snapshot() !== originalSnapshot.value)

const confirmDiscard = async () => {
  if (!isDirty.value) return true
  const { response } = await window.electronAPI.app.showMessageBox({
    type: 'warning',
    buttons: ['保存', '放弃', '取消'],
    defaultId: 0,
    cancelId: 2,
    message: '有未保存的修改',
    detail: '离开前要保存当前模板吗？',
  })
  if (response === 0) return await save()
  return response === 1
}

defineExpose({ confirmDiscard })

const selectTemplate = async (template: UiNoteTemplate) => {
  if (template.id === selectedId.value) return
  if (!await confirmDiscard()) return
  loadTemplate(template)
}

const startNew = async () => {
  if (!await confirmDiscard()) return
  selectedId.value = null
  isNew.value = true
  errorText.value = ''
  assignDraft({ name: '未命名模板', fileNameTemplate: '未命名笔记', contentTemplate: '', variables: [] })
  originalSnapshot.value = ''
}

const makeVariableId = () => globalThis.crypto?.randomUUID?.() ?? `variable-${Date.now()}-${draft.variables.length}`
const addVariable = () => {
  draft.variables.push({
    id: makeVariableId(),
    name: `variable${draft.variables.length + 1}`,
    type: 'string',
    value: '',
    afterUseExpression: '',
  })
}
const removeVariable = (index: number) => draft.variables.splice(index, 1)

const normalizeVariableValue = (variable: TemplateVariable) => {
  if (variable.type === 'string') variable.value = String(variable.value ?? '')
  else if (variable.type === 'number') variable.value = Number(variable.value)
  else variable.value = Boolean(variable.value)
}

const variablesRecord = computed<Record<string, string | number | boolean>>(() =>
  Object.fromEntries(draft.variables.map(variable => [variable.name, variable.value])),
)

const nameError = computed(() => {
  const name = draft.name.trim()
  if (!name) return '模板名不能为空。'
  if (name.length > 100) return '模板名不能超过 100 个字符。'
  const duplicate = props.store.templates.some(template =>
    template.id !== selectedId.value && template.name.trim().toLocaleLowerCase() === name.toLocaleLowerCase(),
  )
  return duplicate ? '模板名已存在（不区分大小写）。' : ''
})

const variableErrors = computed(() => {
  const seen = new Set<string>()
  return draft.variables.map(variable => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable.name)) return '名称只能包含英文字母、数字和下划线，且不能以数字开头。'
    if (reservedVariableNames.has(variable.name)) return '不能使用内置函数或保留字作为变量名。'
    if (seen.has(variable.name)) return '变量名不能重复。'
    seen.add(variable.name)
    if (variable.type === 'number' && !Number.isFinite(Number(variable.value))) return '请输入有限数字。'
    if (variable.type === 'number' && Number.isInteger(Number(variable.value)) && !Number.isSafeInteger(Number(variable.value))) return '整数超出安全范围。'
    if (variable.afterUseExpression.trim()) {
      const evaluated = evaluateNoteTemplateExpression(variable.afterUseExpression, variablesRecord.value, previewNow.value)
      if (!evaluated.ok) return expressionErrorText(evaluated) || '使用后表达式有误。'
      if (typeof evaluated.value !== variable.type) return `表达式结果必须为${variable.type === 'string' ? '字符串' : variable.type === 'number' ? '数字' : '布尔值'}。`
    }
    return ''
  })
})

const filenamePreview = computed(() => {
  const rendered = renderNoteTemplate(draft.fileNameTemplate, variablesRecord.value, previewNow.value)
  return rendered.ok ? normalizeMarkdownFilename(rendered.value) : rendered
})
const contentPreview = computed(() => renderNoteTemplate(draft.contentTemplate, variablesRecord.value, previewNow.value))
const contentPreviewHtml = computed(() => {
  if (!contentPreview.value.ok) return ''
  const html = renderMarkdown(contentPreview.value.value)
  if (!html.includes('<img ')) return html
  // A template's contents are inert: no image can request an app-relative URL
  // before it is replaced. Global templates have no note directory to resolve.
  const fragment = document.createElement('template')
  fragment.innerHTML = html
  for (const image of fragment.content.querySelectorAll('img')) {
    const src = image.getAttribute('src') || ''
    if (/^https?:\/\//i.test(src) || /^data:image\/(?:png|gif|jpeg|webp);/i.test(src)) continue
    image.removeAttribute('src')
    const placeholder = document.createElement('span')
    placeholder.className = 'template-image-placeholder'
    placeholder.textContent = `${image.getAttribute('alt') || '图片'}：相对路径图片将在创建笔记后显示`
    image.replaceWith(placeholder)
  }
  return fragment.innerHTML
})
const previewFeedback = ref('')
watch(contentPreview, () => { previewFeedback.value = '' })
const handlePreviewClick = async (event: MouseEvent) => {
  const target = event.target
  if (!(target instanceof Element)) return
  const button = target.closest<HTMLButtonElement>('.code-block-floating-copy')
  const anchor = target.closest<HTMLAnchorElement>('a[href]')
  if (!button && !anchor) return
  event.preventDefault()
  event.stopPropagation()
  if (button) {
    const code = button.closest('.code-block-shell')?.querySelector('.code-block-content')
    if (!code) return
    try {
      await navigator.clipboard.writeText(code.textContent || '')
      previewFeedback.value = '代码已复制'
    } catch {
      previewFeedback.value = '复制失败，请重试'
    }
    return
  }
  const href = anchor?.getAttribute('href') || ''
  if (/^https?:\/\//i.test(href)) {
    try {
      await window.electronAPI.app.openExternal(href)
    } catch {
      previewFeedback.value = '打开链接失败，请重试'
    }
  } else if (!/^[a-z][a-z\d+.-]*:/i.test(href) && !href.startsWith('//')) {
    previewFeedback.value = '创建笔记后可打开内部链接'
  } else {
    previewFeedback.value = '预览不支持打开此类链接'
  }
}
const filenameError = computed(() => {
  if (!draft.fileNameTemplate.trim()) return '文件名模板不能为空。'
  if (draft.fileNameTemplate.length > 300) return '文件名模板不能超过 300 个字符。'
  return filenamePreview.value.ok ? '' : renderErrorText(filenamePreview.value) || '文件名表达式有误。'
})
const contentError = computed(() => {
  if (draft.contentTemplate.length > 1024 * 1024) return '文件内容不能超过 1 MiB。'
  return contentPreview.value.ok ? '' : renderErrorText(contentPreview.value) || '内容表达式有误。'
})
const draftInput = (): UiNoteTemplateInput => ({
  name: draft.name.trim(),
  fileNameTemplate: draft.fileNameTemplate,
  contentTemplate: draft.contentTemplate,
  variables: draft.variables.map(variable => ({ ...variable })),
})
const transitionError = computed(() => {
  if (nameError.value || filenameError.value || contentError.value || variableErrors.value.some(Boolean)) return ''
  const validated = validateNoteTemplateInput(draftInput(), previewNow.value)
  return validated.ok === false ? `${validated.error.message}（位置 ${validated.error.position + 1}）` : ''
})
const hasErrors = computed(() => Boolean(
  nameError.value || filenameError.value || contentError.value
  || variableErrors.value.some(Boolean) || transitionError.value,
))

const refreshStore = async () => {
  const listed = await noteTemplatesApi.list()
  if (!listed.success || !listed.data) throw new Error(listed.error || '刷新模板失败。')
  emit('updated', listed.data)
  return listed.data
}

const recoverFromStaleRevision = async () => {
  const staleId = selectedId.value
  const wasNew = isNew.value
  const refreshed = await refreshStore()
  await nextTick()
  if (!wasNew && staleId) {
    const latest = refreshed.templates.find(template => template.id === staleId)
    if (latest) loadTemplate(latest)
    else clearDraft()
    errorText.value = latest
      ? '模板已在其他窗口更新，已加载最新版本；本次修改未保存。'
      : '模板已在其他窗口删除；本次修改未保存。'
    return
  }
  errorText.value = '模板列表已在其他窗口更新，请检查后再次保存。'
}

async function save(): Promise<boolean> {
  if (pending.value || hasErrors.value) return false
  pending.value = true
  errorText.value = ''
  const input = draftInput()
  try {
    const result = isNew.value
      ? await noteTemplatesApi.create(input, props.store.revision)
      : await noteTemplatesApi.update(selectedId.value!, input, props.store.revision)
    if (!result.success) {
      errorText.value = result.error || '保存模板失败。'
      if (result.errorCode === 'TEMPLATE_STALE') await recoverFromStaleRevision()
      return false
    }
    const nextStore = result.data?.templates ? result.data : await refreshStore()
    emit('updated', nextStore)
    const saved = isNew.value
      ? nextStore.templates.at(-1)
      : nextStore.templates.find(template => template.id === selectedId.value)
    if (saved) loadTemplate(saved)
    return true
  } catch (error) {
    errorText.value = error instanceof Error ? error.message : '保存模板失败。'
    return false
  } finally {
    pending.value = false
  }
}

const removeSelected = async () => {
  if (!selectedId.value || pending.value) return
  const current = props.store.templates.find(template => template.id === selectedId.value)
  if (!current || !window.confirm(`确定删除模板“${current.name}”吗？已创建的文件不会受到影响。`)) return
  pending.value = true
  errorText.value = ''
  try {
    const result = await noteTemplatesApi.remove(selectedId.value, props.store.revision)
    if (!result.success) {
      errorText.value = result.error || '删除模板失败。'
      if (result.errorCode === 'TEMPLATE_STALE') await recoverFromStaleRevision()
      return
    }
    const nextStore = result.data?.templates ? result.data : await refreshStore()
    emit('updated', nextStore)
    const oldIndex = props.store.templates.findIndex(template => template.id === selectedId.value)
    const next = nextStore.templates[Math.min(Math.max(oldIndex, 0), nextStore.templates.length - 1)]
    if (next) loadTemplate(next)
    else clearDraft()
  } catch (error) {
    errorText.value = error instanceof Error ? error.message : '删除模板失败。'
  } finally {
    pending.value = false
  }
}

const cancelChanges = () => {
  if (isNew.value) {
    const first = props.store.templates[0]
    if (first) loadTemplate(first)
    else clearDraft()
    return
  }
  const original = props.store.templates.find(template => template.id === selectedId.value)
  if (original) loadTemplate(original)
}

const insertTab = async () => {
  const textarea = contentTextarea.value
  if (!textarea) return
  const start = textarea.selectionStart
  const end = textarea.selectionEnd
  draft.contentTemplate = `${draft.contentTemplate.slice(0, start)}  ${draft.contentTemplate.slice(end)}`
  await nextTick()
  textarea.setSelectionRange(start + 2, start + 2)
}

originalSnapshot.value = snapshot()
onMounted(() => { previewTimer = setInterval(refreshPreviewNow, 60_000) })
onBeforeUnmount(() => {
  if (previewTimer) clearInterval(previewTimer)
})
watch(() => props.store.revision, () => {
  if (isDirty.value) return
  const current = props.store.templates.find(template => template.id === selectedId.value) ?? props.store.templates[0]
  if (current) loadTemplate(current)
  else clearDraft()
}, { immediate: true })
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <div class="flex shrink-0 items-center justify-between border-b border-border-soft px-5 py-3">
      <button type="button" class="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium text-text-muted hover:bg-panel-soft hover:text-text-main" @click="emit('back')">
        <ArrowLeft :size="15" />返回选择
      </button>
      <button type="button" class="inline-flex items-center gap-1.5 rounded-xl bg-accent-soft px-3 py-2 text-xs font-semibold text-accent hover:bg-accent/15" :disabled="pending" @click="startNew">
        <FilePlus2 :size="15" />新建模板
      </button>
    </div>

    <div class="grid min-h-0 flex-1 md:grid-cols-[13rem_minmax(0,1fr)]">
      <aside class="max-h-40 overflow-y-auto border-b border-border-soft bg-panel-soft/50 p-3 md:max-h-none md:border-b-0 md:border-r">
        <div class="mb-2 px-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-text-subtle">模板列表</div>
        <button v-if="isNew" type="button" class="mb-1 w-full rounded-xl bg-accent-soft px-3 py-2.5 text-left text-sm font-semibold text-accent">未命名模板 <span class="text-[10px]">（未保存）</span></button>
        <button
          v-for="template in store.templates"
          :key="template.id"
          type="button"
          class="mb-1 w-full truncate rounded-xl px-3 py-2.5 text-left text-sm transition"
          :class="!isNew && selectedId === template.id ? 'bg-accent-soft font-semibold text-accent' : 'text-text-muted hover:bg-panel hover:text-text-main'"
          @click="selectTemplate(template)"
        >
          {{ template.name }}
        </button>
        <p v-if="store.templates.length === 0 && !isNew" class="px-2 py-5 text-center text-xs text-text-subtle">暂无自定义模板</p>
      </aside>

      <main class="min-h-0 overflow-y-auto p-5 md:p-6">
        <div v-if="!selectedId && !isNew" class="flex h-full min-h-52 flex-col items-center justify-center text-center text-text-muted">
          <FilePlus2 :size="28" class="mb-3 text-text-subtle" />
          <p class="text-sm">新建第一个模板，或从左侧选择模板。</p>
        </div>

        <form v-else class="mx-auto grid max-w-3xl gap-5" @submit.prevent="save">
          <div v-if="errorText" role="alert" class="rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">{{ errorText }}</div>

          <label class="grid gap-1.5 text-xs font-semibold text-text-main">
            模板名
            <input v-model="draft.name" maxlength="100" class="h-10 rounded-xl border border-border-soft bg-panel px-3 text-sm font-normal text-text-main outline-none focus:border-accent" />
            <span v-if="nameError" class="font-normal text-danger">{{ nameError }}</span>
          </label>

          <label class="grid gap-1.5 text-xs font-semibold text-text-main">
            文件名模板
            <input v-model="draft.fileNameTemplate" maxlength="300" spellcheck="false" class="h-10 rounded-xl border border-border-soft bg-panel px-3 font-mono text-sm font-normal text-text-main outline-none focus:border-accent" />
            <span v-if="filenameError" class="font-normal text-danger">{{ filenameError }}</span>
            <span v-else class="font-normal text-text-muted">文件名预览：<strong class="text-text-main">{{ renderResultText(filenamePreview) }}</strong></span>
          </label>

          <label class="grid gap-1.5 text-xs font-semibold text-text-main">
            文件内容
            <textarea ref="contentTextarea" v-model="draft.contentTemplate" rows="9" spellcheck="false" class="min-h-44 resize-y rounded-xl border border-border-soft bg-panel px-3 py-2 font-mono text-sm font-normal leading-6 text-text-main outline-none focus:border-accent" @keydown.tab.prevent="insertTab" />
            <span v-if="contentError" class="font-normal text-danger">{{ contentError }}</span>
          </label>

          <details class="rounded-xl border border-border-soft bg-panel-soft/45">
            <summary class="cursor-pointer px-4 py-3 text-xs font-semibold text-text-main">内容预览</summary>
            <div class="max-h-48 min-w-0 overflow-auto border-t border-border-soft px-4 py-3">
              <p v-if="!contentPreview.ok" role="alert" class="text-sm text-danger">{{ renderErrorText(contentPreview) }}</p>
              <p v-else-if="!contentPreview.value.trim()" class="text-sm text-text-muted">暂无内容</p>
              <div v-else class="markdown-body template-markdown-preview" @mouseover.stop @mouseout.stop @click.capture="handlePreviewClick" @auxclick.capture="handlePreviewClick" v-html="contentPreviewHtml" />
            </div>
            <p v-if="previewFeedback" role="status" class="border-t border-border-soft px-4 py-2 text-xs text-text-muted">{{ previewFeedback }}</p>
          </details>

          <section>
            <div class="mb-2 flex items-center justify-between">
              <div>
                <h3 class="text-xs font-semibold text-text-main">变量</h3>
                <p class="mt-1 text-[11px] text-text-muted">所有使用后表达式都基于使用前的同一份变量快照计算。</p>
              </div>
              <button type="button" class="inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs font-medium text-accent hover:bg-accent-soft" @click="addVariable"><Plus :size="14" />添加变量</button>
            </div>

            <div class="grid gap-2">
              <div v-for="(variable, index) in draft.variables" :key="variable.id" class="rounded-xl border border-border-soft bg-panel-soft/45 p-3">
                <div class="grid items-center gap-2 md:grid-cols-[1fr_7rem_1fr_1.25fr_auto]">
                  <label class="grid gap-1 text-[10px] text-text-subtle">名称<input v-model="variable.name" spellcheck="false" class="h-9 rounded-lg border border-border-soft bg-panel px-2 font-mono text-xs text-text-main outline-none focus:border-accent" /></label>
                  <label class="grid gap-1 text-[10px] text-text-subtle">类型<select v-model="variable.type" class="h-9 rounded-lg border border-border-soft bg-panel px-2 text-xs text-text-main outline-none focus:border-accent" @change="normalizeVariableValue(variable)"><option value="string">字符串</option><option value="number">数字</option><option value="boolean">布尔值</option></select></label>
                  <label class="grid gap-1 text-[10px] text-text-subtle">当前值
                    <input v-if="variable.type === 'number'" v-model.number="variable.value" type="number" class="h-9 rounded-lg border border-border-soft bg-panel px-2 text-xs text-text-main outline-none focus:border-accent" />
                    <span v-else-if="variable.type === 'boolean'" class="flex h-9 items-center"><input v-model="variable.value" type="checkbox" class="h-4 w-4 accent-accent" /><span class="ml-2 text-xs text-text-main">{{ variable.value ? 'true' : 'false' }}</span></span>
                    <input v-else v-model="variable.value" type="text" class="h-9 rounded-lg border border-border-soft bg-panel px-2 text-xs text-text-main outline-none focus:border-accent" />
                  </label>
                  <label class="grid gap-1 text-[10px] text-text-subtle">使用后表达式<input v-model="variable.afterUseExpression" spellcheck="false" placeholder="保持不变" class="h-9 rounded-lg border border-border-soft bg-panel px-2 font-mono text-xs text-text-main outline-none focus:border-accent" /></label>
                  <button type="button" aria-label="删除变量" class="mt-4 flex h-9 w-9 items-center justify-center rounded-lg text-text-subtle hover:bg-danger/10 hover:text-danger" @click="removeVariable(index)"><X :size="15" /></button>
                </div>
                <p v-if="variableErrors[index]" class="mt-2 text-xs text-danger">{{ variableErrors[index] }}</p>
              </div>
            </div>
          </section>

          <p v-if="transitionError" role="alert" class="text-xs text-danger">{{ transitionError }}</p>

          <details class="rounded-xl border border-border-soft px-4 py-3 text-xs text-text-muted">
            <summary class="cursor-pointer font-semibold text-text-main">函数与语法说明</summary>
            <div class="mt-3 grid gap-4 leading-5">
              <section>
                <h4 class="font-semibold text-text-main">表达式基础</h4>
                <p class="mt-1">用 <code class="text-accent">&#123;&#123; expression &#125;&#125;</code> 在文件名或内容中插入表达式结果。可以直接使用已定义的变量、字符串、数字、布尔值和括号。</p>
                <p class="mt-1">支持算术 <code>+ - * / %</code>、比较 <code>=== !== &lt; &lt;= &gt; &gt;=</code>、逻辑 <code>&amp;&amp; || !</code> 和条件表达式 <code>条件 ? 值1 : 值2</code>。当任一操作数是字符串时，<code>+</code> 用于拼接文本。</p>
              </section>

              <section>
                <h4 class="font-semibold text-text-main"><code>now(format)</code></h4>
                <p class="mt-1">按系统本地时间输出日期和时间。参数 <code>format</code> 是格式字符串，同一次模板创建中的文件名、内容和变量更新共用同一时间快照。</p>
                <div class="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-lg bg-panel-soft p-3 font-mono text-[11px]">
                  <span>YYYY / YY</span><span>四位 / 两位年份</span>
                  <span>MM / M</span><span>补零 / 不补零的月份</span>
                  <span>DD / D</span><span>补零 / 不补零的日期</span>
                  <span>HH / H</span><span>补零 / 不补零的 24 小时制小时</span>
                  <span>mm / m</span><span>补零 / 不补零的分钟</span>
                  <span>ss / s</span><span>补零 / 不补零的秒</span>
                  <span>ddd</span><span>简称，例如 ddd → 周四</span>
                  <span>dddd</span><span>全称，例如 dddd → 星期四</span>
                  <span>E</span><span>ISO 星期数字，例如 E → 4；周一为 1，周日为 7</span>
                </div>
                <p class="mt-2">示例：<code>now("YYYY-MM-DD ddd HH:mm")</code> → <code>2026-09-03 周四 09:05</code></p>
              </section>

              <dl class="grid gap-3">
                <div>
                  <dt class="font-semibold text-text-main"><code>upper(value)</code></dt>
                  <dd>把参数转换成字符串并转为大写。示例：<code>upper("Looma")</code> → <code>LOOMA</code>。</dd>
                </div>
                <div>
                  <dt class="font-semibold text-text-main"><code>lower(value)</code></dt>
                  <dd>把参数转换成字符串并转为小写。示例：<code>lower("LOOMA")</code> → <code>looma</code>。</dd>
                </div>
                <div>
                  <dt class="font-semibold text-text-main"><code>trim(value)</code></dt>
                  <dd>把参数转换成字符串，并移除开头和结尾的空白。示例：<code>trim("  note  ")</code> → <code>note</code>。</dd>
                </div>
                <div>
                  <dt class="font-semibold text-text-main"><code>pad(value, length, fill?)</code></dt>
                  <dd>在左侧补齐到指定长度；省略 <code>fill</code> 时默认使用 0 补齐，填充内容必须是单个字符。示例：<code>pad(7, 3)</code> → <code>007</code>，<code>pad("A", 3, "-")</code> → <code>--A</code>。</dd>
                </div>
                <div>
                  <dt class="font-semibold text-text-main"><code>replace(value, search, replacement)</code></dt>
                  <dd>把参数转换成字符串，在 <code>value</code> 中查找 <code>search</code>，只替换第一次匹配。示例：<code>replace("a-b-a", "a", "x")</code> → <code>x-b-a</code>。</dd>
                </div>
              </dl>

              <section>
                <h4 class="font-semibold text-text-main">变量使用后表达式</h4>
                <p class="mt-1">可以用同一套语法计算变量的下一次值，例如 <code>day + 1</code>。所有变量都基于使用前的同一份快照计算，结果类型必须与变量类型一致；只有文件创建成功后才会保存新值。</p>
              </section>
            </div>
          </details>

          <footer class="sticky bottom-0 flex flex-wrap justify-end gap-2 border-t border-border-soft bg-panel/95 py-3 backdrop-blur">
            <button v-if="selectedId" type="button" class="mr-auto inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-medium text-danger hover:bg-danger/10" :disabled="pending" @click="removeSelected"><Trash2 :size="14" />删除模板</button>
            <button type="button" class="rounded-xl border border-border-soft px-4 py-2 text-xs font-medium text-text-muted hover:bg-panel-soft" :disabled="pending || !isDirty" @click="cancelChanges">取消</button>
            <button type="submit" class="inline-flex items-center gap-1.5 rounded-xl bg-accent px-4 py-2 text-xs font-semibold text-white hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50" :disabled="pending || hasErrors || !isDirty"><Save :size="14" />{{ pending ? '保存中…' : '保存' }}</button>
          </footer>
        </form>
      </main>
    </div>
  </div>
</template>

<style scoped>
.template-markdown-preview {
  min-width: 0;
  color: var(--text-main);
  background: transparent;
  font-family: var(--font-body);
  font-size: 14px;
  line-height: 1.75;
  overflow-wrap: anywhere;
  user-select: text;
}
.template-markdown-preview :deep(> :first-child) { margin-top: 0; }
.template-markdown-preview :deep(> :last-child) { margin-bottom: 0; }
.template-markdown-preview :deep(h1),
.template-markdown-preview :deep(h2) { border-bottom-color: var(--border-soft); }
.template-markdown-preview :deep(ul) { list-style: disc; }
.template-markdown-preview :deep(ol) { list-style: decimal; }
.template-markdown-preview :deep(.task-list-item) { list-style: none; }
.template-markdown-preview :deep(blockquote) {
  color: var(--text-muted);
  border-left-color: var(--border-soft);
  background: var(--panel-soft);
}
.template-markdown-preview :deep(code),
.template-markdown-preview :deep(pre) {
  font-family: var(--font-code);
  color: var(--text-main);
  background: var(--panel-soft);
}
.template-markdown-preview :deep(pre) { overflow-x: auto; }
.template-markdown-preview :deep(pre code) { background: transparent; }
.template-markdown-preview :deep(.code-block-shell) {
  position: relative;
  margin: 1rem 0;
  border: 1px solid var(--border-soft);
  border-radius: 6px;
  overflow: hidden;
  background: var(--panel-soft);
}
.template-markdown-preview :deep(.code-block-body) { margin: 0; padding-top: 2.5rem; }
.template-markdown-preview :deep(.code-block-floating-copy) {
  position: absolute;
  top: 0.4rem;
  right: 0.5rem;
  max-width: calc(100% - 1rem);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  border: 1px solid var(--border-soft);
  border-radius: 4px;
  padding: 0.15rem 0.5rem;
  color: var(--text-muted);
  background: var(--panel);
  font-size: 11px;
  cursor: pointer;
}
.template-markdown-preview :deep(.code-block-copy-action) { margin-left: 0.5rem; }
.template-markdown-preview :deep(.code-block-floating-copy:hover) { color: var(--accent); }
.template-markdown-preview :deep(table) {
  display: block;
  width: 100%;
  max-width: 100%;
  overflow-x: auto;
}
.template-markdown-preview :deep(tr) { background: var(--panel); border-color: var(--border-soft); }
.template-markdown-preview :deep(tr:nth-child(2n)),
.template-markdown-preview :deep(th) { background: var(--panel-soft); }
.template-markdown-preview :deep(td),
.template-markdown-preview :deep(th) { border-color: var(--border-soft); }
.template-markdown-preview :deep(mark) {
  background: var(--accent-soft);
  color: var(--text-main);
  padding: 0.1em 0.2em;
  border-radius: 3px;
}
.template-markdown-preview :deep(hr) { background: var(--border-soft); }
.template-markdown-preview :deep(a) { color: var(--accent); }
.template-markdown-preview :deep(.looma-note-ref),
.template-markdown-preview :deep(.looma-external-link) { text-decoration: none; border-bottom: 1px solid currentColor; }
.template-markdown-preview :deep(.looma-note-ref) { border-bottom-style: dotted; }
.template-markdown-preview :deep(.looma-link-icon) {
  display: inline-block;
  width: 0.95em;
  height: 0.95em;
  margin-right: 0.2em;
  vertical-align: -0.13em;
}
.template-markdown-preview :deep(img) { max-width: 100%; height: auto; background: transparent; }
.template-markdown-preview :deep(.template-image-placeholder) { color: var(--text-muted); font-size: 0.9em; }
</style>
