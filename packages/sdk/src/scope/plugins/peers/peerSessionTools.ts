import { CallbackTool } from "@ai-zen/agents-core";
import type { Agent, Tool, ToolCallContext } from "@ai-zen/agents-core";

/**
 * PeerSession（peer session）的三个工具 —— 只负责把模型的话翻译成端口调用。
 *
 * 端口（{@link PeerSessionPort}）由宿主实现：开一段会话、把一句话投进去、现读它此刻落在哪一格，
 * 都是宿主的事（会话是宿主的财产，SDK 不认识会话）。SDK 这一侧只有三样东西：参数说明、
 * 给模型看的那几句话（别轮询：目标会话有话说时会自己调 `post_message` 回来；记不住 `sessionId`
 * 就靠 `label`），以及三个工具各自的返回形状。
 *
 * ## 为什么这几句话必须同时出现在 description 与返回文案两处
 *
 * 模型只读它拿到的东西 —— 第一次只看得到 description，之后每次调用只看得到返回值。少写一处，
 * 模型就会开始轮询（`read_session_status` 一个接一个），而每次轮询都要消耗一次模型调用。
 *
 * ## 投递不承诺任何未来
 *
 * `post_message` 的回执只有「收下了」。那边忙不忙、什么时候取走、取走之后会做什么，都不是
 * 这一句话能定下的，写在回执里就是对未来的断言 —— 而未来只能靠观测（`read_session_status`）
 * 与对方自己发来的话去读。所以本文件的回执里没有「把它叫起来了」「排在它手头那批后面」这类话。
 *
 * ## 投递不看关系
 *
 * 谁都能给谁投：`post_message` 只问「目标在不在、活不活」，不问双方的会话是什么关系。平级之间
 * 能不能互发、发了对方理不理，靠的是 agent 自己的知识（它在提示里就知道自己跟谁在说话），
 * 不是一道校验。只有创建还有「只限一层」这条产品限制，它写在 `create_session` 那边。
 */

/** `create_session`：开一段 PeerSession，建完即回 */
export const CREATE_SESSION_TOOL = "create_session";
/** `read_session_status`：只问状态 + 一句摘要，绝不返回全量消息 */
export const READ_SESSION_STATUS_TOOL = "read_session_status";
/** `post_message`：给另一段会话投一句话（不等结果，投递不看关系） */
export const POST_MESSAGE_TOOL = "post_message";

/** 本插件向 `tools` 维度贡献的候选名（顺序即展示顺序） */
export const PEER_SESSION_TOOL_NAMES = [
  CREATE_SESSION_TOOL,
  READ_SESSION_STATUS_TOOL,
  POST_MESSAGE_TOOL,
] as const;

/**
 * 忙不忙 —— 只读的观测值，就是 core 的 `agent.state` 那两格，名字不改。
 *
 * 这里没有 `paused`、也没有 `dead`：那两件事不是「忙不忙」—— 一个是输出开关关着（它闲着，
 * 但不会自己动），一个是根本没有 agent 对象。挤进同一格，模型就分不清「它闲着」与「它压根
 * 不是活的」。死活由同一个答复里的 `alive` 说；两道开关对 PeerSession 不报（PeerSession
 * 只需要「忙不忙 + 最近一句摘要」）。
 *
 * 也没有 `running` / `failed` / `aborted`：失败是某条消息上的事实（那条消息的 `status` /
 * `error`），不是一段会话此刻的状态；也没有 `gone`：会话找不到就是 `found: false`。
 */
export type PeerSessionActivity = "working" | "idle";

/**
 * `create_session` 被结构化拒绝的原因。
 *
 * 拒绝是返回结果而不是异常：模型要能读懂并改变策略（「这层不能开分身了，那我自己做」
 * 「这个 AgentDefinition 没有可用模型，换一个」「手头那几个还忙，先等一等或分给更少的会话」），异常只会
 * 把它这一步打断。
 *
 * 三条都是创建的限制：`post_message` 没有「只限一层」「限额」这类判据 —— 投递只看目标
 * 在不在、活不活。
 */
export type PeerSessionRejectReason = "depth_exceeded" | "model_unresolved" | "too_many_peers";

/**
 * `create_session` 的答案。
 *
 * 成功只给两个字段：`sessionId`（新开那段会话的 id）与可读的 `label`。没有结果 ——
 * 建完即回：这里从来不等那边答完，也不会有任何东西被推回给发起者。
 */
export type PeerSessionCreated =
  | { ok: true; sessionId: string; label: string }
  | { ok: false; reason: PeerSessionRejectReason; hint?: string };

/**
 * `read_session_status` 的答案 —— 判别式：要么「没有这一段」，要么「有这一段」并给出忙不忙与死活。
 *
 * `found: false` 那支的 `status` 就是 `null`：找不到不是一个状态值（忙不忙、活不活都是活对象
 * 身上的事实，找不到就没有对象可读）。把它挤进同一格会让模型把「会话被删了」当成一种可等的情形。
 *
 * 有这一段时只有三格：忙不忙（`status`）、叫什么（`label`）、最近一句说了什么
 * （`lastMessage`：最近一条 assistant 消息的正文摘要，截断到 300 字，超出以省略号收尾；它还没
 * 说过话就是 `null`）—— 这就是「忙不忙 + 最近一句摘要」的全部。
 *
 * 不给全量消息，也不给历史（没有消息数组、没有条数、没有原文）：给了原文模型就会把它当
 * 上下文搬运，token 用量立刻超出预算，而且绕过了本仓自己的上下文管理。
 */
export type PeerSessionStatus =
  | { found: false; status: null }
  | {
      found: true;
      /** 忙不忙（两格，见 {@link PeerSessionActivity}） */
      status: PeerSessionActivity;
      /** 死活：那一段此刻还有没有 agent 对象（`false` = 死了，投过去也没人取走） */
      alive: boolean;
      label: string;
      /** 最近一条 assistant 消息的正文摘要（最多 300 字 + 省略号）；还没说过话就是 `null` */
      lastMessage: string | null;
    };

/**
 * `post_message` 被拒绝的两种原因 —— 就是投递的两条判据。
 *
 * `gone`：这段会话不在（会话行被删了）；
 * `dead`：会话在，但那边没有 agent 对象，投过去也没有人会取走。
 *
 * 两者对模型是同一类答复：这句话没投出去，别等回音。
 */
export type PeerSessionSendRejectReason = "gone" | "dead";

/**
 * `post_message` 的答案。
 *
 * 成功只有 `ok`，一个字段都不多：投递那一刻能定下的只有「收下了」。那边忙不忙、什么时候取走
 * 都不是回执该说的话（那是对未来的断言）。
 */
export type PeerSessionPosted = { ok: true } | { ok: false; reason: PeerSessionSendRejectReason };

/** `post_message` 的入参（`caller` 由插件从 `ToolCallContext` 取，不由模型给） */
export interface PeerSessionPostInput {
  /** 谁在调这个工具（`ctx.agent`）—— 宿主据此认领「哪一段会话在说话」与消息署名 */
  caller: Agent;
  sessionId: string;
  content: string;
}

/** `create_session` 的入参（`caller` 由插件从 `ToolCallContext` 取，不由模型给） */
export interface PeerSessionCreateInput {
  /** 谁在调这个工具（`ctx.agent`）—— 宿主据此认领「哪一段会话在开新会话」 */
  caller: Agent;
  prompt: string;
  agentId?: string;
  modelId?: string;
  label?: string;
}

/**
 * 宿主实现给 SDK 的端口（SDK 不依赖宿主：这个接口是唯一的一处接线）。
 *
 * 不给端口时插件不产出任何工具。
 */
export interface PeerSessionPort {
  /**
   * 开一段会话，建完立刻回 `{ sessionId, label }`。
   *
   * 「立刻」是这一格的全部意思：不在里面等那边答完，也不挂 `.then` 去接任何后续事实。
   * 拒绝照 {@link PeerSessionCreated} 的样子回，不抛错。
   */
  create(input: PeerSessionCreateInput): Promise<PeerSessionCreated>;
  /**
   * 现读那一格加上最近一句的摘要（不存镜像：状态是活对象身上的事实）；找不到就是
   * `found: false`。摘要只是「最近一条 assistant 消息的开头一段」，不是消息列表。
   */
  status(input: { caller: Agent; sessionId: string }): Promise<PeerSessionStatus>;
  /**
   * 把一句话投给一段会话（不等结果，也不回状态）。
   *
   * 与 `create` / `status` 同构：只收 `caller`，不收来源名 / label —— 正文那行
   * 「来自 会话「…」」由宿主按调用方解析（模型说自己是谁不算数）。
   *
   * 收下了就是 `{ ok: true }`；没投出去给原因（{@link PeerSessionSendRejectReason}）。
   */
  post(input: PeerSessionPostInput): Promise<PeerSessionPosted>;
}

/**
 * 「别轮询」那半句：目标会话有话说时会自己 post_message 回来。
 *
 * 这是唯一一句能替模型省下轮询的话：投递不看关系（谁都能给谁投），所以对方真有话要说时不必
 * 等谁去问。
 */
const NO_POLL_HINT =
  "Do not poll it: when that session has something for me it calls post_message on me itself.";

/** 「靠 label 认会话」那半句：`sessionId` 是 UUID，长会话里记不住 */
const LABEL_HINT =
  "Keep `label` next to `sessionId`: if I forget the id later, `label` is how I name this session.";

/** 拒绝各自的一句话：说清「为什么」与「接下来能做什么」（宿主没给 hint 时用它） */
const REJECT_HINTS: Record<PeerSessionRejectReason, string> = {
  depth_exceeded:
    "This session is itself a peer session, and peer sessions cannot open further ones " +
    "(creating is one level only — posting a message is not limited this way). Do the work here " +
    "instead, or report back and let the session that started this one open it.",
  model_unresolved:
    "No model could be resolved for that session (no session override, no modelId on the agent " +
    "definition, no global default model). Pass `modelId`, or pass an `agentId` that has a model " +
    "bound.",
  too_many_peers:
    "This session already has the maximum number of peer sessions busy at the same time. " +
    "Wait until some of them are free (read_session_status tells me which one is idle), or give " +
    "the work to fewer sessions instead of opening another one.",
};

/**
 * `post_message` 被拒绝的两种原因各自的一句话（端口只回原因，不给文案）。
 *
 * 两条都要说清「这句话没投出去、不会有人回音」，否则模型会等一条永远不会到的话。两者都不建议
 * 重试：目标还在就等它自己说话，目标已经不在就自己把活干掉。
 */
const SEND_REJECT_HINTS: Record<PeerSessionSendRejectReason, string> = {
  gone:
    "There is no such session any more: it was deleted, or the host restarted and that in-process " +
    "record is gone (it is now an ordinary session that still shows up in the session list). " +
    "Nothing was sent and no answer will arrive — do the work here instead.",
  dead:
    "That session exists but there is no agent behind it any more, so nobody will take the " +
    "message. Nothing was sent and no answer will arrive — do the work here instead.",
};

/**
 * 「摘要那一格」那半句：答案里另给一格最近一句的摘要 —— 不是全量、不是历史。
 *
 * 写它的理由与 {@link NO_POLL_HINT} 一样：模型会照着自己拿到的那段话理解能力边界，不说清
 * 「这只是摘要」，它下一句就会以为自己在读对方的会话。
 */
const EXCERPT_HINT =
  "`lastMessage` in this answer is only the beginning of the last thing it said (cut at 300 " +
  "characters), and it is all I get: never that session's full transcript, never its history, " +
  "no message count — do not use this answer to fetch context.";

/**
 * 「收下了」那半句：只说两件当场能定下的事 —— ① 已进那边的 inbox；② 别轮询。
 *
 * 不写「它现在在忙 / 会把它叫起来」，也不写「不会自动推给我」：后者与「目标会话有话说时会自己
 * post_message 回来」相互矛盾，而且两者都是对未来的断言。真正能说的只有
 * {@link NO_POLL_HINT} 那一句（“真要说话时会自己发过来”），它刚好把「别轮询」说清。
 */
const SEND_ACCEPTED_HINT =
  "Accepted: the message is in that session's inbox now. That is all this call confirms — " +
  "whether or when that session acts on it is not promised. This call does not come back. " +
  `${NO_POLL_HINT} ${LABEL_HINT}`;

/**
 * 给模型的一句话：先把「忙不忙 / 还活不活着」说清（两件事，各自一个字段，不合成一格），
 * 再带上「摘要只是摘要」与「靠 label」两句，活着的时候再加「别轮询」。
 */
function statusHint(status: PeerSessionActivity, alive: boolean): string {
  if (!alive) {
    return (
      "There is no agent behind that session any more (it is dead): nothing will be taken in " +
      `there and no answer will arrive. Do the work here instead. ${EXCERPT_HINT} ${LABEL_HINT}`
    );
  }
  if (status === "working") {
    return `It is working: it has work in hand right now. ${NO_POLL_HINT} ${EXCERPT_HINT} ${LABEL_HINT}`;
  }
  return `It is idle: it exists and has nothing in hand at this moment. ${NO_POLL_HINT} ${EXCERPT_HINT} ${LABEL_HINT}`;
}

/** 会话根本找不到（`found: false`）时给模型的一句话：这不是第五格，是「没有这一段」 */
const NOT_FOUND_HINT =
  "There is no record of that session any more: it was deleted, or the host restarted and " +
  "that in-process record is gone (in that case it is now an ordinary session that " +
  "still shows up in the session list). No answer will arrive there. If I only remember the " +
  "`label`, that session can no longer be looked up by it.";

/**
 * 造三个工具（顺序即返回顺序）。
 *
 * 三个工具都是即时返回的 `CallbackTool`：真正的等待在宿主那一侧（那边的 agent 自己跑）。
 */
export function createPeerSessionTools(port: PeerSessionPort): Tool[] {
  return [createSessionTool(port), readSessionStatusTool(port), post_messageTool(port)];
}

function createSessionTool(port: PeerSessionPort): Tool {
  return new CallbackTool({
    function: {
      name: CREATE_SESSION_TOOL,
      description: [
        "Open a PEER SESSION: a separate session with its own agent that works on `prompt`",
        "alongside this one (own context, own usage, and it stays readable in the session list",
        "afterwards). Use it for work that can happen in parallel with mine instead of blocking me.",
        "This call returns as soon as the session exists: it does not wait for any answer and no",
        "answer is delivered to me here.",
        "Talk to it afterwards with post_message; do not poll it — when that session has something",
        "for me it calls post_message on me itself.",
        "Creating is limited to one level (a peer session cannot open another one); posting a",
        "message is not limited that way — any session may post a message to any other.",
        "Remember the returned `label` as well as `sessionId`: in a long session I may no",
        "longer recall the id, and the label is how I refer to this session.",
      ].join(" "),
      parameters: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description:
              "What that session should do. Write it as a self-contained task: the new session " +
              "starts from an empty context and cannot see this session.",
          },
          agentId: {
            type: ["string", "null"],
            description:
              "Agent (by id) that runs the new session (null means the agent of this session)",
          },
          modelId: {
            type: ["string", "null"],
            description:
              "Model id for the new session (null means the usual resolution: session " +
              "> agent definition > global default)",
          },
          label: {
            type: ["string", "null"],
            description:
              'Short readable name for this session (null means no label, e.g. "run the tests"). It is what ' +
              "read_session_status shows and what I use to refer to it later.",
          },
        },
        required: ["prompt", "agentId", "modelId", "label"],
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
      return {
        sessionId: created.sessionId,
        label: created.label,
        hint: `${NO_POLL_HINT} ${LABEL_HINT}`,
      };
    },
  });
}

function readSessionStatusTool(port: PeerSessionPort): Tool {
  return new CallbackTool({
    function: {
      name: READ_SESSION_STATUS_TOOL,
      description: [
        "Check a session created earlier: whether it is working or idle right now, and whether it",
        "is still alive (`alive: false` means no agent is behind it any more), or that there is no",
        "such session at all (found: false).",
        "About that session the answer gives exactly two facts: whether it is busy (that one state)",
        "and `lastMessage` — a short excerpt of the last thing it said (cut at 300 characters; null",
        "while it has not said anything yet); the `label` is only the name it was created with.",
        "That excerpt is all I get: the answer is never the full transcript",
        "and never its history, it carries no message list and no message count, and it does not",
        "say what that session is doing — so do not use it to fetch context.",
        "This is a single check, not a waiting loop: which of those states it is in (or that it",
        "is not there any more) is a fact about this moment only, and it does not tell me when",
        "anything will happen. Do not poll —",
        "when that session has something for me it calls post_message on me itself.",
        "If I no longer remember the `sessionId`, the `label` returned by create_session is what",
        "identifies the session — it comes back in the answer, so I can tell them apart.",
      ].join(" "),
      parameters: {
        type: "object",
        properties: {
          sessionId: {
            type: "string",
            description:
              "The sessionId returned by create_session (that is the peer session's own id)",
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
      // 两种形状原样转给模型：找不到就是 `found: false` + `status: null`，不挤成一个状态值
      if (!status.found) return { found: false, status: null, hint: NOT_FOUND_HINT };
      // 有这一段就给四样：忙不忙、还活不活着、那个名字、最近一句的摘要（`null` = 还没说过话）。
      // 消息数组 / 条数 / 历史一概不带：需求要的就是「忙不忙 + 最近一句摘要」。
      return {
        found: true,
        status: status.status,
        alive: status.alive,
        label: status.label,
        lastMessage: status.lastMessage,
        hint: statusHint(status.status, status.alive),
      };
    },
  });
}

function post_messageTool(port: PeerSessionPort): Tool {
  return new CallbackTool({
    function: {
      name: POST_MESSAGE_TOOL,
      description: [
        "Post a message to another session (one created by create_session, or any session I know",
        "the id of) — it is how I talk to that side instead of opening a new one. Whoever it is,",
        "the message is accepted as long as that session exists and has a live agent: posting",
        "does not depend on how the two of us are related.",
        "The call returns whether the message was taken. It does not wait for anything: no answer",
        "comes back here and nothing is delivered to me automatically — when that side has",
        "something to tell me it posts a message to me itself.",
        "Do not poll it: how it acts on the message is its own business, and read_session_status",
        "only tells me which state it is in at that moment.",
        "If I no longer remember the `sessionId`, the `label` returned by create_session is how I",
        "identify that session.",
      ].join(" "),
      parameters: {
        type: "object",
        properties: {
          sessionId: {
            type: "string",
            description:
              "The sessionId returned by create_session (that is the peer session's own id)",
          },
          content: {
            type: "string",
            description:
              "What to say to that side. Write it as a self-contained instruction: it cannot see " +
              "this session, it only has its own history.",
          },
        },
        required: ["sessionId", "content"],
        additionalProperties: false,
      },
    },
    callback: async (input: Record<string, unknown>, ctx: ToolCallContext) => {
      const sent = await port.post({
        caller: ctx.agent,
        sessionId: typeof input.sessionId === "string" ? input.sessionId : "",
        content: typeof input.content === "string" ? input.content : String(input.content ?? ""),
      });

      // 结构化拒绝：模型能按字段分支，不用去读自由文本
      if (!sent.ok) return { rejected: sent.reason, hint: SEND_REJECT_HINTS[sent.reason] };
      return { accepted: true, hint: SEND_ACCEPTED_HINT };
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
