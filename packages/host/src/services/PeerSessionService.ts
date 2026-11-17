/**
 * 平级会话服务 —— 一段对话里的模型**开另一段对话**，之后还能**接着跟它说话**、能**问它现在怎么样**。
 *
 * 对应技术方案 `.ai-zen/plans/20261115-peer-sessions.md`。本文件只做四件事：
 *
 * 1. **建**：按 `conversation.create` 同一条路开一段会话（草稿 → 落真行），拿到 conversationId
 *    就是 `sessionId`，把第一句交出去，**立刻返回**（不等它回答完 —— 等待就等于子代理，那已经
 *    存在了）。
 * 2. **记**：进程内 `Map<sessionId, label>` —— **只记可读名**。血缘、自动交接开关、深度、
 *    状态都不在这里：前两样是会话行上的列（v4：`lineage` / `autoHandoff`，重启也读得回来），
 *    深度由血缘推（父会话自己带血缘 = 它已经是第二层），状态一律现读执行者。进程内那份只剩
 *    「模型认得的那声名字」—— 它不需要落库（会话行上的 `name` 是另一个东西：那是人给这段
 *    会话起的名字）。
 * 3. **答状态**：{@link PeerSessionService.status} —— 它现在忙不忙**现读**（`chatRunner.state`），
 *    不存镜像，也没有「上一次跑成什么样」这种字段。
 * 4. **接着说话**：{@link PeerSessionService.send} —— 直接把一句内容交给执行者，**不看关系**：
 *    「能不能发」只有一条判据，就是目标在不在。
 *
 * ## 为什么只剩一个名字在进程内
 *
 * 从前这里存「谁开的、几层、什么时候开的」，那些都是**身份**，而身份只在进程里活着的后果是
 * 重启就大面积说假话（父会话找不到自己的孩子、子会话自己也不认得）。v4 把它们搬到会话行上：
 * 血缘是 `conversations.lineage`、自动交接开关是 `conversations.autoHandoff`、开启时刻就是
 * `createdAt`。「只限一层」不再看进程内记的深度，而是看**父会话自己有没有血缘**。
 *
 * 剩下没地方放的就是 `label`：它是模型在 `create_session` 里自己起的那个名字（模型记不住
 * UUID，`read_session_status` 靠它报「这是哪一段」），与会话行上那个给人看的 `name` 不是一回事。
 * 它不值得一列（重启之后退回 `name` 就行，那也是一句真话）。
 *
 * ## 「谁在调我」为什么靠 `bind`
 *
 * core 的 `Agent` 上没有 `conversationId`（那是宿主的财产），所以宿主在造出 agent 之后调
 * {@link PeerSessionService.bind} 记一笔 `WeakMap`（agent → conversationId），工具回调里用
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
import type { ConversationCreateParams, ConversationCreateResult } from "../wire/index.js";
import type { ConversationStatus } from "../wire/states.js";

/**
 * 创建子会话时额外带上「谁开的、自动交接开不开」：这两项**创建那一刻写死**，之后只跟着行。
 *
 * 它们是宿主内部的事实（`ConversationOriginInput`），不从客户端收：谁也不能从外面把一段会话
 * 认成「不是我建的」。
 */
type PeerSessionOriginInput = {
  /** 谁开的这段会话（父会话 id） */
  lineage: string;
  /** 自动交接开关的初值：兄弟会话默认开（撞线自己交班、不问） */
  autoHandoff: boolean;
};

/**
 * 子会话第一句的用户输入是谁推来的（core 在正文最前面那行注释里写的就是这个 `label`）。
 *
 * 形状是 core 的 `AgentNS.MessageSource` 判别结构：`kind: "agent"` 说的是「另一个 agent 推来的」，
 * `label` 是给人看的那个名字。宿主不拿字符串比来源。
 */
const SOURCE_FROM_PARENT: AgentNS.MessageSource = { kind: "agent", label: "父对话" };

/** `read_session_status` 里那条摘要的截断长度（**绝不给全量消息**，否则模型会拿它当上下文搬运） */
const STATUS_CHARS = 300;

/**
 * 每个**父对话**同时最多能有多少个平级会话在忙着。
 *
 * 超出了就是一条结构化拒绝 `too_many_peers`：让模型先等一批干完、或者把活分给更少的会话，
 * 比让它一口气开 20 段把端点和额度烧光要好。
 *
 * 判据是**现读**：`chatRunner.state(sessionId).status === "busy"`。这一层不记「谁在忙」，
 * 所以也不会与执行者那边漂。
 */
const MAX_RUNNING_PEERS = 4;

/** `postMessage` 正文注释里的来源：`会话「<调用者的名字>」`（拼注释归 core） */
function senderSource(name: string): AgentNS.MessageSource {
  return { kind: "agent", label: `会话「${name}」` };
}

/** 子会话的诞生：与 `conversation.create` 处理器同一条路（草稿 + 三级模型解析） */
export interface PeerSessionConversationCreator {
  /**
   * 开一段会话，并当场把「谁开的」（血缘）与自动交接开关的初值写进去 ——
   * 这两项是创建那一刻的身份，不在后面补。
   */
  create(
    params: ConversationCreateParams & PeerSessionOriginInput,
  ): Promise<ConversationCreateResult>;
  /**
   * 草稿落成库里那一行。
   *
   * 消息行、素材关系行都按 `conversationId` 挂外键，所以子会话收到第一句之前必须走这一道 ——
   * 与 `conversation.send` 里那一句同义。
   */
  ensurePersisted(conversationId: string): Promise<unknown>;
}

/** 执行者（`ChatRunner` 结构上满足）：本文件只用它的两个口 —— 投一句、现读一格 */
export interface PeerSessionRunner {
  /**
   * 把一条内容投给某段对话（**唯一**的投递入口）。
   *
   * 它自己判「对话在不在、agent 活不活」；`await` 的边界就是「已入队」，回执只有消息 id。
   * 目标不存在时按 `HostError` 抛（`not_found` / `conversation_dead`）。
   */
  deliver(
    conversationId: string,
    input: DeliveryInput,
  ): Promise<{ userMessageId: string }>;
  /** 现读：这一段此刻落在哪一格（忙 / 闲 / 暂停 / 死） */
  state(conversationId: string): { status: ConversationStatus };
}

/** 平级会话服务的依赖（窄接口：本文件不认识整个宿主） */
export interface PeerSessionServiceDeps {
  /**
   * 只读会话那一行：项目 / 助手 / 模型的口径来源、**名字**（`postMessage` 的来源名用它 ——
   * 来源名由宿主解析，不许调用方传）、**血缘**（判「只限一层」）、**开启时刻**（`startedAt`），
   * 外加「这段会话还在不在」。自动交接开关不在这里要：只有宿主那两个判定读它。
   */
  conversations: {
    get(
      id: string,
    ): Promise<{
      id: string;
      workspaceId: string;
      agentId: string;
      name: string;
      /** 谁开的这段会话；`null` = 用户建的（本文件用它判「只限一层」） */
      lineage: string | null;
      /** 开出来的时刻：`read_session_status` 的 `startedAt` 就是它（会话行上的事实） */
      createdAt: number;
    } | undefined>;
    /**
     * 谁由这段会话开的（血缘列反查）：并发限额要数「我手头有几个还忙着」。
     *
     * 从前这件事数的是进程内记录，重启即失；现在数的是库 —— 重启前后是同一批。
     */
    listByLineage(lineage: string): Promise<{ id: string }[]>;
  };
  /** 子会话的诞生 */
  conversationCreator: PeerSessionConversationCreator;
  /** 读子会话最后一条助手消息（主线消息，按 seq 升序） */
  messages: { listByConversation(conversationId: string): Promise<StoredMessage[]> };
  /** 执行者 */
  chatRunner: PeerSessionRunner;
}

/** 一条结构化拒绝（返回结果，不抛错：模型要能读懂并改变策略） */
function rejected(reason: PeerSessionRejectReason, hint: string): PeerSessionCreated {
  return { ok: false, reason, hint };
}

/**
 * 现读的那一格 → `read_session_status` 报的那一格：**逐格同名**，不翻译也不补格子。
 *
 * 两端都是闭集：宿主说 `busy` / `idle` / `paused` / `dead`，SDK 报的就是这四个；多出来的
 * `gone` 不是一格状态，而是「这段会话的会话行找不到了」（见 {@link status}）。
 *
 * 所以本文件没有 `failed`：失败是某一次回答上的事实（消息上的 `error` 与结束原因），不是
 * 一段对话此刻的状态；把「上一次失败了」挂在状态上，就会在它下一次好好回答时继续说假话。
 */
function statusOf(status: ConversationStatus): PeerSessionStatus["state"] {
  return status;
}

/** 一段消息里的纯文本（分段内容只取文本段，与自动命名同一个口径） */
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

/** 截断到上限（超了加一个省略号：读者要知道「后面还有」） */
function clip(text: string, limit: number): string {
  const trimmed = text.trim();
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed;
}

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
   * 上没有 `conversationId`，而工具只拿得到 `ctx.agent` —— 认领调用方就靠这一笔。
   */
  bind(agent: object, conversationId: string): void {
    this.identities.set(agent, conversationId);
  }

  /** 取某个 `sessionId` 的可读名（只给用例与排查看；业务读取走 {@link status}） */
  labelOf(sessionId: string): string | undefined {
    return this.labels.get(sessionId);
  }

  /**
   * 开一段平级会话：建会话 → 落真行 → 把第一句交出去 → **立刻**回 `{ sessionId, label }`。
   *
   * 三种失败是**结构化拒绝**（返回结果，不抛错）：调用方自己已经是平级会话（`depth_exceeded`，
   * 防无限分身）、这个父对话手头忙着 4 个平级会话（`too_many_peers`）、子会话三级解析拿不到
   * 模型（`model_unresolved`）。其余错误照抛 —— 那是接线或环境出了真问题，编一个「拒绝」给
   * 模型反而误导它。
   *
   * 这里**不挂任何「等它答完」的东西**：回答本身会以消息的形式出现，父对话要看就说一句
   * `postMessage`、或者自己接着干活。等待等于子代理，而那已经存在了。
   */
  async create(input: PeerSessionCreateInput): Promise<PeerSessionCreated> {
    const parentConversationId = this.identityOf(input.caller);
    const parent = await this.deps.conversations.get(parentConversationId);
    if (!parent) {
      // 父对话已经不在了（被删）：没有可继承的项目 / 助手，也没有可回的地方
      throw new HostError("not_found", {
        params: { entity: "conversation" },
        detail: { conversationId: parentConversationId, reason: "parent_gone" },
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

    // 2. 并发限额：这个父对话手头忙着的平级会话满了就不建（在 `create` 之前判：拒绝不许留下
    //    副作用 —— 一段建出来又没人管的会话比一条拒绝糟得多）。
    //    数的是血缘列反查出来的那批（库里的事实），忙不忙现读执行者。
    if ((await this.busyPeersOf(parentConversationId)) >= MAX_RUNNING_PEERS) {
      return rejected(
        "too_many_peers",
        `This conversation already has ${MAX_RUNNING_PEERS} peer sessions busy at the same ` +
          "time. Give the work to fewer sessions instead of opening another one.",
      );
    }

    // 3. 子会话：与 `conversation.create` 同一条路（`agentId` 缺省 = 父对话那一个，模型走三级解析）。
    //    血缘与自动交接开关在这里给：谁开的这段会话 + 默认开（撞线自己交班、不问）——
    //    这两项在创建那一刻写进会话行，之后不再从进程内读。
    let created: ConversationCreateResult;
    try {
      created = await this.deps.conversationCreator.create({
        workspaceId: parent.workspaceId,
        agentId: input.agentId ?? parent.agentId,
        ...(input.modelId === undefined ? {} : { modelId: input.modelId }),
        lineage: parentConversationId,
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

    const sessionId = created.conversation.id;
    // 4. 草稿落成真行：消息要挂在这段对话上（外键）
    await this.deps.conversationCreator.ensurePersisted(sessionId);

    // 5. 先记名字：投出去之后马上就有工具回执，名字必须在那一刻之前就在（`read_session_status`
    //    可能紧跟着到达）。血缘已经在第 3 步落库了，这里只留可读名。
    const label = input.label ?? this.nextLabel();
    this.labels.set(sessionId, label);

    // 6. 把第一句交出去（受理即回）：来源写「父对话」，正文最前面那行注释由 core 加。
    //
    //    `mayStart: true` 是因为这里就是创建者：**刚建出来的对话由创建者装上驱动者**。
    //    执行者的判据一个字不改 —— 「投给已存在但没有驱动者的对话」仍然是 `conversation_dead`，
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
   * 问一段平级会话现在怎么样。
   *
   * 查不到就是 `gone`（**不抛错**：模型不该因为查了一段已经不存在的会话而断掉它手上的活）：
   * 判据只剩一条 —— **会话行在不在**（被用户删了就不在）。
   *
   * 从前这里还要求「进程内有它的记录」：那时血缘只在进程里，重启之后连自己开过哪一段都认不出。
   * 现在血缘在会话行上（`lineage`），重启前后一段会话是不是兄弟会话是库里的事实，所以这里不再
   * 看进程内那张表 —— 它只提供可读名，没有就退回行上的 `name`（那也是一句真话）。
   *
   * 那一格**现读**（不存镜像），再加个可读名字与最后一条助手消息的截断摘要
   * （~300 字，绝不给全量）。
   */
  async status(input: { caller: Agent; sessionId: string }): Promise<PeerSessionStatus> {
    const row = await this.deps.conversations.get(input.sessionId);
    if (!row) return { state: "gone" };

    const lastMessage = clip(await this.lastAssistantText(row.id), STATUS_CHARS);
    return {
      state: statusOf(this.deps.chatRunner.state(input.sessionId).status),
      label: this.labels.get(row.id) ?? row.name,
      // 开启时刻就是会话行上的创建时间（不再由进程内记一笔）
      startedAt: new Date(row.createdAt).toISOString(),
      ...(lastMessage.length > 0 ? { lastMessage } : {}),
    };
  }

  /**
   * 跟一段平级会话**接着说话**（`postMessage`）。
   *
   * 只有一件事要做：`deliver`。**不看关系** —— 谁都能给谁说话（投递不看关系是整套模型的
   * 一条硬规矩）；「目标不在」是唯一会失败的情形，而那是 `HostError`（`not_found` /
   * `conversation_dead`），不是一条「拒绝」返回值。
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
    const callerConversationId = this.identityOf(input.caller);
    const source = senderSource(await this.nameOf(callerConversationId));
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
  private async nameOf(conversationId: string): Promise<string> {
    const label = this.labels.get(conversationId);
    if (label !== undefined) return label;
    const row = await this.deps.conversations.get(conversationId);
    if (!row) {
      // 会话行都没了：这条消息没有可信的署名（编一个名字出来只会让目标误会来源）
      throw new HostError("not_found", {
        params: { entity: "conversation" },
        detail: { conversationId, reason: "caller_gone" },
      });
    }
    return row.name;
  }

  /**
   * 这个父对话手头**忙着**的平级会话有几个（限额的判据：先按血缘列反查出那批，再现读执行者）。
   *
   * 「谁是我的孩子」不再数进程内记录：血缘落库之后它是库里的事实，重启也不丢。
   */
  private async busyPeersOf(parentConversationId: string): Promise<number> {
    const children = await this.deps.conversations.listByLineage(parentConversationId);
    let count = 0;
    for (const child of children) {
      if (this.deps.chatRunner.state(child.id).status === "busy") count += 1;
    }
    return count;
  }

  /** 调用方是哪段会话的（没登记过就是接线漏了：编一个会话 id 出来只会更糟） */
  private identityOf(caller: Agent): string {
    const conversationId = this.identities.get(caller);
    if (!conversationId) {
      throw new Error(
        "Cannot reach a peer session: this agent is not bound to any conversation " +
          "(the host must call PeerSessionService.bind(agent, conversationId) when it builds one)",
      );
    }
    return conversationId;
  }

  private nextLabel(): string {
    this.labelSeq += 1;
    return `会话 ${this.labelSeq}`;
  }
  private async lastAssistantText(conversationId: string): Promise<string> {
    const rows = await this.deps.messages.listByConversation(conversationId);
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const row = rows[index]!;
      if (row.role !== AgentNS.Role.Assistant) continue;
      const text = textOf(row.content);
      if (text.trim().length > 0) return text;
    }
    return "";
  }
}

/**
 * 这次失败是不是「三级解析拿不到模型」。
 *
 * 判据是 `ConversationService.create` 的两条模型失败：解析不出来与解析出的模型不在配置里，
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
