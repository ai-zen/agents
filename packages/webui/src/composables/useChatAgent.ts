import { AgentNS } from "@ai-zen/agents-core";
import { reactive, watch } from "vue";
import * as api from "../api";
import { ChatPL } from "../types/ChatPL";
import { debounce } from "../utils/debounce";
import { useAgent } from "./useAgent";

export function useChatAgent() {
  const { agentState, initAgentState } = useAgent();

  const chatAgentState = reactive({
    list: [] as ChatPL.AgentPO[],
    isLoading: false,
    isReady: false,
    isSaving: false,
    current: null as ChatPL.AgentPO | null,
  });

  async function getList() {
    try {
      chatAgentState.isLoading = true;
      await initAgentState();
      const list = agentState.list;
      const current = await api.getCurrentAgentId();
      chatAgentState.list = [createDefaultAgent(), ...list];
      const index = chatAgentState.list.findIndex((item) => item.id == current);
      if (index > -1) {
        chatAgentState.current = chatAgentState.list[index];
      } else {
        chatAgentState.current = chatAgentState.list[0];
      }
      chatAgentState.isReady = true;
    } finally {
      chatAgentState.isLoading = false;
    }
  }

  function initChatAgentState() {
    return getList();
  }

  function createDefaultAgent() {
    return <ChatPL.AgentPO>{
      model_id: "",
      agent_tools_ids: [],
      icon: "🤖",
      id: "default",
      knowledge_bases_ids: [],
      messages: [
        {
          role: AgentNS.Role.Assistant,
          content: "你好，请问有什么需要帮助的？",
          omit: true,
          status: AgentNS.MessageStatus.Completed,
        },
      ],
      model_config: [],
      title: "空白智能体",
      tools_ids: [],
    };
  }

  async function saveCurrentAgentId(agentId: string | null | undefined) {
    console.log("saveCurrentAgentId", agentId);
    try {
      chatAgentState.isSaving = true;
      api.setCurrentAgentId(agentId);
    } finally {
      chatAgentState.isSaving = false;
    }
  }

  // 在当前对话ID变化时自动保存当前对话ID
  watch(
    () => chatAgentState.current?.id,
    debounce(() => {
      saveCurrentAgentId(chatAgentState.current?.id);
    }, 300),
  );

  function getAgent(id?: string) {
    return chatAgentState.list.find((x) => x.id === id);
  }

  function getAgents(ids?: string[]): ChatPL.AgentPO[] {
    return (ids?.map(getAgent).filter((x) => x) as ChatPL.AgentPO[]) ?? [];
  }

  return {
    chatAgentState,
    createDefaultAgent,
    initChatAgentState,
    getAgent,
    getAgents,
  };
}
