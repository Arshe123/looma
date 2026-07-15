<script setup lang="ts">
withDefaults(defineProps<{
  message?: string
  technicalDetail?: string
}>(), {
  message: '',
  technicalDetail: '',
})
</script>

<template>
  <div v-if="message || technicalDetail" class="mt-2 rounded-lg border border-danger/25 bg-danger/10 p-2.5">
    <p v-if="message" class="text-[11px] leading-5 text-danger">
      {{ message }}
    </p>
    <details v-if="technicalDetail" class="mt-2 text-[10px] text-text-muted">
      <summary class="cursor-pointer select-none font-medium text-text-main">技术详情</summary>
      <pre class="mt-2 overflow-auto whitespace-pre-wrap break-all rounded-md bg-panel-soft p-2 font-mono leading-4 text-text-muted">{{ technicalDetail }}</pre>
    </details>
  </div>
</template>
