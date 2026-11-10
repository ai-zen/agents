/**
 * SDK 事件 → 协议事件的翻译器（`SessionManager` 拆出来的四块之一）。
 *
 * ## 管什么
 *
 * 把 Agent（`agent.events`）发出来的东西翻成线上事件，两块：
 *
 *   1. **原样转达** core 的 9 条（`AGENT_EVENTS`：`open` / `chunk` / `chunk-parsed` /
 *      `parsed` / `tool-call-end` / `error` / `finally` / `sub-agent-start` /
 *      `sub-agent-end`）—— 名字与时机都照抄 core，一行不改；
 *   2. **派生**服务端自己的那几条（`SESSION_EVENTS`）：阶段（`session-phase`）、
 *      本轮工具调用的组装态（`session-tool-calls`）。
 *
 * 顺带管 `LiveSession` 上的**流式影子**（`toolCalls` 去重器 / `pushedMessages` /
 * `subAgents` 表与两个序号）—— 它们只服务于「这一轮推过什么」，归零必须同进同退
 * （见 `resetStreamState`）。
 *
 * ## 不管什么
 *
 * 不管「一轮什么时候算结束」。SDK 的 `finally` 只说明**它**说完了，收尾（落盘、发
 * `session-turn-end`、判回收）是 `SessionManager` 的事 —— 所以那两个动作是**注入的**
 * （`settleTurn` / `failTurn`），本类只负责把事件转过去。
 *
 * ## 为什么它能单独成一个类
 *
 * 它只依赖 `session.agent.events` 与事件出口（`EventHub`），**不需要注册表、也不需要
 * 存档** —— 这是四块里耦合最浅的一块，也是唯一一块能在「一段会话对象 + 一个假 Agent」
 * 上测完的东西。
 */

import { FINISHED_STATUSES, pendingToolCalls, type PhaseMessageLike } from "../../lib/phase.js";
import type { EventHub } from "../../lib/events.js";
import {
  AGENT_EVENTS,
  SESSION_EVENTS,
  SESSION_NOTICE_CODES,
  type NoticePayload,
  type PhaseInfo,
  type ServerEvent,
  type ToolCallState,
} from "@ai-zen/agents-protocol";
import type { LiveSession, SubAgentEntry, SubAgentLike } from "./LiveSession.js";

/**
 * 流末 chunk 的真实产物 token 数（`stream_options.include_usage`）；没有就是 undefined
 */
function completionOf(chunk: any): number | undefined {
  const value = chunk?.usage?.completion_tokens;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * 从一片 OpenAI 风格的流式 chunk 里取出正文与推理增量。
 *
 * 主 Agent 与子 Agent 共用这一份取法：两边刷的是同一条 SDK 事件（`chunk-parsed`），
 * 形状一模一样，写两份只会在某天 SDK 改字段时漂成一半对一半错。
 */
function deltaOf(chunk: any): { text: string; reasoning: string } {
  const delta = chunk?.choices?.[0]?.delta;
  const text = typeof delta?.content === "string" ? delta.content : "";
  const reasoning = typeof delta?.reasoning_content === "string" ? delta.reasoning_content : "";
  return { text, reasoning };
}

/**
 * 从 core 那条**正在拼的 assistant 消息**里取出工具调用的组装态。
 *
 * 为什么读第一个参数（receiver）而不是去解析 chunk：组装早就做完了。core 的
 * `Agent.parseStreamData` 每消费一片就**就地**把 delta 拼进 `receiver`，然后才
 * `emit("chunk-parsed", receiver, chunk)`（`packages/core/src/Agent.ts`）。在这里再解析
 * 一遍 chunk，等于把 core 已经做过的拼装重做一份，而且半截 JSON 还得自己接 —— 正是
 * 本项目反复栽过的「第二份实现」。
 *
 * 读到的形状（同上一行引用处，逐字）：
 *
 *     receiver.tool_calls[index] = {
 *       index, id?, type?,
 *       function: { name, arguments },   // arguments 是**累积到此刻**的字符串
 *     }
 *
 * 两个已知的中间态，都按空值处理（不是兜底，是形状本来如此）：
 *   - 名字与参数分几片到达：core 只在本下标的第一个 delta 里见到名字，后续只带参数片段；
 *   - core 建对象时写的是 `{ ...默认值, ...delta.function }`，但同一行后面又摊了一次
 *     `...deltaToolCall`，于是头一片里的 `function` 可能是**这一片的子集**（只有 name、
 *     没有 arguments，或者反过来）—— 缺哪一半都有可能。
 */
function toolCallsOf(receiver: unknown): ToolCallState[] {
  const raw = (receiver as any)?.tool_calls;
  if (!Array.isArray(raw)) return [];
  const calls: ToolCallState[] = [];
  for (const call of raw) {
    // 空位只可能出现在装配中的数组上；跳过比崩掉诚实（这一轮的工具卡片少画一张，
    // 下一片到达时它照样补上）
    if (!call) continue;
    calls.push({
      index: call.index,
      name: typeof call.function?.name === "string" ? call.function.name : "",
      ...(typeof call.id === "string" ? { id: call.id } : {}),
      arguments: typeof call.function?.arguments === "string" ? call.function.arguments : "",
    });
  }
  return calls;
}

/**
 * 工具调用的**上报去重器** —— 只记「上一次报出去的是什么」，不是真相源。
 *
 * 为什么需要它：参数边流边长，而 chunk 的粒度跟内容无关 —— 一个只带 `id` 的片、一个只带
 * `usage` 的收尾片，都会走到上报点。每片都发一次全量，客户端就要按帧
 * 重渲染那张工具卡片（一条长参数能把界面拖成幻灯片）。
 *
 * 为什么判据这么便宜：组装**只追加**（core 那边是 `arguments += …`），所以「变了没有」
 * 等价于「个数变了、某个名字变了、某个 id 变了，或某个参数串的**长度**变了」。把参数串整个
 * 比一遍（`JSON.stringify`）既慢又没必要 —— 它只会往长里长。这条等价关系的前提是 core 的
 * 追加式组装，那边哪天改成覆盖式重写，这里得跟着看。
 */
export class ToolCallReporter {
  /** 上一次报出去的形状（只留判据要用的四个字段） */
  private reported: ToolCallState[] = [];

  /** 有没有变化？有就顺手记成新的「上一次」，调用方据此决定发不发 */
  update(next: readonly ToolCallState[]): boolean {
    const last = this.reported;
    const changed =
      next.length !== last.length ||
      next.some((call, i) => {
        const prev = last[i]!;
        return (
          call.index !== prev.index ||
          call.name !== prev.name ||
          call.id !== prev.id ||
          call.arguments.length !== prev.arguments.length
        );
      });
    if (changed) this.reported = next.map((call) => ({ ...call }));
    return changed;
  }

  /** 一轮结束：影子清零（与 `PhaseTracker.reset()` 同一个时机，见 `resetStreamState`） */
  reset(): void {
    this.reported = [];
  }
}

/**
 * 按**实例**找回它的条目。
 *
 * `sub-agent-end` / `error` 的载荷是实例而不是 id（SDK 侧就这么给），而协议里的 id 是
 * 本层分配的 —— 两边得在这里对上。
 */
function subAgentEntryOf(session: LiveSession, subAgent: SubAgentLike): SubAgentEntry | undefined {
  for (const entry of session.subAgents.values()) {
    if (entry.agent === subAgent) return entry;
  }
  return undefined;
}

export interface EventBridgeOptions {
  /** 事件出口（一条会话的事件可能推给多条连接，广播在这里） */
  hub: Pick<EventHub, "publish">;
  /**
   * 一轮收尾（SDK 的 `finally`）。
   *
   * 注入而不是自己调用：收尾要落盘、发 `session-turn-end`、判回收，全是会话层的规则
   * （见 `SessionManager.settleTurn`）。本类只认得「SDK 说这一轮完了」这个事实。
   */
  settleTurn: (session: LiveSession) => void;
  /** 一轮失败（`error` 事件）：同样只转达事实，去重（`error` 与 `finally` 都会到）在会话层 */
  failTurn: (session: LiveSession, failure: { code: string; message: string }) => void;
  /**
   * 会话内通知（子 Agent 失败时用）。
   *
   * 走会话层而不是直接 `hub.publish`：会话可能已经被收掉，「发不发」由持有注册表的
   * 那一方决定（`SessionManager.notice` 对不存在的会话会抛）。
   */
  notice: (sessionId: string, notice: NoticePayload) => void;
}

export class EventBridge {
  constructor(private readonly options: EventBridgeOptions) {}

  /**
   * 挂上 SDK 事件 → 协议事件的翻译；返回摘除函数。
   *
   * 一个会话一个 Agent，换 Agent 时先摘旧的再挂新的（见 `SessionManager.adoptAgent`）。
   */
  attach(session: LiveSession): () => void {
    const { events } = session.agent;

    const onOpen = () => {
      // core `open`：请求发出去之前那一刻。名字与时机都照抄 core —— 客户端今天不用它，
      // 但「一轮开始了」是 core 的公开事实，线上就该有这一条（用不用是客户端的事）。
      this.emit({
        event: AGENT_EVENTS.open,
        sessionId: session.id,
        turnId: session.turnId,
      });
      session.phase.opened();
      this.emitPhase(session);
    };

    /**
     * 一片 chunk 的解析结果（core `chunk-parsed`）→ 正文增量（`chunk-parsed`）。
     * 同一片的原始 chunk 由 {@link onRawChunk} 在**解析之前**单独发。
     * **第二个参数才是 chunk**。
     *
     * core 的 `Agent.parseStreamData` 发的是 `emit("chunk-parsed", receiver, chunk)`（两个
     * 参数）：第一个是那条正在拼的 assistant 消息，第二个才是这一片原始 chunk。这里曾经写成
     * `(receiver) => deltaOf(receiver?.chunk ?? receiver)` —— 拿到的永远是**消息本身**，
     * `choices[0].delta` 恒空，于是主 Agent 与子 Agent 的正文增量**一条都推不出去**（界面只能
     * 等 `session-turn-end` 之后靠快照一次性刷出来）；唯一漏过去的是流末那片（core 把 `usage` 挂在消息
     * 上，`completionOf(消息)` 恰好读得到），也正是它让这个 bug 看起来像“偶尔掉了”。
     *
     * 单测当时没抓住：假 Agent 是按**单参**形状 fire 的，恰好喂饱了 `receiver?.chunk ?? receiver`
     * 那条“两种形状都认”的兼容写法。假件的形状必须照抄真件的形状，否则它测的是想象。
     */
    const onChunk = (receiver: unknown, chunk: any) => {
      // ① 同一片的解析结果（core `chunk-parsed`）：正文 / 推理增量。
      session.phase.delta(chunk);
      const { text, reasoning } = deltaOf(chunk);
      const completionTokens = completionOf(chunk);
      // 只带 usage 的收尾 chunk 也要出去：客户端靠它校准速率（否则 tok/s 一直是估算值）
      if (text || reasoning || completionTokens !== undefined) {
        this.emit({
          event: AGENT_EVENTS.chunkParsed,
          sessionId: session.id,
          turnId: session.turnId,
          text,
          reasoning,
          ...(completionTokens === undefined ? {} : { usage: { completionTokens } }),
        });
      }

      // ② 派生：阶段 + 工具调用的组装态。
      // 组装态读的是第一个参数（`receiver`），不是 `chunk` —— 理由见 `toolCallsOf`。
      // 它让客户端在流式期间就能画出工具卡片，不必等 `session-turn-end` 之后那份快照。
      this.emitPhase(session);
      this.emitToolCalls(session, receiver);
    };

    /**
     * 原始 chunk（core `chunk`）：在 core 解析这一片**之前**发。
     *
     * 单独挂而不再在 `onChunk` 里发：那样只能覆盖「解析成功」的片，而 core 的 `chunk` 在
     * 解析之前就已经发出去了 —— 解析抛错的那一片，事件照样发生过，线上不该少这一条。
     * 载荷原样搬这一片（厂商形状，协议不解释，见 `AgentChunkEvent`）。
     */
    const onRawChunk = (chunk: any) => {
      this.emit({
        event: AGENT_EVENTS.chunk,
        sessionId: session.id,
        turnId: session.turnId,
        chunk,
      });
    };

    const onParsed = (receiver: any) => {
      // core `parsed`：流结束、receiver 定稿。此后这一轮的正文不再变。
      this.emit({
        event: AGENT_EVENTS.parsed,
        sessionId: session.id,
        turnId: session.turnId,
      });
      session.phase.streamEnded(receiver?.message ?? receiver);
      this.emitPhase(session);
    };

    // 工具跑完一个就报一次：并行时先完成的那个从「等待」里消失，
    // 否则界面会一直念着已经结束的工具名。
    // 同一刻顺手把**刚定型的那条结果消息**推上线（core `tool-call-end` 就是「结果定了」
    // 那一刻，`markResult` 是唯一的结果定型点），再往后拖就只有等到轮末的快照了。
    const onToolCallEnd = () => {
      this.emitAppendedMessages(session);
      this.emitPhase(session);
    };

    const onError = (error: any) => {
      const failure = {
        code: error?.code ?? "internal",
        message: error?.message ?? String(error),
      };
      // core `error` 先上线，再走 `failTurn`（它发的是 `session-turn-end`）：顺序恒为
      // `error` → `finally` → `session-turn-end`，别把这份错误只留在收尾事件里 ——
      // 两者的时机不同（后者要等落盘）。
      this.emit({
        event: AGENT_EVENTS.error,
        sessionId: session.id,
        turnId: session.turnId,
        error: failure,
      });
      this.options.failTurn(session, failure);
    };

    const onFinally = () => {
      // core `finally`：它只说「core 这一侧说完了」，落盘 / 换 id / 回收判定都还没做。
      // 所以这条与 `session-turn-end` 是两条事件，`finally` 先发（`settleTurn` 里发的是
      // 后者）。
      this.emit({
        event: AGENT_EVENTS.finally,
        sessionId: session.id,
        turnId: session.turnId,
      });
      this.options.settleTurn(session);
    };

    /**
     * 一个子 Agent 开始了（core 的 `AgentTool` / `AgentToolLazy` 在委派边界广播）。
     *
     * 两个计数器分开：`index` 是**展示序号**（本轮内从 1 起，栏目标签直接印它），
     * `subAgentId` 是**稳定标识**（客户端拿它当选中态与 React key）。分开的理由是它们
     * 回答不同的问题 —— 「用户看到的第几栏」与「是哪一次委派」，合并成一个数字就会变成
     * 「id 带上了展示含义」，改一次展示就得动一次 id。两者都只在**本轮**内唯一：一轮
     * 结束时列表与计数器一起归零（见 `clearSubAgents`），而客户端也在 `session-turn-end` 上
     * 清自己的列表，所以下一轮的 `sub-1` 不会被任何遗留的选中态认领。
     *
     * 子 Agent 自己的事件流只挂两条，且 **`chunk-parsed` 绝不碰 `session-phase`**：
     * 此刻主 Agent 正在等发起委派的那个工具（如 `call_skill_sub_agent`）返回，阶段
     * 应停在「等待 xxx 返回」；子 Agent 的思考 / 输出是工具内部的事，拿它的 delta 去改
     * 主阶段会让界面变成「输出中」，正好盖掉用户最需要知道的那句话。
     *
     * 这里挂的监听**不用**在 `sub-agent-end` 撤销：子 Agent 实例是「每次委派新建」的
     * （core 的 `AgentTool.exec()` 里 `new Agent(...)`、`AgentToolLazy.exec()` 里
     * `buildAgent(...)`），随本次 run 结束回收，监听器跟着走。
     */
    const onSubStart = ({ subAgent }: { subAgent: SubAgentLike }) => {
      const entry: SubAgentEntry = {
        id: `sub-${++session.subAgentIdSeq}`,
        index: ++session.subAgentSeq,
        agent: subAgent,
        status: "running",
      };
      session.subAgents.set(entry.id, entry);
      this.emit({
        event: AGENT_EVENTS.subAgentStart,
        sessionId: session.id,
        turnId: session.turnId,
        subAgentId: entry.id,
        index: entry.index,
      });

      /** 子 Agent 的正文增量：只带 `subAgentId` 推给客户端，不推进主阶段（理由见上） */
      const onSubChunk = (_receiver: unknown, chunk: any) => {
        // 同上：第二个参数才是 chunk（`chunk-parsed` 是两参，见 `onChunk`）
        const { text, reasoning } = deltaOf(chunk);
        if (!text && !reasoning) return;
        this.emit({
          event: AGENT_EVENTS.chunkParsed,
          sessionId: session.id,
          turnId: session.turnId,
          subAgentId: entry.id,
          text,
          reasoning,
        });
      };

      /**
       * 子 Agent 出错：标签标 `failed`，错误原文送进通知栏。
       *
       * 先填字段再发事件：之后 SDK 还会发 `sub-agent-end`，而那条路径只在状态仍是
       * `running` 时才置 `done` —— **`failed` 不被 `done` 覆盖**的安全网就挂在那里。
       */
      const onSubError = (error: any) => {
        entry.status = "failed";
        this.options.notice(session.id, {
          level: "error",
          code: SESSION_NOTICE_CODES.subAgentFailed,
          params: { index: entry.index, message: error?.message ?? String(error) },
        });
        this.emitSubAgentEnded(session, entry);
      };

      subAgent.events.on("chunk-parsed", onSubChunk);
      subAgent.events.on("error", onSubError);
    };

    const onSubEnd = ({ subAgent }: { subAgent: SubAgentLike }) => {
      const entry = subAgentEntryOf(session, subAgent);
      // 只把「还在跑」的置为完成：失败已由 `error` 监听标成 failed，不能被这里覆盖
      if (!entry || entry.status !== "running") return;
      entry.status = "done";
      this.emitSubAgentEnded(session, entry);
    };

    events.on("open", onOpen);
    events.on("chunk", onRawChunk);
    events.on("chunk-parsed", onChunk);
    events.on("parsed", onParsed);
    events.on("tool-call-end", onToolCallEnd);
    events.on("sub-agent-start", onSubStart);
    events.on("sub-agent-end", onSubEnd);
    events.on("error", onError);
    events.on("finally", onFinally);

    return () => {
      events.off("open", onOpen);
      events.off("chunk", onRawChunk);
      events.off("chunk-parsed", onChunk);
      events.off("parsed", onParsed);
      events.off("tool-call-end", onToolCallEnd);
      events.off("sub-agent-start", onSubStart);
      events.off("sub-agent-end", onSubEnd);
      events.off("error", onError);
      events.off("finally", onFinally);
    };
  }

  /**
   * 对外报的阶段要**再筛一遍**「谁还在跑」。
   *
   * 状态机只知道「这一轮都调了哪些工具」，而工具是并发跑的：结果消息一到终态，
   * 那个名字就该从等待里消失。不做这一步，界面会一直念着已经跑完的工具。
   *
   * 快照（`session.snapshot`）、清单（`session.list`）与 `session-phase` 三处报的必须是
   * **同一个**阶段，所以只有这一处实现。
   */
  phaseOf(session: LiveSession): PhaseInfo | null {
    const phase = session.phase.phase;
    if (!phase || phase.kind !== "tool-waiting" || !phase.calls) return phase;
    const pending = pendingToolCalls(phase.calls, session.agent.messages as any[]);
    return { ...phase, tools: pending.map((call) => call.name) };
  }

  emitPhase(session: LiveSession): void {
    this.emit({
      event: SESSION_EVENTS.phase,
      sessionId: session.id,
      turnId: session.turnId,
      phase: this.phaseOf(session),
    });
  }

  /**
   * 把本轮工具调用的**组装态**推上线（`session-tool-calls`）。
   *
   * 为什么另起一条事件而不塞进 `chunk-parsed`：那条是文本流（每片的语义是「再加这
   * 一段」），工具调用是组装态（每次给的是「到现在为止是什么」）。两种语义混在一条事件
   * 里，客户端就得靠猜这个字段该接还是该替。
   *
   * 为什么发全量而不是增片：core 已经替我们拼好了（见 `toolCallsOf`），再让客户端攒一遍
   * 片段，就是把同一个拼装在两个仓库里各写一份。
   *
   * 只发**变化了的**帧：判据在 `ToolCallReporter.update`（个数 / 名字 / id / 参数长度），
   * 不做全串比较。
   */
  emitToolCalls(session: LiveSession, receiver: unknown): void {
    const toolCalls = toolCallsOf(receiver);
    // 空集合不是一次「变化」：这条 receiver 上此刻还没有工具调用（纯正文的片、只带 usage
    // 的收尾片、以及一轮里**下一个**内层循环刚开始时的空消息），把它当成「工具调用被清空
    // 了」发出去，客户端会把刚画好的卡片抹掉。真正的归零只有一处：`resetStreamState`。
    if (toolCalls.length === 0) return;
    if (!session.toolCalls.update(toolCalls)) return;
    this.emit({
      event: SESSION_EVENTS.toolCalls,
      sessionId: session.id,
      turnId: session.turnId,
      toolCalls,
    });
  }

  /**
   * 把**刚刚定型**的工具结果消息逐条推上线（core `tool-call-end`）。
   *
   * 为什么不能只靠 `chunk-parsed`：那条事件的语义是**正文增量**（「再往后接这一段」），
   * 而工具结果是一条**完整消息** —— `role: "tool"` + `tool_call_id`（与 `session-tool-calls`
   * 里那次调用配对的身份）+ 定型后的正文。`tool_call_id` 不在任何一段正文里，客户端拿增量
   * 拼不出来；硬拼就得自己包装一条「工具结果」，那是同一条消息的第二份表示。
   *
   * 为什么要逐条推、不等快照：`session.snapshot` 要等 `session-turn-end` 之后才拿得到，而一个长
   * 轮次里工具能跑好几分钟 —— 用户盯着参数卡片，看不到它跑出了什么。core 那边结果本来就是
   * 逐条定型的（`tool-call-end` 每个工具各发一次，谁先跑完谁先发），这里只是把那一刻已经
   * 定型的消息顺手转出去。
   *
   * 为什么只推 `role === "tool"`：流式中的 assistant 消息还在拼，客户端已经在用
   * `chunk-parsed` + 占位消息画它了；再从这条通道推一遍，同一条消息就有了两种表示
   * （增量拼出来的那份和这条快照），收尾时还要对账「哪一份才是真的」。工具结果没有这个
   * 问题：它推出去时已经定型，也没有别的通道在画它。
   *
   * 为什么判据是「定型了吗」而不是「下标越过游标了」：core 在工具**执行前**就把结果消息
   * 追加进 `agent.messages`（`Message.Tool` → `status: "pending"`、正文为空），跑完才就地
   * 翻成终态 —— 于是并行时先完成的那条往往排在**后面**，它前面那条还在 `pending`。只按下标
   * 往后推会把还在跑的那条（正文空）当成结果发出去（客户端画出一张空卡片，等它真跑完时
   * 游标已经越过它，那张卡片再也不会被补上）；反过来「等前面那条跑完再往后推」又会让先
   * 完成的结果干等后完成的那个。所以两条判据：**已定型**（`FINISHED_STATUSES`，与
   * `phaseOf` 判「谁还在跑」用的是同一份）+ **推过没有**（`session.pushedMessages`）。
   */
  emitAppendedMessages(session: LiveSession): void {
    for (const message of session.agent.messages) {
      if (session.pushedMessages.has(message)) continue;
      const { role, status } = message as PhaseMessageLike;
      // 只推工具结果（理由见上）：assistant 消息此刻还在流里，`chunk-parsed` 在画它
      if (role !== "tool") continue;
      // 还没定型：等它自己那次 `tool-call-end` —— 此刻它正文还是空的
      if (!FINISHED_STATUSES.has(status ?? "")) continue;
      session.pushedMessages.add(message);
      this.emit({
        event: AGENT_EVENTS.toolCallEnd,
        sessionId: session.id,
        turnId: session.turnId,
        message,
      });
    }
  }

  /**
   * 把一个子 Agent 的终态发给客户端。
   *
   * 状态取**条目上的那个**（调用方在发之前已经写好）：`running` 走不到这里 ——
   * 收尾只有两处（`error` 置 failed、`sub-agent-end` 仅在 running 时置 done）。
   * 只信一处状态，事件与快照才不会一个说 done、一个说 failed。
   */
  emitSubAgentEnded(session: LiveSession, entry: SubAgentEntry): void {
    const status = entry.status === "failed" ? "failed" : "done";
    this.emit({
      event: AGENT_EVENTS.subAgentEnd,
      sessionId: session.id,
      turnId: session.turnId,
      subAgentId: entry.id,
      status,
    });
  }

  /**
   * 清空子 Agent 列表与展示序号。
   *
   * 为什么要清：子 Agent 是「内循环里工具调用的产物」，**只活在当前一轮**。一轮结束后
   * 主 Agent 已给出最终答案，子 Agent 只剩历史价值；留着会让栏目标签停在一段已经过去
   * 的对话上，而且下一轮的第一个子 Agent 会顶着上一轮的序号出现。`reload` / `setAgent`
   * （换了 Agent）、`adopt`（换了会话 id：迁移 / 另存为）、`close` 同理：旧条目上的实例
   * 已不再被任何东西引用。
   *
   * 两个计数器只有一个归零：
   *   - **展示序号归零**：下一轮又是「子AGENT1」（用户看到的是「这一轮的第三个」）；
   *   - **id 序号不归零**：`subAgentId` 是客户端选中态与 React key 的锚点，让它跨轮复用
   *     得到同一个值，就会出现「上一轮残留的选中 id 突然接到新一轮的 sub-1 上」。id 不带
   *     展示含义，多递增几次没有成本。
   */
  clearSubAgents(session: LiveSession): void {
    session.subAgents.clear();
    session.subAgentSeq = 0;
  }

  /**
   * 一轮的**流式状态**归零：阶段 + 工具调用的去重影子 + 「哪些消息已经推过」。
   *
   * 为什么三件事合成一个动作：它们必须同进同退。只清阶段不清影子，下一轮若拼出来的名字
   * 与参数与上一轮逐字相同（同一句话重试、同一个脚本再跑一次），去重判据会认为「没变」，
   * 那整轮的工具卡片一张都不会出现 —— 一个只在重复劳动时才出现的 bug，碰上了也很难相信。
   * 写成一个动作，就不存在「改到一处、漏掉另一处」的形态。
   *
   * 消息游标归位用的是**以当前消息表为基线**（`new Set(messages)`）而不是 `clear()`：
   * 清空之后下一轮第一次推就会把整段历史当成「刚追加的」重推一遍 —— 那是「跨轮泄漏」的
   * 另一面（上一轮的东西漏到下一轮），而不是解药。
   */
  resetStreamState(session: LiveSession): void {
    session.phase.reset();
    session.toolCalls.reset();
    session.pushedMessages = new Set(session.agent.messages);
  }

  private emit(event: ServerEvent): void {
    this.options.hub.publish(event);
  }
}
