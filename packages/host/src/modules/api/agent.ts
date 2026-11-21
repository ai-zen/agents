import { z } from "zod";

import type { AgentNS } from "@ai-zen/agents-core";
import { resolveModel, type SdkAgent } from "@ai-zen/agents-sdk";

import { HostError } from "../../infra/errors.js";
import { materialsFor } from "../agent/materials.js";
import type { Session } from "../session/types.js";
import { ASSET_ID_KEY } from "../asset/types.js";
import type { HostApiDeps } from "./deps.js";
import type { Trpc } from "./trpc.js";

/**
 * 一条消息最多几张素材（`dev-docs/prd/09-attachments.md` 第 5 行）：与「一张最多 20MB」是同一
 * 句话的两半，数值只在这里写一次。
 */
const MAX_ASSETS_PER_MESSAGE = 4;

const sendInput = z.object({
  workspaceId: z.string(),
  /** 只有建行那一支用它：已有会话的助手是会话行上的事实，不听这一次调用怎么说 */
  agentId: z.string(),
  /**
   * 一段字符串，或者一组内容段（多模态：文字与素材引用混排）。
   *
   * 段的形状由 `AgentNS.MessageContentSection` 定义，宿主不在这里重描一遍：`__asset_id` 这类
   * 本地键不在那个类型里，所以用 `z.custom` 原样放行、一个键都不删（落库那份就是发出那份）。
   */
  content: z.union([z.string(), z.array(z.custom<AgentNS.MessageContentSection>())]),
  /** 客户端给的 id：它据此在界面上先把这条消息显示出来，落地时用的就是这个 id */
  messageId: z.string(),
  /** 给了就投给这一段；不给就是这一段还不存在 —— 建行与投递是同一个动作 */
  sessionId: z.string().optional(),
});

type SendInput = z.infer<typeof sendInput>;

const wakeInput = z.object({ sessionId: z.string() });
const wakeOutput = z.object({ sessionId: z.string() });
/** 闸与中止这四个动作只认会话 id；活着才有效，没有活执行体时是空操作 */
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
     * 让这段会话现在有执行体：把材料从库里读出来交给运行时，由它装起来、登记、开跑。
     *
     * 不投递任何东西。会话行已经存在 —— 唤醒不创建会话，它只填补「行在、执行体不在」这一格。
     * 已经有执行体时是空操作：重建会把一段正在跑的会话换掉，而调用方要的只是「它活着」。
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

    send: api.procedure
      .input(sendInput)
      .output(z.object({ sessionId: z.string(), messageId: z.string() }))
      .mutation(async ({ input }) => {
        // 两条分支（投给已有的会话 / 建一段新的）都从这里过，所以判在分岔之前。
        assertAssetCount(deps, input.content);

        // 给了 sessionId 就是往一段已有的会话投递。投递不创建会话、也不复活会话：没有活着
        // 的执行体就直接报错，「先唤醒再投递」是客户端的编排（先调 `wake`），不是宿主的兜底。
        if (input.sessionId !== undefined) {
          const session = existingSession(deps, input.sessionId);
          const agent = deps.runtime.get(session.id);
          if (agent === undefined) {
            throw new HostError(
              "not_found",
              deps.t("会话 {sessionId} 没有运行中的执行体，先运行它再投递", {
                sessionId: session.id,
              }),
              { entity: "agent", sessionId: session.id },
            );
          }

          return deliver(deps, session, agent, input);
        }

        // 不给 sessionId：会话是由这一次发送产生的，建行、叫醒、投递都是这次发送的一部分
        // —— 它没有「复活一段已有的会话」这层含义。
        const session = await createSession(deps, input);
        return deliver(deps, session, await wakeSession(deps, session), input);
      }),

    /**
     * 闸与中止这四个动作：都只对活着的执行体有效，没有它时是空操作。
     *
     * `pause` / `resume` 两道闸缺一不可：`cancel` 交接时宿主会关掉输出闸且不自己开回来，
     * 没有 `resume` 的话那一段会话从此不取件，界面上表现为「它不理我」而没有任何报错。
     */
    pause: api.procedure
      .input(controlInput)
      .output(controlOutput)
      .mutation(({ input }) => {
        deps.runtime.get(input.sessionId)?.pauseOutput();
        return { sessionId: input.sessionId };
      }),

    resume: api.procedure
      .input(controlInput)
      .output(controlOutput)
      .mutation(({ input }) => {
        deps.runtime.get(input.sessionId)?.resumeOutput();
        return { sessionId: input.sessionId };
      }),

    /** 中止进行中的请求，但不销毁执行体：掐完之后那一段是「闲 + 输出闸关」的状态 */
    abort: api.procedure
      .input(controlInput)
      .output(controlOutput)
      .mutation(({ input }) => {
        deps.runtime.get(input.sessionId)?.abort();
        return { sessionId: input.sessionId };
      }),

    /** 杀死：执行体销毁，会话行与历史一个字都不动 */
    kill: api.procedure
      .input(controlInput)
      .output(controlOutput)
      .mutation(({ input }) => {
        deps.runtime.kill(input.sessionId);
        return { sessionId: input.sessionId };
      }),

    /**
     * 作废这一段**还没被取走**的那些条目（`dev-docs/prd/04-session.md`「中断不是杀死」那张表里的
     * 「作废，库里也删」）。它是**调用方的显式决定**：内核那一侧从不自己清队列（`Agent.clearInbox`
     * 的注释里写着为什么），所以这条只由 `/free` 这样的用户动作翻过来 —— `/clear` 只管清屏，
     * 两件事不合成一条命令。
     *
     * **排队区有两处，两处都要清**：内存里是执行体的队列，库里是 `inbox` 表的那几行（关掉再打开，
     * 那几句还在等，靠的就是它）。用户看到的排队区**就是库里那几行**，所以只清内存会剩下一段
     * 「界面上还排着、实际永远不跑」的条目。
     *
     * 于是分两条路，判据是「这一段有没有活执行体」：
     *
     * - **有**：`agent.clearInbox()` 作废队列、报 `inboxCleared`，观察者据此删库行、推一条空队列
     *   —— 有内存可以为准时**以内存为事实**，这一层只借它返回的条数，不自己再数一遍库里那几行
     *   （两处各有各的真相不是这个域该有的样子）；
     * - **没有**：内存里根本没有队列可以说话，库就是它的全部 —— 那就直接数出来、直接删，再自己
     *   推一条空的 `agent.inbox`。这条路上没有执行体，没有别人替它说这一句。
     *
     * 会话行不存在时是 `not_found`（与别的 procedure 同一句词）：没有这一段，就没有「它的排队区」。
     */
    clearInbox: api.procedure
      .input(clearInboxInput)
      .output(clearInboxOutput)
      .mutation(({ input }) => {
        const session = existingSession(deps, input.sessionId);
        const agent = deps.runtime.get(session.id);

        // 有活执行体：队列在它手上，作废与「推一条空队列」都由它那一条事实带出去
        if (agent !== undefined) return { cleared: agent.clearInbox().length };

        // 没有活执行体：库里那几行就是用户看到的排队区，清完自己说一句（没人替这一段说）
        const pending = deps.inbox.listBySession(session.id);
        deps.inbox.clearBySession(session.id);
        deps.events.emit({ type: "agent.inbox", sessionId: session.id, inbox: [] });

        return { cleared: pending.length };
      }),
  });
}

/**
 * 递一条话给这段会话的执行体。
 *
 * 投递留在这里，是因为它是**客户端的动作翻进队列**：一句客户端的原话进 core 的队列，没有第二件
 * 事要做（唤醒是另一件事，`send` 的两支各自先把它做掉）。运行时那一侧的 `post` 是「一段会话
 * 寄给另一段会话」，不是这个动作。
 */
function deliver(
  deps: HostApiDeps,
  session: Session,
  agent: SdkAgent,
  input: SendInput,
): { sessionId: string; messageId: string } {
  const entry: AgentNS.InboxEntryWithContent & { messageId: string } = {
    messageId: input.messageId,
    createdAt: new Date().toISOString(),
    // 高：内循环在工具跑完那个边界取一次件，所以它不必等到这一批彻底跑完；它也不打断
    // 正在吐的回答 —— 取件只发生在两次请求之间。
    priority: "high",
    // 来源不是准入判断（宿主不判来路），它只是让模型知道这句话是谁说的
    source: { kind: "user" },
    content: input.content,
  };

  // 先落库再入队。反过来的话，崩在这两步之间时这一条只剩在内存里，进程一没就没发生过；
  // 而先落库最坏的代价是同一条被再取一次 —— 那一种重复认得出（它的 `messageId` 会在历史里）。
  deps.inbox.insert(session.id, entry);
  agent.push(entry);

  return { sessionId: session.id, messageId: input.messageId };
}

/**
 * 造会话行。模型在造行这一刻就解析出来写进去：解析不出就在这里失败，不落一条指不到模型的
 * 半成品行，行上的 `modelId` 从这一刻起就是事实。
 */
async function createSession(deps: HostApiDeps, input: SendInput): Promise<Session> {
  const definition = await deps.definitions.get(input.agentId);
  const model = resolveModel({
    agentModelId: definition.modelId,
    defaultModel: deps.config.read().defaultModel,
  });

  if (model === null) {
    throw new HostError(
      "config_invalid",
      deps.t("助手 {agentDefinitionId} 没有可用的模型", { agentDefinitionId: input.agentId }),
      { entity: "agentDefinition", agentDefinitionId: input.agentId },
    );
  }

  return deps.sessions.create({
    workspaceId: input.workspaceId,
    // 自动起的名字先给一个时刻串，此后由自动命名或用户改名接管
    name: new Date().toISOString(),
    nameIsAuto: true,
    agentId: input.agentId,
    modelId: model.modelId,
    // 人建的会话默认不自动交接；它也不属于任何别的会话
    autoHandoff: false,
    lineage: null,
  });
}

/**
 * 一条消息里带素材引用的段最多 4 条。**判在投递之前**（也判在建行与唤醒之前）：投出去再拒，
 * 用户已经看见它发出去了 —— 那一条已经在队列里、也已经落进了历史，「拒」这件事就变成了一次
 * 事后报错。
 *
 * 数的是段不是素材 id：「带 `__asset_id` 的段」就是这个数 —— 同一张图在一句话里被引用两次，
 * 厂商那边也是两段。内容是**原样入库**的，这里只读、不改一个字节，也不重排段。
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
      deps.t("一条消息最多 {max} 张素材，这一条带了 {count} 张", {
        max: MAX_ASSETS_PER_MESSAGE,
        count,
      }),
      { max: MAX_ASSETS_PER_MESSAGE, count },
    );
  }
}

function existingSession(deps: HostApiDeps, sessionId: string): Session {
  const session = deps.sessions.get(sessionId);
  if (session === undefined) {
    throw new HostError("not_found", deps.t("找不到 id 为 {sessionId} 的会话", { sessionId }), {
      entity: "session",
      sessionId,
    });
  }
  return session;
}

/**
 * 叫醒这一段：材料由宿主从库里读出来，装起来与开跑交给运行时。
 *
 * 观察者不在这里挂：它是全进程一份、装配根在第一次 `wake` 之前就挂好的（装载归一的那几条消息
 * 由运行时在唤醒过程中补报 `messageChanged`，靠那一条落库）。
 */
async function wakeSession(deps: HostApiDeps, session: Session): Promise<SdkAgent> {
  return deps.runtime.wake(session.id, await materialsFor(deps, session));
}
