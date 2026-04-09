<template>
  <div class="model-edit-page">
    <el-page-header :content="currentModeConfig?.title" @back="$router.back()">
    </el-page-header>

    <el-form
      class="form"
      :model="formState.form"
      v-loading="formState.isLoading"
      ref="formRef"
      label-width="150px"
    >
      <el-form-item
        prop="id"
        label="编号"
        :rules="{ required: true, message: '请输入编号' }"
      >
        <el-input
          :disabled="route.query.mode == FormMode.Edit"
          v-model="formState.form.id"
        ></el-input>
      </el-form-item>

      <el-form-item
        prop="icon"
        label="图标"
        :rules="{ required: true, message: '请选择图标' }"
      >
        <el-input
          v-model="formState.form.icon"
          placeholder="可以输入 emoji 或 图片url（http:// 或 https:// 开头）"
        ></el-input>
      </el-form-item>

      <el-form-item
        prop="title"
        label="标题"
        :rules="{ required: true, message: '请输入标题' }"
      >
        <el-input
          v-model="formState.form.title"
          placeholder="请输入标题"
        ></el-input>
      </el-form-item>

      <el-form-item
        prop="name"
        label="模型标识"
        :rules="{ required: true, message: '请输入模型标识' }"
      >
        <el-input
          v-model="formState.form.name"
          placeholder="请输入模型标识，用于服务端调用的唯一标识"
        ></el-input>
      </el-form-item>

      <el-form-item
        prop="type"
        label="模型类型"
        :rules="{ required: true, message: '请选择模型类型' }"
      >
        <el-select v-model="formState.form.type" placeholder="请选择模型类型">
          <el-option
            label="聊天补全模型"
            :value="ModelType.ChatCompletion"
          ></el-option>
          <el-option label="嵌入模型" :value="ModelType.Embedding"></el-option>
        </el-select>
      </el-form-item>

      <el-form-item
        prop="base"
        label="模型基类"
        :rules="{ required: true, message: '请选择模型基类' }"
      >
        <el-select v-model="formState.form.base" placeholder="请选择模型基类">
          <el-option
            v-for="(model, key) of ChatCompletionModels"
            :value="key"
            :label="model.title"
          ></el-option>
          <el-option label="Claude" value="Claude" disabled></el-option>
          <el-option label="Gemini" value="Gemini" disabled></el-option>
        </el-select>
      </el-form-item>

      <el-form-item
        prop="endpoint_id"
        label="服务端"
        :rules="{ required: true, message: '请选择服务端' }"
      >
        <el-select
          v-model="formState.form.endpoint_id"
          placeholder="请选择服务端"
        >
          <el-option
            v-for="endpoint in endpointList"
            :key="endpoint.id"
            :label="endpoint.title"
            :value="endpoint.id"
          ></el-option>
        </el-select>
      </el-form-item>

      <el-divider content-position="left">高级配置</el-divider>

      <el-form-item prop="INPUT_MAX_TOKENS" label="最大输入Token">
        <el-input-number
          v-model="formState.form.INPUT_MAX_TOKENS"
          :min="0"
          placeholder="请输入最大输入Token数"
          style="width: 100%"
        />
      </el-form-item>

      <el-form-item
        prop="OUTPUT_MAX_TOKENS_LOWER_LIMIT"
        label="最大输出Token下限"
      >
        <el-input-number
          v-model="formState.form.OUTPUT_MAX_TOKENS_LOWER_LIMIT"
          :min="0"
          placeholder="请输入最大输出Token下限数"
          style="width: 100%"
        />
      </el-form-item>

      <el-form-item prop="OUTPUT_MAX_TOKENS" label="最大输出Token上限">
        <el-input-number
          v-model="formState.form.OUTPUT_MAX_TOKENS"
          :min="0"
          placeholder="请输入最大输出Token上限数"
          style="width: 100%"
        />
      </el-form-item>

      <el-form-item prop="IS_SUPPORT_FUNCTION_CALL" label="支持函数调用">
        <el-switch v-model="formState.form.IS_SUPPORT_FUNCTION_CALL" />
      </el-form-item>

      <el-form-item prop="IS_SUPPORT_TOOLS_CALL" label="支持工具调用">
        <el-switch v-model="formState.form.IS_SUPPORT_TOOLS_CALL" />
      </el-form-item>

      <el-form-item prop="IS_SUPPORT_IMAGE_CONTENT" label="支持图片内容">
        <el-switch v-model="formState.form.IS_SUPPORT_IMAGE_CONTENT" />
      </el-form-item>

      <el-form-item>
        <el-button
          type="primary"
          @click="submit"
          :icon="Check"
          :loading="formState.isSaving"
          >完成</el-button
        >
      </el-form-item>
    </el-form>
  </div>
</template>

<script setup lang="ts">
import { Check } from "@element-plus/icons-vue";
import { ElForm, ElMessage } from "element-plus";
import { computed, onMounted, reactive, ref } from "vue";
import { useRoute } from "vue-router";
import * as api from "../../../api";
import router from "../../../router";
import { ChatPL } from "../../../types/ChatPL";
import { FormMode } from "../../../types/Common";
import { uuid } from "../../../utils/uuid";
import { ChatCompletionModels } from "@ai-zen/agents-core";
import { ModelType } from "@ai-zen/agents-core/dist/Model";

const formRef = ref<InstanceType<typeof ElForm> | null>(null);

const route = useRoute();

const MODE_CONFIG: Record<FormMode, { title: string }> = {
  create: {
    title: "新增模型",
  },
  edit: {
    title: "编辑模型",
  },
};

const currentModeConfig = computed(
  () => MODE_CONFIG[route.query.mode as FormMode],
);

function createModel() {
  return <ChatPL.ModelPO>{
    id: uuid(),
    title: "",
    icon: "🤖",
    name: "",
    type: ModelType.ChatCompletion,
    base: "ChatGPT",
    endpoint_id: "",
  };
}

const formState = reactive({
  form: createModel(),
  isLoading: false,
  isSaving: false,
});

const endpointList = ref<ChatPL.EndpointPO[]>([]);

async function loadEndpointList() {
  try {
    endpointList.value = await api.getEndpointList();
  } catch (error: any) {
    ElMessage.error(`加载服务端列表失败：${error?.message}`);
  }
}

onMounted(async () => {
  try {
    formState.isLoading = true;
    await loadEndpointList();

    if (route.query.mode == FormMode.Create) {
      formState.form = createModel();
    } else if (
      route.query.mode == FormMode.Edit &&
      typeof route.query.id == "string"
    ) {
      const model = await api.getModel(route.query.id);
      if (!model)
        throw new Error(`未查找到 id == ${route.query.id} 对应的模型`);
      formState.form = model;
    } else {
      throw new Error(`非法访问`);
    }
  } catch (error: any) {
    ElMessage.error(`初始化表单失败：${error?.message}`);
  } finally {
    formState.isLoading = false;
  }
});

async function submit() {
  formState.isSaving = true;

  try {
    await formRef.value?.validate();
  } catch (error) {
    formState.isSaving = false;
    ElMessage.error("请确保所有内容填写正确！");
    return;
  }

  try {
    const model = JSON.parse(JSON.stringify(formState.form));

    if (route.query.mode == FormMode.Create) {
      await api.addModel(model);
    } else {
      await api.editModel(model);
    }

    ElMessage.success("操作成功！");

    router.back(); // 立即回到上一页
  } catch (error: any) {
    ElMessage.error(`操作失败：${error?.message || "未知错误"}`);
  } finally {
    formState.isSaving = false;
  }
}
</script>

<style lang="scss" scoped>
.model-edit-page {
  padding: 20px;
}

.form {
  margin-top: 20px;
  width: 600px;
}
</style>
