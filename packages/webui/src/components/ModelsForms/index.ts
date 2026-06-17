import { Models } from "@ai-zen/agents-core";
import { defineComponent } from "vue";
import ChatGPT_ModelConfigForm from "./ChatGPT.vue";

type ModelsFormsMap = Record<
  keyof typeof Models,
  ReturnType<typeof defineComponent>
>;

export const MODELS_FORMS_MAP: Partial<ModelsFormsMap> = {
  ChatGPT: ChatGPT_ModelConfigForm,
  TextEmbeddingAda002_2: undefined,
};
