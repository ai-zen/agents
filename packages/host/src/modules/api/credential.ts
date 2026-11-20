import { z } from "zod";

import type { CredentialService } from "../credential/service.js";
import type { Trpc } from "./trpc.js";

/**
 * 凭证过 wire 的那一份：`hash` 不在里面。它留在库里有意义，出了库没有 —— 客户端拿摘要做
 * 不了任何事，而传出去等于把令牌的指纹送走。
 */
const credentialSchema = z.object({
  id: z.string(),
  note: z.string(),
  createdAt: z.number(),
  revokedAt: z.number().nullable(),
});

/**
 * 凭证归宿主：创建、列出、吊销是宿主自己的管理动作，客户端只做「记住密码」与连接管理。
 * 这三条先照常放进契约 —— 它比「没有入口」好，本地命令行迟早要用到同一份形状。
 */
export interface CredentialApiDeps {
  readonly credentials: CredentialService;
}

export function credentialRouter(deps: CredentialApiDeps, api: Trpc) {
  return api.router({
    list: api.procedure.output(z.array(credentialSchema)).query(() => deps.credentials.list()),

    /** `token` 是明文唯一一次出现的地方：响应里不给，之后就只剩摘要 */
    create: api.procedure
      .input(z.object({ note: z.string() }))
      .output(z.object({ credential: credentialSchema, token: z.string() }))
      .mutation(({ input }) => deps.credentials.create(input.note)),

    revoke: api.procedure
      .input(z.object({ credentialId: z.string() }))
      .output(credentialSchema)
      .mutation(({ input }) => deps.credentials.revoke(input.credentialId)),
  });
}
