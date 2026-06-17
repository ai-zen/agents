<template>
  <div class="tool-edit-page">
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
        prop="function.name"
        label="调用名称"
        :rules="{ required: true, message: '请输入调用名称' }"
      >
        <el-input
          v-model="formState.form.function.name"
          placeholder="请输入调用名称"
        ></el-input>
      </el-form-item>

      <el-form-item
        prop="function.description"
        label="调用描述"
        :rules="{ required: true, message: '请输入调用描述' }"
      >
        <el-input
          v-model="formState.form.function.description"
          placeholder="请输入调用描述"
        ></el-input>
      </el-form-item>

      <el-form-item prop="function.parameters" label="调用入参">
        <ParametersEditor v-model="formState.form.function.parameters" />
      </el-form-item>

      <el-form-item
        prop="code"
        label="代码"
        :rules="{ required: true, message: '请输入代码' }"
      >
        <el-input
          v-model="formState.form.code"
          type="textarea"
          :rows="10"
          placeholder="请输入代码，必须使用 return 返回结果"
        ></el-input>
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

      <!-- <el-form-item>
        <pre><code>{{ formState.form }}</code></pre>
      </el-form-item> -->
    </el-form>
  </div>
</template>

<script setup lang="ts">
import { Check } from "@element-plus/icons-vue";
import { ElForm, ElMessage } from "element-plus";
import { computed, onMounted, reactive, ref } from "vue";
import { useRoute } from "vue-router";
import * as api from "../../../api";
import ParametersEditor from "../../../components/ParametersEditor/index.vue";
import router from "../../../router";
import { ChatPL } from "../../../types/ChatPL";
import { FormMode } from "../../../types/Common";
import { uuid } from "../../../utils/uuid";

const formRef = ref<InstanceType<typeof ElForm> | null>(null);

const route = useRoute();

const MODE_CONFIG: Record<FormMode, { title: string }> = {
  create: {
    title: "新增工具",
  },
  edit: {
    title: "编辑工具",
  },
};

const currentModeConfig = computed(
  () => MODE_CONFIG[route.query.mode as FormMode],
);

function createTool() {
  return <ChatPL.ToolPO>{
    id: uuid(),
    title: "",
    icon: "🌏",
    type: "function",
    function: {
      parameters: {
        type: "object",
        properties: {
          arg1: {
            type: "string",
            description: "参数1说明",
          },
        },
        required: ["arg1"],
      },
      description: "",
      name: "",
    },
    code: "",
  };
}

const formState = reactive({
  form: createTool(),
  isLoading: false,
  isSaving: false,
});

onMounted(async () => {
  try {
    formState.isLoading = true;
    if (route.query.mode == FormMode.Create) {
      formState.form = createTool();
    } else if (
      route.query.mode == FormMode.Edit &&
      typeof route.query.id == "string"
    ) {
      const tool = await api.getTool(route.query.id);
      if (!tool) throw new Error(`未查找到 id == ${route.query.id} 对应的工具`);
      formState.form = tool;
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
    const tool = JSON.parse(JSON.stringify(formState.form));

    if (route.query.mode == FormMode.Create) {
      await api.addTool(tool);
    } else {
      await api.editTool(tool);
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
.tool-edit-page {
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
