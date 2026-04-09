<template>
  <div class="message-list">
    <div
      class="message"
      v-for="(message, index) of modelValue"
      :key="index"
      :class="message.role"
    >
      <el-row>
        <el-select class="role" v-model="message.role">
          <el-option :value="AgentNS.Role.System" label="系统"></el-option>
          <el-option :value="AgentNS.Role.Assistant" label="助手"></el-option>
          <el-option :value="AgentNS.Role.User" label="用户"></el-option>
        </el-select>
        <el-tooltip
          v-if="allowSet?.includes('hidden')"
          effect="light"
          placement="top"
          content="勾选此选项时，用户将看不到此消息，通常用于隐藏提示词和少样本训练。"
        >
          <el-checkbox class="hidden" v-model="message.hidden"
            >隐藏</el-checkbox
          >
        </el-tooltip>
        <el-tooltip
          v-if="allowSet?.includes('omit')"
          effect="light"
          placement="top"
          content="勾选此选项时，此消息将不会发送给服务端，通常用于欢迎语"
        >
          <el-checkbox class="omit" v-model="message.omit">排除</el-checkbox>
        </el-tooltip>
        <el-button
          class="delete"
          type="danger"
          plain
          :disabled="modelValue.length === 1"
          @click="deleteMessage(index)"
        >
          <el-icon> <Delete /> </el-icon>&ensp;删除</el-button
        >
      </el-row>
      <el-input
        class="content"
        v-model="(message.content as string)"
        type="textarea"
        resize="vertical"
        placeholder="请输入聊天内容"
      ></el-input>
    </div>
    <el-row class="button-row">
      <el-button type="success" plain @click="addMessage()">
        <el-icon> <Plus /> </el-icon>&ensp;新增预设消息</el-button
      >
    </el-row>
  </div>
</template>

<script setup lang="ts">
import { Delete, Plus } from "@element-plus/icons-vue";
import { PropType } from "vue";
import { AgentNS } from "@ai-zen/agents-core";

const props = defineProps({
  modelValue: {
    required: true,
    type: Array as PropType<AgentNS.Message[]>,
  },
  allowSet: {
    required: false,
    type: Array as PropType<("hidden" | "omit")[]>,
  },
});

function deleteMessage(index: number) {
  props.modelValue.splice(index, 1);
}

function addMessage() {
  // 根据上一条消息的角色自动安排下一个消息的角色
  const lastMessage = props.modelValue.at(-1);
  let role = AgentNS.Role.User;
  switch (lastMessage?.role) {
    case AgentNS.Role.System:
      role = AgentNS.Role.User;
      break;
    case AgentNS.Role.Assistant:
      role = AgentNS.Role.User;
      break;
    case AgentNS.Role.User:
      role = AgentNS.Role.Assistant;
      break;
  }

  props.modelValue.push({
    role,
    content: "",
    hidden: true,
    status: AgentNS.MessageStatus.Completed,
  });
}
</script>

<style lang="scss" scoped>
.message-list {
  display: flex;
  flex-direction: column;
  width: 100%;

  .message {
    border-left: 2px solid;
    padding-left: 12px;
    &.system {
      border-color: var(--el-color-danger-light-5);
    }
    &.assistant {
      border-color: var(--el-color-success-light-5);
    }
    &.user {
      border-color: var(--el-color-primary-light-5);
    }
  }

  .message + .message {
    margin-top: 12px;
  }

  .role {
    width: 0;
    flex-grow: 1;
  }

  .hidden,
  .omit {
    margin-left: 12px;
    margin-right: 0px;
  }

  .delete {
    margin-left: 12px;
  }

  .message {
    width: 100%;
  }

  .label {
    color: var(--el-text-color-secondary);
  }

  .content {
    margin-top: 6px;
  }

  .button-row {
    margin-top: 12px;
  }
}
</style>
