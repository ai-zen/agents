import { z } from "zod";

import type { NoticeService } from "../notice/service.js";
import type { Trpc } from "./trpc.js";

/**
 * 通知过 wire 的那一份，形状只有 `notice/types.ts` 那一处：这里是它的声明式影子，
 * `.output()` 拿它校验出去的值，客户端照它生成类型。
 */
const noticeSchema = z.object({
  id: z.string(),
  level: z.enum(["info", "success", "warning", "error"]),
  code: z.string(),
  message: z.string(),
  durationMs: z.number().nullable(),
  sessionId: z.string().nullable(),
  createdAt: z.number(),
});

/** 给了 `sessionId` 就是那一段的（含全局的）；不给就是全部 */
const scopeInput = z.object({ sessionId: z.string().optional() });

/** 这一域只要通知服务本身：文案由产生通知的那一方渲染好，这里没有要翻译的东西 */
export interface NoticeApiDeps {
  readonly notices: NoticeService;
}

export function noticeRouter(deps: NoticeApiDeps, api: Trpc) {
  return api.router({
    list: api.procedure
      .input(scopeInput)
      .output(z.array(noticeSchema))
      .query(({ input }) =>
        input.sessionId === undefined
          ? deps.notices.list()
          : deps.notices.listBySession(input.sessionId),
      ),

    /**
     * 不给 `sessionId` 就清全部。确认在客户端做：这里多一个 `confirm` 参数，只是把同一件事
     * 在两处各判一遍，而两处迟早会对不上。
     */
    clear: api.procedure.input(scopeInput).mutation(({ input }) => {
      if (input.sessionId === undefined) deps.notices.clear();
      else deps.notices.clearBySession(input.sessionId);
    }),
  });
}
