<template>
  <div class="agent-edit-page">
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
        prop="messages"
        label="预设消息"
        :rules="{
          required: true,
          type: 'array',
          validator(_rule, value: AgentNS.Message[], callback) {
            if (!value.length) {
              callback(new Error('请添加预设消息'));
            } else if (value.at(-1)?.role == AgentNS.Role.Assistant) {
              callback(new Error('预设消息不能以 AI 角色的消息结尾'));
            } else {
              callback();
            }
          },
        }"
      >
        <el-text size="small">
          {{
            "可以使用 \{\{ 参数名称 \}\} 的方式将调用入参作为变量加入到预设消息中。"
          }}
        </el-text>
        <MessagesEditor v-model="formState.form.messages" />
      </el-form-item>

      <el-form-item
        prop="model_id"
        label="模型"
        :rules="{ required: true, message: '请选择模型' }"
      >
        <el-select v-model="formState.form.model_id">
          <el-option
            v-for="model of modelState.list"
            :value="model.id"
            :label="model.title"
          ></el-option>
        </el-select>
      </el-form-item>

      <component
        v-if="
          formState.form.model_id && MODELS_FORMS_MAP[currentModelPo?.base!]
        "
        :is="MODELS_FORMS_MAP[currentModelPo?.base!]"
        :model_config="formState.form.model_config"
        :model_po="getModel(formState.form.model_id)"
      >
      </component>

      <el-form-item
        prop="knowledge_bases_ids"
        label="知识库"
        :rules="{ required: false, type: 'array' }"
      >
        <el-select v-model="formState.form.knowledge_bases_ids" multiple>
          <el-option
            v-for="knowledgeBase of knowledgeBaseState.list"
            :value="knowledgeBase.id"
            :label="knowledgeBase.title"
          ></el-option>
        </el-select>
      </el-form-item>

      <el-form-item
        prop="retrieval_type"
        label="知识召回方式"
        :rules="{
          required: Boolean(formState.form.knowledge_bases_ids.length),
          message: '请选择知识库召回方式',
        }"
      >
        <el-select v-model="formState.form.retrieval_type" clearable>
          <el-option
            :value="ChatPL.RetrievalType.RAG_EMBEDDING_SEARCH"
            label="RAG向量化搜索"
          ></el-option>
          <el-option
            :value="ChatPL.RetrievalType.TOOL_INDEXED_SEARCH"
            label="TOOL索引搜索"
          ></el-option>
        </el-select>
      </el-form-item>

      <el-form-item
        prop="agent_tools_ids"
        label="子智能体"
        :rules="{ required: false, type: 'array' }"
      >
        <el-select v-model="formState.form.agent_tools_ids" multiple>
          <!-- 过滤自己 -->
          <el-option
            v-for="agent of agentToolState.list.filter(
              (x) => x.id !== formState.form.id,
            )"
            :value="agent.id"
            :label="agent.title"
          ></el-option>
        </el-select>
      </el-form-item>

      <el-form-item
        prop="tools_ids"
        label="工具"
        :rules="{ required: false, type: 'array' }"
      >
        <el-select v-model="formState.form.tools_ids" multiple>
          <el-option
            v-for="tool of toolState.list"
            :value="tool.id"
            :label="tool.title"
          ></el-option>
        </el-select>
      </el-form-item>

      <el-form-item>
        <el-button
          type="primary"
          @click="submit"
          :icon="Check"
          :loading="formState.isSaving"
          >完成
        </el-button>
      </el-form-item>
    </el-form>
  </div>
</template>

<script setup lang="ts">
import { AgentNS } from "@ai-zen/agents-core";
import { Check } from "@element-plus/icons-vue";
import { ElForm, ElMessage } from "element-plus";
import { computed, onMounted, reactive, ref } from "vue";
import { useRoute } from "vue-router";
import * as api from "../../../api";
import MessagesEditor from "../../../components/MessagesEditor/index.vue";
import { MODELS_FORMS_MAP } from "../../../components/ModelsForms";
import ParametersEditor from "../../../components/ParametersEditor/index.vue";
import { useAgentTool } from "../../../composables";
import { useKnowledgeBase } from "../../../composables/useKnowledgeBase";
import { useModel } from "../../../composables/useModel";
import { useTool } from "../../../composables/useTool";
import router from "../../../router";
import { ChatPL } from "../../../types/ChatPL";
import { FormMode } from "../../../types/Common";
import { uuid } from "../../../utils/uuid";

const formRef = ref<InstanceType<typeof ElForm> | null>(null);

const route = useRoute();

const MODE_CONFIG: Record<FormMode, { title: string }> = {
  create: {
    title: "新增智能体",
  },
  edit: {
    title: "编辑智能体",
  },
};

const { modelState, initModelState, getModel } = useModel();

const currentModeConfig = computed(
  () => MODE_CONFIG[route.query.mode as FormMode],
);

const currentModelPo = computed(() =>
  modelState.list.find((model) => model.id == formState.form.model_id),
);

function createAgent() {
  return <ChatPL.AgentToolPO>{
    model_id: "",
    agent_tools_ids: [],
    icon: "🤖",
    id: uuid(),
    knowledge_bases_ids: [],
    retrieval_type: undefined,
    messages: [
      {
        role: AgentNS.Role.System,
        content: "你是一个AI助手，专门帮助用户查找信息。",
        hidden: true,
        status: AgentNS.MessageStatus.Completed,
      },
    ],
    model_config: {},
    title: "",
    tools_ids: [],
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
  };
}

const formState = reactive({
  form: createAgent(),
  isLoading: false,
  isSaving: false,
});

onMounted(async () => {
  try {
    formState.isLoading = true;
    if (route.query.mode == FormMode.Create) {
      formState.form = createAgent();
    } else if (
      route.query.mode == FormMode.Edit &&
      typeof route.query.id == "string"
    ) {
      const agent = await api.getAgentTool(route.query.id);
      if (!agent)
        throw new Error(`未查找到 id == ${route.query.id} 对应的智能体`);
      formState.form = agent;
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
    const agent = JSON.parse(JSON.stringify(formState.form));

    if (route.query.mode == FormMode.Create) {
      await api.addAgentTool(agent);
    } else {
      await api.editAgentTool(agent);
    }

    ElMessage.success("操作成功！");

    router.back(); // 立即回到上一页
  } catch (error: any) {
    ElMessage.error(`操作失败：${error?.message || "未知错误"}`);
  } finally {
    formState.isSaving = false;
  }
}

const { knowledgeBaseState, initKnowledgeBaseState } = useKnowledgeBase();
const { agentToolState, initAgentToolState } = useAgentTool();
const { toolState, initToolState } = useTool();

onMounted(() => {
  initKnowledgeBaseState();
  initAgentToolState();
  initToolState();
  initModelState();
});
</script>

<style lang="scss" scoped>
.agent-edit-page {
  padding: 20px;
}

.form {
  margin-top: 20px;
  width: 600px;
}
</style>
