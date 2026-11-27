import { z } from "zod";

import type { McpServerDefinition } from "@ai-zen/agents-sdk";

import { HostError } from "../../infra/errors.js";
import type { HostApiDeps } from "./deps.js";
import type { Trpc } from "./trpc.js";

/**
 * 五层。取值与 `McpConfig` 的 `McpScope` 是同一份 —— 那一处是声明，这里是它过 wire 的影子
 * （`z.enum` 推出来的联合类型正好就是那个类型，两处对不上是编译错，不是运行时惊喜）。
 */
const scopeSchema = z.enum([
  "workspace",
  "workspaceAiZen",
  "workspaceAgents",
  "user",
  "userAgents",
]);

/**
 * 出参一律是这一格：这一批服务器 + 每条写在哪一层（`McpConfig.describe` 的结果）。
 *
 * 写完也回这一份（而不是只回一个 `ok`）：客户端不必再发一次 `list`，也就不必处理「两个请求
 * 之间夹进另一处改动」这种两半不一致的处境。形状只有 SDK 那一处（`types/index.ts` 的
 * `McpServerDefinition`），这里不抄第二份：`z.custom` 就是「这个值的形状由别处声明」
 * （`config.ts` 的 `config` 与 `agentDefinition.ts` 的 `definition` 是同一个先例）。
 */
const serversResult = z.object({
  servers: z.array(z.object({ scope: scopeSchema, server: z.custom<McpServerDefinition>() })),
});

/**
 * MCP 配置面：列（每条写在哪一层）、加一条、删一条、改一条。
 *
 * 这一层只把项目换成那个目录，其余的判断都在 `McpConfig` 那一侧：写哪两层、与文件里已有 InboxEntry
 * 合并（不是覆盖）、这一层没有它时 `not_found`、不可写的那三层 `unsupported`。在这里再判一次
 * 就多出一处会与那里不一致的规则。
 *
 * 写完「不必重启宿主」由配置事件接线（`app.ts` 里那条订阅：非 `agentDefinition` 的事件都让
 * 运行期重读一遍），所以这里没有第二条刷新路径。
 */
export function mcpRouter(deps: HostApiDeps, api: Trpc) {
  return api.router({
    /**
     * 列。停用的那几条也在里面（`server.disabled` 为真），并标着它停在哪一层 —— 「重新启用
     * 一条」改的是它所在那一层的文件，不是合并后的清单（那里面根本没有它）。
     */
    list: api.procedure
      .input(z.object({ workspaceId: z.string() }))
      .output(serversResult)
      .query(async ({ input }) => ({
        servers: await deps.mcp.describe(cwdOf(deps, input.workspaceId)),
      })),

    /**
     * 加一条或改一条：同名（`server.id`）即是改，没有即是加 —— 两者落下去是同一件事（与那一层
     * 文件里那一条合并），所以不分成两个 procedure。
     *
     * `scope` 在入参里是那五层，可写的只有两层：另外三层由 `McpConfig.save` 抛
     * `unsupported`（它比这里多知道一条「那个文件是谁的」），这一层不重判。
     */
    update: api.procedure
      .input(
        z.object({
          workspaceId: z.string(),
          scope: scopeSchema,
          server: z.custom<McpServerDefinition>(),
        }),
      )
      .output(serversResult)
      .mutation(async ({ input }) => {
        const cwd = cwdOf(deps, input.workspaceId);
        await deps.mcp.save(input.scope, cwd, input.server);
        return { servers: await deps.mcp.describe(cwd) };
      }),

    /** 删一条。这一层里没有它就是 `not_found`（`McpConfig.remove` 抛的那一句，这里不另判） */
    delete: api.procedure
      .input(z.object({ workspaceId: z.string(), scope: scopeSchema, name: z.string() }))
      .output(serversResult)
      .mutation(async ({ input }) => {
        const cwd = cwdOf(deps, input.workspaceId);
        await deps.mcp.remove(input.scope, cwd, input.name);
        return { servers: await deps.mcp.describe(cwd) };
      }),
  });
}

/**
 * 这五层文件以哪个目录为准：项目根（`workspace` / `workspaceAiZen` / `workspaceAgents` 三层
 * 都在它下面，另两层与它无关）。
 *
 * 项目不存在是 `not_found`，不是「五层文件都空着」：层表拼不出路径，给它一份空清单等于说
 * 「这个项目一条 MCP 服务器都没有」，而事实是这个项目不存在（客户端按 id 传错了，或者项目
 * 刚被删掉）。
 */
function cwdOf(deps: HostApiDeps, workspaceId: string): string {
  const workspace = deps.workspaces.get(workspaceId);
  if (workspace === undefined) {
    throw new HostError("not_found", deps.t("找不到 id 为 {workspaceId} 的项目", { workspaceId }), {
      entity: "workspace",
      workspaceId,
    });
  }
  return workspace.cwd;
}
