/**
 * 断线之后**补拉**：拉回「现在是什么状态」与「我漏了哪些消息」（PRD L5 / A12）。
 *
 * ## 为什么是客户端拉，而不是服务端重放
 *
 * 推送是「在线时的一脚提醒」，不重放、不需要 ack（`packages/server/src/wire/events.ts` 开头）。
 * 断线期间发生的事一律作废，重连的客户端自己按两样拉回来：
 *   1. `conversation.state` —— 六态、上下文阈值、思考档、用量、问题、状态栏块（一份完整快照）；
 *   2. `message.list({ after })` —— 消息。
 *
 * ## `after` 的语义（A12）：从那条**开始**，不是从它的下一条
 *
 * 上次拿到的最后一条可能正是「流式中那条」，它的内容在这段时间里变了。把它的 id 交给
 * `after`，服务端回的**第一条就是它自己**（内容是最新的），于是这次补拉天然是「最新内容 + 之后
 * 的全部」—— 这也是 {@link mergeResumed} 用「整体替换」而不是「追加」的原因：流式那条是替换，
 * 不是再写一条。
 *
 * 三种情形（服务端 `message.list` 的约定）：
 *   · 不给 `after` → 全部；
 *   · 给了且该 id 存在 → 从它开始（`anchor` 回它）+ 其后全部；
 *   · 给了但该 id 不存在（已删除、库换过）→ 全部（`anchor` 为空）。
 * 客户端据此把 `anchor` 是不是空当成「这次是续传还是全量」，不必自己猜。
 */

import type {
  AgentNS,
  ConversationState,
  MethodName,
  MethodParams,
  MethodResult,
} from "@ai-zen/agents-server";

/**
 * 补拉只需要「能调契约方法」这一件事。
 *
 * `Client` 结构上满足它；用例也可以给一个假的，于是补拉的这段逻辑不必起 socket 就能测。
 */
export interface ContractCaller {
  call<M extends MethodName>(method: M, params: MethodParams<M>): Promise<MethodResult<M>>;
}

/** 这次补拉是续传（`after` 命中）还是全量（没给 / 没命中） */
export type ResumeMode = "anchor" | "full";

/** 一次补拉的结果：一份现场 + 一段消息 */
export interface ResumedConversation {
  conversationId: string;
  /** `conversation.state` 里的现场（六态、用量、问题、状态块都在里面） */
  state: ConversationState;
  /** `message.list` 回的那个 `anchor`：命中的那条 id，没命中为空 */
  anchor: string | null;
  /**
   * 消息：`mode === "anchor"` 时**第一条就是 `anchor` 那条**，内容是服务端最新的（可能是流式中
   * 那条的部分内容 + 还在写的标记）；`mode === "full"` 时是整段对话的全部消息。
   */
  messages: AgentNS.Message[];
  mode: ResumeMode;
}

/**
 * 补拉一段对话：先 `conversation.state`、再 `message.list({ after })`。
 *
 * 两步串行而不是并发：状态里有「这一段现在在不在跑」，消息里有「跑到哪了」，两个结果都要落到
 * 同一份快照上；串行让「快照对应哪一刻」这件事至少是确定的（先状态、后消息，消息更晚更新）。
 */
export async function resumeConversation(
  client: ContractCaller,
  conversationId: string,
  after?: string,
): Promise<ResumedConversation> {
  const { state } = await client.call("conversation.state", { conversationId });
  const listed = await client.call("message.list", {
    conversationId,
    ...(after ? { after } : {}),
  });

  return {
    conversationId,
    state,
    anchor: listed.anchor,
    messages: listed.messages,
    mode: listed.anchor === null ? "full" : "anchor",
  };
}

/**
 * 把补拉结果并进本地消息列表 —— 「续传」与「全量」两种情形各自的拼法，只此一处。
 *
 * · 全量（`anchor` 为空）：整份替换。本地那一份只是旧快照，服务端的是它现在的样子。
 * · 续传：本地 `anchor` 之前的部分原样保留，从 `anchor` 起**整段换成服务端给的** —— 服务端回的
 *   第一条就是 `anchor` 那条的最新内容，所以流式中那条是**替换**而不是又追加一条（追加会在屏幕
 *   上留一段过期正文）。
 * · 续传但本地找不到 `anchor`（对话被撤回、本地列表被换过）：按全量处理，以服务端为准。
 */
export function mergeResumed(
  local: readonly AgentNS.Message[],
  resumed: ResumedConversation,
): AgentNS.Message[] {
  const anchor = resumed.anchor;
  if (resumed.mode === "full" || anchor === null) return [...resumed.messages];

  const index = local.findIndex((message) => message.id === anchor);
  if (index < 0) return [...resumed.messages];
  return [...local.slice(0, index), ...resumed.messages];
}

/** 本地消息列表里最后一条的 id —— 重连补拉的 `after` 就是它 */
export function lastMessageId(messages: readonly AgentNS.Message[]): string | undefined {
  return messages.at(-1)?.id;
}
