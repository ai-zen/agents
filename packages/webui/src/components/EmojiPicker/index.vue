<template>
  <el-tooltip
    class="emoji-tooltip"
    placement="bottom"
    effect="light"
    v-bind="$attrs"
  >
    <slot></slot>
    <template #content>
      <div class="emoji-picker__emojis-scroll">
        <div class="emoji-picker__emojis">
          <button
            v-for="emoji in emojis"
            :key="emoji"
            @click="$emit('output', emoji)"
          >
            {{ emoji }}
          </button>
        </div>
      </div>
    </template>
  </el-tooltip>
</template>

<script lang="ts" setup>
import { ref } from "vue";

defineEmits(["output"]);

const emojis = ref([
  "⌚",
  "☀️",
  "☁️",
  "☔️",
  "☹️",
  "♀️♂️",
  "⚡️",
  "⚡",
  "⛄",
  "⛅️",
  "⛷️",
  "✈️",
  "✉️",
  "✨",
  "❄️",
  "⭐️",
  "⭐",
  "🌀",
  "🌄",
  "🌅",
  "🌆",
  "🌇",
  "🌈",
  "🌉",
  "🌊",
  "🌍",
  "🌎",
  "🌏",
  "🌙",
  "🌚",
  "🌛",
  "🌝",
  "🌞",
  "🌟",
  "🌤️",
  "🌧️",
  "🌩️",
  "🌫️",
  "🌬️",
  "🌭",
  "🌮",
  "🌲",
  "🌳",
  "🌴",
  "🌵",
  "🌹",
  "🌺",
  "🌻",
  "🍇",
  "🍉",
  "🍊",
  "🍋",
  "🍌",
  "🍍",
  "🍎",
  "🍒",
  "🍓",
  "🍔",
  "🍕",
  "🍜",
  "🍟",
  "🍦",
  "🍩",
  "🍪",
  "🍫",
  "🍬",
  "🍭",
  "🍱",
  "🍴",
  "🍷",
  "🍸",
  "🍹",
  "🍺",
  "🍻",
  "🍼",
  "🍽️",
  "🍾",
  "🍿",
  "🎀",
  "🎁",
  "🎂",
  "🎃",
  "🎄",
  "🎅",
  "🎇",
  "🎈",
  "🎉",
  "🎊",
  "🎖️",
  "🎠",
  "🎡",
  "🎢",
  "🎧",
  "🎪",
  "🎵",
  "🎶",
  "🏂",
  "🏃‍♀",
  "🏃‍♂",
  "🏄‍♀",
  "🏄‍♂",
  "🏅",
  "🏆",
  "🏊‍♀",
  "🏊‍♂",
  "🏋️",
  "🏞️",
  "🐙",
  "🐝",
  "🐞",
  "🐠",
  "🐬",
  "🐱",
  "🐶",
  "🐼",
  "🐾",
  "👻",
  "💌",
  "💡",
  "💣",
  "💥",
  "💧",
  "💫",
  "💻",
  "📌",
  "📚",
  "📚",
  "📝",
  "📬",
  "📱",
  "📷",
  "🔒",
  "🔥",
  "🕷️",
  "🗝️",
  "🤐",
  "🤑",
  "🤓",
  "🤔",
  "🤖",
  "🤗",
  "🤣",
  "🤥",
  "🤨",
  "🤩",
  "🤫",
  "🤭",
  "🤶",
  "🤸‍♀",
  "🤸‍♂",
  "🤽‍♀",
  "🤽‍♂",
  "🤾‍♀",
  "🤾‍♂",
  "🥇",
  "🥛",
  "🥤",
  "🥰",
  "🥳",
  "🥺",
  "🦄",
  "🧘‍♀",
  "🧘‍♂",
  "😂",
  "😃",
  "😄",
  "😅",
  "😆",
  "😇",
  "😉",
  "😊",
  "😍",
  "😎",
  "😏",
  "😒",
  "😕",
  "😗",
  "😘",
  "😙",
  "😚",
  "😜",
  "😝",
  "😟",
  "😦",
  "😧",
  "😬",
  "😭",
  "😮",
  "😯",
  "😲",
  "😳",
  "😶",
  "🙁",
  "🙂",
  "🙃",
  "🚀",
  "🚁",
  "🚌",
  "🚑",
  "🚒",
  "🚔",
  "🚕",
  "🚗",
  "🚙",
  "🚛",
  "🚣‍♀",
  "🚣‍♂",
  "🚴‍♀",
  "🚴‍♂",
  "🚶‍♀",
  "🚶‍♂",
  "🛳️",
]);
</script>

<style lang="scss">
.emoji-picker__emojis-scroll {
  height: 360px;
  overflow-y: scroll;
}

.emoji-picker__emojis {
  display: flex;
  flex-wrap: wrap;
  width: 38px * 6;

  button {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    margin: 3px;
    border: var(--el-border);
    border-color: var(--el-border-color);
    border-radius: 6px;
    cursor: pointer;
  }
}
</style>
