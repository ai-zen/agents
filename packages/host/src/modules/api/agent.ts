import { z } from "zod";

import type { Agent } from "@ai-zen/agents-core";
import { resolveModel } from "@ai-zen/agents-sdk";

import { HostError } from "../../infra/errors.js";
import { assemble } from "../agent/assembly.js";
import { AgentSubscription } from "../agent/subscription.js";
import type { Session } from "../session/types.js";
import type { HostApiDeps } from "./deps.js";
import type { Trpc } from "./trpc.js";

const sendInput = z.object({
  workspaceId: z.string(),
  /** 只有建行那一支用它：已有会话的助手是会话行上的事实，不听这一次调用怎么说 */
  agentId: z.string(),
  content: z.string(),
  /** 客户端给的 id：它据此在界面上先把这条消息显示出来，落地时用的就是这个 id */
  messageId: z.string(),
  /** 给了就投给这一段；不给就是这一段还不存在 —— 建行与投递是同一个动作 */
  sessionId: z.string().optional(),
});

type SendInput = z.infer<typeof sendInput>;

const wakeInput = z.object({ sessionId: z.string() });
const wakeOutput = z.object({ sessionId: z.string() });

export function agentRouter(deps: HostApiDeps, api: Trpc) {
  return api.router({
    /**
     * 让这段会话现在有执行体：按库里的事实装配一个并登记。
     *
     * 不投递任何东西。会话行已经存在 —— 唤醒不创建会话，它只填补「行在、执行体不在」这一格。
     * 已经有执行体时是空操作：重建会把一段正在跑的会话换掉，而调用方要的只是「它活着」。
     */
    wake: api.procedure
      .input(wakeInput)
      .output(wakeOutput)
      .mutation(async ({ input }) => {
        const session = existingSession(deps, input.sessionId);
        if (deps.agents.get(session.id) === undefined) await wakeSession(deps, session);

        return { sessionId: session.id };
      }),

    send: api.procedure
      .input(sendInput)
      .output(z.object({ sessionId: z.string(), messageId: z.string() }))
      .mutation(async ({ input }) => {
        // 给了 sessionId 就是往一段已有的会话投递。投递不创建会话、也不复活会话：没有活着
        // 的执行体就直接报错，「先唤醒再投递」是客户端的编排（先调 `wake`），不是宿主的兜底。
        if (input.sessionId !== undefined) {
          const session = existingSession(deps, input.sessionId);
          const agent = deps.agents.get(session.id);
          if (agent === undefined) {
            throw new HostError(
              "not_found",
              deps.t("会话 {sessionId} 没有运行中的执行体，先运行它再投递", {
                sessionId: session.id,
              }),
              { entity: "agent", sessionId: session.id },
            );
          }

          return deliver(deps, session, agent, input);
        }

        // 不给 sessionId：会话是由这一次发送产生的，建行、装配、登记、投递都是这次发送的
        // 一部分 —— 它没有「复活一段已有的会话」这层含义。
        const session = await createSession(deps, input);
        return deliver(deps, session, await wakeSession(deps, session), input);
      }),
  });
}

function deliver(
  deps: HostApiDeps,
  session: Session,
  agent: Agent,
  input: SendInput,
): { sessionId: string; messageId: string } {
  deps.delivery.hand(session.id, agent, {
    content: input.content,
    // 来源不是准入判断（宿主不判来路），它只是让模型知道这句话是谁说的
    source: { kind: "user" },
    messageId: input.messageId,
  });

  return { sessionId: session.id, messageId: input.messageId };
}

/**
 * 造会话行。模型在造行这一刻就解析出来写进去：解析不出就在这里失败，不落一条指不到模型的
 * 半成品行，行上的 `modelId` 从这一刻起就是事实。
 */
async function createSession(deps: HostApiDeps, input: SendInput): Promise<Session> {
  const definition = await deps.definitions.get(input.agentId);
  const model = resolveModel({
    agentModelId: definition.modelId,
    defaultModel: deps.config.read().defaultModel,
  });

  if (model === null) {
    throw new HostError(
      "config_invalid",
      deps.t("助手 {agentDefinitionId} 没有可用的模型", { agentDefinitionId: input.agentId }),
      { entity: "agentDefinition", agentDefinitionId: input.agentId },
    );
  }

  return deps.sessions.create({
    workspaceId: input.workspaceId,
    // 自动起的名字先给一个时刻串，此后由自动命名或用户改名接管
    name: new Date().toISOString(),
    nameIsAuto: true,
    agentId: input.agentId,
    modelId: model.modelId,
    // 人建的会话默认不自动交接；它也不属于任何别的会话
    autoHandoff: false,
    lineage: null,
  });
}

function existingSession(deps: HostApiDeps, sessionId: string): Session {
  const session = deps.sessions.get(sessionId);
  if (session === undefined) {
    throw new HostError("not_found", deps.t("找不到 id 为 {sessionId} 的会话", { sessionId }), {
      entity: "session",
      sessionId,
    });
  }
  return session;
}

async function wakeSession(deps: HostApiDeps, session: Session): Promise<Agent> {
  const agent = await assemble(deps, session);
  deps.agents.add(session.id, agent, new AgentSubscription(deps, session.id, agent));
  return agent;
}
