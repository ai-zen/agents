import { resolveModel } from "@ai-zen/agents-sdk";

import { HostError } from "../../infra/errors.js";
import type { AgentDefinitionService } from "../config/agents.js";
import type { GeneralConfig } from "../config/general.js";
import type { Translator } from "../i18n/index.js";
import type { SessionService } from "./service.js";
import type { SessionRecord } from "./types.js";

/** 建一行会话要问的那几处。够用就好：这条路上没有 Agent，也没有排队区 */
export interface CreateSessionDeps {
  readonly sessions: SessionService;
  readonly definitions: AgentDefinitionService;
  readonly config: GeneralConfig;
  readonly t: Translator;
}

/** 建一行会话要的那两格：落在哪个项目里、用哪个 AgentDefinition */
export interface CreateSessionInput {
  workspaceId: string;
  agentId: string;
}

/**
 * 写一行会话。只写库：起 Agent 是 `runtime.agent.wake` 的事，投话是 `runtime.agent.send` 的事。
 *
 * 模型在造行这一刻就解析出来写进去（会话级那一格此刻还不存在，所以只可能是定义那级或全局
 * 兜底）：解析不出就在这里失败，不落一条指不到模型的半成品行 —— 行上的 `modelId` 从这一刻起
 * 就是事实。
 *
 * 名字是创建时刻那一串时刻串，它的来源记 `default`：客户端把这种名字显示成「新会话 · 时刻」，
 * 而不是把库里那个 ISO 串直接上屏。自动命名的判据是「只有一条用户消息」，刚建出来的这一段
 * 一条都没有，所以它不会被触发。
 */
export async function createSession(
  deps: CreateSessionDeps,
  input: CreateSessionInput,
): Promise<SessionRecord> {
  const definition = await deps.definitions.get(input.agentId);
  const model = resolveModel({
    agentModelId: definition.modelId,
    defaultModel: deps.config.read().defaultModel,
  });

  if (model === null) {
    throw new HostError(
      "config_invalid",
      deps.t("AgentDefinition {agentDefinitionId} 没有可用的模型", {
        agentDefinitionId: input.agentId,
      }),
      { entity: "agentDefinition", agentDefinitionId: input.agentId },
    );
  }

  return deps.sessions.create({
    workspaceId: input.workspaceId,
    name: new Date().toISOString(),
    // 占位名：客户端把它显示成「新会话 · 时刻」，自动起名可以覆盖它
    nameSource: "default",
    agentId: input.agentId,
    modelId: model.modelId,
    // 人建的会话默认不自动交接；它也不属于任何别的会话
    autoHandoff: false,
    lineage: null,
  });
}
