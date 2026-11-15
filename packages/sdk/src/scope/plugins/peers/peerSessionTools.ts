import { CallbackTool } from "@ai-zen/agents-core";
import type { Agent, Tool, ToolCallContext } from "@ai-zen/agents-core";

/**
 * 平级会话（peer session）的三个工具 —— **只负责把模型的话翻译成端口调用**。
 *
 * 端口（{@link PeerSessionPort}）由宿主实现：开一段会话、开跑、之后接着跟它说话、跑完把结果投回
 * 发起者，全都是宿主的事（会话是宿主的财产，SDK 不认识会话）。SDK 这一侧只有三件东西：参数说明，
 * 以及**给模型看的那几句话**（结果会自动推回来别轮询；接着发的话排在哪；记不住 `sessionId` 就靠
 * `label`）。
 *
 * 为什么这几句话必须同时出现在 description 与返回文案两处：模型只读它拿到的东西 —— 第一次只看
 * 得到 description，之后每次调用只看得到返回值。少写一处，模型就会开始忙等轮询
 * （`read_session_status` 一个接一个），而每轮轮询都要烧一次模型调用。
 */

/** `create_session`：开一段平级会话，受理即回 */
export const CREATE_SESSION_TOOL = "create_session";
/** `read_session_status`：只问状态 + 一条摘要，绝不返回全量消息 */
export const READ_SESSION_STATUS_TOOL = "read_session_status";
/** `send_to_session`：继续跟已经存在的那段平级会话说一句（不等结果） */
export const SEND_TO_SESSION_TOOL = "send_to_session";

/** 本插件向 `tools` 维度贡献的候选名（顺序即展示顺序） */
export const PEER_SESSION_TOOL_NAMES = [
  CREATE_SESSION_TOOL,
  READ_SESSION_STATUS_TOOL,
  SEND_TO_SESSION_TOOL,
] as const;

/**
 * 平级会话的状态。
 *
 * 前四个是记录里的状态；`gone` 只出现在 `read_session_status` 的答案里：这段会话的记录
 * 找不到了（被删掉，或者宿主重启之后那份进程内记录没了 —— 那时它就是一段普通会话）。
 */
export type PeerSessionState = "running" | "idle" | "failed" | "aborted" | "gone";

/**
 * `create_session` 被**结构化拒绝**的原因。
 *
 * 拒绝是返回结果而不是异常：模型要能读懂并改变策略（「这层不能开分身了，那我自己做」
 * 「这个助手没有可用模型，换一个」「先等已有的跑完」），异常只会把它这一轮打断。
 */
export type PeerSessionRejectReason = "depth_exceeded" | "model_unresolved" | "too_many_peers";

/**
 * `create_session` 的答案。
 *
 * 成功只给两个字段：`sessionId`（子会话的 conversationId）与可读的 `label`。**没有结果** ——
 * 「建完即回，不等子会话跑完」是整个方案的定盘星：等待就等于子代理，那已经存在了。
 */
export type PeerSessionCreated =
  | { ok: true; sessionId: string; label: string }
  | { ok: false; reason: PeerSessionRejectReason; hint?: string };

/**
 * `read_session_status` 的答案。
 *
 * `lastMessage` 是子会话最后一条助手消息的**截断摘要**（宿主侧 ~300 字），不是全量消息：
 * 给了原文，模型就会把它当上下文搬运，token 立刻炸，而且绕过了我们自己的上下文管理。
 */
export interface PeerSessionStatus {
  state: PeerSessionState;
  label?: string;
  startedAt?: string;
  lastMessage?: string;
}

/**
 * `send_to_session` 的答案。
 *
 * 成功只给 `state`：**投递那一刻**对方处于什么状态（`running` = 这一条排在它这一轮末尾；
 * `idle` = 这一条会把它叫起来；`settling` = 它正在收尾，这一条排在后面）。不是「已经跑完了」——
 * 本工具从不等结果。
 *
 * 两种拒绝：`gone`（这段会话没有了：被删了，或者宿主重启之后那份进程内记录没了）、
 * `not_allowed`（它与我之间没有父子关系：平级会话之间不许互发）。
 */
export type PeerSessionSent =
  | { ok: true; state: "running" | "idle" | "settling" }
  | { ok: false; reason: "gone" | "not_allowed" };

/** `send_to_session` 的入参（`caller` 由插件从 `ToolCallContext` 取，不由模型给） */
export interface PeerSessionSendInput {
  /** 谁在调这个工具（`ctx.agent`）—— 宿主据此认领「哪一段会话在说话」与消息署名 */
  caller: Agent;
  sessionId: string;
  content: string;
}

/** `create_session` 的入参（`caller` 由插件从 `ToolCallContext` 取，不由模型给） */
export interface PeerSessionCreateInput {
  /** 谁在调这个工具（`ctx.agent`）—— 宿主据此认领「哪一段会话在开分身」 */
  caller: Agent;
  prompt: string;
  agentId?: string;
  modelId?: string;
  label?: string;
}

/**
 * 宿主实现给 SDK 的端口（**SDK 不依赖宿主**：这个接口是唯一的一处接线）。
 *
 * 不给端口时插件不产出任何工具 —— 老行为一个字不变。
 */
export interface PeerSessionPort {
  create(input: PeerSessionCreateInput): Promise<PeerSessionCreated>;
  status(input: { caller: Agent; sessionId: string }): Promise<PeerSessionStatus>;
  /**
   * 继续跟一段已有的平级会话说一句（不返回结果：结果跑完会自己推回来）。
   *
   * 与 `create` / `status` 同构：**只收 `caller`**，不收来源名 / label —— 正文那行「来自 会话「…」
   * 自动推送」由宿主按调用方解析（模型说自己是谁不算数）。
   */
  send(input: PeerSessionSendInput): Promise<PeerSessionSent>;
}

/** ① 结果会自动推回来、别轮询；② 记不住 `sessionId` 就靠 `label` */
const CREATE_HINT =
  "The result of this session is pushed back to me automatically when it settles — that push " +
  "wakes me up, so do not poll it (and do not call read_session_status in a loop). Keep `label` " +
  "next to `sessionId`: if I forget the id later, `label` is how I name this session.";

/** 拒绝各自的一句话：说清「为什么」与「接下来能做什么」（宿主没给 hint 时用它） */
const REJECT_HINTS: Record<PeerSessionRejectReason, string> = {
  depth_exceeded:
    "This conversation is itself a peer session, and peer sessions cannot open further peer " +
    "sessions (one level only). Do the work here instead, or report back and let the conversation " +
    "that started this one spawn it.",
  model_unresolved:
    "No model could be resolved for that peer session (no session override, no modelId on the " +
    "agent definition, no global default model). Pass `modelId`, or pass an `agentId` that has a " +
    "model bound.",
  too_many_peers:
    "This conversation already has the maximum number of peer sessions running at the same time. " +
    "Wait for some of them to finish (their results are pushed back to me automatically), or give " +
    "the work to fewer sessions instead of opening another one.",
};

/**
 * `send_to_session` 被拒绝的两种原因各自的一句话（端口只回原因，不给文案）。
 *
 * `gone` 要说清「不会再有回音」（否则模型会等一条永远不会到的结果），`not_allowed` 要说清
 * 「自己把活干掉」，两者都不建议重试。
 */
const SEND_REJECT_HINTS: Record<"gone" | "not_allowed", string> = {
  gone:
    "There is no record of this session any more: it was deleted, or the host restarted and that " +
    "in-process record is gone (it is now an ordinary conversation that still shows up in the " +
    "session list). Nothing was sent and no result will arrive — do the work here instead.",
  not_allowed:
    "That session is not related to this one: only a conversation and the peer sessions it " +
    "started can talk to each other, and peer sessions cannot message each other. Nothing was " +
    "sent — handle it here, or report back and let the conversation that started this one relay.",
};

/**
 * `send_to_session` 成功时每个 `state` 一句给模型的话。
 *
 * 三句必须都在（少一句模型就会开始忙等，或者记不住是哪段会话）：
 *   ① 对方在跑 → 这一条排在它这一轮末尾；对方空闲 → 这一条会把它叫起来；
 *   ② **不要等结果**，跑完会自动推回来；
 *   ③ 记不住 `sessionId` 就靠 `label` 认。
 * 「排在末尾 / 叫起来 / 先攒着」只差头一句，后两句三支一模一样。
 */
const SEND_TAIL =
  "Do not wait for a result: this message does not come back here, the result of that session " +
  "is pushed back to me automatically when it settles and that push wakes me up. If I forget the " +
  "`sessionId`, the `label` returned by create_session is how I name this session.";

/** `send_to_session` 成功回执里的 `state`（与宿主的 `DeliveryOutcome.state` 同义） */
export type PeerSessionSendState = "running" | "idle" | "settling";

function sendHint(state: PeerSessionSendState): string {
  switch (state) {
    case "running":
      return (
        "It is running, so this message waits in line and is picked up at the end of its current " +
        `turn. ${SEND_TAIL}`
      );
    case "idle":
      return `It was idle, so this message wakes it up and it starts a new turn. ${SEND_TAIL}`;
    case "settling":
      return (
        "It is finishing its current turn, so this message is held and delivered as soon as that " +
        `turn settles. ${SEND_TAIL}`
      );
  }
}

/** 每个状态一句给模型的话（同样带着「别轮询」与「靠 label」两句） */
function statusHint(state: PeerSessionState): string {
  switch (state) {
    case "running":
      return (
        "It is still running. Its result will be pushed to me automatically when it settles — do " +
        "not poll it. If I forget the `sessionId`, the `label` identifies this session."
      );
    case "idle":
      return (
        "It finished and its result was already pushed to me automatically. Do not poll it again. " +
        "If I forget the `sessionId`, the `label` identifies this session."
      );
    case "failed":
    case "aborted":
      return (
        "It stopped without finishing; the result (including why it stopped) was already pushed " +
        "to me automatically. Do not poll it again. If I forget the `sessionId`, the `label` " +
        "identifies this session."
      );
    case "gone":
      return (
        "There is no record of this session any more: it was deleted, or the host restarted and " +
        "that in-process record is gone (in that case it is now an ordinary conversation that " +
        "still shows up in the session list). Do not wait for a result that will never arrive; if " +
        "I only remember the `label`, that session can no longer be looked up by it."
      );
  }
}

/**
 * 造三个工具（顺序即返回顺序）。
 *
 * 三个工具都是即时返回的 `CallbackTool`：真正的等待在宿主那一侧（子会话自己跑）。
 */
export function createPeerSessionTools(port: PeerSessionPort): Tool[] {
  return [createSessionTool(port), readSessionStatusTool(port), sendToSessionTool(port)];
}

/** `create_session({ prompt, agentId?, modelId?, label? })` → `{ sessionId, label }` */
function createSessionTool(port: PeerSessionPort): Tool {
  return new CallbackTool({
    function: {
      name: CREATE_SESSION_TOOL,
      description: [
        "Open a PEER SESSION: a separate, full conversation with its own agent that works on",
        "`prompt` in parallel with me (own context, own usage, and it stays readable in the",
        "session list afterwards). Use it for work that can happen alongside this conversation",
        "instead of blocking it.",
        "This call returns as soon as the session is accepted — it does NOT wait for the work to",
        "finish, so do not expect the result here.",
        "The result is pushed back to me automatically when that session settles, and that push",
        "wakes me up so I can carry on: do not poll it repeatedly.",
        "Remember the returned `label` as well as `sessionId`: in a long conversation I may no",
        "longer recall the id, and the label is how I refer to this session.",
      ].join(" "),
      parameters: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description:
              "What that session should do. Write it as a self-contained task: the peer session " +
              "starts from an empty context and cannot see this conversation.",
          },
          agentId: {
            type: "string",
            description:
              "Agent (by id) that runs the peer session (optional, defaults to the agent of this " +
              "conversation)",
          },
          modelId: {
            type: "string",
            description:
              "Model id for the peer session (optional, defaults to the usual resolution: session " +
              "> agent definition > global default)",
          },
          label: {
            type: "string",
            description:
              'Short readable name for this session (optional, e.g. "run the tests"). It is what ' +
              "the pushed-back result says and what read_session_status shows.",
          },
        },
        required: ["prompt"],
        additionalProperties: false,
      },
    },
    callback: async (input: Record<string, unknown>, ctx: ToolCallContext) => {
      const created = await port.create({
        caller: ctx.agent,
        prompt: typeof input.prompt === "string" ? input.prompt : String(input.prompt ?? ""),
        ...optionalString("agentId", input.agentId),
        ...optionalString("modelId", input.modelId),
        ...optionalString("label", input.label),
      });

      // 结构化拒绝：模型能按字段分支，不用去读自由文本（宿主没给 hint 时用 SDK 这一份）
      if (!created.ok)
        return { rejected: created.reason, hint: created.hint ?? REJECT_HINTS[created.reason] };
      return { sessionId: created.sessionId, label: created.label, hint: CREATE_HINT };
    },
  });
}

/** `read_session_status({ sessionId })` → `{ state, label?, startedAt?, lastMessage?, hint }` */
function readSessionStatusTool(port: PeerSessionPort): Tool {
  return new CallbackTool({
    function: {
      name: READ_SESSION_STATUS_TOOL,
      description: [
        "Check a peer session created earlier: its state (running / idle / failed / aborted /",
        "gone) plus a short digest of its last assistant message — never the full conversation,",
        "so do not use it to fetch results or context.",
        "The result is pushed back to me automatically when that session settles and that push",
        "wakes me up: this tool is for a single check (is it still running? is it gone?), not for",
        "polling in a loop.",
        "If I no longer remember the `sessionId`, the `label` returned by create_session is what",
        "identifies the session — it comes back in the answer, so I can tell them apart.",
      ].join(" "),
      parameters: {
        type: "object",
        properties: {
          sessionId: {
            type: "string",
            description:
              "The sessionId returned by create_session (that id is also the conversation id of " +
              "that session)",
          },
        },
        required: ["sessionId"],
        additionalProperties: false,
      },
    },
    callback: async (input: Record<string, unknown>, ctx: ToolCallContext) => {
      const status = await port.status({
        caller: ctx.agent,
        sessionId: typeof input.sessionId === "string" ? input.sessionId : "",
      });
      // 键的出现与否本身就是信息：`label` / `startedAt` / `lastMessage` 拿不到就不出现
      return {
        state: status.state,
        ...(status.label === undefined ? {} : { label: status.label }),
        ...(status.startedAt === undefined ? {} : { startedAt: status.startedAt }),
        ...(status.lastMessage === undefined ? {} : { lastMessage: status.lastMessage }),
        hint: statusHint(status.state),
      };
    },
  });
}

/** `send_to_session({ sessionId, content })` → `{ accepted, state }` / `{ rejected, hint }` */
function sendToSessionTool(port: PeerSessionPort): Tool {
  return new CallbackTool({
    function: {
      name: SEND_TO_SESSION_TOOL,
      description: [
        "Send another message to a PEER SESSION created earlier by create_session — it is how I",
        "carry on with that session instead of starting a new one.",
        "If that session is running, this message is queued and picked up at the end of its",
        "current turn; if it is idle, this message wakes it up and it starts a new turn. Either",
        "way the call returns immediately.",
        "Do not wait for a result here: this message does not come back, and the result of that",
        "session is pushed back to me automatically when it settles (that push wakes me up), so do",
        "not poll it.",
        "If I no longer remember the `sessionId`, the `label` returned by create_session is how I",
        "identify that session.",
      ].join(" "),
      parameters: {
        type: "object",
        properties: {
          sessionId: {
            type: "string",
            description:
              "The sessionId returned by create_session (that id is also the conversation id of " +
              "that session)",
          },
          content: {
            type: "string",
            description:
              "What to say to that session. Write it as a self-contained instruction: it cannot " +
              "see this conversation, it only has its own history.",
          },
        },
        required: ["sessionId", "content"],
        additionalProperties: false,
      },
    },
    callback: async (input: Record<string, unknown>, ctx: ToolCallContext) => {
      const sent = await port.send({
        caller: ctx.agent,
        sessionId: typeof input.sessionId === "string" ? input.sessionId : "",
        content: typeof input.content === "string" ? input.content : String(input.content ?? ""),
      });

      // 结构化拒绝：模型能按字段分支，不用去读自由文本
      if (!sent.ok) return { rejected: sent.reason, hint: SEND_REJECT_HINTS[sent.reason] };
      return { accepted: true, state: sent.state, hint: sendHint(sent.state) };
    },
  });
}

/** 可选的字符串参数：空串与非字符串都当作「没给」，不往端口里塞一个假值 */
function optionalString<K extends "agentId" | "modelId" | "label">(
  key: K,
  value: unknown,
): Partial<Record<K, string>> {
  if (typeof value !== "string" || value.length === 0) return {};
  return { [key]: value } as Partial<Record<K, string>>;
}
