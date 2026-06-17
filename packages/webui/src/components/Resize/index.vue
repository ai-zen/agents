<template>
  <div
    class="resize-wrapper"
    :style="{
      '--resize-controller-size':
        typeof props.size == 'number' ? `${props.size}px` : props.size,
    }"
  >
    <template v-for="placement of props.placements">
      <div
        :class="`resize-controller controller-${placement}`"
        @mousedown="onMouseDown($event, placement)"
      ></div
    ></template>

    <div class="resize-content" ref="resizeContentRef">
      <slot></slot>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from "vue";

const props = withDefaults(
  defineProps<{
    width: string | number;
    height: string | number;
    size?: string | number;
    placements?: ("top" | "bottom" | "left" | "right")[];
  }>(),
  { size: 5, placements: () => ["top", "bottom", "left", "right"] }
);

const resizeContentRef = ref<HTMLDivElement | null>(null);

onMounted(() => {
  resizeContentRef.value?.style.setProperty(
    "width",
    typeof props.width == "number" ? `${props.width}px` : props.width
  );
  resizeContentRef.value?.style.setProperty(
    "height",
    typeof props.height == "number" ? `${props.height}px` : props.height
  );
});

let beginPosition: { x: number; y: number } | null = null;
let beginSize: DOMRect | null = null;
let beginPlacement: "top" | "bottom" | "left" | "right" | null = null;

function onMouseDown(
  e: MouseEvent,
  placement: "top" | "bottom" | "left" | "right"
) {
  beginPosition = { x: e.clientX, y: e.clientY };
  beginSize = resizeContentRef?.value?.getBoundingClientRect() || null;
  beginPlacement = placement;
  document.addEventListener("mousemove", onMouseMove);
  document.addEventListener("mouseup", onMouseUp);
}

function onMouseMove(e: MouseEvent) {
  if (!beginPosition) return;
  if (!beginSize) return;

  const diffX = e.clientX - beginPosition.x;
  const diffY = e.clientY - beginPosition.y;

  if (beginPlacement == "top") {
    const height = beginSize.height - diffY;
    resizeContentRef.value?.style.setProperty("height", `${height}px`);
  }

  if (beginPlacement == "bottom") {
    const height = beginSize.height + diffY;
    resizeContentRef.value?.style.setProperty("height", `${height}px`);
  }

  if (beginPlacement == "left") {
    const width = beginSize.width - diffX;
    resizeContentRef.value?.style.setProperty("width", `${width}px`);
  }

  if (beginPlacement == "right") {
    const width = beginSize.width + diffX;
    resizeContentRef.value?.style.setProperty("width", `${width}px`);
  }
}

function onMouseUp(_e: MouseEvent) {
  beginPosition = null;
  beginSize = null;

  document.removeEventListener("mousemove", onMouseMove);
  document.removeEventListener("mouseup", onMouseUp);
}
</script>

<style lang="scss" scoped>
.resize-wrapper {
  position: relative;
}

.resize-controller {
  position: absolute;
}

.controller-top,
.controller-bottom {
  width: 100%;
  height: var(--resize-controller-size);
  cursor: ns-resize;
}

.controller-left,
.controller-right {
  width: var(--resize-controller-size);
  height: 100%;
  cursor: ew-resize;
}

.controller-top {
  top: 0px;
}

.controller-right {
  right: 0px;
}

.controller-bottom {
  bottom: 0px;
}

.controller-left {
  left: 0px;
}
</style>
