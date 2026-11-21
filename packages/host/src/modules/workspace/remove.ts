import { HostError } from "../../infra/errors.js";
import type { Translator } from "../i18n/index.js";
import { removeSessions } from "../session/remove.js";
import type { RemoveSessionsDeps } from "../session/remove.js";
import type { SessionService } from "../session/service.js";
import type { WorkspaceService } from "./service.js";

/**
 * 删一个项目要经过的那几个域。会话那一段的收尾是 `removeSessions` 的事，这里只多要项目行与
 * 「这个项目名下有哪些会话」。
 */
export interface RemoveWorkspaceDeps extends RemoveSessionsDeps {
  readonly workspaces: WorkspaceService;
  readonly sessions: SessionService;
  readonly t: Translator;
}

/**
 * 删一个项目，连带它名下的会话。
 *
 * 返回被连带删掉的那几段会话的 id：「删前说清代价」用的就是这一份，客户端在删之前先
 * `session.list` 拿到的也是同一批。
 *
 * 目录本身一个字都不碰：这里删的只有库里的行与它名下会话引用过的素材字节。
 */
export function removeWorkspace(
  deps: RemoveWorkspaceDeps,
  workspaceId: string,
): { sessions: string[] } {
  // `WorkspaceService.remove` 不看有没有这一行，删一个不存在的项目会安静地成功：先 `get` 一次，
  // 才分得出「删掉了」与「本来就没有」。
  // 文案在产生处就过 `t`：宿主的用户可见文案没有出口渲染那一层，写死一句中文，英文环境下
  // 这一句就不翻译了。
  if (deps.workspaces.get(workspaceId) === undefined) {
    throw new HostError("not_found", deps.t("找不到 id 为 {workspaceId} 的项目", { workspaceId }), {
      entity: "workspace",
      workspaceId,
    });
  }

  // 名下的会话在删之前读出来：删完之后这张表里就没有它们的 id 了，而返回值要用它们。
  const sessionIds = deps.sessions.list(workspaceId).map((session) => session.id);

  // 会话那一段的收尾与「删一段会话」共用一份实现，差别只在 `removeRows` 删的是哪一行：
  // 这里删项目那一行，会话行随外键跟着走。
  removeSessions(deps, sessionIds, () => deps.workspaces.remove(workspaceId));

  return { sessions: sessionIds };
}
