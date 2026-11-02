<script setup lang="ts">
import { computed } from 'vue'
import NoteRefPicker from '../preview/NoteRefPicker.vue'
import type { ContinuousReferenceRequest, ContinuousReferenceSelection, ContinuousReferencesController } from './continuousMarkdownReferences'

const props = defineProps<{
  request: ContinuousReferenceRequest | null
  controller: ContinuousReferencesController
}>()
// Each keyed instance captures its own request. A late select/close from an
// unmounted picker must never operate on a subsequently opened request.
const handlers = computed(() => {
  const request = props.request
  const controller = props.controller
  return {
    select: (payload: ContinuousReferenceSelection) => request && controller.select(request, payload),
    close: () => { if (request) controller.cancel(true, request) },
  }
})
</script>

<template>
  <NoteRefPicker
    v-if="request"
    :key="request.id"
    :from-relative-path="request.fromRelativePath"
    :selected-text="request.selectedText"
    v-on="handlers"
  />
</template>
