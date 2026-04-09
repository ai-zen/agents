<template>
  <div class="endpoint-edit-page">
    <el-page-header :content="currentModeConfig?.title" @back="$router.back()">
    </el-page-header>

    <el-form
      class="form"
      :model="formState.form"
      v-loading="formState.isLoading"
      ref="formRef"
      label-width="120px"
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
        <!-- <EmojiInput v-model="formState.form.icon"></EmojiInput> -->
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
        prop="endpoint_key"
        label="服务端类型"
        :rules="{ required: true, message: '请选择服务端类型' }"
      >
        <el-select v-model="formState.form.endpoint_key">
          <el-option
            v-for="(endpoint, key) of Endpoints"
            :value="key"
            :label="endpoint.title"
          ></el-option>
          <!-- 如果要针对服务端标题做i18n可以拿key去做 -->
          <!-- TODO: 切换的时候还需要给默认值 -->
        </el-select>
      </el-form-item>

      <component
        v-if="
          formState.form.endpoint_key &&
          ENDPOINTS_FORMS_MAP[formState.form.endpoint_key]
        "
        :is="ENDPOINTS_FORMS_MAP[formState.form.endpoint_key]"
        :endpoint_config="formState.form.endpoint_config"
        :endpoint_key="formState.form.endpoint_key"
      >
      </component>

      <el-form-item>
        <el-button
          type="primary"
          @click="submit"
          :icon="Check"
          :loading="formState.isSaving"
          >完成</el-button
        >
      </el-form-item>

      <!-- <el-form-item>
        <pre><code>{{ formState.form }}</code></pre>
      </el-form-item> -->
    </el-form>
  </div>
</template>

<script setup lang="ts">
import { Endpoints } from "@ai-zen/agents-core";
import { Check } from "@element-plus/icons-vue";
import { ElForm, ElMessage } from "element-plus";
import { computed, onMounted, reactive, ref } from "vue";
import { useRoute } from "vue-router";
import * as api from "../../../api";
import { ENDPOINTS_FORMS_MAP } from "../../../components/EndpointForms";
import router from "../../../router";
import { ChatPL } from "../../../types/ChatPL";
import { FormMode } from "../../../types/Common";
import { uuid } from "../../../utils/uuid";

const formRef = ref<InstanceType<typeof ElForm> | null>(null);

const route = useRoute();

const MODE_CONFIG: Record<FormMode, { title: string }> = {
  create: {
    title: "新增服务端",
  },
  edit: {
    title: "编辑服务端",
  },
};

const currentModeConfig = computed(
  () => MODE_CONFIG[route.query.mode as FormMode],
);

function createEndpoint() {
  return <ChatPL.EndpointPO>{
    id: uuid(),
    title: "",
    icon: "🌏",
    endpoint_config: {
      url: "",
      headers: {
        // "Content-Type": "application/json",
        // Authorization: "",
        // "api-key": "",
      },
      body: {},
    },
  };
}

const formState = reactive({
  form: createEndpoint(),
  isLoading: false,
  isSaving: false,
});

onMounted(async () => {
  try {
    formState.isLoading = true;
    if (route.query.mode == FormMode.Create) {
      formState.form = createEndpoint();
    } else if (
      route.query.mode == FormMode.Edit &&
      typeof route.query.id == "string"
    ) {
      const endpoint = await api.getEndpoint(route.query.id);
      if (!endpoint)
        throw new Error(`未查找到 id == ${route.query.id} 对应的服务端`);
      formState.form = endpoint;
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
    const endpoint = JSON.parse(JSON.stringify(formState.form));

    if (route.query.mode == FormMode.Create) {
      await api.addEndpoint(endpoint);
    } else {
      await api.editEndpoint(endpoint);
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
.endpoint-edit-page {
  padding: 20px;
}

.form {
  margin-top: 20px;
  width: 600px;
}

.message-list {
  display: flex;
  flex-direction: column;
  width: 100%;

  .message {
    border-left: 2px solid var(--el-color-primary-light-5);
    padding-left: 12px;
  }

  .message + .message {
    margin-top: 12px;
  }

  .role {
    width: 0;
    flex-grow: 1;
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
