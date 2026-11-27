import { z } from "zod";

import type { AgentNS } from "@ai-zen/agents-core";
import type { SdkAgent } from "@ai-zen/agents-sdk";

import { HostError } from "../../infra/errors.js";
import { materialsFor } from "../agent/materials.js";
import type { SessionRecord } from "../session/types.js";
import { ASSET_ID_KEY } from "../asset/types.js";
import { agentRunOnceProcedure } from "./agentRunOnce.js";
import type { HostApiDeps } from "./deps.js";
import type { Trpc } from "./trpc.js";

/**
 * 一条消息最多几张 Asset：与「一张最多 4MB」是同一句话的两半，数值只在这里写一次。
 */
const MAX_ASSETS_PER_MESSAGE = 4;

const sendInput = z.object({
  workspaceId: z.string(),
  /** 会话行上的那一格，与 `session.open` 回的是同一个值；投递不认这一次调用另说的一个 */
  agentId: z.string(),
  /**
   * 一段字符串，或者一组内容段（多模态：文字与 Asset 引用混排）。
   *
   * 段的形状由 `AgentNS.MessageContentSection` 定义，宿主不在这里重描一遍：`__asset_id` 这类
   * 本地键不在那个类型里，所以用 `z.custom` 原样放行、一个键都不删（落库那份就是发出那份）。
   */
  content: z.union([z.string(), z.array(z.custom<AgentNS.MessageContentSection>())]),
  /** 客户端给的 id：它据此在界面上先把这条消息显示出来，写进 messages 时用的就是这个 id */
  messageId: z.string(),
  /**
   * 投给哪一段。必填：投递只落在已经有 Agent 的那一段上；这一段还不存在时先 `session.create`
   * 建行，没有 Agent 时先 `runtime.agent.wake` 叫起来。
   */
  sessionId: z.string(),
});

type SendInput = z.infer<typeof sendInput>;

const wakeInput = z.object({ sessionId: z.string() });
const wakeOutput = z.object({ sessionId: z.string() });
/** 开关与中止这四个动作只认会话 id；活着才有效，没有活 Agent 时是空操作 */
const controlInput = z.object({ sessionId: z.string() });
const controlOutput = z.object({ sessionId: z.string() });
/**
 * 清排队区：认会话 id，回的是清掉几条。
 *
 * 回条数而不是回队列本身：客户端手里那条空队列自己拼得出来（清完就是空），它真正答不上来的是
 * 「刚才那几条算不算被清掉了」—— 条数就是那一句答案。
 */
const clearInboxInput = z.object({ sessionId: z.string().min(1) });
const clearInboxOutput = z.object({ cleared: z.number() });

export function agentRouter(deps: HostApiDeps, api: Trpc) {
  return api.router({
    /**
     * 让这段会话现在有 Agent：把材料从库里读出来交给运行时，由它装起来、登记、开跑。
     *
     * 不投递任何东西。会话行已经存在 —— 唤醒不创建会话，它只填补「行在、Agent 不在」这一格。
     * 已经有 Agent 时是空操作：重建会把一段正在跑的会话换掉，而调用方要的只是「它活着」。
     */
    wake: api.procedure
      .input(wakeInput)
      .output(wakeOutput)
      .mutation(async ({ input }) => {
        const session = existingSession(deps, input.sessionId);
        if (deps.runtime.get(session.id) === undefined) {
          await deps.runtime.wake(session.id, await materialsFor(deps, session));
        }

        return { sessionId: session.id };
      }),

    /**
     * 投一条话给活着的 Agent。只投递：建行是 `session.create`，起 Agent 是 `runtime.agent.wake`。
     *
     * 没有 Agent 时是 `not_found`（不在此处唤醒它）：投递不创建会话、也不复活会话，
     * 「先唤醒再投递」是客户端的编排，不是宿主的兜底。
     */
    send: api.procedure
      .input(sendInput)
      .output(z.object({ sessionId: z.string(), messageId: z.string() }))
      .mutation(({ input }) => {
        // 判在投递之前：投出去再拒，用户已经看见它发出去了
        assertAssetCount(deps, input.content);

        const session = existingSession(deps, input.sessionId);
        const agent = deps.runtime.get(session.id);
        if (agent === undefined) {
          throw new HostError(
            "not_found",
            deps.t("会话 {sessionId} 没有运行中的Agent，先运行它再投递", {
              sessionId: session.id,
            }),
            { entity: "agent", sessionId: session.id },
          );
        }

        return send(deps, session, agent, input);
      }),

    /**
     * 开关与中止这四个动作：都只对活着的 Agent 有效，没有它时是空操作。
     *
     * `pause` / `resume` 两道开关缺一不可：`cancel` 交接时宿主会关掉输出开关且不自己开回来，
     * 没有 `resume` 的话那一段会话从此不取走，界面上表现为「它不理会输入」而没有任何报错。
     */
    pauseOutput: api.procedure
      .input(controlInput)
      .output(controlOutput)
      .mutation(({ input }) => {
        deps.runtime.get(input.sessionId)?.pauseOutput();
        return { sessionId: input.sessionId };
      }),

    resumeOutput: api.procedure
      .input(controlInput)
      .output(controlOutput)
      .mutation(({ input }) => {
        deps.runtime.get(input.sessionId)?.resumeOutput();
        return { sessionId: input.sessionId };
      }),

    /** 中止进行中的请求，但不销毁 Agent：掐完之后那一段是「闲 + 输出开关关」的状态 */
    abort: api.procedure
      .input(controlInput)
      .output(controlOutput)
      .mutation(({ input }) => {
        deps.runtime.get(input.sessionId)?.abort();
        return { sessionId: input.sessionId };
      }),

    /** 杀死：Agent 销毁，会话行与历史一个字都不动 */
    kill: api.procedure
      .input(controlInput)
      .output(controlOutput)
      .mutation(({ input }) => {
        deps.runtime.kill(input.sessionId);
        return { sessionId: input.sessionId };
      }),

    /**
     * 作废这一段还没被取走的那些 InboxEntry（「中断不是杀死」那张表里的
     * 「作废，库里也删」）。它是调用方的显式决定：内核那一侧从不自己清队列（`Agent.clearInbox`
     * 的注释里写着为什么），所以这条只由 `/free` 这样的用户动作翻过来 —— `/clear` 只管清屏，
     * 两件事不合成一条命令。
     *
     * 排队区有两处，两处都要清：内存里是 Agent 的队列，库里是 `inbox` 表的那几行（关掉再打开，
     * 那几句还在等，靠的就是它）。用户看到的排队区就是库里那几行，所以只清内存会剩下一段
     * 「界面上还排着、实际永远不跑」的 InboxEntry。
     *
     * 于是分两条路，判据是「这一段有没有活 Agent」：
     *
     * - 有：`runtime.agent.clearInbox()` 作废队列、报 `inboxCleared`，观察者据此删库行、推一条空队列
     *   —— 有内存可以为准时以内存为事实，这一层只借它返回的条数，不自己再数一遍库里那几行
     *   （两处各有各的真相不是这个域该有的样子）；
     * - 没有：内存里根本没有队列可以说话，库就是它的全部 —— 那就直接数出来、直接删，再自己
     *   推一条空的 `agent.inbox`。这条路上没有 Agent，没有别人替它说这一句。
     *
     * 会话行不存在时是 `not_found`（与别的 procedure 同一句词）：没有这一段，就没有「它的排队区」。
     */
    clearInbox: api.procedure
      .input(clearInboxInput)
      .output(clearInboxOutput)
      .mutation(({ input }) => {
        const session = existingSession(deps, input.sessionId);
        const agent = deps.runtime.get(session.id);

        // 有活 Agent：队列在它手上，作废与「推一条空队列」都由它那一条事实带出去
        if (agent !== undefined) return { cleared: agent.clearInbox().length };

        // 没有活 Agent：库里那几行就是用户看到的排队区，清完自己说一句（没人替这一段说）
        const pending = deps.inbox.listBySession(session.id);
        deps.inbox.clearBySession(session.id);
        deps.events.emit({ type: "agent.inbox", sessionId: session.id, inbox: [] });

        return { cleared: pending.length };
      }),

    /** 一次性 `Agent` 的跑法：建会话行的那条路不经过它（见 `agentRunOnce.ts`） */
    runOnce: agentRunOnceProcedure(deps, api),
  });
}

/**
 * 递一条话给这段会话的 Agent。
 *
 * 投递留在这里，是因为它是客户端的动作翻进队列：一句客户端的原话进 core 的队列，没有第二件
 * 事要做（唤醒与建行都是另外两条 procedure）。运行时那一侧的 `post` 是「一段会话寄给另一段
 * 会话」，不是这个动作。
 */
function send(
  deps: HostApiDeps,
  session: SessionRecord,
  agent: SdkAgent,
  input: SendInput,
): { sessionId: string; messageId: string } {
  const entry: AgentNS.InboxEntryWithContent & { messageId: string } = {
    messageId: input.messageId,
    createdAt: new Date().toISOString(),
    // 高：内循环在工具跑完那个边界取一次件，所以它不必等到这一批彻底跑完；它也不打断
    // 正在吐的回答 —— 取走只发生在两次请求之间。
    priority: "high",
    // 来源不是准入判断（宿主不判来路），它只是让模型知道这句话是谁说的
    source: { kind: "user" },
    content: input.content,
  };

  // 先落库再入队。反过来的话，崩在这两步之间时这一条只剩在内存里，进程一没就没发生过；
  // 而先落库最坏的代价是同一条被再取一次 —— 那一种重复认得出（它的 `messageId` 会在历史里）。
  //
  // 这一句 `insert` 之后 `push` 报出去的那条 `inboxAdded` 还会让观察者再写一次同一个 id：
  // 两次写同一行在表那一侧是空动作（`insert` 对已经在库的那个 id 什么都不做），于是这条路
  // 既保住了「落库先于入队」，也不会在每投一句时把一次主键冲突报成错误。
  deps.inbox.insert(session.id, entry);
  agent.send(entry);

  return { sessionId: session.id, messageId: input.messageId };
}

/**
 * 一条消息里带 Asset 引用的段最多 4 条。判在投递之前：投出去再拒，用户已经看见它发出去了
 * —— 那一条已经在队列里、也已经落进了历史，「拒」这件事就变成了一次事后报错。
 *
 * 数的是段不是 Asset id：「带 `__asset_id` 的段」就是这个数 —— 同一张图在一句话里被引用两次，
 * 厂商那边也是两段。内容是原样入库的，这里只读、不改一个字节，也不重排段。
 */
function assertAssetCount(deps: HostApiDeps, content: SendInput["content"]): void {
  if (!Array.isArray(content)) return;

  const count = content.filter(
    (section) =>
      typeof section === "object" &&
      section !== null &&
      typeof (section as unknown as Record<string, unknown>)[ASSET_ID_KEY] === "string",
  ).length;

  if (count > MAX_ASSETS_PER_MESSAGE) {
    throw new HostError(
      "invalid_params",
      deps.t("一条消息最多 {max} 张Asset，这一条带了 {count} 张", {
        max: MAX_ASSETS_PER_MESSAGE,
        count,
      }),
      { max: MAX_ASSETS_PER_MESSAGE, count },
    );
  }
}

function existingSession(deps: HostApiDeps, sessionId: string): SessionRecord {
  const session = deps.sessions.get(sessionId);
  if (session === undefined) {
    throw new HostError("not_found", deps.t("找不到 id 为 {sessionId} 的会话", { sessionId }), {
      entity: "session",
      sessionId,
    });
  }
  return session;
}
