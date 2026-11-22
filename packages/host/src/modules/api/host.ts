import { z } from "zod";

import type { HostApiDeps } from "./deps.js";
import type { Trpc } from "./trpc.js";

/**
 * 宿主自己那几格：现在是哪一版、升级的第 ② 段，以及关掉它。
 *
 * `upgrade` 的入参只有一个版本号，schema 只判「非空」：范围、tag、`latest` 是不是一个号由
 * `UpdateService` 判（那一条判据带着 `invalid_params` 的文案与 `details`，不归边界）。
 */
export function hostRouter(deps: HostApiDeps, api: Trpc) {
  return api.router({
    version: api.procedure
      .output(z.object({ version: z.string() }))
      .query(() => ({ version: deps.updates.version() })),

    upgrade: api.procedure
      .input(z.object({ version: z.string().min(1) }))
      .output(z.object({ version: z.string(), restarting: z.literal(true) }))
      .mutation(({ input }) => deps.updates.upgrade(input.version)),

    /**
     * 关掉宿主：客户端的 `/shutdown` 那一条命令的最后一句。
     *
     * 入参是空的：「关掉」没有可选项 —— 关哪个宿主由这条连接决定（它就是连着的那一个），确认在
     * 客户端做（命令 + 一次二次确认），宿主不为此再接一个 `confirm` 参数，那只是把同一件事在两处
     * 各判一遍。退出码也不是客户端给的：正常关闭就是正常关闭，升级那一路另有它的码与理由。
     *
     * 回 `{ accepted: true }` 而不是「关完了」：收尾排在答复之后（连接会被断掉，那正是关掉宿主
     * 的一部分），客户端拿到这一个答复就该知道这一条已经受理，随后是重连还是退回连接屏由它自己定。
     */
    shutdown: api.procedure
      .output(z.object({ accepted: z.literal(true) }))
      .mutation(() => {
        deps.shutdown();
        return { accepted: true };
      }),
  });
}
