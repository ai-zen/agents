import { AgentNS, type Agent, type AgentEvents } from "@ai-zen/agents-core";
import type { Scope } from "../scope/Scope.js";
import type {
  PeerSessionCreated,
  PeerSessionPort,
  PeerSessionSent,
  PeerSessionStatus,
} from "../scope/plugins/peers/peerSessionTools.js";
import { SILENT_LOG, type LogSink } from "../shared/logger.js";
import type { ModelParams } from "../types/index.js";
import { createAgent } from "./createAgent.js";
import { RuntimePeerSessions } from "./RuntimePeerSessions.js";
import { Scopes } from "./Scopes.js";
import type { SdkAgent } from "./SdkAgent.js";

/**
 * 装出一个执行体需要的全部事实 —— 从上往下给（`TRD` 的「材料从上往下给」）。
 *
 * 这里没有一样是运行时自己去取的：历史与没取走的条目在库里的那一份只有宿主认得，模型解析的
 * 三级链只有 `createAgent` 一处实现，运行时只负责把它们拼成一个活着的对象。
 */
export interface WakeMaterials {
  /** 在哪一个目录上干活：能力容器按它取（同一个目录上的几段会话共用一个） */
  cwd: string;
  /** 用哪个助手定义装 */
  agentId: string;
  /** 这一段会话的模型覆盖（三级解析的第一级） */
  modelId?: string;
  /** 与 `modelId` 同一级的模型参数覆盖（档位补丁就叠在这一份上） */
  modelParams?: ModelParams;
  /**
   * 谁开的这一段：`null` = 人建的，否则是开出它的那一段会话的身份。
   *
   * 运行时只拿它判一件事：这一段自己能不能再开一段（`PRD.md` 4.3 的「防俄罗斯套娃」）。
   * 血缘本身是会话行上的事实，展示归宿主。
   */
  lineage: string | null;
  /** 已经落库的历史，按原顺序。**不含**助手定义里的模板消息 —— 那些由 `createAgent` 装 */
  history: AgentNS.Message[];
  /** 还没被取走的条目（上次没来得及处理的那几句），按入队顺序 */
  waiting: AgentNS.InboxEntryWithContent[];
}

/** 开一段新会话要的事实：运行时发身份，行由宿主写 */
export interface NewPeerSession {
  /** 哪一段会话开的 */
  lineage: string;
  /** 交给新会话的第一句话（它从空上下文开始，只能用这一句话知道要干什么） */
  prompt: string;
  /** 用哪个助手定义装 */
  agentId: string;
  /** 模型覆盖（不给就按该定义走三级解析） */
  modelId?: string;
  /** 模型给的可读名字；不给则由宿主按 `prompt` 起一个 */
  label?: string;
}

/** `open` 的答案：开成了就把材料交回来，开不成给原因（运行时不替宿主编理由） */
export type OpenPeerSession =
  | { ok: true; sessionId: string; materials: WakeMaterials }
  | { ok: false; reason: "model_unresolved" };

/**
 * 运行时向宿主借的四件事。
 *
 * 它们全是「读写文件、写库」那一类：运行时自己不做这些，但必须有地方做。
 */
export interface RuntimePorts {
  /** 造一个能力容器（怎么发现能力、装哪些插件归宿主） */
  openScope(cwd: string, peers: PeerSessionPort): Promise<Scope>;
  /** 开一段会话：写行、定身份、把装它的材料交回来 */
  open(input: NewPeerSession): Promise<OpenPeerSession>;
  /** 一段会话此刻叫什么（宿主从会话行现读）；`undefined` = 库里没有这一段 */
  nameOf(sessionId: string): Promise<string | undefined>;
  /** 日志口（可选）：不注入就什么都不记 */
  log?: LogSink;
}

/** 登记项：一段会话与它此刻活着的执行体。**一个身份一条**，全仓只有这一份表 */
interface Resident {
  readonly sessionId: string;
  /** 唤醒时定下的目录：换项目是换会话，不是把执行体搬走 */
  readonly cwd: string;
  readonly lineage: string | null;
  readonly agent: SdkAgent;
}

/**
 * 运行时交出去的事实。
 *
 * 三种来源，按 `type` 判别：
 * - 运行时自己知道的两格：一段会话出现了（`resident:appeared`）、没了（`resident:gone`）。
 *   这两件事只有运行时知道 —— 执行体自己说不出「我在这张登记表里」；
 * - 每个执行体的内核事件：名字与载荷**原样**转出（`started`、`messageAdded`、`state:idle` 等），
 *   只额外带上它属于哪一段会话。
 *
 * 内核那一支为什么用映射类型拼、而不是手抄一份成员：手抄的那一份与内核的事件表迟早漂开，而漂开
 * 的后果是订阅者按 `fact.type === "messageAdded"` 收窄不出载荷的形状。映射之后，每一个成员都是
 * 「事件名 + 同一个名字的载荷 + 会话身份」的交叉，订阅者按名字判别就取得到那一格。
 *
 * 载荷里带出去的是活对象本身（内核原样），不是拷贝：收到事实的人手里攥着的就是那条消息。
 */
export type RuntimeFact =
  | {
      type: "resident:appeared";
      sessionId: string;
      cwd: string;
      lineage: string | null;
      agent: SdkAgent;
    }
  | { type: "resident:gone"; sessionId: string }
  | {
      [K in keyof AgentEvents]: { type: K; sessionId: string } & AgentEvents[K];
    }[keyof AgentEvents];

/**
 * 内核事件表的一份**穷尽**清单：键与值是同一个字。
 *
 * 它只为一件事存在 —— 防漂移。`keyof AgentEvents` 上加了新事件而这张表没补，TypeScript 直接
 * 报缺属性；表里多写一个内核没有的名字同样过不了编译。转发那一处从这张表取名字，不另抄第二份。
 */
const AGENT_EVENT_NAMES: { readonly [K in keyof AgentEvents]: K } = {
  started: "started",
  stopped: "stopped",
  killed: "killed",
  "state:idle": "state:idle",
  "state:working": "state:working",
  "output:paused": "output:paused",
  "output:resumed": "output:resumed",
  "input:paused": "input:paused",
  "input:resumed": "input:resumed",
  aborted: "aborted",
  inboxAdded: "inboxAdded",
  inboxTaken: "inboxTaken",
  inboxCleared: "inboxCleared",
  messageAdded: "messageAdded",
  messageChanged: "messageChanged",
  messageRemoved: "messageRemoved",
  delta: "delta",
  requestSent: "requestSent",
  responseFinished: "responseFinished",
  toolStarted: "toolStarted",
  toolFinished: "toolFinished",
  subAgentStarted: "subAgentStarted",
  subAgentFinished: "subAgentFinished",
  denied: "denied",
  failed: "failed",
};

/** 上面那张表的值：挂转发要按名字逐个挂，键与值是同一个字，取哪一边都一样 */
const AGENT_EVENT_LIST: ReadonlyArray<keyof AgentEvents> = Object.values(AGENT_EVENT_NAMES);

/** `send` 的答案与工具那一侧同一个形状（`ok` / 两条拒绝原因） */
export type PostResult = PeerSessionSent;

/** 摘要的截断长度：模型看的是「最近一句说了什么」，不是把对方的记忆搬过来 */
const EXCERPT_LIMIT = 300;

/**
 * 运行时 —— 让执行体活着，并让它们互相说话。
 *
 * 三件事，共用同一份登记：
 * - **常驻**：`wake` 装起来、登记、开跑；`kill` 收掉。一段会话最多一个执行体。
 * - **事件驱动**：没有人 `await` 也照样跑 —— 一条投递把它从闲推到忙，跑完自己回到闲。
 *   运行时不给「等它跑完」这种口，常驻会话也没有「跑完了」这个对象。
 * - **发话**：`post` 把一句话寄给另一段会话（模型那一侧对应的工具是 `post_message`）。
 *
 * 它还管能力容器的生死（见 `Scopes`）：容器按目录存活，「这个目录上还有几段会话活着」由登记表
 * 自己答得出，不必问谁。
 *
 * 它自己**没有**库、连接、凭证、语言与用户可见文案，也不认识会话行：身份是不透明的字符串，
 * 名字要问 `ports.nameOf`。
 */
export class AgentRuntime {
  /**
   * 活着的那些。**只有活着的**：杀死与删会话都把登记项去掉，于是「这一段在我这儿还在不在」
   * 与「它有没有执行体」是同一个问题。
   */
  private readonly residents = new Map<string, Resident>();
  /**
   * 正在装的那几次。记的是那次调用的 Promise：记「正在装」的布尔标志会在两次并发唤醒里一起
   * 看到 false，于是装出两个执行体，而登记表只留得下一个。
   */
  private readonly waking = new Map<string, Promise<SdkAgent>>();
  /** 订了这份事实的那些人。**旁路**：只收，不参与任何判断 */
  private readonly listeners = new Set<(fact: RuntimeFact) => void>();
  /**
   * 每个活着的执行体那一组转发订阅，按会话收好。
   *
   * 与登记表分开的理由：登记表答的是「谁活着」，这张表答的是「谁的转发还没解」。杀一段会话只解
   * 它自己那一组，别的执行体一个字都不动。
   */
  private readonly forwarders = new Map<string, Array<() => void>>();

  /** 能力容器：按目录一份，什么时候造、什么时候拆归它 */
  readonly scopes: Scopes;

  /** 平级会话的三方法端口：插件拿它造那三个工具，宿主这里一个字节都不必知道 */
  readonly peerSessions: PeerSessionPort;

  constructor(private readonly ports: RuntimePorts) {
    this.peerSessions = new RuntimePeerSessions(this);
    this.scopes = new Scopes({
      openScope: (cwd, peers) => this.ports.openScope(cwd, peers),
      aliveSessions: (cwd) => this.aliveOn(cwd),
      peers: this.peerSessions,
      log: ports.log ?? SILENT_LOG,
    });
  }

  /**
   * 订阅运行时交出去的事实；返回退订函数（幂等：连着调两次不会炸）。
   *
   * 这是**旁路**：订阅者不改任何决定，也不参与任何判断。晚到的订阅者拿不到过去的事实 ——
   * 事实只报变化，快照那一侧由 `get` / `aliveOn` 对齐，两者合起来才说得清「此刻」与「怎么走到
   * 这一刻」。
   */
  observe(listener: (fact: RuntimeFact) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 这一段此刻活着的执行体；没有就是 `undefined` */
  get(sessionId: string): SdkAgent | undefined {
    return this.residents.get(sessionId)?.agent;
  }

  /** 这个执行体属于哪一段会话；查不到 = 它不属于任何一段（被派出去的那个） */
  sessionOf(agent: Agent): string | undefined {
    for (const [sessionId, resident] of this.residents) {
      if (resident.agent === agent) return sessionId;
    }
    return undefined;
  }

  /** 这个目录上还活着哪几段会话（拆容器之前问的就是它） */
  aliveOn(cwd: string): readonly string[] {
    const sessionIds: string[] = [];
    for (const [sessionId, resident] of this.residents) {
      if (resident.cwd === cwd) sessionIds.push(sessionId);
    }
    return sessionIds;
  }

  /**
   * 唤醒：装起来、登记、开跑。
   *
   * **幂等**：已经活着就把它交回去；正在装的话，等的是同一次装。两个触发方同时叫醒同一段
   * （客户端连点两下发送）不该装出两个执行体 —— 那条会话的记忆只有一个，两个执行体会同时写它。
   *
   * 装不出来就抛（模型解析不出来、定义文件读不出来、历史形状不对），并且**不留登记项**：
   * 一个装了一半的会话在登记表里，等于告诉外面「它活着」，而它连件都收不了。
   */
  async wake(sessionId: string, materials: WakeMaterials): Promise<SdkAgent> {
    const running = this.residents.get(sessionId);
    if (running !== undefined) return running.agent;

    const inflight = this.waking.get(sessionId);
    if (inflight !== undefined) return inflight;

    const assembling = this.assemble(sessionId, materials).finally(() =>
      this.waking.delete(sessionId),
    );
    this.waking.set(sessionId, assembling);
    return assembling;
  }

  /**
   * 发话：把一句话寄给另一段会话。
   *
   * **投递不创建、也不复活会话**（`PRD.md` 4.1）：目标没有执行体就是没投出去，由发起方自己
   * 决定怎么跟用户说。两条拒绝原因要分得开 —— `gone` 是这段会话不在了（行都没了），`dead`
   * 是行还在、只是没人取件。判据只有宿主答得出，所以问 `nameOf`。
   *
   * 优先级是 `low`：寄来的话不该插进对方手上那一批的工具调用之间。对方这一批跑完再取它，
   * 顺序是它自己队列的顺序。**投递不承诺任何未来** —— 收下了就是收下了。
   */
  async post(input: {
    from: string;
    to: string;
    content: AgentNS.MessageContent;
  }): Promise<PostResult> {
    const target = this.residents.get(input.to);
    if (target === undefined) {
      const exists = (await this.ports.nameOf(input.to)) !== undefined;
      return { ok: false, reason: exists ? "dead" : "gone" };
    }

    // 署名按发起方现读的名字走：名字长在会话行上，这里存一份就等着它过期
    const label = await this.labelOf(input.from);
    target.agent.push({
      content: input.content,
      priority: "low",
      source: { kind: "agent", label },
    });
    return { ok: true };
  }

  /**
   * 一段会话此刻什么样：忙不忙、名字、最近说了什么。
   *
   * **不给全量消息、不给历史**：这个答案唯一的读者是另一段会话的模型，给了原文它就会把对方的
   * 记忆当上下文搬运（`PRD.md` 4.3）。
   *
   * `found: false` 说的是「我这儿没有它的执行体」：会话行被删了，或者进程重启之后还没人叫醒
   * 它，都落在这一格。
   */
  async status(sessionId: string): Promise<PeerSessionStatus> {
    const resident = this.residents.get(sessionId);
    if (resident === undefined) return { found: false, status: null };

    return {
      found: true,
      status: resident.agent.state,
      // 登记表里只有活着的执行体（杀死与删会话都会去掉登记项），所以找到就是活着
      alive: true,
      label: await this.labelOf(sessionId),
      lastMessage: lastMessageOf(resident.agent.messages),
    };
  }

  /**
   * 开一段平级会话：写行、装起来、把 `prompt` 递进去，建完即回。
   *
   * **只许开一层**（`PRD.md` 4.3）：一段会话本身是别人开出来的话，它开不出第二层；被派出去的
   * 那个执行体（subagent）不属于任何一段会话，同样开不出来。判据是登记表里的血缘 —— 这一格
   * 只有运行时知道，所以这条规矩落在这里，而不是落在一道谁也查不动的校验里。
   *
   * 不等那边的答复：它收下这句话之后怎么干、什么时候干，都不是这一句能定下的。
   */
  async openPeer(input: {
    from: string;
    prompt: string;
    agentId?: string;
    modelId?: string;
    label?: string;
  }): Promise<PeerSessionCreated> {
    const opener = this.residents.get(input.from);
    if (opener === undefined || opener.lineage !== null) {
      return { ok: false, reason: "depth_exceeded" };
    }

    const opened = await this.ports.open({
      lineage: input.from,
      prompt: input.prompt,
      agentId: input.agentId ?? opener.agent.definition.id,
      modelId: input.modelId,
      label: input.label,
    });
    // 模型解析不出来是**结构化的拒绝**：模型读得懂，可以换个助手或自己干
    if (!opened.ok) return { ok: false, reason: opened.reason };

    await this.wake(opened.sessionId, opened.materials);
    await this.post({ from: input.from, to: opened.sessionId, content: input.prompt });

    return {
      ok: true,
      sessionId: opened.sessionId,
      label: await this.labelOf(opened.sessionId),
    };
  }

  /**
   * 杀死：执行体销毁，登记项去掉。会话行与历史留着（`PRD.md` 4.1）。
   *
   * 四步次序（`live-objects.md` 判据四）：
   * - 先去掉登记项再杀：杀死会发最后几条事件，那时这一段不该还能被别人查到活着的执行体，
   *   也不该有人趁这一刻往里投话；
   * - 杀完再报「没了」：它最后那几条事实要排在这一条之前转出去；
   * - 报完再解这一组转发订阅：先解再报的话，订阅者永远不知道自己漏了什么。
   */
  kill(sessionId: string): void {
    const resident = this.residents.get(sessionId);
    if (resident === undefined) return;

    this.residents.delete(sessionId);
    resident.agent.kill();
    this.broadcast({ type: "resident:gone", sessionId });
    this.detach(sessionId);
  }

  /** 收工：杀光、拆光。进程退出前那一步；此后再叫醒就要重新给材料 */
  async close(): Promise<void> {
    for (const sessionId of [...this.residents.keys()]) this.kill(sessionId);
    await this.scopes.disposeAll();
  }

  /**
   * 装配：取容器、造执行体、把历史接在模板后面、把没取走的条目放回队列。
   *
   * 两处次序不是随手定的：
   * - 历史一条一条 `append`，**不给 `agent.messages` 整体赋值**：那个数组是记忆的唯一真相，
   *   换掉它会让已经拿到引用的地方继续指着旧的那一份；
   * - 放回队列排在装历史之后：一条条目落过地没有，判据是它那条消息在不在已经装好的历史里。
   *   反过来排，这个判据就得另找一份账。
   */
  private async assemble(sessionId: string, materials: WakeMaterials): Promise<SdkAgent> {
    const scope = await this.scopes.for(materials.cwd);

    const agent = await createAgent(scope, materials.agentId, {
      modelId: materials.modelId,
      modelParams: materials.modelParams,
    });

    const history = recovered(materials.history);
    for (const message of history) agent.append(message);

    const landed = new Set(history.map((message) => message.id));
    const waiting = materials.waiting.filter(
      (entry) => entry.messageId === undefined || !landed.has(entry.messageId),
    );
    agent.restore(waiting);

    // 三项次序（`live-objects.md` 判据一与判据四）：
    // - 先挂转发再登记：「出现」之后这一段会话发出来的每一条事实都要转出去，一条不落；
    // - 报「出现」排在开跑之前：一跑起来就可能被别的执行体 `post` 到，那些事实必须排在「出现」
    //   后面，否则订阅者会先收到一条关于它还不认识的会话的事实；
    // - 报「出现」排在写登记表之后：报完那一刻，`get` / `aliveOn` 这两份快照立刻查得到它，
    //   订阅者拿着「出现」去问不会被回一句「没这一段」。
    this.forwarders.set(sessionId, this.forward(sessionId, agent));
    this.residents.set(sessionId, {
      sessionId,
      cwd: materials.cwd,
      lineage: materials.lineage,
      agent,
    });
    this.broadcast({
      type: "resident:appeared",
      sessionId,
      cwd: materials.cwd,
      lineage: materials.lineage,
      agent,
    });
    void agent.start();

    return agent;
  }

  /**
   * 给一个执行体挂上转发：它的每一条内核事件都变成一条运行时事实（名字与载荷原样，只多一个
   * 会话身份）。交回来的是这一组退订函数，由调用方按会话收好。
   */
  private forward(sessionId: string, agent: SdkAgent): Array<() => void> {
    const offs: Array<() => void> = [];
    for (const name of AGENT_EVENT_LIST) {
      offs.push(
        agent.on(name, (payload) =>
          // 全文件唯一一处类型断言，理由是表与载荷同源：`name` 取自上面那张穷尽表，`payload` 由
          // `agent.on` 按同一个名字给出，拼出来的就是 `RuntimeFact` 里对应的那一支。编译器推不出
          // 「名字与载荷一一对应」这件事实，所以由这里说一次。
          this.broadcast({ type: name, sessionId, ...payload } as RuntimeFact),
        ),
      );
    }
    return offs;
  }

  /**
   * 把一条事实交给每一个订阅者。
   *
   * 这里**不 try/catch**：一个订阅者抛错不该连累别的订阅者、也不该打断这个执行体，而这件事的
   * 实现只有一处 —— 内核发事件那里（`EventBus.emit`）。在这里再包一层就是两份实现，而且哪一份
   * 先生效说不清。
   */
  private broadcast(fact: RuntimeFact): void {
    for (const listener of this.listeners) listener(fact);
  }

  /** 解掉一段会话的转发订阅（整组解，只解这一段会话） */
  private detach(sessionId: string): void {
    const offs = this.forwarders.get(sessionId);
    if (offs === undefined) return;
    this.forwarders.delete(sessionId);
    for (const off of offs) off();
  }

  /** 这一段此刻叫什么；库里已经没有这一段时退回身份本身（说得出是哪一段，不编一个名字） */
  private async labelOf(sessionId: string): Promise<string> {
    return (await this.ports.nameOf(sessionId)) ?? sessionId;
  }
}

/**
 * 装载这一刻唯一要修的一件：上个进程没写完的那几条。
 *
 * `pending` / `writing` 是「正在写」的中间态，写它们的那一次请求已经不在了；落到 `aborted`
 * 才归内核开头那两套归一策略管（保留半截还是丢掉）。其余一个字都不动 —— 修尾本来就是外循环
 * 开头那一步的事，这里再修一遍就是两份实现。
 *
 * 给的是新对象：交进来的那一批是别人的（宿主从库里读出来的），就地改它等于替它改库。
 */
function recovered(history: readonly AgentNS.Message[]): AgentNS.Message[] {
  return history.map((message) =>
    message.status === AgentNS.MessageStatus.Pending ||
    message.status === AgentNS.MessageStatus.Writing
      ? { ...message, status: AgentNS.MessageStatus.Aborted }
      : message,
  );
}

/** 最近一条助手消息的正文摘要（`null` = 它还没说过话） */
function lastMessageOf(messages: readonly AgentNS.Message[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role !== AgentNS.Role.Assistant) continue;
    const text = plainText(message.content);
    if (text === undefined) continue;
    return text.length > EXCERPT_LIMIT ? `${text.slice(0, EXCERPT_LIMIT)}…` : text;
  }
  return null;
}

/** 一条内容的文字部分：字符串原样，段数组只取 `text` 段（图片与文件没有「说了什么」可言） */
function plainText(content: AgentNS.MessageContent | undefined): string | undefined {
  if (typeof content === "string") return content.trim() === "" ? undefined : content;
  if (content === undefined) return undefined;

  const text = content
    .filter((section): section is AgentNS.TextContentSection => section.type === "text")
    .map((section) => section.text)
    .join("\n");
  return text.trim() === "" ? undefined : text;
}
