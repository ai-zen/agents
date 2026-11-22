import { z } from "zod";

import { listMentionFiles } from "../workspace/mentions.js";
import { removeWorkspace } from "../workspace/remove.js";
import type { HostApiDeps } from "./deps.js";
import type { Trpc } from "./trpc.js";

/**
 * 项目行过 wire 的那一份。形状只有 `workspace/types.ts` 那一处，这里是它的声明式影子。
 *
 * 没有修改 `cwd` 的入参，也没有搬家的 procedure：位置不可变，要换地方就是另一个项目。
 */
const workspaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  cwd: z.string(),
  createdAt: z.number(),
});

export function workspaceRouter(deps: HostApiDeps, api: Trpc) {
  return api.router({
    /**
     * 列项目。`cwd` 不存在时照常列出来：列表报的是库里的事实，目录还在不在是另一件事，
     * 那件事要由看得见盘上东西的那一层说。
     */
    list: api.procedure.output(z.array(workspaceSchema)).query(() => deps.workspaces.list()),

    /**
     * 建一个项目。`cwd` 的归一化在 `WorkspaceService.create` 里做，这一层不再做一遍：
     * 两处各做一次，第二处就得处理「第一处的结果再进来一次」这种不存在的处境。
     *
     * 名字没给就取创建时刻那一串毫秒，这一格由宿主定、不让客户端传：那一串毫秒只有宿主在创建
     * 那一刻拿得到，由客户端给就是每条客户端各拿自己的时钟算一遍，同一个动作会落出不同的名字。
     */
    create: api.procedure
      .input(z.object({ cwd: z.string().min(1), name: z.string().optional() }))
      .output(z.object({ workspace: workspaceSchema }))
      .mutation(({ input }) => ({
        workspace: deps.workspaces.create(input.name ?? String(Date.now()), input.cwd),
      })),

    /**
     * 项目目录里的文件清单，给客户端的「`@` 提及」用。
     *
     * 这件事只能在宿主做：客户端在远端，读不到那台机器的盘。回的是相对 `cwd` 的路径（正斜杠、
     * 字典序、最多 500 条），`query` 给了就按子串筛（大小写不敏感，比对相对路径）——
     * 客户端每敲一个字母问一次，筛在这儿省掉的是整份清单过 wire。
     *
     * 只有路径，没有大小也没有内容：那份清单是给人挑的，挑中之后读哪个文件是下一步的事。
     */
    files: api.procedure
      .input(z.object({ workspaceId: z.string().min(1), query: z.string().optional() }))
      .output(z.object({ files: z.array(z.string()) }))
      .query(({ input }) => ({
        files: listMentionFiles(deps, input.workspaceId, input.query),
      })),

    /** 改名。只有名字这一格可改：`cwd` 与 `createdAt` 不在可改的事实里 */
    rename: api.procedure
      .input(z.object({ workspaceId: z.string().min(1), name: z.string().min(1) }))
      .output(z.object({ workspace: workspaceSchema }))
      .mutation(({ input }) => ({
        workspace: deps.workspaces.rename(input.workspaceId, input.name),
      })),

    /**
     * 删项目，连带它名下的会话。回去的那几段会话 id 就是这一次的代价：客户端在删之前用
     * `session.list` 数出来的也是同一批。
     */
    remove: api.procedure
      .input(z.object({ workspaceId: z.string().min(1) }))
      .output(z.object({ sessions: z.array(z.string()) }))
      .mutation(({ input }) => removeWorkspace(deps, input.workspaceId)),
  });
}
