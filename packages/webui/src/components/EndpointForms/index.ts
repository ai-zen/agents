import { EndpointKeys } from "@ai-zen/agents-core";
import { defineComponent } from "vue";
import AzureOpenAI_EndpointConfigForm from "./AzureOpenAI.vue";
import CommonEndpoint_EndpointConfigForm from "./CommonEndpoint.vue";
import OpenAI_EndpointConfigForm from "./OpenAI.vue";
import Zhipu_EndpointConfigForm from "./Zhipu.vue";

type EndpointsFormsMap = Record<
  EndpointKeys,
  ReturnType<typeof defineComponent>
>;

export const ENDPOINTS_FORMS_MAP: EndpointsFormsMap = {
  AzureOpenAI: AzureOpenAI_EndpointConfigForm,
  CommonEndpoint: CommonEndpoint_EndpointConfigForm,
  OpenAI: OpenAI_EndpointConfigForm,
  Zhipu: Zhipu_EndpointConfigForm,
};
