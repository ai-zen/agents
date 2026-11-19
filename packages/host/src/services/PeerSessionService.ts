/**
 * 平级会话服务 —— 一段会话里的模型**开另一段会话**，之后还能**接着跟它说话**、能**问它现在怎么样**。
 *
 * 对应技术方案 `.ai-zen/plans/20261115-peer-sessions.md`。本文件只做四件事：
 *
 * 1. **建**：按 `session.create` 同一条路开一段会话（草稿 → 落真行），拿到 sessionId
 *    就是 `sessionId`，把第一句交出去，**立刻返回**（不等它回答完 —— 等待就等于子代理，那已经
 *    存在了）。
 * 2. **记**：进程内 `Map<sessionId, label>` —— **只记可读名**。血缘、自动交接开关、深度、
 *    状态都不在这里：前两样是会话行上的列（v4：`lineage` / `autoHandoff`，重启也读得回来），
 *    深度由血缘推（父会话自己带血缘 = 它已经是第二层），状态一律现读执行者。进程内那份只剩
 *    「模型认得的那声名字」—— 它不需要落库（会话行上的 `name` 是另一个东西：那是人给这段
 *    会话起的名字）。
 * 3. **答状态**：{@link PeerSessionService.status} —— 它现在忙不忙**现读**（`chatRunner.state`），
 *    外加**最近一句说了什么**（`agent.messages` 里最后那条助手消息的正文，截断到 300 字）；
 *    不存镜像，也没有「上一次跑成什么样」这种字段，更不把消息数组交出去。
 * 4. **接着说话**：{@link PeerSessionService.send} —— 直接把一句内容交给执行者，**不看关系**：
 *    「能不能发」只有一条判据，就是目标在不在。
 *
 * ## 为什么只剩一个名字在进程内
 *
 * 从前这里存「谁开的、几层、什么时候开的」，那些都是**身份**，而身份只在进程里活着的后果是
 * 重启就大面积说假话（开它的那段会话找不到它，它自己也不认得是谁开的）。v4 把它们搬到会话行上：
 * 血缘是 `sessions.lineage`、自动交接开关是 `sessions.autoHandoff`、开启时刻就是
 * `createdAt`。「只限一层」不再看进程内记的深度，而是看**父会话自己有没有血缘**。
 *
 * 剩下没地方放的就是 `label`：它是模型在 `create_session` 里自己起的那个名字（模型记不住
 * UUID，`read_session_status` 靠它报「这是哪一段」），与会话行上那个给人看的 `name` 不是一回事。
 * 它不值得一列（重启之后退回 `name` 就行，那也是一句真话）。
 *
 * ## 「谁在调我」为什么靠 `bind`
 *
 * core 的 `Agent` 上没有 `sessionId`（那是宿主的财产），所以宿主在造出 agent 之后调
 * {@link PeerSessionService.bind} 记一笔 `WeakMap`（agent → sessionId），工具回调里用
 * `ctx.agent` 认领调用方。**不给 core 的 `Agent` 加字段**：那是另一个包的类型，而且是
 * 「用完即弃」的对象，宿主侧记一笔就够，也不会泄漏（WeakMap 跟着 agent 一起回收）。
 *
 * ## 投递不在这里判
 *
 * 见 {@link PeerSessionService.send}：一句 `chatRunner.deliver(...)`，收下了就回 `{ ok }`。
 * 「目标在不在」「它忙不忙」都不是本文件的事 —— 忙不是拒绝的理由（队列本来就收），而不在
 * 那条真错误由执行者按 `HostError` 抛出来。
 */

import { AgentNS } from "@ai-zen/agents-core";
import type { Agent } from "@ai-zen/agents-core";
import type {
  PeerSessionCreateInput,
  PeerSessionCreated,
  PeerSessionPort,
  PeerSessionRejectReason,
  PeerSessionSendInput,
  PeerSessionSent,
  PeerSessionStatus,
} from "@ai-zen/agents-sdk";

import type { DeliveryInput } from "../runtime/ChatRunner.js";
import type { StoredMessage } from "../storage/types.js";
import { HostError } from "../wire/errors.js";
import type { SessionCreateParams, SessionCreateResult } from "../wire/index.js";
import type { SessionPresence } from "../wire/states.js";

/**
 * 创建平级会话时额外带上「谁开的、自动交接开不开」：这两项**创建那一刻写死**，之后只跟着行。
 *
 * 它们是宿主内部的事实（`SessionOriginInput`），不从客户端收：谁也不能从外面把一段会话
 * 认成「不是我建的」。
 */
type PeerSessionOriginInput = {
  /** 谁开的这段会话（父会话 id） */
  lineage: string;
  /** 自动交接开关的初值：平级会话默认开（撞线自己交班、不问） */
  autoHandoff: boolean;
};

/**
 * 平级会话的第一句用户输入是谁推来的（core 在正文最前面那行注释里写的就是这个 `label`）。
 *
 * 形状是 core 的 `AgentNS.MessageSource` 判别结构：`kind: "agent"` 说的是「另一个 agent 推来的」，
 * `label` 是给人看的那个名字。宿主不拿字符串比来源。
 */
const SOURCE_FROM_PARENT: AgentNS.MessageSource = { kind: "agent", label: "父会话" };

/**
 * `read_session_status` 里那条摘要的截断长度。
 *
 * **绝不给全量消息**：需求只要「最近一句说了什么（一小段摘要）」（`PRD.md` 2.3 / 4.6、
 * `PLAN.md` 10.2）。300 字够模型认出「它说到哪了」，又不至于把对方的上下文搬过来烧 token。
 */
const STATUS_CHARS = 300;

/**
 * 每个**父会话**同时最多能有多少个平级会话在忙着。
 *
 * 超出了就是一条结构化拒绝 `too_many_peers`：让模型先等一批干完、或者把活分给更少的会话，
 * 比让它一口气开 20 段把端点和额度烧光要好。
 *
 * 判据是**现读**：`chatRunner.state(sessionId).status === "working"`。这一层不记「谁在忙」，
 * 所以也不会与执行者那边漂。
 */
const MAX_RUNNING_PEERS = 4;

/** `post_message` 正文注释里的来源：`会话「<调用者的名字>」`（拼注释归 core） */
function senderSource(name: string): AgentNS.MessageSource {
  return { kind: "agent", label: `会话「${name}」` };
}

/** 一条消息里的纯文本（分段内容只取文本段，与自动命名同一个口径） */
function textOf(content: AgentNS.MessageContent | null | undefined): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((section) => ("text" in section && typeof section.text === "string" ? section.text : ""))
      .filter((text) => text.length > 0)
      .join("\n");
  }
  return "";
}

/**
 * 最近一条**助手**消息的正文（没有就是空串）。
 *
 * 从**内存里的 `agent.messages`** 里倒着找（状态是现读，摘要也一样：不查库、不另存一份）。
 * 只找助手消息：用户说的话是「谁让它干的」，不是「它最近说了什么」。正文是空白的那些
 * （只有工具调用、或者还在写的空壳）跳过。
 */
function lastAssistantText(messages: AgentNS.Message[] | null): string {
  if (messages === null) return "";
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role !== AgentNS.Role.Assistant) continue;
    const text = textOf(message.content);
    if (text.trim().length > 0) return text;
  }
  return "";
}

/** 截断到上限（超了加一个省略号：读者要知道「后面还有」）；空白就是 `null` */
function clip(text: string, limit: number): string | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed;
}

/** 平级会话的诞生：与 `session.create` 处理器同一条路（草稿 + 三级模型解析） */
export interface PeerSessionSessionCreator {
  /**
   * 开一段会话，并当场把「谁开的」（血缘）与自动交接开关的初值写进去 ——
   * 这两项是创建那一刻的身份，不在后面补。
   */
  create(
    params: SessionCreateParams & PeerSessionOriginInput,
  ): Promise<SessionCreateResult>;
  /**
   * 草稿落成库里那一行。
   *
   * 消息行、素材关系行都按 `sessionId` 挂外键，所以平级会话收到第一句之前必须走这一道 ——
   * 与 `session.send` 里那一句同义。
   */
  ensurePersisted(sessionId: string): Promise<unknown>;
}

/** 执行者（`ChatRunner` 结构上满足）：本文件只用它的两个口 —— 投一句、现读一格 */
export interface PeerSessionRunner {
  /**
   * 把一条内容投给某段会话（**唯一**的投递入口）。
   *
   * 它自己判「会话在不在、agent 活不活」；`await` 的边界就是「已入队」，回执只有消息 id。
   * 目标不存在时按 `HostError` 抛（`not_found` / `session_dead`）。
   */
  deliver(
    sessionId: string,
    input: DeliveryInput,
  ): Promise<{ userMessageId: string }>;
  /**
   * 现读：这一段此刻那**四件事**（忙闲 / 输入闸 / 输出闸 / 死活）。
   *
   * 与 `ChatRunner.state` 同一个口（结构上直接满足）：字段就是那四件事，不另做一份投影。
   */
  state(sessionId: string): SessionPresence;
  /**
   * 这一段此刻**在内存里的**消息 —— 就是 `agent.messages` 本身（`ChatRunner.messagesOf` 结构上
   * 满足）：活着读内存，没有 agent 就是 `null`（那时也就不可能有人「刚说过一句」）。
   *
   * 摘要走这一口而不走 `deps.messages`：状态与摘要是同一刻的同一段，两者必须同源。
   */
  messagesOf(sessionId: string): AgentNS.Message[] | null;
}

/** 平级会话服务的依赖（窄接口：本文件不认识整个宿主） */
export interface PeerSessionServiceDeps {
  /**
   * 只读会话那一行：项目 / 助手 / 模型的口径来源、**名字**（`post_message` 的来源名用它 ——
   * 来源名由宿主解析，不许调用方传）、**血缘**（判「只限一层」）、**开启时刻**（`startedAt`），
   * 外加「这段会话还在不在」。自动交接开关不在这里要：只有宿主那两个判定读它。
   */
  sessions: {
    get(
      id: string,
    ): Promise<{
      id: string;
      workspaceId: string;
      agentId: string;
      name: string;
      /** 谁开的这段会话；`null` = 用户建的（本文件用它判「只限一层」） */
      lineage: string | null;
      /** 开出来的时刻（会话行上的事实；`read_session_status` 不报这一格 —— 需求里没有它） */
      createdAt: number;
    } | undefined>;
    /**
     * 谁由这段会话开的（血缘列反查）：并发限额要数「我手头有几个还忙着」。
     *
     * 从前这件事数的是进程内记录，重启即失；现在数的是库 —— 重启前后是同一批。
     */
    listByLineage(lineage: string): Promise<{ id: string }[]>;
  };
  /** 平级会话的诞生 */
  sessionCreator: PeerSessionSessionCreator;
  /**
   * 消息仓储。
   *
   * `read_session_status` 的摘要那一格**不从库读**：它要的是「这一段此刻说到哪了」，那是活
   * 对象身上的事实（`chatRunner.messagesOf` 交回的 `agent.messages`，见 {@link PeerSessionRunner}）。
   * 查库会把两件事搞错 —— 写库是异步的（刚说的那句话可能还没落行），而且状态与摘要会从
   * 「同一刻的同一段」变成两个来源。接线照旧给着，清它归后面那一批收零调用符号。
   */
  messages: { listBySession(sessionId: string): Promise<StoredMessage[]> };
  /** 执行者 */
  chatRunner: PeerSessionRunner;
}

/** 一条结构化拒绝（返回结果，不抛错：模型要能读懂并改变策略） */
function rejected(reason: PeerSessionRejectReason, hint: string): PeerSessionCreated {
  return { ok: false, reason, hint };
}

/**
 * 宿主的**四件事** → SDK 的 `read_session_status` 报的那一格（**过渡投影，不是第二份事实**）。
 *
 * 宿主这一侧四件事已经各占一格（`PRD.md` 4.4），SDK 那个面向模型的工具也按同一口径报：
 * 忙不忙（`status`）+ 死活（`alive`）。**不再有投影**：以前这里把四件事压回一格四词，
 * 就是因为 SDK 当时只收那一格；现在两边同名同值，直接端过去。
 *
 * 两道闸不对平级会话报（`PRD.md` 4.6 只要「忙不忙 + 最近一句摘要」）。
 *
 * 找不到那一段不是第五种情形：它是判别式的另一支（`{ found: false, status: null }`）。
 *
 * 所以本文件没有 `failed`：失败是某一次回答上的事实（消息上的 `error` 与结束原因），不是
 * 一段会话此刻的状态；把「上一次失败了」挂在状态上，就会在它下一次好好回答时继续说假话。
 */

export class PeerSessionService implements PeerSessionPort {
  /**
   * 进程内只剩「可读名」：sessionId → 模型在 `create_session` 里起的那声名字。
   *
   * 血缘、开关、状态、深度都不在这里（它们在会话行上或由执行者现读，见文件头）。重启之后这
   * 张表是空的，`label` 退回会话行上的 `name` —— 少了一个模型起的名字，但每一句都是真的。
   */
  private readonly labels = new Map<string, string>();
  /**
   * 「这个 agent 是哪段会话的」—— 宿主在造出 agent 之后登记（见 {@link bind}）。
   *
   * 键用 `object` 而不是 `Agent`：工厂那一侧拿到的是宿主自己的 `ChatAgent` 表面（测试里甚至
   * 是替身），而工具那一侧给的是 core 的 `Agent`。两者是同一个对象，能当 `WeakMap` 的键就行。
   */
  private readonly identities = new WeakMap<object, string>();
  /** 缺省名字的序号（`会话 1` / `会话 2` …） */
  private labelSeq = 0;

  private readonly deps: PeerSessionServiceDeps;

  constructor(deps: PeerSessionServiceDeps) {
    this.deps = deps;
  }

  /**
   * 登记「这个 agent 是哪段会话的」。
   *
   * 由 agent 工厂在造出 agent 之后调用（`app.ts` 的 `defaultAgentFactory`）：core 的 `Agent`
   * 上没有 `sessionId`，而工具只拿得到 `ctx.agent` —— 认领调用方就靠这一笔。
   */
  bind(agent: object, sessionId: string): void {
    this.identities.set(agent, sessionId);
  }

  /** 取某个 `sessionId` 的可读名（只给用例与排查看；业务读取走 {@link status}） */
  labelOf(sessionId: string): string | undefined {
    return this.labels.get(sessionId);
  }

  /**
   * 开一段平级会话：建会话 → 落真行 → 把第一句交出去 → **立刻**回 `{ sessionId, label }`。
   *
   * 三种失败是**结构化拒绝**（返回结果，不抛错）：调用方自己已经是平级会话（`depth_exceeded`，
   * 防无限分身）、这个父会话手头忙着 4 个平级会话（`too_many_peers`）、平级会话三级解析拿不到
   * 模型（`model_unresolved`）。其余错误照抛 —— 那是接线或环境出了真问题，编一个「拒绝」给
   * 模型反而误导它。
   *
   * 这里**不挂任何「等它答完」的东西**：回答本身会以消息的形式出现，父会话要看就说一句
   * `post_message`、或者自己接着干活。等待等于子代理，而那已经存在了。
   */
  async create(input: PeerSessionCreateInput): Promise<PeerSessionCreated> {
    const parentSessionId = this.identityOf(input.caller);
    const parent = await this.deps.sessions.get(parentSessionId);
    if (!parent) {
      // 父会话已经不在了（被删）：没有可继承的项目 / 助手，也没有可回的地方
      throw new HostError("not_found", {
        params: { entity: "session" },
        detail: { sessionId: parentSessionId, reason: "parent_gone" },
      });
    }

    // 1. 深度守卫（只有一层）：一个平级会话不许再开平级会话。
    //
    //    判据是**父会话自己的血缘列**（不是进程内记的深度）：它自己就是别人开的，就不能再开。
    //    重启之后这条判据照样成立 —— 这是把深度从记录搬到列上最要紧的一条（PRD 1.3）。
    if (parent.lineage !== null) {
      return rejected(
        "depth_exceeded",
        "This conversation is itself a peer session, and peer sessions cannot open further peer " +
          "sessions (one level only). Do the work here instead, or report back and let the " +
          "conversation that started this one spawn it.",
      );
    }

    // 2. 并发限额：这个父会话手头忙着的平级会话满了就不建（在 `create` 之前判：拒绝不许留下
    //    副作用 —— 一段建出来又没人管的会话比一条拒绝糟得多）。
    //    数的是血缘列反查出来的那批（库里的事实），忙不忙现读执行者。
    if ((await this.busyPeersOf(parentSessionId)) >= MAX_RUNNING_PEERS) {
      return rejected(
        "too_many_peers",
        `This conversation already has ${MAX_RUNNING_PEERS} peer sessions busy at the same ` +
          "time. Give the work to fewer sessions instead of opening another one.",
      );
    }

    // 3. 平级会话：与 `session.create` 同一条路（`agentId` 缺省 = 父会话那一个，模型走三级解析）。
    //    血缘与自动交接开关在这里给：谁开的这段会话 + 默认开（撞线自己交班、不问）——
    //    这两项在创建那一刻写进会话行，之后不再从进程内读。
    let created: SessionCreateResult;
    try {
      created = await this.deps.sessionCreator.create({
        workspaceId: parent.workspaceId,
        agentId: input.agentId ?? parent.agentId,
        ...(input.modelId === undefined ? {} : { modelId: input.modelId }),
        lineage: parentSessionId,
        autoHandoff: true,
      });
    } catch (error) {
      if (isModelUnresolved(error)) {
        return rejected(
          "model_unresolved",
          "No model could be resolved for that peer session (no session override, no modelId on " +
            "the agent definition, no global default model). Pass `modelId`, or pass an `agentId` " +
            "that has a model bound.",
        );
      }
      throw error;
    }

    const sessionId = created.session.id;
    // 4. 草稿落成真行：消息要挂在这段会话上（外键）
    await this.deps.sessionCreator.ensurePersisted(sessionId);

    // 5. 先记名字：投出去之后马上就有工具回执，名字必须在那一刻之前就在（`read_session_status`
    //    可能紧跟着到达）。血缘已经在第 3 步落库了，这里只留可读名。
    const label = input.label ?? this.nextLabel();
    this.labels.set(sessionId, label);

    // 6. 把第一句交出去（受理即回）：来源写「父会话」，正文最前面那行注释由 core 加。
    //
    //    `mayStart: true` 是因为这里就是创建者：**刚建出来的会话由创建者装上 agent**。
    //    执行者的判据一个字不改 —— 「投给已存在但没有 agent 的会话」仍然是 `session_dead`，
    //    那条判据是这套模型的一部分。
    await this.deps.chatRunner.deliver(sessionId, {
      content: input.prompt,
      source: SOURCE_FROM_PARENT,
      mayStart: true,
    });

    // 7. 就这么回，不等它答完
    return { ok: true, sessionId, label };
  }

  /**
   * 问一段平级会话现在怎么样 —— **只答两件事：忙不忙 + 最近一句说了什么**（需求原话，`PRD.md`
   * 4.6 / `PLAN.md` 10.2）。
   *
   * 找不到就是判别式的另一支（`{ found: false, status: null }`，**不抛错**：模型不该因为查了一段
   * 已经不存在的会话而断掉它手上的活）：判据只剩一条 —— **会话行在不在**（被用户删了就不在）。
   *
   * 从前这里还要求「进程内有它的记录」：那时血缘只在进程里，重启之后连自己开过哪一段都认不出。
   * 现在血缘在会话行上（`lineage`），重启前后一段会话是不是平级会话是库里的事实，所以这里不再
   * 看进程内那张表 —— 它只提供可读名，没有就退回行上的 `name`（那也是一句真话）。
   *
   * 三格全**现读**，不存镜像：状态读执行者那一格，摘要读那一段 `agent.messages` 里最后一条
   * 助手消息的正文（截断到 300 字）。**不给消息数组、不给条数、不给历史** —— 给了就等于把对方
   * 的上下文搬过来，token 会炸（`PRD.md` 2.3）；也**没有** `startedAt`：需求里没有这一格。
   */
  async status(input: { caller: Agent; sessionId: string }): Promise<PeerSessionStatus> {
    const row = await this.deps.sessions.get(input.sessionId);
    // 找不到 = 判别式的另一支：`status: null`（那些格都是活对象身上的事实，找不到就没有对象可读）
    if (!row) return { found: false, status: null };

    // 摘要从内存里取（不查库）：就是那一段自己的 `agent.messages`，与状态同一刻、同一来源
    const lastMessage = clip(
      lastAssistantText(this.deps.chatRunner.messagesOf(input.sessionId)),
      STATUS_CHARS,
    );

    const presence = this.deps.chatRunner.state(input.sessionId);
    return {
      found: true,
      status: presence.status,
      alive: presence.alive,
      label: this.labels.get(row.id) ?? row.name,
      lastMessage,
    };
  }

  /**
   * 跟一段平级会话**接着说话**（`post_message`）。
   *
   * 只有一件事要做：`deliver`。**不看关系** —— 谁都能给谁说话（投递不看关系是整套模型的
   * 一条硬规矩）；「目标不在」是唯一会失败的情形，而那是 `HostError`（`not_found` /
   * `session_dead`），不是一条「拒绝」返回值。
   *
   * 回执只有「收下了」（`{ ok: true }`）：它忙不忙、什么时候取件、取走之后做什么，都不是
   * 投递这一刻能定下的事实 —— 本工具从不等结果，也不回状态。
   *
   * ## 重启之后仍然认得它
   *
   * 血缘在会话行上（`lineage`），不在进程内：重启之后这段会话还是别人开的那一段，用户照样
   * 能接管它、接着说话，`status` 也照旧答得出它现在在哪一格。进程内只剩那个可读名，重启
   * 之后退回行上的 `name`。
   */
  async send(input: PeerSessionSendInput): Promise<PeerSessionSent> {
    const callerSessionId = this.identityOf(input.caller);
    const source = senderSource(await this.nameOf(callerSessionId));
    await this.deps.chatRunner.deliver(input.sessionId, {
      content: input.content,
      source,
    });
    // 回执只有「收下了」：它忙不忙、什么时候取件都不是这一句话能定下的事实
    return { ok: true };
  }

  /**
   * 调用方的可读名字（正文注释里那一句「来自 会话「…」」）。
   *
   * 名字有两处来源：进程内那个 `label`（模型认识的那个名字，重启前开的那一段才有），
   * 否则用会话行上的 `name`（用户给这段会话起的名字）。两者都是**宿主的事实**，不进工具参数。
   */
  private async nameOf(sessionId: string): Promise<string> {
    const label = this.labels.get(sessionId);
    if (label !== undefined) return label;
    const row = await this.deps.sessions.get(sessionId);
    if (!row) {
      // 会话行都没了：这条消息没有可信的署名（编一个名字出来只会让目标误会来源）
      throw new HostError("not_found", {
        params: { entity: "session" },
        detail: { sessionId, reason: "caller_gone" },
      });
    }
    return row.name;
  }

  /**
   * 这个父会话手头**忙着**的平级会话有几个（限额的判据：先按血缘列反查出那批，再现读执行者）。
   *
   * 「谁是我的孩子」不再数进程内记录：血缘落库之后它是库里的事实，重启也不丢。
   */
  private async busyPeersOf(parentSessionId: string): Promise<number> {
    const children = await this.deps.sessions.listByLineage(parentSessionId);
    let count = 0;
    for (const child of children) {
      // 「忙」只看忙闲那一格：输出闸关着不算忙（它手上确实没活），那时也不占并发名额
      if (this.deps.chatRunner.state(child.id).status === "working") count += 1;
    }
    return count;
  }

  /** 调用方是哪段会话的（没登记过就是接线漏了：编一个会话 id 出来只会更糟） */
  private identityOf(caller: Agent): string {
    const sessionId = this.identities.get(caller);
    if (!sessionId) {
      throw new Error(
        "Cannot reach a peer session: this agent is not bound to any conversation " +
          "(the host must call PeerSessionService.bind(agent, sessionId) when it builds one)",
      );
    }
    return sessionId;
  }

  private nextLabel(): string {
    this.labelSeq += 1;
    return `会话 ${this.labelSeq}`;
  }
}

/**
 * 这次失败是不是「三级解析拿不到模型」。
 *
 * 判据是 `SessionService.create` 的两条模型失败：解析不出来与解析出的模型不在配置里，
 * 它们都是 `config_invalid`（文案键 `error.modelUnresolved`）；点名要的模型不存在则是
 * `not_found` + `params.entity === "model"`。**只看码、不看文案**：文案会翻译。
 */
function isModelUnresolved(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  const params = (error as { params?: unknown }).params;
  if (code === "config_invalid") return true;
  return (
    code === "not_found" &&
    params !== null &&
    typeof params === "object" &&
    (params as { entity?: unknown }).entity === "model"
  );
}
