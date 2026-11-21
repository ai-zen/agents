import { z } from "zod";

import type { HostApiDeps } from "./deps.js";
import type { Trpc } from "./trpc.js";

const sessionIdParams = z.object({ sessionId: z.string().min(1) });
const sessionIdResult = z.object({ sessionId: z.string() });

/**
 * 交接的三个动作分成三条，不合成一条「切换交接态」：它们的前置条件不同（收口要开闸、取消
 * 不开闸），合并之后调用方必须再告诉宿主「这一次是哪种」，那等于把三件事塞进一个参数。
 */
export function handoffRouter(deps: HostApiDeps, api: Trpc) {
  const { procedure } = api;

  return api.router({
    start: procedure
      .input(sessionIdParams)
      .output(sessionIdResult)
      .mutation(({ input }) => {
        deps.handoff.start(input.sessionId);
        return { sessionId: input.sessionId };
      }),

    finish: procedure
      .input(sessionIdParams)
      .output(sessionIdResult)
      .mutation(({ input }) => {
        deps.handoff.finish(input.sessionId);
        return { sessionId: input.sessionId };
      }),

    cancel: procedure
      .input(sessionIdParams)
      .output(sessionIdResult)
      .mutation(({ input }) => {
        deps.handoff.cancel(input.sessionId);
        return { sessionId: input.sessionId };
      }),
  });
}
