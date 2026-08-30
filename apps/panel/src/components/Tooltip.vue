<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue';

const props = defineProps<{
  text: string;
}>();

let sequence = 0;
const trigger = ref<HTMLElement | null>(null);
const bubble = ref<HTMLElement | null>(null);
const open = ref(false);
const placement = ref<'top' | 'bottom'>('top');
const position = ref({ top: 0, left: 0 });
const id = `tooltip-${++sequence}`;

function updatePosition(): void {
  if (!trigger.value || !bubble.value) return;

  const triggerRect = trigger.value.getBoundingClientRect();
  const bubbleRect = bubble.value.getBoundingClientRect();
  const margin = 10;
  const gap = 9;

  let top = triggerRect.top - bubbleRect.height - gap;
  placement.value = 'top';
  if (top < margin) {
    top = triggerRect.bottom + gap;
    placement.value = 'bottom';
  }

  const left = Math.min(
    Math.max(margin, triggerRect.left + (triggerRect.width - bubbleRect.width) / 2),
    Math.max(margin, window.innerWidth - bubbleRect.width - margin),
  );

  position.value = { top, left };
}

function startTracking(): void {
  window.addEventListener('resize', updatePosition);
  window.addEventListener('scroll', updatePosition, true);
  void nextTick(updatePosition);
}

function stopTracking(): void {
  window.removeEventListener('resize', updatePosition);
  window.removeEventListener('scroll', updatePosition, true);
}

function show(): void {
  if (!props.text) return;
  open.value = true;
}

function hide(): void {
  open.value = false;
}

watch(open, (visible) => {
  if (visible) startTracking();
  else stopTracking();
});

onBeforeUnmount(stopTracking);
</script>

<template>
  <span
    ref="trigger"
    class="tooltip-trigger"
    @mouseenter="show"
    @mouseleave="hide"
    @focusin="show"
    @focusout="hide"
  >
    <slot />
  </span>

  <Teleport to="body">
    <span
      v-if="open"
      :id="id"
      ref="bubble"
      class="tooltip-bubble"
      :data-placement="placement"
      role="tooltip"
      :style="{ top: `${position.top}px`, left: `${position.left}px` }"
    >
      {{ text }}
    </span>
  </Teleport>
</template>
