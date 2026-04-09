<template>
  <div
    class="chat-message"
    :class="{ 'my-message': message.role === AgentNS.Role.User }"
  >
    <div class="message-header">
      <span class="message-sender">{{ props.roleText[message.role] }}</span>
    </div>
    <div class="message-body">
      <div class="message-content">
        <Markdown
          v-if="renderedContent.html"
          :markdown="renderedContent.output"
        ></Markdown>
        <div v-else class="raw">{{ renderedContent.output }}</div>
      </div>

      <div class="message-append">
        <div class="message-append-row">
          <div
            class="text-button is-hover-show"
            :class="{ 'is-active': isUseMarkdown }"
            @click="isUseMarkdown = !isUseMarkdown"
            title="是否以Markdown格式展示聊天内容"
          >
            MD
          </div>
        </div>
        <div class="message-append-row">
          <template v-if="message.role == AgentNS.Role.Assistant">
            <div
              class="text-button"
              v-if="message.status == AgentNS.MessageStatus.Completed"
              @click="onCopyClick"
            >
              复制
            </div>
            <div v-else-if="message.status" class="text-status">
              {{
                {
                  [AgentNS.MessageStatus.Pending]: "思考中",
                  [AgentNS.MessageStatus.Writing]: "输出中",
                  [AgentNS.MessageStatus.Completed]: "完成",
                  [AgentNS.MessageStatus.Error]: "发生错误",
                  [AgentNS.MessageStatus.Aborted]: "已中止",
                  [AgentNS.MessageStatus.Unknown]: "未知状态",
                }[message.status]
              }}
            </div>
          </template>
        </div>
      </div>
    </div>
    <div class="message-footer">
      <slot name="footer"></slot>
    </div>
  </div>
</template>

<script setup lang="ts">
import { PropType, computed, ref } from "vue";
import { AgentNS } from "@ai-zen/agents-core";
import { ElMessage } from "element-plus";
import Markdown from "./Markdown.vue";

const props = defineProps({
  message: {
    type: Object as PropType<AgentNS.Message>,
    required: true,
  },
  roleText: {
    type: Object as PropType<Record<AgentNS.Role, string>>,
    default: () => ({
      [AgentNS.Role.System]: "系统",
      [AgentNS.Role.User]: "你",
      [AgentNS.Role.Assistant]: "AI助手",
      [AgentNS.Role.Function]: "函数调用结果",
      [AgentNS.Role.Tool]: "工具使用结果",
    }),
  },
});

/**
 * 是否使用 markdown
 */
const isUseMarkdown = ref(true);

/**
 * 格式化输出消息内容
 */
const renderedContent = computed((): { output: string; html: boolean } => {
  const msg = props.message;
  const msg_content = msg.raw_content || msg.content;
  const is_empty =
    !msg_content?.length && !msg.function_call && !msg.tool_calls?.length;

  if (msg.status == AgentNS.MessageStatus.Pending && is_empty) {
    return { output: "思考中...", html: false };
  } else if (msg.status == AgentNS.MessageStatus.Writing && is_empty) {
    return { output: "输出中...", html: false };
  } else if (msg.status == AgentNS.MessageStatus.Error) {
    return {
      output: msg_content?.toString() || "发生未知错误",
      html: false,
    };
  } else {
    let output = "";

    if (msg_content instanceof Array) {
      output = msg_content
        .map((section) => {
          switch (section.type) {
            case "image_url":
              return `![a image](${section.image_url?.url})`;
            case "text":
              return section.text;
          }
        })
        .join("");
    } else {
      output = msg_content || "";
    }

    if (msg.role == AgentNS.Role.Function || msg.role == AgentNS.Role.Tool) {
      output = `\`${msg.name}\`\n\n`;
      output += `\n\`\`\`\`\`\`json\n${msg_content}\n\`\`\`\`\`\``;
    }

    if (msg.function_call) {
      if (output) output += "\n\n---\n\n";
      output += `正在调用函数：\`${msg.function_call?.name}\`\n\n`;
      output += `\n\`\`\`json\n${msg.function_call?.arguments}\n\`\`\``;
    }

    if (msg.tool_calls?.length) {
      msg.tool_calls.forEach((tool_call) => {
        if (output) output += "\n\n---\n\n";
        output += `正在调用工具函数：\`${tool_call.function?.name}\`\n\n`;
        output += `\n\`\`\`json\n${tool_call.function?.arguments}\n\`\`\``;
      });
    }

    // TODO: 以下内容改为markdown警告展示
    if (msg.finish_reason == AgentNS.FinishReason.ContentFilter) {
      output += "内容很不幸被过滤了";
    } else if (msg.finish_reason == AgentNS.FinishReason.Length) {
      output += "内容超出长度限制";
    }

    if (!output) {
      output = "未获得任何内容";
    }

    return { output, html: isUseMarkdown.value };
  }
});

async function onCopyClick() {
  try {
    await navigator.clipboard.writeText(renderedContent.value.output);
    ElMessage.success("复制成功");
  } catch {}
}
</script>

<style lang="scss" scoped>
.chat-message {
  display: flex;
  flex-direction: column;
  margin: 0.5em;
  font-size: 14px;
}

.message-header {
  width: 100%;
  display: flex;
  align-items: center;
  margin-bottom: 0.5rem;

  .message-time {
    font-size: 0.8rem;
  }
}

.my-message .message-header {
  flex-direction: row-reverse;
}

.message-body {
  width: 100%;
  display: flex;

  .message-content {
    display: block;
    width: max-content;
    height: max-content;
    padding: 0.75em 1em;
    border-radius: 6px;
    max-width: calc(100% - 100px);
    box-sizing: border-box;
    line-height: 1.5em;
    background-color: var(--el-bg-color-page);

    .dark & {
      box-shadow: var(--el-box-shadow-light);
      border: var(--el-border);
    }

    .raw {
      white-space: pre-wrap;
    }

    .markdown {
      white-space: normal;
    }
  }
}

.my-message .message-body {
  flex-direction: row-reverse;
}

.message-append {
  display: flex;
  flex-direction: column;
  justify-content: flex-end;

  .message-append-row {
    display: flex;
    align-items: center;
    padding: 0 0.3em;
  }

  .text-status {
    font-size: 12px;
    color: #999;
    margin: 3px;
    flex-shrink: 0;

    &.is-hover-show {
      opacity: 0;
    }
  }

  .text-button {
    font-size: 12px;
    color: #999;
    margin: 3px;
    flex-shrink: 0;

    cursor: pointer;

    &.is-hover-show {
      opacity: 0;
    }

    &.is-active {
      text-decoration: underline;
    }
  }
}

.message-body:hover .message-append .is-hover-show {
  opacity: 1;
}

.my-message .message-append .message-append-row {
  flex-direction: row-reverse;
}
</style>
