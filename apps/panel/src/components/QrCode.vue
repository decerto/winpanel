<script setup lang="ts">
import { computed } from 'vue';
import { encode } from 'uqr';

/**
 * A QR code, drawn inline.
 *
 * Rendered as an SVG the component builds itself rather than an <img> or a
 * canvas. The panel's content security policy allows no external origins and
 * no inline scripts, and the server it runs on may have no outbound access at
 * all, so a hosted chart API or a runtime-loaded library is not an option.
 *
 * The modules become one <path> instead of a few thousand <rect> elements,
 * which keeps the DOM small enough to render without a visible pause.
 */

const props = withDefaults(
  defineProps<{
    value: string;
    /** Rendered size in pixels. */
    size?: number;
    label?: string;
  }>(),
  { size: 200, label: 'QR code' },
);

const qr = computed(() => {
  if (props.value.length === 0) return null;

  try {
    // Two modules of quiet zone. Scanners need a light margin to find the
    // finder patterns; without it the code is unreadable on a dark page.
    const { data, size } = encode(props.value, { border: 2 });

    let path = '';
    for (let row = 0; row < data.length; row++) {
      const cells = data[row] ?? [];
      for (let column = 0; column < cells.length; column++) {
        if (cells[column]) path += `M${column} ${row}h1v1h-1z`;
      }
    }

    return { path, size };
  } catch {
    // A code that cannot be generated must not take the page down with it:
    // the secret is also shown as text, so setup can still be completed.
    return null;
  }
});
</script>

<template>
  <svg
    v-if="qr"
    :viewBox="`0 0 ${qr.size} ${qr.size}`"
    :width="size"
    :height="size"
    role="img"
    :aria-label="label"
    shape-rendering="crispEdges"
  >
    <rect :width="qr.size" :height="qr.size" fill="#ffffff" />
    <path :d="qr.path" fill="#000000" />
  </svg>
</template>
