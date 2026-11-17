<script setup lang="ts">
import { computed } from 'vue'
import { graphNodeRadius } from '@/shared/utils/knowledge-graph'
import { graphDirectoryHue } from '@/renderer/utils/knowledge-graph-scene'
import type { GraphEdge, GraphNode } from '@/shared/utils/knowledge-graph'
import type { GraphNodeLabel, GraphSceneEdge } from '@/renderer/utils/knowledge-graph-scene'

const props = defineProps<{
  nodes: GraphNode[]
  edges: GraphSceneEdge[]
  nodeLabels: Map<string, GraphNodeLabel>
  selectedPath: string
  activePath: string
  selectedEdgeId: string
  connected: Set<string>
  selectedConnected: Set<string>
  errorPaths: Set<string>
}>()
const paintNodes = computed(() => [...props.nodes].sort((a, b) => {
  const priority = (node: GraphNode) => node.note.path === props.selectedPath ? 2 : props.selectedConnected.has(node.note.path) ? 1 : 0
  return priority(a) - priority(b)
}))
const emit = defineEmits<{
  select: [path: string, event: MouseEvent | KeyboardEvent]
  hover: [path: string]
  leave: [path: string]
  edge: [edge: GraphEdge, event: MouseEvent | KeyboardEvent]
  open: [path: string]
}>()
</script>

<template>
  <g class="knowledge-scene">
    <g class="graph-edges">
      <g v-for="geometry in edges" :key="geometry.edge.id" class="graph-edge" :style="{ '--graph-hue': graphDirectoryHue(geometry.edge.source) }" :class="{ 'is-selected': selectedEdgeId === geometry.edge.id }">
        <path :d="geometry.lineD" class="edge-line" />
        <path v-if="geometry.headD" :d="geometry.headD" class="edge-head" />
        <path :d="geometry.d" class="edge-target" data-graph-control role="button" tabindex="0" :aria-label="`${geometry.edge.source} 引用 ${geometry.edge.target}，查看引用片段`" @click="emit('edge', geometry.edge, $event)" @keydown.enter.prevent="emit('edge', geometry.edge, $event)" @keydown.space.prevent="emit('edge', geometry.edge, $event)"><title>{{ geometry.edge.source }} → {{ geometry.edge.target }}</title></path>
      </g>
    </g>
    <g v-for="node in paintNodes" :key="node.note.path" :data-note-path="node.note.path" data-graph-control class="graph-node" :class="{ 'is-selected': selectedPath === node.note.path, 'is-dimmed': activePath && !connected.has(node.note.path), 'has-error': errorPaths.has(node.note.path) }" :style="{ transform: `translate(${node.x}px, ${node.y}px)`, '--graph-hue': graphDirectoryHue(node.note.path) }" role="button" tabindex="0" :aria-label="`${node.note.title}，${node.note.path}；选择查看关系，双击打开`" :aria-pressed="selectedPath === node.note.path" @keydown.enter.prevent="emit('select', node.note.path, $event)" @keydown.space.prevent="emit('select', node.note.path, $event)">
      <title>{{ node.note.title }}&#10;{{ node.note.path }}</title>
      <circle :r="graphNodeRadius(node.note) + 9" class="node-halo" /><circle :r="graphNodeRadius(node.note)" class="node-dot" @pointerenter="emit('hover', node.note.path)" @pointerleave="emit('leave', node.note.path)" @click="emit('select', node.note.path, $event)" @dblclick="emit('open', node.note.path)" />
      <text v-if="nodeLabels.has(node.note.path)" :x="nodeLabels.get(node.note.path)!.x" :y="nodeLabels.get(node.note.path)!.y" text-anchor="middle" class="node-title" :style="{ fontSize: `${nodeLabels.get(node.note.path)!.fontSize}px` }">{{ nodeLabels.get(node.note.path)!.text }}</text>
    </g>
  </g>
</template>

<style scoped>
.knowledge-scene{--graph-lightness:43%;--graph-saturation:38%}
:global([data-theme="dark"] .knowledge-scene){--graph-lightness:70%;--graph-saturation:45%}
.graph-edge,.graph-node{--graph-color:hsl(var(--graph-hue,140) var(--graph-saturation) var(--graph-lightness))}
[role=button]:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
.graph-edge{opacity:.65}
.graph-edge.is-selected,.graph-edge:hover{opacity:1}
.edge-line{fill:none;stroke:var(--graph-color);stroke-width:1.4;stroke-linecap:butt;pointer-events:none}
.edge-head{fill:var(--graph-color);stroke:none;pointer-events:none}
.graph-edge.is-selected .edge-line,.graph-edge:hover .edge-line{stroke-width:2.4}
.edge-target{fill:none;stroke:transparent;stroke-width:14;cursor:pointer}
.graph-node{pointer-events:none}
.graph-node.is-dimmed{opacity:.38}
.node-dot{pointer-events:all;cursor:pointer;fill:var(--graph-color);stroke:var(--panel);stroke-width:2}
.node-halo{pointer-events:none;fill:color-mix(in srgb,var(--graph-color) 20%,transparent);opacity:0}
.graph-node:hover .node-halo,.graph-node.is-selected .node-halo{opacity:1}
.graph-node.is-selected .node-dot{stroke:var(--text-main)}
.graph-node.has-error .node-dot{fill:var(--text-subtle)}
.node-title{pointer-events:none;fill:var(--text-main);paint-order:stroke;stroke:var(--panel);stroke-width:4px;stroke-linejoin:round}
.graph-node.is-selected .node-title{font-weight:600}
</style>
