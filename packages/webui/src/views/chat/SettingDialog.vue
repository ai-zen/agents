<template>
  <el-dialog title="智能体配置" v-model="dialogState.visible">
    <el-form
      v-if="currentSession && currentSessionAgent"
      :model="currentSession"
      ref="formRef"
      label-position="top"
    >
      <el-form-item prop="model_id" label="聊天模型" :rules="MODEL_KEY_RULE">
        <el-select
          v-model="currentSession.model_id"
          style="width: 100%"
          clearable
        >
          <el-option
            v-for="model of modelState.list.filter(
              (x) => x.type == ModelType.ChatCompletion,
            )"
            :label="model.title"
            :value="model.id"
          ></el-option>
        </el-select>
      </el-form-item>
    </el-form>
  </el-dialog>
</template>

<script setup lang="ts">
import { ElForm, FormItemRule } from "element-plus";
import { onMounted, reactive, ref } from "vue";
import { useModel } from "../../composables/useModel";
import { ChatPL } from "../../types/ChatPL";
import { ModelType } from "@ai-zen/agents-core/dist/Model";

const formRef = ref<InstanceType<typeof ElForm> | null>(null);

defineProps<{
  modelState: ReturnType<typeof useModel>["modelState"];
  currentSession?: ChatPL.SessionPO;
  currentSessionAgent?: ChatPL.AgentPO;
  currentModelId?: string;
}>();

const MODEL_KEY_RULE: FormItemRule = {
  validator(_rule, value, callback) {
    if (!value) {
      callback(new Error("请选择聊天模型"));
    } else {
      callback();
    }
  },
};

const dialogState = reactive({
  visible: true, // 提前渲染会话表单，这样才能正确地直接通过 validate 方法触发验证。
});

onMounted(() => {
  dialogState.visible = false;
});

function open() {
  dialogState.visible = true;
}

function validate() {
  return formRef.value?.validate();
}

defineExpose({ open, validate });
</script>
