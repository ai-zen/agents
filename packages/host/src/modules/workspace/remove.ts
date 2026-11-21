import type { AgentRuntime } from "@ai-zen/agents-sdk";

import { HostError } from "../../infra/errors.js";
import type { AssetService } from "../asset/service.js";
import type { Translator } from "../i18n/index.js";
import type { SessionService } from "../session/service.js";
import type { WorkspaceService } from "./service.js";

/**
 * 删一个项目要经过的四个域。四样都是域服务而不是表：这条路的每一步都要先读出事实、再动库。
 */
export interface RemoveWorkspaceDeps {
  readonly workspaces: WorkspaceService;
  readonly sessions: SessionService;
  readonly assets: AssetService;
  readonly runtime: AgentRuntime;
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

  // 名下的会话在删之前读出来：删完之后这张表里就没有它们的 id 了，而返回值与下面那份素材清单
  // 都要用它们。
  const sessionIds = deps.sessions.list(workspaceId).map((session) => session.id);

  // 先杀执行体，再删行。反过来的话，从删完行到杀掉这一刻，活着的执行体还在往它那一段写：
  // 那一行已经没了，这些写要么落进一段不存在的会话，要么被外键拦住。没有活执行体时 `kill`
  // 是空操作，所以不必先问它在不在。
  for (const sessionId of sessionIds) deps.runtime.kill(sessionId);

  // 素材 id 也必须在删之前收：消息与素材关联行会随外键一起消失，删完再问「这几段引用过什么」
  // 只会得到空。同一个素材被两段会话引用时会收进来两次，所以用集合去重。
  const assetIds = new Set<string>();
  for (const sessionId of sessionIds) {
    for (const asset of deps.assets.listBySession(sessionId)) assetIds.add(asset.id);
  }

  // 只删项目这一行：会话、消息、inbox 行与素材关联由外键 `ON DELETE CASCADE` 跟着走，
  // 这里不跨域逐个删 —— 那样每一处都得自己记得还有哪几张表挂在下面。
  deps.workspaces.remove(workspaceId);

  // 扫的是上一步收起来的那一份，不是全表：只有这几段会话引用过的素材可能刚刚失去最后的引用，
  // 全表扫是另一件事，还会让这个动作带着一个与调用点无关的代价。
  //
  // 它排在上一步之后：素材的行与字节要等到引用行真的没了才删得掉，先扫的话每一份都还挂着一条
  // 马上要消失的引用，一份也扫不掉。
  deps.assets.sweepUnreferenced([...assetIds]);

  return { sessions: sessionIds };
}
