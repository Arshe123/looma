<script setup lang="ts">
import { computed, onBeforeUnmount } from 'vue'
import MessageDialog from './MessageDialog.vue'
import { useMessageDialogStore } from '@/renderer/stores/message-dialog'

const dialogs = useMessageDialogStore()
const current = computed(() => {
  const request = dialogs.current
  return request && { ...request, respond: (response: number) => dialogs.respond(request.id, response) }
})
onBeforeUnmount(() => dialogs.cancelAll())
</script>

<template>
  <MessageDialog
    v-if="current"
    :key="current.id"
    :open="true"
    :options="current.options"
    @response="current.respond"
  />
</template>