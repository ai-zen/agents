import type { AgentRuntime } from "@ai-zen/agents-sdk";

import type { Bus } from "../../infra/bus.js";
import type { AssetService } from "../asset/service.js";
import type { HostEvent } from "../events.js";
import type { HandoffService } from "../handoff/service.js";
import type { QuestionRegistry } from "../question/registry.js";

/**
 * 让会话消失要经过的四个域。都是域服务而不是表：这条路的每一步都要先读出事实、再动库。
 */
export interface RemoveSessionsDeps {
  readonly assets: AssetService;
  readonly runtime: AgentRuntime;
  /**
   * 这几段上挂着的题。题没有表，它只活在内存里、挂到被答了或这一段没了为止 —— 那一段没了，
   * 就得由删那一段的这个人去收。
   */
  readonly questions: QuestionRegistry;
  /**
   * 交接那一侧按会话记的两格：「此刻挂着的那道题」与「这一段答过不交接、不再问」。两格都是按
   * 会话 id 存的内存格，会话行没了不会自己消失。
   */
  readonly handoff: HandoffService;
  /**
   * 推事实的那条总线。「这一段没了」得由发起删除的这条路说出来：外键级联只删行，它一个字都不会
   * 往外说，另一个连着的客户端于是要等到下一次 `session.list` 才发现。
   */
  readonly events: Bus<HostEvent>;
}

/**
 * 让这几段会话消失：杀 Agent、收内存里按会话记着的那几格、收 Asset 引用、删行、按引用归零扫 Asset。
 *
 * 每一段删完推一条 `session.removed`：这一段真的没了，别的客户端手里的列表才能跟着动。
 *
 * `removeRows` 是「删那几行」本身，由调用方递进来：删一段会话删的是它那一行，删一个项目删的是
 * 项目那一行（会话行随外键跟着走）。两条路的差别只有这一句，其余收尾完全一样 —— 复制成两份的话，
 * 迟早有一份漏掉收题或扫 Asset，而那种漏法不报错也不显形。
 *
 * 返回这一次跟着一起删掉的 Asset id：Asset 是按引用归零才删的，所以这一份可能比传进来的少。
 */
export function removeSessions(
  deps: RemoveSessionsDeps,
  sessionIds: readonly string[],
  removeRows: () => void,
): string[] {
  // 先杀 Agent，再删行。反过来的话，从删完行到杀掉这一刻，活着的 Agent 还在往它那一段写：
  // 那一行已经没了，这些写要么落进一段不存在的会话，要么被外键拦住。没有活 Agent 时 `kill`
  // 是空操作，所以不必先问它在不在。
  for (const sessionId of sessionIds) deps.runtime.kill(sessionId);

  // 题跟着它那一段一起消失。题没有表，不会随会话行被外键级联掉 —— 不在这里收，这几段上挂着的
  // 题就再没人认得。等题的人拿到的是 `undefined`（没人答它了），不是「用户说了不」。
  for (const sessionId of sessionIds) deps.questions.forget(sessionId);

  // 交接那一侧的记忆也跟着忘：`declined` 是「这一段答过不交接、不再问」，`asking` 是此刻挂着的
  // 那道题。两格都按会话 id 存，这一段都没了，留着它们只会一直长大。
  for (const sessionId of sessionIds) deps.handoff.forget(sessionId);

  // Asset id 必须在删之前收：消息行与 Asset 关联行会随外键一起消失，删完再问「这几段引用过什么」
  // 只会得到空。同一个 Asset 被两段会话引用时会收进来两次，所以用集合去重。
  const assetIds = new Set<string>();
  for (const sessionId of sessionIds) {
    for (const asset of deps.assets.listBySession(sessionId)) assetIds.add(asset.id);
  }

  // 消息、排队区、Asset 关联与通知都挂在会话行上，各自的外键是 `ON DELETE CASCADE`：删掉那一行，
  // 它们跟着走。这里不跨域逐个删 —— 那样每一处都得自己记得还有哪几张表挂在下面。
  removeRows();

  // 删完才说「这段没了」：收到这条的客户端会去回读列表，排在删行之前的话它读回去那一段还在。
  //
  // 这一句只能写在这里，不能挂在表上：外键级联删的是行，它不会对谁说一句话。删一段会话与删一个
  // 项目（名下会话随外键跟着走）走的是同一个地方，两条路上「这一段没了」因此说的是同一句话。
  for (const sessionId of sessionIds) deps.events.emit({ type: "session.removed", sessionId });

  // 扫的是上一步收起来的那一份，不是全表：只有这几段会话引用过的 Asset 可能刚刚失去最后的引用，
  // 全表扫是另一件事，还会让这个动作带着一个与调用点无关的代价。
  //
  // 它排在删行之后：Asset 的行与字节要等到引用行真的没了才删得掉，先扫的话每一份都还挂着一条
  // 马上要消失的引用，一份也扫不掉。
  return deps.assets.sweepUnreferenced([...assetIds]);
}
