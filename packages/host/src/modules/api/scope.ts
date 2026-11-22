import { z } from "zod";

import type { HostApiDeps } from "./deps.js";
import type { Trpc } from "./trpc.js";

/**
 * 回执的三格：过了一遍几份容器、刷成几份、哪几份没刷成。
 *
 * 不是「一句 `ok`」：刷新是逐个容器收口的，一份刷不动时其余照旧刷 —— 那种处境下回一句「好了」
 * 就是错的，而它恰恰是最需要被人看见的一种（那个目录此后拿的还是旧配置）。
 *
 * 失败项带 `cwd` 与 `reason` 两格：用户要能说出「哪一个目录没刷动」，光有一个数字说不出。
 */
const refreshReport = z.object({
  total: z.number(),
  refreshed: z.number(),
  failed: z.array(z.object({ cwd: z.string(), reason: z.string() })).readonly(),
});

/**
 * 能力容器这一面：让宿主现在就把每个已造好的容器按磁盘上的配置重读一遍。
 *
 * 只刷已经造好的：没人用过的目录没有容器，下一次用到时按新配置现造 —— 为了能刷一次而先造
 * 一个，等于凭空多装一份能力（连一次 MCP 连接都可能跟着来）。
 *
 * 与配置写口不重复：写口改完配置，宿主自己挂在配置事件上刷一遍（那一路不需要谁来调）。这一条是
 * 给「现在就说一遍」用的 —— 用户在命令里按了刷新，回执里得说清这一手真的做了事。
 */
export function scopeRouter(deps: HostApiDeps, api: Trpc) {
  return api.router({
    /**
     * 无入参：刷哪几份由宿主自己知道（就是它手上那些容器），调用方说得出「刷哪些目录」的时候
     * 再说 —— 那时这一格该长的是筛选条件，不是现在编一个用不上的。
     */
    reload: api.procedure
      .output(refreshReport)
      .mutation(() => deps.runtime.scopes.refreshAll()),
  });
}
