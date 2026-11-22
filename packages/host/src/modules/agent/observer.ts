import { AgentNS, type Agent } from "@ai-zen/agents-core";
import type { AgentRuntime, RuntimeFact } from "@ai-zen/agents-sdk";

import type { Bus } from "../../infra/bus.js";
import type { AssetService } from "../asset/service.js";
import { ASSET_ID_KEY } from "../asset/types.js";
import type { HostEvent } from "../events.js";
import type { messageTable } from "../session/messages.js";
import type { inboxTable } from "./inbox.js";

export interface HostObserverDeps {
  readonly messages: ReturnType<typeof messageTable>;
  readonly inbox: ReturnType<typeof inboxTable>;
  /**
   * 素材域：消息落地那一刻把内容里的 `__asset_id` 登记成引用行。
   *
   * 观察者只揽这一件事：它把「这条消息引用了哪份素材」记下来；素材什么时候真的被删（引用归零）
   * 是 `AssetService.sweepUnreferenced` 的事，那时才有人读这张表。
   */
  readonly assets: AssetService;
  readonly events: Bus<HostEvent>;
  readonly onError: (error: unknown, what: string) => void;
  /** 这一段此刻是否在交接。传函数不传值：交接态会在一个执行体的寿命里变两次以上 */
  readonly isHandingOff: (sessionId: string) => boolean;
}

/**
 * 宿主这一侧唯一的观察者：**全进程一份**，构造时不绑定任何会话。
 *
 * 它接的是运行时交出来的那一条事实流（`AgentRuntime.observe`），按事实上的 `sessionId` 分派到
 * 这段会话的库与这条线上。它不记账：谁活着、忙不忙、容器还在不在都有运行时管，这里只把事实翻成
 * 「写库」与「推客户端」两个动作 —— 事实从下往上冒，材料从上往下给，中间没有第二处持有同样的东西。
 *
 * 与从前每个执行体挂一份订阅相比，只有两处不同，两处都是这件事本身要求的：
 * - `sessionId` 从构造参数变成事实上的那一格：一份观察者要同时听所有会话；
 * - `messageFinished` 这一条从前没人接（那时装配不经过观察者）。它管的是流式收尾、中断与工具
 *   定型那几处，装载时的状态归一不走它。见下面那一格的注释。
 *
 * `scope:*` 那三格与其余不带「消息 / 状态 / 闸 / 队列 / 死活」意义的事实这一版不往客户端推：
 * 客户端要看能力表是另一件事，等有人要了再接。这一段只搬老行为，没人在用的不新接。
 */
export class HostObserver {
  /**
   * 进程正在往下走：`kill` 带来的「排队区作废」不再落库 —— 关掉宿主不是杀死那一段。
   *
   * 两条路（用户按杀死、整个进程退出）共用同一个内核事实（`inboxCleared`），后果却相反：前者那
   * 些条目真的作废了，后者一条都没作废、下次打开还要接着等。区别只在宿主这一层，所以开关放在这
   * 一层，内核那一格一个字都不改。
   */
  private goingDown = false;

  constructor(private readonly deps: HostObserverDeps) {}

  /**
   * 调用方在 `runtime.close()` **之前**调它。
   *
   * `close()` 里逐段 `kill`，每一段都会清空队列并报 `inboxCleared`；那些事实从这一刻起说的不是
   * 「这些条目作废」，是「这个进程要没了」。
   */
  shutdown(): void {
    this.goingDown = true;
  }

  /** 挂到运行时的事实流上；返回退订函数（幂等由运行时那一侧保证） */
  attach(runtime: AgentRuntime): () => void {
    return runtime.observe((fact) => this.handle(fact));
  }

  /**
   * 一条事实该干什么。`sessionId` 从事实里取 —— 这是「一个观察者听所有会话」唯一需要多做的事。
   *
   * 每一格都照老 `AgentSubscription` 的那一份搬：写库走同一张表、推客户端走同一个总线、失败走
   * 同一个 `onError`。新增的只有 `messageFinished`（见下）。
   */
  private handle(fact: RuntimeFact): void {
    switch (fact.type) {
      /**
       * 活了：这一条排在开跑之前（运行时那边报完「出现」才 `start()`），客户端因此可能在它跑
       * 起来之前就把这一段挂到界面上。它就是老 `AgentRegistry.add` 里推的那一条。
       */
      case "resident:appeared":
        this.emitEvent({ type: "agent.alive", sessionId: fact.sessionId, alive: true });
        return;

      /** 没了：排在杀死之后，它最后那几条事实都在这条前面转出去了（老 `kill` 里那一条） */
      case "resident:gone":
        this.emitEvent({ type: "agent.alive", sessionId: fact.sessionId, alive: false });
        return;

      /**
       * 能力容器的三格这一版不推。容器说什么（出现了、刷新完了、拆掉了）宿主照旧什么都不用做：
       * 容器活着是因为运行时持有它，拆不拆由它自己判。客户端要看能力表是另一件事，等有人要了再接。
       */
      case "scope:appeared":
      case "scope:refreshed":
      case "scope:gone":
        return;

      // 一条消息的三条事件说的是同一种事（新增 / 变了 / 没了），差别只在属于谁：带 `subAgent`
      // 的是被派出去那个执行体的消息 —— 那些从不入库（随它一起消失），也不属于这段会话的转录，
      // 走 `subagent.message` 按那次工具调用分栏。
      case "messageAdded":
        if (fact.subAgent !== undefined) {
          return this.subAgentMessage(
            fact.sessionId,
            fact.agent,
            fact.message,
            fact.subAgent,
            fact.via,
          );
        }
        this.writeMessage(fact.sessionId, fact.message);
        this.emitEvent({
          type: "message.added",
          sessionId: fact.sessionId,
          message: fact.message,
        });
        return;

      case "messageChanged":
        if (fact.subAgent !== undefined) {
          return this.subAgentMessage(
            fact.sessionId,
            fact.agent,
            fact.message,
            fact.subAgent,
            fact.via,
          );
        }
        this.changedMessage(fact.sessionId, fact.message);
        return;

      /**
       * 定稿：这一版是终版，此后不再变（`completed` / `error` / `aborted` 且只报一次）。
       *
       * 它必须落库，而且**不推新事件**：客户端那边 `message.changed` 已经说过这条消息的内容了，
       * 再推一条同样的正文只是让界面把同一句话重画一次。落库这一半有三处离不了它：
       * - **流式收尾**：`status` / `finish_reason` / `usage` 是收流之后才钉到消息上的，最后一片
       *   `delta` 早于它们；
       * - **中断与出错**：那条消息停在 `aborted` / `error`，只在定稿这一刻写一次；
       * - **工具定型**：工具结果消息的状态也是在那一刻才定下的。
       *
       * **装载时的状态归一不走这一条**：装配时 `append` 进来的历史听不到它（转发订阅挂在
       * `append` 之后，而 `settle` 每条消息只报一次）。那几条是运行时归一之后补报一条
       * `messageChanged` 送过来的，也就是下面那一格。
       *
       * 走 `writeMessage` 而不是直接写库：交接期间不落库这条判断只有一处。
       */
      case "messageFinished":
        this.writeMessage(fact.sessionId, fact.message);
        return;

      // 库里那一行也要消失：留着它，用户会看见一条模型那边已经不存在的消息
      case "messageRemoved":
        // subagent 那些一条都没进过库，没有可删的；客户端那边它跟着那次工具调用一起收场
        if (fact.subAgent !== undefined) return;
        this.removeMessage(fact.sessionId, fact.message);
        return;

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
       * `responseFinished` 与 `messageFinished` 那两条补上。
       *
       * 一片写一次整行（长回答是平方级的字符串重写量）：节流会把「客户端已经显示出来的最后
       * 几个字」推迟进库，进程在那个窗口里死掉，重启后这条消息短一截，而用户刚才明明看见了。
       *
       * 它与 `messageChanged` 走同一个出口（`changedMessage`）：两条说的都是「这条消息变了」，
       * 客户端那边只有一个动作 —— 整条替换成这一份。
       */
      case "delta":
        if ("message" in fact.source) {
          // 不登记素材引用（第三格 `false`）：流式期间一片一次，而这时正文还在长 —— 引用等它落到
          // `messageChanged` / `responseFinished` / `messageFinished` 那几处再记（`link` 幂等，
          // 真在那里重记一次也只留一行）。
          this.changedMessage(fact.sessionId, fact.source.message, false);
          return;
        }
        // subagent 的原始片只报「是哪个执行体」，消息本身不在载荷里（`DeltaSource` 的第二格
        // 只有 `subAgent` 与那次工具调用）。正在被写的那条就是它最后一条，且此刻在写：收流
        // 期间没有别的东西往它的消息里追加。状态那一格要判 —— 嵌套委派时转发上来的来源被
        // 改写成子执行体，它的最后一条是个已经定型的旧消息，拿它去套就是把旧正文推一遍。
        {
          const message = fact.source.subAgent.messages.at(-1);
          if (message !== undefined && message.status === AgentNS.MessageStatus.Writing) {
            this.subAgentMessage(
              fact.sessionId,
              fact.agent,
              message,
              fact.source.subAgent,
              fact.source.toolCall,
            );
          }
        }
        return;

      /**
       * `status` / `finish_reason` / `usage` 是收流之后才钉到消息上的，最后一片 `delta`
       * 早于它们，上面那条写不出这三格。core 只在这里给出定型的那条消息，而单条 `usage`
       * 是要跟着消息落库的。
       */
      case "responseFinished":
        // subagent 的收口也会转发上来，而它的话从不入库：不分这一支的话，落库那一处会把
        // subagent 的回复写进这段会话的主转录，客户端还会收到一条自己从没 `message.added`
        // 过的 id。
        if (fact.subAgent !== undefined) {
          return this.subAgentMessage(
            fact.sessionId,
            fact.agent,
            fact.message,
            fact.subAgent,
            fact.via,
          );
        }
        this.changedMessage(fact.sessionId, fact.message);
        return;

      case "state:idle":
        this.emitEvent(this.statusEvent(fact.sessionId, fact.agent));
        return;
      case "state:working":
        this.emitEvent(this.statusEvent(fact.sessionId, fact.agent));
        return;

      // 载荷只带 agent，两道闸各读各的现读值：一条事件名说明它动了，值不在这里另报一份
      case "output:paused":
        this.emitEvent(this.pausedEvent(fact.sessionId, fact.agent, "output"));
        return;
      case "output:resumed":
        this.emitEvent(this.pausedEvent(fact.sessionId, fact.agent, "output"));
        return;
      case "input:paused":
        this.emitEvent(this.pausedEvent(fact.sessionId, fact.agent, "input"));
        return;
      case "input:resumed":
        this.emitEvent(this.pausedEvent(fact.sessionId, fact.agent, "input"));
        return;

      /**
       * inbox 一有变化就落库，理由与 core 把持久化挂在这三条事件上相同。
       *
       * 推给客户端的是**此刻还在等的那一份**（`agent.inboxPending` 现读），不是这几条事件
       * 各带的那几条：`inboxTaken` 说「这些离开了」，客户端要的是「还剩哪些」，两者拼起来
       * 才是界面；在宿主里维护一份队列副本去算剩下的，那份副本迟早与 core 的队列对不上。
       */
      case "inboxAdded":
        // 钥匙没有正文也没有 `messageId`：它说的是「输入已经在 `messages` 里了」，
        // 重启之后没有可恢复的东西。
        //
        // 带正文而没有 `messageId` 的也落不了库：这一行的身份就是那个 id（表拿它当主键），
        // 而它可以是 core 在落地那一刻现生成的 —— 那种条目连「这是哪一条」都答不出。
        // 宿主自己投递的条目一律带 id。
        //
        // 宿主投递的那条路已经先写过同一行了（它要先落库再入队），所以这里会撞上那个 id：
        // 表那一侧的写是幂等的，第二次什么都不做，这不报错也不算漏写 —— 事实照旧是「这一条
        // 在排队区里」，库里那一行是它先写下的。
        if (fact.entry.content !== undefined && fact.entry.messageId !== undefined) {
          const storable = { ...fact.entry, messageId: fact.entry.messageId };
          try {
            this.deps.inbox.insert(fact.sessionId, storable);
          } catch (error) {
            this.deps.onError(error, "inbox-write");
          }
        }
        this.emitEvent(this.inboxEvent(fact.sessionId, fact.agent));
        return;

      /**
       * `inboxTaken` 排在落地**之后**（core 的两处取件都是先 `append` 再报这一条），
       * 所以「删 inbox 行」永远不会早于「写消息行」，顺序上不丢东西。
       *
       * 仍然按「那条消息在库里吗」过一遍：写消息那次失败过（`onError` 报的是它）的话，
       * 这条条目还没落到任何地方，删掉它就是那句话凭空消失 —— 留着，重启时放回队列再落一次。
       * 钥匙没进过这张表（它没有 `messageId`），所以先按有没有正文分一次。
       */
      case "inboxTaken": {
        const landed: string[] = [];
        for (const entry of fact.entries) {
          if (entry.content === undefined || entry.messageId === undefined) continue;
          if (this.deps.messages.get(entry.messageId) !== undefined) landed.push(entry.messageId);
        }
        try {
          this.deps.inbox.deleteMany(landed);
        } catch (error) {
          this.deps.onError(error, "inbox-delete");
        }
        this.emitEvent(this.inboxEvent(fact.sessionId, fact.agent));
        return;
      }

      // 作废不是取走：这些条目再也不会落地，它们那一行没有等下去的理由。
      // 整段清掉而不是删载荷里的那几个 id —— 队列此刻已经空了，这张表里这段会话也不该剩东西。
      //
      // 关机时**不删**：这一条的意思是「这些条目作废」，而整个进程退出不是杀死那一段 —— 它们一条
      // 都没作废，下次打开还要接着等（需求：关掉再打开，记忆与排队区都在）。下面推客户端那一句
      // 一并不发，那时已经在关机，没有谁还看着这个界面。
      case "inboxCleared":
        if (this.goingDown) return;
        try {
          this.deps.inbox.clearBySession(fact.sessionId);
        } catch (error) {
          this.deps.onError(error, "inbox-delete");
        }
        this.emitEvent(this.inboxEvent(fact.sessionId, fact.agent));
        return;

      /** 这次请求 / 这次工具失败了：那是执行体自己的事，宿主只把它记进日志 */
      case "failed":
        this.deps.onError(fact.error, "agent-failed");
        return;

      /**
       * 旁观的人自己炸了 —— 这一条**就是**「让宿主记一句」：订阅者只是看，被观察的执行体照常跑。
       * 运行时那一侧已经在自己的记录里说过一次，宿主这一侧的出口是同一个 `onError`。
       */
      case "observerFailed":
        this.deps.onError(fact.error, "observer-failed");
        return;

      /**
       * 其余带 `sessionId` 的事实这一版不推：`turnStarted` / `turnFinished` / `toolStarted` /
       * `toolFinished` / `subAgentStarted` / `subAgentFinished` / `requestSent` / `denied` /
       * `started` / `stopped` / `killed` / `aborted`。老行为里它们不收（客户端看的是状态、闸、
       * 消息与队列那几格），这一段只搬老行为，没人在用的不新接。
       */
      default:
        return;
    }
  }

  private statusEvent(sessionId: string, agent: Agent): HostEvent {
    return { type: "agent.status", sessionId, status: agent.state };
  }

  private pausedEvent(sessionId: string, agent: Agent, side: "input" | "output"): HostEvent {
    return {
      type: "agent.paused",
      sessionId,
      side,
      paused: side === "input" ? agent.isInputPaused : agent.isOutputPaused,
    };
  }

  private inboxEvent(sessionId: string, agent: Agent): HostEvent {
    return { type: "agent.inbox", sessionId, inbox: agent.inboxPending };
  }

  /**
   * 交接期间不落库：这一任写下的东西属于即将被换掉的那份记忆，落进去就跟着新记忆一起活着，
   * 而用户看到的历史里会多出一段「上一代在想什么」。推给客户端照旧 —— 用户要看得见它在写。
   *
   * 判在写之前、而推送在写之后：两半共用一个入口，拆开写就会有人只给其中一半加这道判断。
   *
   * `linkAssets` 只有 `delta` 给 `false`（那一处正文还在长，见 `delta` 分支的注释）。
   */
  private writeMessage(sessionId: string, message: AgentNS.Message, linkAssets = true): void {
    if (this.deps.isHandingOff(sessionId)) return;
    try {
      this.deps.messages.upsert(sessionId, message);
    } catch (error) {
      this.deps.onError(error, "message-write");
      return;
    }

    // 行真的写进去了才登记引用：`session_assets.messageId` 是指向 `messages` 的外键，
    // 反过来写会撞外键，而那时库里已经有一条「没有引用」的消息行。
    if (linkAssets) this.linkAssets(message);
  }

  /**
   * 把这条消息内容里带 `__asset_id` 的段登记成引用行。
   *
   * 为什么挂在落库那一处而不是投递那一处：引用是「这条消息引用了哪份素材」的事实，它与消息行
   * 同生 —— 消息行的每一个落点（新增 / 变了 / 定稿）都走 {@link writeMessage}，挂在这里就漏不掉；
   * 挂到某一个具体分支上，另外两个分支的消息（比如装载时补报的那几条）就永远没有引用行，那些
   * 素材会被 `sweepUnreferenced` 提前当成无主删掉。
   *
   * 失败只报一句、不让这一次写库失败：一条登记没写进去，最坏的代价是那份素材被多留一会儿
   *（或者被提前删掉，由下一次发送时「附件已不在」那一句推说），而消息本身不能因此丢。
   */
  private linkAssets(message: AgentNS.Message): void {
    const assetIds = assetIdsOf(message.content);
    if (assetIds.length === 0) return;
    try {
      this.deps.assets.link(message.id, assetIds);
    } catch (error) {
      this.deps.onError(error, "asset-link");
    }
  }

  /** 一条消息变了：落库、推出去。`messageChanged` / `delta` / `responseFinished` 都走这里 */
  private changedMessage(sessionId: string, message: AgentNS.Message, linkAssets = true): void {
    this.writeMessage(sessionId, message, linkAssets);
    this.emitEvent({ type: "message.changed", sessionId, message });
  }

  /** 一条消息没了：删库、推出去 */
  private removeMessage(sessionId: string, message: AgentNS.Message): void {
    try {
      this.deps.messages.delete(message.id);
    } catch (error) {
      this.deps.onError(error, "message-delete");
    }
    this.emitEvent({ type: "message.removed", sessionId, messageId: message.id });
  }

  /** subagent 的消息不入库，只推给它挂的那一栏 */
  private subAgentMessage(
    sessionId: string,
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

    this.emitEvent({ type: "subagent.message", sessionId, toolCallId, message });
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

/**
 * 内容里带 `__asset_id` 的段指回的那些素材 id（按出现顺序去重）。
 *
 * 读的是「形状上有没有这个键」：`__asset_id` 不是 `AgentNS` 的已知字段，落库那一份原样带着它，
 * 出网那一份由 core 的白名单剥掉 —— 同一个段的两份内容只差这一个键。
 */
function assetIdsOf(content: AgentNS.MessageContent | undefined): string[] {
  if (!Array.isArray(content)) return [];
  const ids: string[] = [];
  for (const section of content) {
    const assetId = (section as unknown as Record<string, unknown>)[ASSET_ID_KEY];
    if (typeof assetId === "string" && !ids.includes(assetId)) ids.push(assetId);
  }
  return ids;
}
