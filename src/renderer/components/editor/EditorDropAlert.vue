<script setup lang="ts">
import MessageDialog from '../MessageDialog.vue'

withDefaults(defineProps<{
  open: boolean
  title?: string
  message: string
  detail?: string
}>(), {
  title: '无法插入该文件',
  detail: '',
})

const emit = defineEmits<{ close: [] }>()
</script>

<template>
  <MessageDialog
    :open="open"
    :options="{ type: 'error', title, message, detail, detailLabel: '技术详情' }"
    @response="emit('close')"
  />
</template>