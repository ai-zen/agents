/**
 * MCP Elicitation 的「这次调用属于谁」。
 *
 * ## 为什么要这一层
 *
 * MCP 客户端是按 Scope 共享的：一个工作目录一份，那段目录下所有会话共用同一台 MCP 连接。
 * 而 `elicitation/create` 是服务器在 `tools/call` 中途发回来的，处理器拿到的载荷里没有「是哪段
 * 会话的哪次调用」—— 它只知道「有一台服务器要问人」。
 *
 * 所以出题之前得有人记账：谁能答题（宿主的题板）、答在哪一段会话下。这一层就是那本账 ——
 * 按客户端记一个栈，`call_mcp_tool` 在真正发请求之前把当前这一格的账压进去，回来时弹出。
 *
 * ## 并发的代价（写在这里，别当成 bug 查）
 *
 * 同一批工具调用是并行跑的（core 的 `runTools` 用 `Promise.all`）。两次 `call_mcp_tool` 同时在
 * 飞时，栈顶是「最后压进去的那一次」—— 服务器的 elicitation 回来时，本模块把它记在那一次头上。
 * 同一段会话内的并行调用不受影响（答题的仍是同一段会话）；跨会话并行才有可能记到另一段上，
 * 而那种情况下也没有任何客户端可见的信息能把它们分开。
 *
 * ## 没有账时一律 cancel
 *
 * 一次性 Agent（子 agent、`runOnce`、`/ask`）手上没有题板 —— 宿主不会给它们装这一层。于是栈是
 * 空的，处理器回 `cancel`：没人做决定，说的就是这个。`decline` 是留给用户的明确拒绝的（面板上的
 * `[拒绝]`），自动回的只可能是 `cancel`。
 */

import type { Agent } from "@ai-zen/agents-core";

/** 服务器要问的那张表：与宿主 `FormRequest` 的 `requestedSchema` 同一形状（spec 的子集） */
export interface ElicitRequest {
  readonly message: string;
  readonly requestedSchema: Record<string, unknown>;
}

/**
 * 表单内容的值（spec 里 `requestedSchema` 允许的那四种：字符串、数字、布尔、多选枚举）。
 *
 * 收得比宿主的 `Record<string, unknown>` 窄：交回服务器的那一份必须正好是这四种，多一层收窄
 * 在边界上，比事后在别处发现一个对象被序列化进去强。
 */
export type ElicitContent = Record<string, string | number | boolean | string[]>;

/** 一次作答（与 MCP 的 `action` 一一对应） */
export interface ElicitAnswer {
  readonly action: "accept" | "decline" | "cancel";
  readonly content?: ElicitContent;
}

/**
 * 一个 Agent 的答题通道：题挂在 `sessionId` 那段会话下，`ask` 把表交给宿主、等一个答复。
 *
 * `ask` 回 `undefined` 是「没人答它了」（会话没了），处理器据此回 `cancel` —— 那不是「用户说了
 * 不」，是「没人做决定」。
 */
export interface ElicitationOwner {
  readonly sessionId: string;
  readonly ask: (request: ElicitRequest) => Promise<ElicitAnswer | undefined>;
}

/** 按 Agent 记的账：谁装了哪一条答题通道 */
const owners = new WeakMap<Agent, ElicitationOwner>();

/** 按客户端记的栈：此刻正在飞的那几次调用各自属于谁（栈顶是最近压进去的） */
const inFlight = new WeakMap<object, ElicitationOwner[]>();

/** 给这个 Agent 装一条答题通道（宿主在建这一段会话时装，一次性 Agent 不装） */
export function volunteerElicitation(agent: Agent, owner: ElicitationOwner): void {
  owners.set(agent, owner);
}

/** 这个 Agent 有没有答题通道 */
export function elicitationOwnerOf(agent: Agent | undefined): ElicitationOwner | undefined {
  return agent === undefined ? undefined : owners.get(agent);
}

/**
 * 在这次调用的范围内把「谁在问」绑到那个客户端上。
 *
 * 压栈而不是覆盖：同一次调用里可能嵌套（服务器在 elicitation 之后又发一个），弹栈时只弹自己那
 * 一格 —— 覆盖会把外层那一格丢掉，后一个 request 就不知道该挂哪一段会话了。
 */
export async function withElicitationOwner<T>(
  client: object | undefined,
  owner: ElicitationOwner | undefined,
  run: () => Promise<T>,
): Promise<T> {
  if (client === undefined || owner === undefined) return await run();

  const stack = inFlight.get(client) ?? [];
  inFlight.set(client, stack);
  stack.push(owner);
  try {
    return await run();
  } finally {
    stack.pop();
  }
}

/** 这个客户端此刻在飞的那一次属于谁（没有人在飞就是 `undefined`） */
export function currentElicitationOwner(client: object): ElicitationOwner | undefined {
  const stack = inFlight.get(client);
  return stack === undefined ? undefined : stack.at(-1);
}
