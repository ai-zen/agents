import { z } from "zod";

import type { AgentNS } from "@ai-zen/agents-core";

import type { SearchService } from "../search/service.js";
import type { Trpc } from "./trpc.js";

/**
 * 命中项过 wire 的那一份。
 *
 * `message` 用 `z.custom`：它的形状只有 core 那一处，在这里再抄一份 zod 就是第二份形状，
 * 抄漏一格不会报错，只会在客户端安静地少一个字段。
 */
const searchHitSchema = z.object({
  messageId: z.string(),
  sessionId: z.string(),
  sessionName: z.string(),
  snippet: z.string(),
  message: z.custom<AgentNS.Message>(),
});

/**
 * `scope` 不给就是全库。三个分支写成联合而不是两个可选字段：两个都能省略时，类型上分不出
 * 「只要这一段」与「全库」。
 */
const messageSearchInput = z.object({
  keyword: z.string(),
  scope: z
    .union([z.object({ sessionId: z.string() }), z.object({ workspaceId: z.string() })])
    .optional(),
  limit: z.number().int().positive(),
});

const sessionSearchInput = z.object({
  keyword: z.string(),
  workspaceId: z.string().optional(),
  limit: z.number().int().positive(),
});

/** 这一域只要搜索服务本身：命中项与会话行都是库里的事实，没有要渲染的句子 */
export interface SearchApiDeps {
  readonly search: SearchService;
}

export function searchRouter(deps: SearchApiDeps, api: Trpc) {
  return api.router({
    messages: api.procedure
      .input(messageSearchInput)
      .output(z.array(searchHitSchema))
      .query(({ input }) => deps.search.messages(input.keyword, input.scope, input.limit)),

    /**
     * 没有 `.output()`：会话过 wire 的形状已经声明在 `session.list` 上，这里再写一份就是
     * 第二份，两处迟早对不上。出去的仍是 `SessionRecord`，tRPC 从返回类型推。
     */
    sessions: api.procedure
      .input(sessionSearchInput)
      .query(({ input }) => deps.search.sessions(input.keyword, input.workspaceId, input.limit)),
  });
}
