import { z } from "zod";

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

export function sessionRouter(deps: HostApiDeps, api: Trpc) {
  return api.router({
    list: api.procedure
      .input(z.object({ workspaceId: z.string() }))
      .output(z.array(sessionSchema))
      .query(({ input }) => deps.sessions.list(input.workspaceId)),
  });
}
