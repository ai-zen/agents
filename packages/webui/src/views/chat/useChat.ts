import { Agent } from "@ai-zen/agents-core";
import { computed, ref, watch } from "vue";
import { useDeserialize } from "../../composables/useDeserialize";
import { ChatPL } from "../../types/ChatPL";

export function useChat(options: {
  getCurrentSession(): ChatPL.SessionPO | undefined;
  getCurrentSessionAgent(): ChatPL.AgentPO | undefined;
  getEndpoint(id: string): ChatPL.EndpointPO | undefined;
  getModel(id: string): ChatPL.ModelPO | undefined;
  getTools(ids: string[]): ChatPL.ToolPO[];
  getAgentTools(ids: string[]): ChatPL.AgentToolPO[];
  getAgents(ids: string[]): ChatPL.AgentPO[];
  getKnowledgeBases(ids: string[]): ChatPL.KnowledgeBasePO[];
}) {
  const { formatAgent } = useDeserialize({
    getEndpoint: options.getEndpoint,
    getModel: options.getModel,
    getTools: options.getTools,
    getAgentTools: options.getAgentTools,
    getAgents: options.getAgents,
    getKnowledgeBases: options.getKnowledgeBases,
  });

  const chatRef = ref<Agent>();

  async function initChat() {
    const sessionPO = options.getCurrentSession();
    if (!sessionPO) return;
    const agentPO = options.getCurrentSessionAgent();
    if (!agentPO) return;
    if (!sessionPO.model_id && !agentPO.model_id) return;
    chatRef.value = await formatAgent({
      ...agentPO,
      model_id: sessionPO.model_id || agentPO.model_id,
      model_config: {
        ...agentPO.model_config,
        ...sessionPO.model_config,
      },
    });
    chatRef.value.messages = sessionPO.messages;
  }

  watch(
    [
      () => options.getCurrentSession(),
      () => options.getCurrentSession()?.model_id,
      () => options.getCurrentSession()?.model_config,
    ],
    initChat,
  );

  const isHasPendingMessage = computed(() => {
    return chatRef.value?.isHasPendingMessage;
  });

  return {
    chatRef,
    isHasPendingMessage,
  };
}
