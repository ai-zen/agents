import { AgentNS } from "@ai-zen/agents-core";
import type { AgentRuntime } from "@ai-zen/agents-sdk";

import type { Bus } from "../../infra/bus.js";
import { HostError } from "../../infra/errors.js";
import type { AssetService } from "../asset/service.js";
import type { HostEvent } from "../events.js";
import type { Translator } from "../i18n/index.js";
import type { messageTable } from "./messages.js";
import type { SessionService } from "./service.js";

/**
 * 撤回要经过的五个域。都是域服务而不是表：每一步都要先读出事实、再动库，而素材要连同盘上的
 * 字节一起收。
 *
 * `runtime` 只为了两件事：它忙不忙（跑着的时候不许撤），以及记忆里活着的那一份在哪里。
 */
export interface RewindDeps {
  readonly sessions: SessionService;
  readonly messages: ReturnType<typeof messageTable>;
  readonly assets: AssetService;
  readonly runtime: AgentRuntime;
  readonly events: Bus<HostEvent>;
  readonly t: Translator;
}

/**
 * 撤回到这条消息之前：这条与它之后的全部硬删，正文交回去让客户端回填输入框。
 *
 * 「撤回」是**这一句不算我说过**，所以它删的是历史本身（库里的行、记忆里那一份），不是把话
 * 改成别的东西、也不是留一条「已撤回」的空壳 —— 模型下一次请求要看不到它说过的那半截。
 *
 * ## 一条一条的规则
 *
 * 1. 会话行不存在 → `not_found`（连「这一段是谁」都不知道，后面每一步都没有材料）；
 * 2. 目标消息不存在、或不属于这一段 → `not_found`（`messageId` 是客户端给的，它可能属于另一段
 *    会话，也可能那条已经没了）；
 * 3. **只认用户自己说的话**：`role === "user"` 且 `source?.kind === "user"`，别的一律
 *    `invalid_params`。助手的话与工具结果不是「自己说过的话」，撤回它们的语义另说（撤回一条
 *    助手回复等于什么？它后面的工具调用要不要一起作废？），这一版不做；
 * 4. **跑着的时候不许撤**：`working` 时记忆正被写（`PRD.md` 4.1：没在跑的时候才可以直接改
 *    记忆），从外面 `splice` 一手就是两个东西同时改同一个数组；
 * 5. 硬删：这一段历史里**从这一条起（含）到最后**的消息逐条删行；记忆里活着的那一份用
 *    `splice` **就地**删（不换数组引用 —— 执行体自己拿着那个数组，换一个它看不见）；
 * 6. 素材：删之前把这几个 id 收起来（`assets.listBySession` 是按「这一段的消息引用了哪些」
 *    查的，所以收起的是整段的引用，删完之后由 `sweepUnreferenced` 逐个判「还剩不剩引用」
 *    —— 还被活下来的消息引用的那些会原地留下）；
 * 7. 删掉的每一条推一条 `message.removed`，客户端据此把行去掉；
 * 8. 返回目标那条的 `content` 原样（可能是字符串，也可能是内容块数组），客户端拿它回填输入框。
 *
 * **不通过 agent 的 `emit("messageRemoved")` 报这件事**：观察者收到那条会去删库、并推一条
 * `message.removed` 给客户端，而这里已经删过、也会自己推 —— 两条路一起走就是删两次、推两条。
 */
export function rewindTo(
  deps: RewindDeps,
  sessionId: string,
  messageId: string,
): { content: AgentNS.MessageContent } {
  // 1. 会话行
  if (deps.sessions.get(sessionId) === undefined) {
    throw new HostError("not_found", deps.t("找不到 id 为 {sessionId} 的会话", { sessionId }), {
      entity: "session",
      sessionId,
    });
  }

  // 2. 目标消息：`messages.get` 只按 id 查、不认会话，所以「属不属于这一段」只能拿这一段的历史比。
  // 顺带取到它的下标 —— 后面「从这一条起」用的就是这个下标。
  const history = deps.messages.listBySession(sessionId);
  const index = history.findIndex((message) => message.id === messageId);
  if (index === -1) {
    throw new HostError(
      "not_found",
      deps.t("这一段历史里没有 id 为 {messageId} 的消息", { messageId }),
      { entity: "message", sessionId, messageId },
    );
  }

  const target = history[index]!;

  // 3. 只认用户自己说的话：助手的话、工具结果、宿主注入的那几条（`source.kind` 是 `system` /
  // `agent`）都不是「自己说过的话」。
  if (target.role !== AgentNS.Role.User || target.source?.kind !== "user") {
    throw new HostError(
      "invalid_params",
      deps.t("只能撤回到自己说过的话之前：助手的话与工具结果不是这个意思"),
      { entity: "message", sessionId, messageId, role: target.role },
    );
  }

  // 4. 跑着的时候不许撤：那一刻记忆正被内核写。
  const agent = deps.runtime.get(sessionId);
  if (agent?.state === "working") {
    throw new HostError("busy", deps.t("这段会话还在跑，等它停下来再撤回"), {
      entity: "session",
      sessionId,
    });
  }

  // 6 的前半步：素材 id 必须在删之前收。消息行一没，关联行跟着级联消失，删完再问「这一段引用过
  // 什么」只会得到空。
  const assetIds = deps.assets.listBySession(sessionId).map((asset) => asset.id);

  // 5. 硬删。先删库再删记忆：库是权威那一份，中途出事时最坏是多留几条活着的历史，
  // 而反过来的话，库里那一条已经没人记得它是谁了。
  const doomed = history.slice(index);
  for (const message of doomed) deps.messages.delete(message.id);

  if (agent !== undefined) {
    // 就地删：`splice` 从目标那条起一直切到末尾，**不换数组引用**（执行体自己拿着它）。
    // 按 id 找下标而不是直接用上面那个：记忆里前面还接着助手定义带来的系统提示，两边的下标
    // 不是一个。记忆里找不到这一条（理论上不会）就什么都不动。
    const at = agent.messages.findIndex((message) => message.id === messageId);
    if (at !== -1) agent.messages.splice(at);
  }

  // 6 的后半步：扫的是刚收起来的那一份，不是全表 —— 只有这一段引用过的素材可能刚刚失去最后的
  // 引用。它排在删消息之后：关联行要真的没了，`countByAsset` 才会归零。
  deps.assets.sweepUnreferenced(assetIds);

  // 7. 逐条推事实：推在删完之后，订阅者收到它时回读历史，读到的已经是删干净的那一份。
  for (const message of doomed) {
    deps.events.emit({ type: "message.removed", sessionId, messageId: message.id });
  }

  // 8. 正文原样交回去。撤回的是自己说过的话，它总有正文；真空着时给一个空串 —— 输入框里
  // 就是一个空的输入框，而不是 `undefined` 那样的第四种状态。
  return { content: target.content ?? "" };
}
