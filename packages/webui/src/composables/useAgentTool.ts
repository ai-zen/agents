import { reactive } from "vue";
import * as api from "../api";
import { ChatPL } from "../types/ChatPL";

export function useAgentTool() {
  const agentToolState = reactive({
    list: [] as ChatPL.AgentToolPO[],
    isLoading: false,
    isReady: false,
    isSaving: false,
  });

  async function getList() {
    try {
      agentToolState.isLoading = true;
      agentToolState.list = await api.getAgentToolList();
      agentToolState.isReady = true;
    } finally {
      agentToolState.isLoading = false;
    }
  }

  async function initAgentToolState() {
    await getList();
  }

  function getAgentTool(id?: string) {
    return agentToolState.list.find((x) => x.id === id);
  }

  function getAgentTools(ids?: string[]): ChatPL.AgentToolPO[] {
    return (
      (ids?.map(getAgentTool).filter((x) => x) as ChatPL.AgentToolPO[]) ?? []
    );
  }

  return {
    agentToolState,
    initAgentToolState,
    getAgentTool,
    getAgentTools,
  };
}
