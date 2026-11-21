import { z } from "zod";

import type { AgentNS } from "@ai-zen/agents-core";

import { HostError } from "../../infra/errors.js";
import type { HostApiDeps } from "./deps.js";
import type { Trpc } from "./trpc.js";

/**
 * 会话行过 wire 的那一份。形状只有 `session/types.ts` 那一处，这里是它的声明式影子：
 * `.output()` 拿它校验出去的值，客户端照它生成类型。
 */
const sessionSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  nameIsAuto: z.boolean(),
  pinned: z.boolean(),
  agentId: z.string(),
  modelId: z.string().nullable(),
  thinkingLevel: z.string().nullable(),
  autoHandoff: z.boolean(),
  lineage: z.string().nullable(),
  handoffThreshold: z.number().nullable(),
  guardThreshold: z.number().nullable(),
  pendingHandoff: z.enum(["self", "summary"]).nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

/**
 * 打开一段会话看到的那一份。
 *
 * `live` 为 `null` 表示这段会话现在没有执行体（重启之后所有会话都是这一种）—— 那时状态无从谈起，
 * 而消息与排队区照样给得出来，因为那时库就是它的全部。
 *
 * 消息与排队区用 `z.custom`：形状只有 core 那一处，在这里再抄一份就是第二份，抄漏一格不会报错，
 * 只会让客户端安静地少一个字段。排队区那一格是 core 的 `InboxEntry`，其中「钥匙」那种没有正文
 * —— 界面要的是「还有几条在等」，不是每条都能拼出句子。
 */
const sessionView = z.object({
  session: sessionSchema,
  live: z
    .object({
      state: z.enum(["working", "idle"]),
      inputPaused: z.boolean(),
      outputPaused: z.boolean(),
      handingOff: z.boolean(),
    })
    .nullable(),
  messages: z.array(z.custom<AgentNS.Message>()),
  inbox: z.array(z.custom<AgentNS.InboxEntry>()),
});

export function sessionRouter(deps: HostApiDeps, api: Trpc) {
  return api.router({
    list: api.procedure
      .input(z.object({ workspaceId: z.string() }))
      .output(z.array(sessionSchema))
      .query(({ input }) => deps.sessions.list(input.workspaceId)),

    /**
     * 打开一段会话：状态、消息、排队区一次取到。
     *
     * 有执行体时五样全从它的内存里读；没有执行体时才读库。分成两次取会在两次请求之间夹进新消息，
     * 而库里的正文在流式期间本来就落后于内存——两处各读一半，客户端拿到的是一份混着两个时刻的状态。
     */
    open: api.procedure
      .input(z.object({ sessionId: z.string() }))
      .output(sessionView)
      .query(({ input }) => {
        const session = deps.sessions.get(input.sessionId);
        if (session === undefined) {
          throw new HostError(
            "not_found",
            deps.t("找不到 id 为 {sessionId} 的会话", { sessionId: input.sessionId }),
            { entity: "session", sessionId: input.sessionId },
          );
        }

        const agent = deps.runtime.get(session.id);
        if (agent === undefined) {
          return {
            session,
            live: null,
            messages: deps.messages.listBySession(session.id),
            inbox: deps.inbox.listBySession(session.id),
          };
        }

        return {
          session,
          live: {
            state: agent.state,
            inputPaused: agent.isInputPaused,
            outputPaused: agent.isOutputPaused,
            handingOff: deps.handoff.isHandingOff(session.id),
          },
          messages: [...agent.messages],
          inbox: [...agent.inboxPending],
        };
      }),
  });
}
