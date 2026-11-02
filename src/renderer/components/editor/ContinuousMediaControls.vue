<script setup lang="ts">
import { shallowRef, ref, watch, onBeforeUnmount } from 'vue'
import type { Editor } from '@tiptap/vue-3'
import ImageInsertDialog from '../preview/ImageInsertDialog.vue'
import type { ContinuousMediaController } from './continuousMarkdownMedia'
import './continuousMarkdownMedia.css'
const props = defineProps<{ controller: ContinuousMediaController; filePath: string }>()
const open = ref(false)
const editor = shallowRef<Editor | null>(null)
function openDialog() {
  const bridge = props.controller.createDialogEditor()
  if (!bridge) return false
  editor.value = bridge
  open.value = true
  return true
}
function closeDialog() {
  open.value = false
  editor.value = null
  props.controller.cancelDialog()
}
watch(() => props.filePath, closeDialog)
watch(() => props.controller, (_current, previous) => { previous.cancelDialog(); closeDialog() })
onBeforeUnmount(closeDialog)
defineExpose({ openDialog, closeDialog })
</script>
<template>
  <ImageInsertDialog v-if="editor" :open="open" :editor="editor" :file-path="filePath" @close="closeDialog" />
</template>
