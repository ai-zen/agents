<template>
  <EmojiPicker
    :disabled="disabled"
    @output="$emit('update:modelValue', $event)"
  >
    <div class="emoji-input" :class="{ 'is-disabled': disabled }">
      <input
        :disabled="disabled"
        :value="$props.modelValue"
        @input="$emit('update:modelValue', ($event.target as any).value)"
        maxlength="1"
      />
    </div>
  </EmojiPicker>
</template>

<script lang="ts" setup>
import EmojiPicker from "../EmojiPicker/index.vue";

defineProps({
  modelValue: { type: String, required: true },
  disabled: { type: Boolean, default: false },
});

defineEmits(["update:modelValue"]);
</script>

<style lang="scss" scoped>
.emoji-input {
  width: 32px;
  height: 32px;
  font-size: 14px;
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: var(--el-border);

  &.is-disabled {
    input {
      cursor: unset;
    }
  }

  input {
    width: 100%;
    height: 100%;
    border: none;
    padding: none;
    background-color: unset;
    outline: none;
    text-align: center;
    cursor: pointer;
  }
}
</style>
