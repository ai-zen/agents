/**
 * SDK 事件 → 协议事件的翻译器（`SessionManager` 拆出来的四块之一）。
 *
 * ## 管什么
 *
 * 把 Agent（`agent.events`）发出来的东西翻成线上事件：
 *
 *   1. **原样转达** core 的那几条（`AGENT_EVENTS`：`open` / `chunk` / `parsed` /
 *      `tool-call-end` / `error` / `finally` / `sub-agent-start` / `sub-agent-end`）——
 *      名字与时机都照抄 core，一行不改；
 *   2. **派生**服务端自己的那几条（`SESSION_EVENTS`）：阶段（`session-phase`）。
 *
 * core 的 `chunk-parsed` 与 `message` **不上线**：它们分别是「客户端折 `chunk` 就能得到的
 * 派生值」与「`tool-call-end` + 轮末快照已经覆盖的事实」。摘出来另立事件，等于给同一个
 * 事实立第二个定义 —— 而这个定义只能靠自己一直维护着与 core 同步。
 *
 * 顺带管 `LiveSession` 上的**流式影子**（`subAgents` 表与两个序号）—— 它只服务于「这一轮
 * 报过什么」，归零见 `resetStreamState`。
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
import type { NoticePayload, PhaseInfo, ServerEvent } from "../../protocol/index.js";
import type { LiveSession, SubAgentEntry, SubAgentLike } from "./LiveSession.js";

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
        event: "open",
        sessionId: session.id,
        turnId: session.turnId,
      });
      session.phase.opened();
      this.emitPhase(session);
    };

    /**
     * 一片 chunk 的解析结果（core `chunk-parsed`）：只用来推进阶段。
     *
     * **第二个参数才是 chunk**（core 发的是 `emit("chunk-parsed", receiver, chunk)`）。
     * 正文与推理增量不在这里转发 —— 客户端拿原始 `chunk` 自己折（core 的 `applyChunk`），
     * 服务端再把增量摘一份推出去就是同一件事的第二份实现。
     */
    const onChunk = (_receiver: unknown, chunk: any) => {
      session.phase.delta(chunk);
      this.emitPhase(session);
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
        event: "chunk",
        sessionId: session.id,
        turnId: session.turnId,
        chunk,
      });
    };

    /**
     * 一条消息被追加或就地改完（core `message`）→ 只取「工具结果定型」那一瞬（`tool-call-end`）。
     *
     * 消息本身**不上线**：客户端要的那条工具结果由 `tool-call-end` 带货，其余（用户消息、
     * 占位 assistant）要么是它自己造的、要么由轮末快照给。所以这里不再有 `message` 事件，
     * 只有一个派生出口。
     */
    const onMessage = (message: any) => {
      const { role, status } = message as PhaseMessageLike;
      if (role !== "tool" || !FINISHED_STATUSES.has(status ?? "")) return;
      this.emit({
        event: "tool-call-end",
        sessionId: session.id,
        turnId: session.turnId,
        message,
      });
    };

    const onParsed = (receiver: any) => {
      // core `parsed`：流结束、receiver 定稿。此后这一轮的正文不再变。
      this.emit({
        event: "parsed",
        sessionId: session.id,
        turnId: session.turnId,
      });
      session.phase.streamEnded(receiver?.message ?? receiver);
      this.emitPhase(session);
    };

    // 工具跑完一个就报一次：并行时先完成的那个从「等待」里消失，
    // 否则界面会一直念着已经结束的工具名。
    // （「刚定型的那条消息」已经由 `message` 事件推上去了，这里只管阶段）
    const onToolCallEnd = () => {
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
        event: "error",
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
        event: "finally",
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
        event: "sub-agent-start",
        sessionId: session.id,
        turnId: session.turnId,
        subAgentId: entry.id,
        index: entry.index,
      });

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
          code: "subAgentFailed",
          params: { index: entry.index, message: error?.message ?? String(error) },
        });
        this.emitSubAgentEnded(session, entry);
      };

      /**
       * 子 Agent 的**原始片**：与主 Agent 同一条事件，带 `subAgentId` 归到它的对话里。
       *
       * 客户端要自己折消息（`applyChunk`），靠的就是这一条 —— 只转 `chunk-parsed`
       * （正文增量）的话，子 Agent 的思考内容、工具调用、用量都折不出来。
       */
      subAgent.events.on("chunk", (chunk: any) => {
        this.emit({
          event: "chunk",
          sessionId: session.id,
          turnId: session.turnId,
          subAgentId: entry.id,
          chunk,
        });
      });
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
    events.on("message", onMessage);
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
      events.off("message", onMessage);
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
      event: "session-phase",
      sessionId: session.id,
      turnId: session.turnId,
      phase: this.phaseOf(session),
    });
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
      event: "sub-agent-end",
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

  /** 一轮的**流式状态**归零（阶段）。工具调用的组装态不再由服务端维护，见文件头。 */
  resetStreamState(session: LiveSession): void {
    session.phase.reset();
  }

  private emit(event: ServerEvent): void {
    this.options.hub.publish(event);
  }
}
