import { reactive } from "vue";
import * as api from "../api";
import { ChatPL } from "../types/ChatPL";

export function useModel() {
  const modelState = reactive({
    list: [] as ChatPL.ModelPO[],
    isLoading: false,
    isReady: false,
    isSaving: false,
  });

  async function getList() {
    try {
      modelState.isLoading = true;
      modelState.list = await api.getModelList();
      modelState.isReady = true;
    } finally {
      modelState.isLoading = false;
    }
  }

  async function initModelState() {
    await getList();
  }

  function getModel(id?: string) {
    return modelState.list.find((x) => x.id === id);
  }

  function getModels(ids?: string[]): ChatPL.ModelPO[] {
    return (ids?.map(getModel).filter((x) => x) as ChatPL.ModelPO[]) ?? [];
  }

  return {
    getModel,
    getModels,
    modelState,
    initModelState,
  };
}
