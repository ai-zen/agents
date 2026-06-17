import { reactive, watch } from "vue";
import * as api from "../api";
import { ChatPL } from "../types/ChatPL";
import { debounce } from "../utils/debounce";
import { uuid } from "../utils/uuid";

export function useSession(options: {
  getDefaultAgent: () => ChatPL.AgentPO | undefined;
}) {
  const sessionState = reactive({
    list: [] as ChatPL.SessionPO[],
    isLoading: false,
    isReady: false,
    isSaving: false,
    current: undefined as ChatPL.SessionPO | undefined,
  });

  async function getList() {
    try {
      sessionState.isLoading = true;
      const [list, current] = await Promise.all([
        api.getSessionList(),
        api.getCurrentSessionId(),
      ]);
      if (list.length) {
        sessionState.list = list;

        // 如果读取出来的当前对话id(current)存在于对话列表(list)，
        // 则使用对应的对话(sessionState.list[index])作为当前对话，
        // 否则使用第一条对话(sessionState.list[0])作为当前对话。
        const index = sessionState.list.findIndex((item) => item.id == current);
        if (index > -1) {
          sessionState.current = sessionState.list[index];
        } else {
          sessionState.current = sessionState.list[0];
        }
      } else {
        await addSession();
      }
      sessionState.isReady = true;
    } finally {
      sessionState.isLoading = false;
    }
  }

  function createSessionTitle(prefix: string = "新") {
    const maxKeyNumber = Math.max(
      0,
      ...sessionState.list.map((session) =>
        Number(
          new RegExp(`^${prefix}对话([\\d]+$)`).exec(session.title)?.[1] ?? 0,
        ),
      ),
    );

    return `${prefix}对话${maxKeyNumber + 1}`;
  }

  function createSession(agent = options.getDefaultAgent()) {
    if (!agent) throw new Error("agent is required");

    const clonedAgent = JSON.parse(JSON.stringify(agent));

    return <ChatPL.SessionPO>{
      id: uuid(),
      title: createSessionTitle(clonedAgent.title),
      icon: clonedAgent.icon,
      agent_id: clonedAgent.id,
      messages: clonedAgent.messages,
      model_id: clonedAgent.model_id,
      model_config: clonedAgent.model_config,
      new_message_image: "",
      new_message_content: "",
    };
  }

  async function addSession(newSession = createSession()) {
    try {
      sessionState.isSaving = true;
      sessionState.list.push(newSession);
      sessionState.current = newSession;
      await api.addSession(JSON.parse(JSON.stringify(newSession)));
    } finally {
      sessionState.isSaving = false;
    }
  }

  async function removeSession(sessionId: string) {
    try {
      sessionState.isSaving = true;
      const index = sessionState.list.findIndex((x) => x.id === sessionId);
      if (index == -1) return;
      sessionState.list.splice(index, 1);
      if (sessionId == sessionState.current?.id) {
        sessionState.current = sessionState.list.at(-1) || undefined;
      }
      await api.deleteSession(sessionId);
    } finally {
      sessionState.isSaving = false;
    }
  }

  async function saveSession(session: ChatPL.SessionPO) {
    console.log("saveSession", session);
    try {
      sessionState.isSaving = true;
      await api.editSession(JSON.parse(JSON.stringify(session)));
    } finally {
      sessionState.isSaving = false;
    }
  }

  async function saveCurrentSessionId(sessionId: string | null | undefined) {
    console.log("saveCurrentSessionId", sessionId);
    try {
      sessionState.isSaving = true;
      api.setCurrentSessionId(sessionId);
    } finally {
      sessionState.isSaving = false;
    }
  }

  // 在当前对话ID变化时自动保存当前对话ID
  watch(
    () => sessionState.current?.id,
    debounce(() => {
      saveCurrentSessionId(sessionState.current?.id);
    }, 300),
  );

  // 在当前对话任意内容变化时自动保存
  watch(
    () => sessionState.current,
    debounce(() => {
      if (sessionState.current) saveSession(sessionState.current);
    }, 300),
    { deep: true },
  );

  async function initSessionState() {
    await getList();
  }

  return {
    sessionState,
    createSession,
    addSession,
    removeSession,
    saveSession,
    initSessionState,
  };
}
