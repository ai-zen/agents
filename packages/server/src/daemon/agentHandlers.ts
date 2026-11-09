/**
 * Agent 级方法（`agent.*`）的服务端入口。
 *
 * 与 `sessionHandlers.ts` 分开的理由就是命名：改的是**全局的 Agent 定义**，影响所有用
 * 这个 Agent 的会话，不是"对某一段会话做事"。混进 `session.*` 会让调用方以为它只影响
 * 当前会话 —— 那种误解在"切换模型后另一个窗口也变了"时才被发现。
 *
 * 本文件两类方法，粒度不同（见 `protocol/config.ts` 里 `AGENT_ADMIN_METHODS` 的注释）：
 *
 *   - `agent.model.set`：**改一个字段**（`/model` 用）。请求形状被收窄成两个 id，
 *     实现挂在装配层 `SessionAgentFactory.setModel`（它要顺带清掉与新模型不兼容的
 *     思考参数，那是装配层的知识）；
 *   - `agent.list/get/save/remove`：**整份定义的读写**（配置中心的 Agent 编辑屏用）。
 *     实现在 `ConfigService`：它管的就是配置文件与定义目录，不需要拉起 Agent。
 *
 * 两类都留在这个文件里，是因为它们对客户端来说是同一个命名空间 `agent.*`；
 * 拆成两个 handler 文件只会让接线处出现两条 `...createXxxHandlers()`。
 */

import type { MethodHandler } from "./Daemon.js";
import { badParams, field, requireString } from "./params.js";
import type { SessionAgentFactory } from "../service/agent/SessionAgentFactory.js";
import type { ConfigService } from "../service/config/ConfigService.js";
import type { AgentDefinition } from "@ai-zen/agents-sdk";
import { AGENT_METHODS, type AgentSetModelResult } from "../protocol/sessions.js";
import {
  AGENT_ADMIN_METHODS,
  type AgentGetResult,
  type AgentKind,
  type AgentListResult,
  type AgentRemoveResult,
  type AgentSaveResult,
} from "../protocol/config.js";

export interface AgentHandlerOptions {
  /** 只需装配层的 `setModel`（写入 Agent 定义），不必把整个工厂交出去 */
  factory: Pick<SessionAgentFactory, "setModel">;
  /** 整份定义的读写（`ConfigService`，路径已由组装根注入） */
  config: ConfigService;
}

export function createAgentHandlers(options: AgentHandlerOptions): Record<string, MethodHandler> {
  const { factory, config } = options;

  return {
    [AGENT_METHODS.setModel]: async (params): Promise<AgentSetModelResult> => {
      const agentId = requireString(params, "agentId");
      const modelId = requireString(params, "modelId");
      return await factory.setModel({ agentId, modelId });
    },

    [AGENT_ADMIN_METHODS.list]: async (): Promise<AgentListResult> => {
      return await config.listAgents();
    },

    [AGENT_ADMIN_METHODS.get]: async (params): Promise<AgentGetResult> => {
      return await config.getAgent({ id: requireString(params, "id"), kind: optionalKind(params) });
    },

    [AGENT_ADMIN_METHODS.save]: async (params): Promise<AgentSaveResult> => {
      return await config.saveAgent(requireKind(params), requireDefinition(params));
    },

    [AGENT_ADMIN_METHODS.remove]: async (params): Promise<AgentRemoveResult> => {
      return await config.removeAgent(requireKind(params), requireString(params, "id"));
    },
  };
}

/**
 * 存到哪一类目录。
 *
 * 必须显式给：同名 id 在 `agents/` 与 `sub-agents/` 里是**两份不同的定义**
 * （都叫 `default` 是常态），猜一个就等于有一半概率写错文件。
 */
function requireKind(params: unknown): AgentKind {
  const value = field(params, "kind");
  if (value !== "agent" && value !== "subagent") {
    throw badParams(`invalid "kind" (expected agent | subagent)`);
  }
  return value;
}

/**
 * `agent.get` 的可选 `kind`：查哪个池子。
 *
 * 与 `requireKind` 分开而不是复用一个「带默认值」的版本：`save`/`remove` 要决定写/删
 * 哪个目录，猜不得；而 `agent.get` 的「只想按 id 看一眼」还得能不带。但**缺省不等于放宽**
 * ——给了就必须是那两个值：
 *
 *   - `kind: null` 当「没给」处理不接受：那是客户端给了一个说不清的值，静默按顶层优先
 *     就又回到了这一版要消掉的歧义（点中子 Agent 的 `default`，拿到顶层那份）；
 *   - 拼错的 `"sub-agent"` / `"Agent"` 同理，必须当场报出来而不是退化成顶层优先 ——
 *     否则客户端两栏界面写错了大小写，症状会表现成「数据错乱」而不是「参数错」。
 */
function optionalKind(params: unknown): AgentKind | undefined {
  const value = field(params, "kind");
  if (value === undefined) return undefined;
  if (value !== "agent" && value !== "subagent") {
    throw badParams(`invalid "kind" (expected agent | subagent)`);
  }
  return value;
}

/**
 * 整份定义。
 *
 * 只校验**服务端必须理解的那一位**：`id` —— 它决定文件名（`<id>.json`），没有它
 * 根本落不了盘。其余字段（`name` / `messages` / `permissions` …）的形状归 SDK 定义，
 * 这里不解释、不改写：配置中心的编辑屏是「整份读写」的通道，服务端替它挑字段只会
 * 造出第二份会漂移的规则。
 */
function requireDefinition(params: unknown): AgentDefinition {
  const value = field(params, "definition");
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw badParams(`missing or invalid "definition"`);
  }
  const id = (value as { id?: unknown }).id;
  if (typeof id !== "string" || id.length === 0) {
    throw badParams(`invalid "definition.id"`);
  }
  return value as AgentDefinition;
}

