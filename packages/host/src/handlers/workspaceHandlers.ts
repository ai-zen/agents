/**
 * `workspace.*`：项目（PRD D9 / D10 / D11 / D12）。
 *
 * 薄到只有一层：参数交给 `WorkspaceService`，结果原样回去。唯一在接线层补的是删项目之后的
 * 两件事（回收它的 Scope、逐段对话推 `deleted`）—— 那两样分别属于运行时与接线层，服务层只负责
 * 删行并算出代价（裁定 R43 / R33）。素材字节的清理不在这里：挂引用归零之后由素材层删。
 */

import type { HandlerTable } from "../net/index.js";
import type { ChatEventEmitter, ChatRunner, ScopeRegistry } from "../runtime/index.js";
import type { ConversationService } from "../services/ConversationService.js";
import type { WorkspaceService } from "../services/WorkspaceService.js";
import type {
  WorkspaceRemoveParams,
  WorkspaceRemoveResult,
} from "../wire/index.js";

/** `workspace.*` 的实现要的持有者 */
export interface WorkspaceHandlerDeps {
  workspaces: WorkspaceService;
  /** 删项目要连带它的对话一起清（PRD D11）：删之前先记下名下有哪几段 */
  conversations: ConversationService;
  /** 名下的对话在运行时里可能还留着现场，删之前一并丢掉 */
  runner: ChatRunner;
  /** 删项目要把它的 Scope 一起销毁（MCP 连接在这里断开） */
  scopes: ScopeRegistry;
  /**
   * 推 `conversation.changed`（L5 / D22：删项目带走的那几段对话也要让别的窗口知道）。
   * 不注入时不推。
   */
  emit?: ChatEventEmitter;
  /** 时间戳（`conversation.changed.at`）；缺省用 `Date.now` */
  now?: () => string;
}

export function createWorkspaceHandlers(deps: WorkspaceHandlerDeps): HandlerTable {
  return {
    "workspace.list": async (context) => await deps.workspaces.list(context.params),
    "workspace.create": async (context) => await deps.workspaces.create(context.params),
    "workspace.get": async (context) => await deps.workspaces.get(context.params),
    "workspace.rename": async (context) => await deps.workspaces.rename(context.params),
    "workspace.remove": async (context) => await removeWorkspace(deps, context.params),
  };
}

/**
 * 删项目（PRD D11 / D17 / F-F9 / R43）。
 *
 * 顺序是有意的：
 *   1. 先记下名下的对话（删完就问不出来了，而运行时里它们的现场要一起丢）；
 *   2. 服务层删行（它顺带让运行时忘掉那几段对话的临时覆盖，以及删完之后清归零的素材字节）；
 *   3. 逐段对话丢掉这一轮的现场，并推一条 `deleted`（多端在线时对方界面靠它去拉）；
 *   4. 销毁这个 Workspace 的 Scope —— MCP 连接在这里断开（architecture §4 销毁缘由之一）。
 *
 * 第 3 步已经把名下那几段对话的现场丢了（`forget`：叫停 + 摘掉 agent 登记），于是第 4 步
 * 不会因为「还活着的 agent」被拒绝。真撞上了（比如某个 agent 不是经 `AgentRegistry` 造的），
 * `scopes.dispose` 的错误照原样上抛：那是程序错误，不该被这里默默吞掉。
 *
 * `dryRun` 只走第 2 步：它要的只是代价，不该有任何副作用。
 */
async function removeWorkspace(
  deps: WorkspaceHandlerDeps,
  params: WorkspaceRemoveParams,
): Promise<WorkspaceRemoveResult> {
  const doomed =
    params.dryRun === true
      ? []
      : (await deps.conversations.list({ workspaceId: params.workspaceId })).conversations;

  const report = await deps.workspaces.remove(params);
  if (params.dryRun !== true && report.removed) {
    for (const conversation of doomed) {
      deps.runner.forget(conversation.id);
      deps.emit?.("conversation.changed", {
        conversationId: conversation.id,
        workspaceId: params.workspaceId,
        change: "deleted",
        messageCount: null,
        at: (deps.now ?? (() => new Date().toISOString()))(),
      });
    }
    await deps.scopes.dispose(params.workspaceId);
  }
  return { removed: report.removed, consequences: report.consequences };
}
