import { z } from "zod";

import type { HostApiDeps } from "./deps.js";
import type { Trpc } from "./trpc.js";

/**
 * 宿主自己那两格：现在是哪一版，以及升级的第 ② 段。
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
  });
}
