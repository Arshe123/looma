<script setup lang="ts">
import { Plus } from 'lucide-vue-next'
</script>

<template>
  <button
    type="button"
    aria-label="打开快速插入菜单"
    class="flex items-center justify-center w-6 h-6 rounded-full bg-panel-soft hover:bg-accent-soft text-text-muted transition-colors z-10"
  ><Plus :size="14" /></button>
</template>
