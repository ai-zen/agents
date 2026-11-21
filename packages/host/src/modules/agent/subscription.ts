import { AgentNS, type Agent } from "@ai-zen/agents-core";

import type { Bus } from "../../infra/bus.js";
import type { HostEvent } from "../events.js";
import type { messageTable } from "../session/messages.js";
import type { inboxTable } from "./inbox.js";

export interface AgentSubscriptionDeps {
  readonly messages: ReturnType<typeof messageTable>;
  readonly inbox: ReturnType<typeof inboxTable>;
  readonly events: Bus<HostEvent>;
  readonly onError: (error: unknown, what: string) => void;
  /** 这一段此刻是否在交接。传函数不传值：交接态会在一个执行体的寿命里变两次以上 */
  readonly isHandingOff: (sessionId: string) => boolean;
}

/**
 * 一个执行体接上宿主的三个出口：`messages` 表、推给客户端的事件、`inbox` 表。
 *
 * 它不记账：这段会话活不活、忙不闲都有别人管，这里只把 core 说的事实转出去。
 * `agent` 只用来订阅，不当字段存下来 —— 换模型换的是另一个执行体实例，存着的那个随即过期。
 */
export class AgentSubscription {
  private readonly unsubscribes: Array<() => void>;

  constructor(
    private readonly deps: AgentSubscriptionDeps,
    private readonly sessionId: string,
    agent: Agent,
  ) {
    this.unsubscribes = [
      // 一条消息的三条事件说的是同一种事（新增 / 变了 / 没了），差别只在属于谁：带 `subAgent`
      // 的是被派出去那个执行体的消息 —— 那些从不入库（随它一起消失），也不属于这段会话的转录，
      // 走 `subagent.message` 按那次工具调用分栏。
      agent.on("messageAdded", ({ agent, message, subAgent, via }) => {
        if (subAgent !== undefined) return this.subAgentMessage(agent, message, subAgent, via);
        this.writeMessage(message);
        this.emitEvent({ type: "message.added", sessionId: this.sessionId, message });
      }),

      agent.on("messageChanged", ({ agent, message, subAgent, via }) => {
        if (subAgent !== undefined) return this.subAgentMessage(agent, message, subAgent, via);
        this.changedMessage(message);
      }),

      // 库里那一行也要消失：留着它，用户会看见一条模型那边已经不存在的消息
      agent.on("messageRemoved", ({ message, subAgent }) => {
        // subagent 那些一条都没进过库，没有可删的；客户端那边它跟着那次工具调用一起收场
        if (subAgent !== undefined) return;
        try {
          this.deps.messages.delete(message.id);
        } catch (error) {
          this.deps.onError(error, "message-delete");
        }
        this.emitEvent({
          type: "message.removed",
          sessionId: this.sessionId,
          messageId: message.id,
        });
      }),

      /**
       * 流式期间的正文只从这一条拿到。core 在收流的循环里直接改内存里那条消息，一个 turn
       * 期间既不报 `messageChanged`（它只在中断、出错、工具结果定型这三处发），成功收尾时
       * 也不补一条 —— 只有这里不写、不推，库里那行 assistant 会永远停在落库那一刻的空正文上，
       * 客户端收到的第一条也是唯一一条只有 id 的空消息，模型说的话永远到不了界面。
       *
       * 写的是 `source.message` 那个活对象，原片一个字节都不解析：core 在派发之后立刻把这一片
       * 攒进那条消息，自己再 `applyChunk` 一遍就是把同一句加两次。
       *
       * 派发排在那次累加之前，所以这一条推出去的正文还差刚收到的这一片；最后一片的正文由
       * `responseFinished` 那条补上（它在收流之后才发）。
       *
       * 一片写一次整行（长回答是平方级的字符串重写量）：节流会把「客户端已经显示出来的最后
       * 几个字」推迟进库，进程在那个窗口里死掉，重启后这条消息短一截，而用户刚才明明看见了。
       *
       * 它与 `messageChanged` 走同一个出口（`changedMessage`）：两条说的都是「这条消息变了」，
       * 客户端那边只有一个动作 —— 整条替换成这一份。
       */
      agent.on("delta", ({ agent, source }) => {
        if ("message" in source) {
          this.changedMessage(source.message);
          return;
        }
        // subagent 的原始片只报「是哪个执行体」，消息本身不在载荷里（`DeltaSource` 的第二格
        // 只有 `subAgent` 与那次工具调用）。正在被写的那条就是它最后一条，且此刻在写：收流
        // 期间没有别的东西往它的消息里追加。状态那一格要判 —— 嵌套委派时转发上来的来源被
        // 改写成子执行体，它的最后一条是个已经定型的旧消息，拿它去套就是把旧正文推一遍。
        const message = source.subAgent.messages.at(-1);
        if (message !== undefined && message.status === AgentNS.MessageStatus.Writing) {
          this.subAgentMessage(agent, message, source.subAgent, source.toolCall);
        }
      }),

      /**
       * `status` / `finish_reason` / `usage` 是收流之后才钉到消息上的，最后一片 `delta`
       * 早于它们，上面那条写不出这三格。core 只在这里给出定型的那条消息，而单条 `usage`
       * 是要跟着消息落库的。
       */
      agent.on("responseFinished", ({ message }) => this.changedMessage(message)),

      agent.on("state:idle", (event) => this.emitEvent(this.statusEvent(event.agent))),
      agent.on("state:working", (event) => this.emitEvent(this.statusEvent(event.agent))),

      // 载荷只带 agent，两道闸各读各的现读值：一条事件名说明它动了，值不在这里另报一份
      agent.on("output:paused", (event) => this.emitEvent(this.pausedEvent(event.agent, "output"))),
      agent.on("output:resumed", (event) =>
        this.emitEvent(this.pausedEvent(event.agent, "output")),
      ),
      agent.on("input:paused", (event) => this.emitEvent(this.pausedEvent(event.agent, "input"))),
      agent.on("input:resumed", (event) => this.emitEvent(this.pausedEvent(event.agent, "input"))),

      /**
       * inbox 一有变化就落库，理由与 core 把持久化挂在这三条事件上相同。
       *
       * 推给客户端的是**此刻还在等的那一份**（`agent.inboxPending` 现读），不是这几条事件
       * 各带的那几条：`inboxTaken` 说「这些离开了」，客户端要的是「还剩哪些」，两者拼起来
       * 才是界面；在宿主里维护一份队列副本去算剩下的，那份副本迟早与 core 的队列对不上。
       */
      agent.on("inboxAdded", ({ agent, entry }) => {
        // 钥匙没有正文也没有 `messageId`：它说的是「输入已经在 `messages` 里了」，
        // 重启之后没有可恢复的东西。
        //
        // 带正文而没有 `messageId` 的也落不了库：这一行的身份就是那个 id（表拿它当主键），
        // 而它可以是 core 在落地那一刻现生成的 —— 那种条目连「这是哪一条」都答不出。
        // 宿主自己投递的条目一律带 id。
        if (entry.content !== undefined && entry.messageId !== undefined) {
          const storable = { ...entry, messageId: entry.messageId };
          try {
            this.deps.inbox.insert(this.sessionId, storable);
          } catch (error) {
            this.deps.onError(error, "inbox-write");
          }
        }
        this.emitEvent(this.inboxEvent(agent));
      }),

      /**
       * `inboxTaken` 排在落地**之后**（core 的两处取件都是先 `append` 再报这一条），
       * 所以「删 inbox 行」永远不会早于「写消息行」，顺序上不丢东西。
       *
       * 仍然按「那条消息在库里吗」过一遍：写消息那次失败过（`onError` 报的是它）的话，
       * 这条条目还没落到任何地方，删掉它就是那句话凭空消失 —— 留着，重启时放回队列再落一次。
       * 钥匙没进过这张表（它没有 `messageId`），所以先按有没有正文分一次。
       */
      agent.on("inboxTaken", ({ agent, entries }) => {
        const landed: string[] = [];
        for (const entry of entries) {
          if (entry.content === undefined || entry.messageId === undefined) continue;
          if (this.deps.messages.get(entry.messageId) !== undefined) landed.push(entry.messageId);
        }
        try {
          this.deps.inbox.deleteMany(landed);
        } catch (error) {
          this.deps.onError(error, "inbox-delete");
        }
        this.emitEvent(this.inboxEvent(agent));
      }),

      // 作废不是取走：这些条目再也不会落地，它们那一行没有等下去的理由。
      // 整段清掉而不是删载荷里的那几个 id —— 队列此刻已经空了，这张表里这段会话也不该剩东西。
      agent.on("inboxCleared", ({ agent }) => {
        try {
          this.deps.inbox.clearBySession(this.sessionId);
        } catch (error) {
          this.deps.onError(error, "inbox-delete");
        }
        this.emitEvent(this.inboxEvent(agent));
      }),
    ];
  }

  /**
   * 解绑：之后 core 再发生什么都不再落库、不再推。幂等。
   *
   * 没有「还没落定的写」要交代：落库走 `node:sqlite` 的同步接口，事件派发本身也是同步的，
   * 走到这里时栈上不可能还挂着一行没写完的消息。
   */
  detach(): void {
    for (const unsubscribe of this.unsubscribes) unsubscribe();
    this.unsubscribes.length = 0;
  }

  private statusEvent(agent: Agent): HostEvent {
    return { type: "agent.status", sessionId: this.sessionId, status: agent.state };
  }

  private pausedEvent(agent: Agent, side: "input" | "output"): HostEvent {
    return {
      type: "agent.paused",
      sessionId: this.sessionId,
      side,
      paused: side === "input" ? agent.isInputPaused : agent.isOutputPaused,
    };
  }

  private inboxEvent(agent: Agent): HostEvent {
    return { type: "agent.inbox", sessionId: this.sessionId, inbox: agent.inboxPending };
  }

  /**
   * 交接期间不落库：这一任写下的东西属于即将被换掉的那份记忆，落进去就跟着新记忆一起活着，
   * 而用户看到的历史里会多出一段「上一代在想什么」。推给客户端照旧 —— 用户要看得见它在写。
   *
   * 判在写之前、而推送在写之后：两半共用一个入口，拆开写就会有人只给其中一半加这道判断。
   */
  private writeMessage(message: AgentNS.Message): void {
    if (this.deps.isHandingOff(this.sessionId)) return;
    try {
      this.deps.messages.upsert(this.sessionId, message);
    } catch (error) {
      this.deps.onError(error, "message-write");
    }
  }

  /** 一条消息变了：落库、推出去。`messageChanged` / `delta` / `responseFinished` 都走这里 */
  private changedMessage(message: AgentNS.Message): void {
    this.writeMessage(message);
    this.emitEvent({ type: "message.changed", sessionId: this.sessionId, message });
  }

  /** subagent 的消息不入库，只推给它挂的那一栏 */
  private subAgentMessage(
    agent: Agent,
    message: AgentNS.Message,
    subAgent: Agent,
    toolCall?: AgentNS.ToolCall,
  ): void {
    // 事件里带的是那次委派的工具调用本身（`message*` 走 `via`，`delta` 走 `source.toolCall`），
    // 它的 `id` 就是名册上那一项的 `toolCallId`。`ToolCall.id` 在类型上可选，缺了就按「哪个
    // 执行体」去名册里查那一笔账 —— 那一格是必填的。
    const toolCallId =
      toolCall?.id ?? agent.subAgents.find((entry) => entry.agent === subAgent)?.toolCallId;

    if (toolCallId === undefined) {
      // 分栏靠这一格：编一个会让这条消息落到别人的栏里，宁可不发，但不要安静地丢
      this.deps.onError(
        new Error(
          `Cannot attribute a subagent message to a tool call: subagent "${subAgent.id}" is not in the roster`,
        ),
        "subagent-message",
      );
      return;
    }

    this.emitEvent({
      type: "subagent.message",
      sessionId: this.sessionId,
      toolCallId,
      message,
    });
  }

  /** 客户端掉线、某个订阅者抛错，都不该把 core 的循环带崩 —— 那一次 emit 在 core 的事件派发栈里 */
  private emitEvent(event: HostEvent): void {
    try {
      this.deps.events.emit(event);
    } catch (error) {
      this.deps.onError(error, "event-emit");
    }
  }
}
