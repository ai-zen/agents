/**
 * 会话门面 `RemoteSessions` —— 把 `ServerClient.call("session.xxx", …)` 收成带类型的方法。
 *
 * ## 为什么它必须 100% 覆盖
 *
 * 覆盖不全的后果不是「少几个方法」，而是**有人绕过门面直接裸调协议**：桌面端就这么干了
 * （它的注释自己写了理由），于是「会话动作叫什么、参数怎么拼」在两个地方各写一遍，
 * 协议一改名就得改两处、还只改一处也能编译通过。所以门面的方法集合必须**等于**方法表
 * 的 key 集合 —— 少一条编译不过，多一条也编译不过（用例见 `facade/coverage.test-d.ts`）。
 *
 * ## 为什么是 28 条（`SessionMethod` 21 + `WorkspaceMethod` 6 + `ContentMethod` 1）
 *
 * 会话是工作区的下级对象，客户端做事时两者总是成对出现（列清单要工作区 id、开会话要
 * 工作区路径、改名要指明是哪个工作区的存档）。分成两个对象的话，每次调用点都要同时持有
 * 两个引用，而「哪一条属于哪一边」就成了每次都要重新判的事。
 *
 * `content.upload` 挂在这一边而不另开一个对象：它要的输入就是「哪一段会话」——端点与
 * 视觉能力跟着那段会话的模型走，所以调用点手里一定已经有会话 id。
 *
 * ## 方法名为什么不等于表的 key
 *
 * 表里是**线上名字**（`session.create` / `workspace.resolve`），门面里是**本地语义**
 * （`open` / `resolveWorkspace`）：`create` 与 `attach` 在客户端这一侧是同一个动作的两条
 * 分支（「开一段」/「接一段」），叫 `create` 会让人以为只能新建。差异只在本文件里，
 * 对应关系由类型级用例钉死（改一处名字而忘了改另一处 = 编译不过）。
 *
 * 它是**无状态**的薄封装（只持有连接），不缓存、不判活：连接的生死归 `ServerConnection`。
 */

import type {
  ContentUploadResult,
  HandoffMode,
  MessageContent,
  MigrationStrategy,
  ModelParams,
  SessionAnswerResult,
  SessionAttachResult,
  SessionCancelResult,
  SessionCloseResult,
  SessionCreateResult,
  SessionHandoffResult,
  SessionListResult,
  SessionLastResult,
  SessionMigrateResult,
  SessionModelParamsSetResult,
  SessionModelSetResult,
  SessionRemoveResult,
  SessionRenameResult,
  SessionRollbackResult,
  SessionSaveAsResult,
  SessionSaveResult,
  SessionSendResult,
  SessionSetAgentResult,
  SessionSnapshotResult,
  SubAgentSnapshotResult,
  WorkspaceFilesResult,
  WorkspaceListResult,
  WorkspaceRelocateResult,
  WorkspaceRemoveResult,
  WorkspaceRenameResult,
  WorkspaceResolveResult,
} from "@ai-zen/agents-server/protocol";
import type { ServerClient } from "../types.js";

/** 一批要换成内容块的字节（`content.upload` 的入参） */
export interface UploadContentInput {
  /** 原始字节（图片 / 文件）；长度由门面自己填进帧里，调用方不必再算一遍 */
  bytes: Uint8Array;
  /** MIME（`image/png` …）：决定走图片通道还是文件通道 */
  mime: string;
  /** 文件名：上传与 `file` 块都要它 */
  filename: string;
}

/** 开一个会话要多说几句，单独成类型，避免调用点各拼一份 */
export interface OpenSessionInput {
  /**
   * 工作目录绝对路径。**建议不给**：不给就用服务端自己的目录（那才是会话真正跑的地方）。
   * 给了也只是“我希望是这里”，路径仍由服务端规范化。
   */
  path?: string;
  agentId?: string;
  /** 续接已有存档时给出它的 id；不给则由服务端分配新 id */
  sessionId?: string;
  /**
   * 每轮收尾是否自动写存档（缺省 `true`）。`false` = 一次性调用：那段会话不属于工作区
   * 的历史，不进 `sessions/`、也不挪「本工作区上一轮会话」指针。
   *
   * 想留档只有一条路：显式 {@link RemoteSessions.save}（CLI 侧 `ai --save`）。
   */
  persist?: boolean;
}

export class RemoteSessions {
  constructor(private readonly client: ServerClient) {}

  // ==================== 工作区（`workspace.*`，6 条） ====================

  /**
   * 路径 → 工作区身份。
   *
   * 不给 `path` 就是在问「服务端自己的工作区在哪」—— 远程部署时这才是唯一有意义的问法：
   * 客户端把自己进程的当前工作目录送上去，等于让客户端替服务端决定会话跑在哪个目录。
   */
  async resolveWorkspace(path?: string): Promise<WorkspaceResolveResult> {
    return await this.client.call<WorkspaceResolveResult>(
      "workspace.resolve",
      path ? { path } : {},
    );
  }

  /** 工作区的文件清单（`@` 补全用；扫的是**服务端**磁盘） */
  async files(workspaceId: string): Promise<WorkspaceFilesResult> {
    return await this.client.call<WorkspaceFilesResult>("workspace.files", { workspaceId });
  }

  /**
   * 盘上**全部**工作区（带 `pathExists`）。
   *
   * 侧栏要用它：只看自己 cwd 那一个工作区的话，用户 `mv` 完目录就再也看不到旧工作区 ——
   * 而它（连同历史）还在盘上。顺序由服务端定死，客户端不必重排。
   */
  async listWorkspaces(): Promise<WorkspaceListResult> {
    return await this.client.call<WorkspaceListResult>("workspace.list");
  }

  /** 改工作区显示名（**不动 id、不动 path**） */
  async renameWorkspace(workspaceId: string, title: string): Promise<WorkspaceRenameResult> {
    return await this.client.call<WorkspaceRenameResult>("workspace.rename", {
      workspaceId,
      title,
    });
  }

  /** 删一个工作区 —— **连它的全部会话一起**（幂等：本来就没有 → `removed:false`） */
  async removeWorkspace(workspaceId: string): Promise<WorkspaceRemoveResult> {
    return await this.client.call<WorkspaceRemoveResult>("workspace.remove", {
      workspaceId,
    });
  }

  /**
   * 把工作区记录的 path 改到新目录（**id 不变**）。
   *
   * 这是「目录改名之后历史不丢」的入口：`mv` 之后调用方拿旧 id 调它，之后对新路径
   * `resolve` 就会回到同一个 id。
   */
  async relocateWorkspace(workspaceId: string, path: string): Promise<WorkspaceRelocateResult> {
    return await this.client.call<WorkspaceRelocateResult>("workspace.relocate", {
      workspaceId,
      path,
    });
  }

  // ==================== 会话生命周期（`session.*`，21 条） ====================

  /**
   * 开（或续接）一个会话。
   *
   * 工作区在这里解析（客户端只递「我希望是这里」），路径仍由服务端规范化 —— 这条链上
   * 只有一个会漂的副本就够多了，不必再多一个。
   */
  async open(input: OpenSessionInput): Promise<SessionCreateResult> {
    const workspace = await this.resolveWorkspace(input.path);
    return await this.client.call<SessionCreateResult>("session.create", {
      workspaceId: workspace.workspaceId,
      // 服务端能自己反查路径：客户端只在**它确实知道**时才递上去
      ...(input.path ? { path: input.path } : {}),
      ...(input.agentId ? { agentId: input.agentId } : {}),
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.persist !== undefined ? { persist: input.persist } : {}),
    });
  }

  /**
   * 接上一段**已经存在**的会话。
   *
   * 与 `open()` 的区别就是「要不要开新的」：`open()` 对活着的 id 会被服务端拒掉
   * （`session-exists`，不静默顶掉正在跑的会话），而「接着上次」/「`/load` 选一段」
   * 要的恰恰是接上那段 —— 它可能还在服务端内存里活着（上次只是断开了连接）。
   * 活着就接、盘上有就装回来，都没有则服务端回 `session-missing`。
   */
  async attach(input: {
    workspaceId: string;
    sessionId: string;
    /** 服务端已知这个工作区时可以不给 */
    path?: string;
    agentId?: string;
  }): Promise<SessionAttachResult> {
    return await this.client.call<SessionAttachResult>("session.attach", input);
  }

  /**
   * 开始一轮；返回 `turnId`，过程与结果都走事件。
   *
   * `content` 可以是纯文本，也可以是「文本 + 内容块」的数组 —— 服务端不解释它，原样交给
   * Agent。但**一个文件 / 一张图该以什么形式进去**不是客户端决定的：那是
   * {@link uploadContent} 的事（端点能力、上传还是内联、文件归属，判据全在服务端）。
   */
  async send(sessionId: string, content: MessageContent): Promise<SessionSendResult> {
    return await this.client.call<SessionSendResult>("session.send", { sessionId, content });
  }

  /** 掐掉本轮（不销毁会话）：`cancelled:false` = 本来就没在跑（幂等） */
  async cancel(sessionId: string): Promise<SessionCancelResult> {
    return await this.client.call<SessionCancelResult>("session.cancel", { sessionId });
  }

  /**
   * 回答服务端提出的问题（目前只有自动迁移的「交接方式三选一」）。
   *
   * `choice: null` = 用户选「不交接」（跳过本次迁移）。返回 `answered: false` 表示**来晚了**
   * （超时 / 已答过 / 会话已收）—— 那不是错误，客户端把选择器收掉即可。
   */
  async answer(
    sessionId: string,
    questionId: string,
    choice: string | null,
  ): Promise<SessionAnswerResult> {
    return await this.client.call<SessionAnswerResult>("session.answer", {
      sessionId,
      questionId,
      choice,
    });
  }

  /**
   * 某个工作区的会话清单（盘上的存档 ∪ 内存里的活会话，一条不重，按 `updatedAt` 倒序）。
   *
   * `title` / `messageCount` / `live` 都在同一条里：侧栏一次拿全，不必自己拼两个来源。
   */
  async list(workspaceId: string): Promise<SessionListResult> {
    return await this.client.call<SessionListResult>("session.list", { workspaceId });
  }

  /** 改显示名（**不动 id**；与「另存为」`saveAs` 是两件事） */
  async rename(
    workspaceId: string,
    sessionId: string,
    title: string,
  ): Promise<SessionRenameResult> {
    return await this.client.call<SessionRenameResult>("session.rename", {
      workspaceId,
      sessionId,
      title,
    });
  }

  /** 删一段会话（物理删存档，幂等：本来就没有 → `removed:false`） */
  async remove(workspaceId: string, sessionId: string): Promise<SessionRemoveResult> {
    return await this.client.call<SessionRemoveResult>("session.remove", {
      workspaceId,
      sessionId,
    });
  }

  /** 某个工作区「上一轮会话」的指针（续接用；没有则 `null`） */
  async last(workspaceId: string): Promise<SessionLastResult> {
    return await this.client.call<SessionLastResult>("session.last", { workspaceId });
  }

  /** 撤回：从 `index` 起删掉并落盘；返回剩下的消息与被删的首条用户消息 */
  async rollback(sessionId: string, index: number): Promise<SessionRollbackResult> {
    return await this.client.call<SessionRollbackResult>("session.rollback", {
      sessionId,
      index,
    });
  }

  /** 整份快照：消息 / 阶段 / 轮次 / 用量 / 模型 */
  async snapshot(sessionId: string): Promise<SessionSnapshotResult> {
    return await this.client.call<SessionSnapshotResult>("session.snapshot", { sessionId });
  }

  /** 按磁盘上的新配置/定义重建 Agent（保留消息），返回重建后的快照 */
  async reload(sessionId: string): Promise<SessionSnapshotResult> {
    return await this.client.call<SessionSnapshotResult>("session.reload", { sessionId });
  }

  /**
   * 换 Agent：同一段对话换个 Agent 继续（服务端保留消息、更新 `agentId` 并落盘）。
   *
   * 返回快照：模型、消息与阈值都跟着变了，客户端拿它一次对齐屏幕。
   */
  async setAgent(sessionId: string, agentId: string): Promise<SessionSetAgentResult> {
    return await this.client.call<SessionSetAgentResult>("session.setAgent", {
      sessionId,
      agentId,
    });
  }

  /**
   * 换**这一段会话**的模型（`session.model.set`）：写存档的 `modelId` 并重建 Agent。
   *
   * 它与 `agent.model.set`（{@link RemoteConfig.agentSetModel}）的形状刻意一样、作用域刻意
   * 不同：那个改的是**全局的** Agent 定义（影响所有用它的会话），这个只改这一段 ——
   * 它们本来就属于两个门面，因为「作用对象是不是某一段会话」正是这两个联合的分界。
   */
  async modelSet(sessionId: string, modelId: string): Promise<SessionModelSetResult> {
    return await this.client.call<SessionModelSetResult>("session.model.set", {
      sessionId,
      modelId,
    });
  }

  /**
   * 改**这一段会话**的模型**参数**（`session.modelParams.set`）；`null` = 清掉这一层覆盖。
   *
   * 与 `modelSet` 分开：两者是同一级（会话级）的两份事实，但语义完全不同 ——「换模型」会
   * 连带清掉参数（新模型不一定接受旧参数），改参数不该动模型。合成一条就只能靠参数开关
   * 分叉，调用方得猜自己改的是哪一份。
   */
  async modelParamsSet(
    sessionId: string,
    modelParams: ModelParams | null,
  ): Promise<SessionModelParamsSetResult> {
    return await this.client.call<SessionModelParamsSetResult>("session.modelParams.set", {
      sessionId,
      modelParams,
    });
  }

  /**
   * 明确关闭一段会话（幂等：不在跑时回 `closed:false`，不当错误）。
   *
   * 它是「我不看这段了」的**唯一**显式表达（服务端在持有者消失后自己按宽限期收）：
   * 一次性调用（`ai "…"`）跑完就该让服务端当场把这段会话还回去；长连接上切会话
   * （`/new`、`/load`）也必须显式调它 —— 否则内存峰值随切换次数线性增长，直到宽限期才回落。
   */
  async close(sessionId: string): Promise<SessionCloseResult> {
    return await this.client.call<SessionCloseResult>("session.close", { sessionId });
  }

  /**
   * 落盘当前会话（缺省同时把它设为「上一轮会话」）。
   *
   * `setAsLast: false` 是一次性调用的归档（`ai --save`）：写档但不篡改续接指针 ——
   * 否则连着跑几条 `cat … | ai --save` 之后，下次 `ai` 会续接到最后一条管道结果上。
   */
  async save(sessionId: string, options: { setAsLast?: boolean } = {}): Promise<SessionSaveResult> {
    return await this.client.call<SessionSaveResult>("session.save", {
      sessionId,
      ...(options.setAsLast !== undefined ? { setAsLast: options.setAsLast } : {}),
    });
  }

  /**
   * 另存为指定 id（`/save <名字>`）：服务端写新档、删旧档，并**换掉活会话的键**。
   *
   * 返回值里的 `sessionId` 才是当前有效的那个 —— 与 `migrate` 同一个规矩。
   */
  async saveAs(sessionId: string, id: string): Promise<SessionSaveAsResult> {
    return await this.client.call<SessionSaveAsResult>("session.saveAs", { sessionId, id });
  }

  /**
   * 只产出交接文档（`/handoff`）：会话 id 不变、历史不动。
   *
   * 进度（`handoffWriting` / `handoffPath` / 降级）走 `session-notice`，流式正文走
   * `chunk` —— 这个方法可能要跑一两分钟，等回执期间界面靠事件渲染。
   */
  async handoff(sessionId: string, mode?: HandoffMode): Promise<SessionHandoffResult> {
    return await this.client.call<SessionHandoffResult>("session.handoff", {
      sessionId,
      ...(mode ? { mode } : {}),
    });
  }

  /**
   * 交接 + 开新会话（`/migrate`）：**返回的 `sessionId` 可能是新的**。
   *
   * `strategy` 缺省 `prune`（换 id）；`omit` 保持同一个 id。调用方必须用返回值里的那个 id，
   * 而不是自己手上那个 —— 旧 id 在服务端已经退场（`unknown-session`）。
   */
  async migrate(
    sessionId: string,
    mode?: HandoffMode,
    strategy?: MigrationStrategy,
  ): Promise<SessionMigrateResult> {
    return await this.client.call<SessionMigrateResult>("session.migrate", {
      sessionId,
      ...(mode ? { mode } : {}),
      ...(strategy ? { strategy } : {}),
    });
  }

  /**
   * 某个子 Agent 到目前为止的完整对话（Agent 栏目切过去时对齐用）。
   *
   * 子 Agent 只活在当前一轮：`session-turn-end` 之后服务端会丢弃它，这条调用会报
   * `sub-agent-missing` —— 那不是服务端出错，客户端该做的是把栏目收回去。
   */
  async subAgentSnapshot(sessionId: string, subAgentId: string): Promise<SubAgentSnapshotResult> {
    return await this.client.call<SubAgentSnapshotResult>("session.subAgent.snapshot", {
      sessionId,
      subAgentId,
    });
  }

  // ==================== 内容（`content.*`，1 条） ====================

  /**
   * 一批字节 → 一块能放进消息的内容（`text` / `image_url` / `file`）。
   *
   * 字节走帧后的二进制 payload（不 base64 塞回 JSON）；`bytes` 这个长度字段由这里从
   * `input.bytes` 自己算 —— 调用方只说“就这些字节”，没有第二个地方能把长度写错。
   * 怎么发（上传成 `file_id` / 内联成 data URL / 退化成文本提示）由服务端按**这段会话**
   * 实际用的端点与模型决定，回来的 `warning` 是它的降级说明（转进通知栏）。
   */
  async uploadContent(sessionId: string, input: UploadContentInput): Promise<ContentUploadResult> {
    return await this.client.call<ContentUploadResult>(
      "content.upload",
      { sessionId, bytes: input.bytes.byteLength, mime: input.mime, filename: input.filename },
      { bytes: input.bytes },
    );
  }
}
