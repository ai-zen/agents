import { reactive } from "vue";
import * as api from "../api";
import { ChatPL } from "../types/ChatPL";

export function useEndpoint() {
  const endpointState = reactive({
    list: [] as ChatPL.EndpointPO[],
    isLoading: false,
    isReady: false,
    isSaving: false,
  });

  async function getList() {
    try {
      endpointState.isLoading = true;
      endpointState.list = await api.getEndpointList();
      endpointState.isReady = true;
    } finally {
      endpointState.isLoading = false;
    }
  }

  async function initEndpointState() {
    await getList();
  }

  function getEndpoint(id?: string) {
    return endpointState.list.find((x) => x.id === id);
  }

  function getEndpoints(ids?: string[]): ChatPL.EndpointPO[] {
    return (
      (ids?.map(getEndpoint).filter((x) => x) as ChatPL.EndpointPO[]) ?? []
    );
  }

  return {
    getEndpoint,
    getEndpoints,
    endpointState,
    initEndpointState,
  };
}
