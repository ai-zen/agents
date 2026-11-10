/**
 * 会话层的方法门面 —— 把 `ServerClient.call("session.xxx", …)` 收成带类型的方法。
 *
 * 为什么要这一层：`ServerClient.call` 的 `params` 是 `unknown`，逐处手写方法名与
 * 参数形状等于把线上契约抄一遍。这里每个方法都对着 `@ai-zen/agents-protocol` 的类型，
 * 协议改了这边编译不过，而不是运行期才 500。
 *
 * 它是**无状态**的薄封装（只持有连接）：TUI 拿到一个实例就能开/发/存/取快照。
 */

import {
  EVENT_METHODS,
  SESSION_METHODS,
  WORKSPACE_METHODS,
  type HandoffMode,
  type MessageContent,
  type SessionAnswerResult,
  type SessionAttachResult,
  type SessionCancelResult,
  type SessionCloseResult,
  type SessionCreateResult,
  type SessionHandoffResult,
  type SessionListResult,
  type SessionLastResult,
  type SessionMigrateResult,
  type SessionRollbackResult,
  type SessionSaveAsResult,
  type SessionSaveResult,
  type SessionSendResult,
  type SessionSnapshotResult,
  type SubAgentSnapshotResult,
  type WorkspaceResolveResult,
  type WorkspaceFilesResult,
} from "@ai-zen/agents-protocol";
import type { ServerClient } from "./types.js";

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

  /** 让这条连接开始收事件（服务端主动推的阶段 / 增量 / 收尾） */
  async watch(): Promise<void> {
    await this.client.call(EVENT_METHODS.watch);
  }

  /**
   * 路径 → 工作区身份。
   *
   * 不给 `path` 就是在问「服务端自己的工作区在哪」—— 远程部署时这才是唯一有意义的问法：
   * 客户端把自己进程的当前工作目录送上去，等于让客户端替服务端决定会话跑在哪个目录。
   */
  async resolveWorkspace(path?: string): Promise<WorkspaceResolveResult> {
    return await this.client.call<WorkspaceResolveResult>(
      WORKSPACE_METHODS.resolve,
      path ? { path } : {},
    );
  }

  /** 工作区的文件清单（`@` 补全用；扫的是**服务端**磁盘） */
  async files(workspaceId: string): Promise<WorkspaceFilesResult> {
    return await this.client.call<WorkspaceFilesResult>(WORKSPACE_METHODS.files, { workspaceId });
  }

  /** 某个工作区「上一轮会话」的指针（续接用；没有则 null） */
  async last(workspaceId: string): Promise<SessionLastResult> {
    return await this.client.call<SessionLastResult>(SESSION_METHODS.last, { workspaceId });
  }

  /**
   * 回答服务端提出的问题（目前只有自动迁移的「交接方式三选一」）。
   *
   * `mode: null` = 用户选「不交接」（跳过本次迁移）。返回 `answered: false` 表示**来晚了**
   * （超时 / 已答过 / 会话已收）—— 那不是错误，客户端把选择器收掉即可。
   */
  async answer(
    sessionId: string,
    questionId: string,
    choice: string | null,
  ): Promise<SessionAnswerResult> {
    return await this.client.call<SessionAnswerResult>(SESSION_METHODS.answer, {
      sessionId,
      questionId,
      choice,
    });
  }

  /**
   * 某个子 Agent 到目前为止的完整对话（Agent 栏目切过去时对齐用）。
   *
   * 子 Agent 只活在当前一轮：`session.turnEnd` 之后服务端会丢弃它，这条调用会报
   * `sub-agent-missing` —— 那不是服务端出错，客户端该做的是把栏目收回去。
   */
  async subAgentSnapshot(sessionId: string, subAgentId: string): Promise<SubAgentSnapshotResult> {
    return await this.client.call<SubAgentSnapshotResult>(SESSION_METHODS.subAgentSnapshot, {
      sessionId,
      subAgentId,
    });
  }

  /** 开（或续接）一个会话 */
  async open(input: OpenSessionInput): Promise<SessionCreateResult> {
    const workspace = await this.resolveWorkspace(input.path);
    return await this.client.call<SessionCreateResult>(SESSION_METHODS.create, {
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
   * 要的恰恰是接上那段 —— 它可能还在服务端内存里活着（上次 TUI 只是断开了连接）。
   * 活着就接、盘上有就装回来，都没有则服务端回 `session-missing`。
   */
  async attach(input: {
    workspaceId: string;
    sessionId: string;
    /** 服务端已知这个工作区时可以不给 */
    path?: string;
    agentId?: string;
  }): Promise<SessionAttachResult> {
    return await this.client.call<SessionAttachResult>(SESSION_METHODS.attach, input);
  }

  /**
   * 开始一轮；返回 `turnId`，过程与结果都走事件。
   *
   * `content` 可以是纯文本，也可以是「文本 + 图片」的内容块数组 —— 服务端不解释它，
   * 原样交给 Agent（内容块怎么拼是客户端的事，见 `@ai-zen/agents-protocol` 的 `sessions.ts`）。
   */
  async send(sessionId: string, content: MessageContent): Promise<SessionSendResult> {
    return await this.client.call<SessionSendResult>(SESSION_METHODS.send, { sessionId, content });
  }

  async cancel(sessionId: string): Promise<SessionCancelResult> {
    return await this.client.call<SessionCancelResult>(SESSION_METHODS.cancel, { sessionId });
  }

  /**
   * 某个工作区的会话清单（盘上的存档 ∪ 内存里的活会话，一条不重，按 `updatedAt` 倒序）。
   *
   * 以前这里是两条（`list` 活会话 / `listSaved` 只有 id）：TUI 只关心“能不能续接”，
   * 所以两条都够用；GUI 的侧栏不行（得自己拼、还会拼出同一段两条）。服务端合成一条后，
   * 这里也只剩一条 —— 清单里的 `title` / `messageCount` / `live` TUI 暂时不用。
   */
  async list(workspaceId: string): Promise<SessionListResult> {
    return await this.client.call<SessionListResult>(SESSION_METHODS.list, { workspaceId });
  }

  /** 撤回：从 `index` 起删掉并落盘；返回剩下的消息与被删的首条用户消息 */
  async rollback(sessionId: string, index: number): Promise<SessionRollbackResult> {
    return await this.client.call<SessionRollbackResult>(SESSION_METHODS.rollback, {
      sessionId,
      index,
    });
  }

  /** 整份快照：消息 / 阶段 / 轮次 / 用量 */
  async snapshot(sessionId: string): Promise<SessionSnapshotResult> {
    return await this.client.call<SessionSnapshotResult>(SESSION_METHODS.snapshot, { sessionId });
  }

  /** 按磁盘上的新配置/定义重建 Agent（保留消息），返回重建后的快照 */
  async reload(sessionId: string): Promise<SessionSnapshotResult> {
    return await this.client.call<SessionSnapshotResult>(SESSION_METHODS.reload, { sessionId });
  }

  /**
   * 换 Agent：同一段对话换个 Agent 继续（服务端保留消息、更新 `agentId`）。
   *
   * 返回快照：模型、消息与阈值都跟着变了，客户端拿它一次对齐屏幕。
   */
  async setAgent(sessionId: string, agentId: string): Promise<SessionSnapshotResult> {
    return await this.client.call<SessionSnapshotResult>(SESSION_METHODS.setAgent, {
      sessionId,
      agentId,
    });
  }

  /**
   * 明确关闭一段会话（幂等：不在跑时回 `closed:false`，不当错误）。
   *
   * 它是「我不看这段了」的**唯一**显式表达（服务端在持有者消失后自己按宽限期收）：
   * 一次性调用（`ai "…"`）跑完就该让服务端当场把这段会话还回去。
   */
  async close(sessionId: string): Promise<SessionCloseResult> {
    return await this.client.call<SessionCloseResult>(SESSION_METHODS.close, { sessionId });
  }

  /**
   * 落盘当前会话（缺省同时把它设为「上一轮会话」）。
   *
   * `setAsLast: false` 是一次性调用的归档（CLI 的 `ai --save`）：写档但不篡改续接指针
   * —— 否则连着跑几条 `cat … | ai --save` 之后，下次 `ai` 会续接到最后一条管道结果上。
   */
  async save(sessionId: string, options: { setAsLast?: boolean } = {}): Promise<SessionSaveResult> {
    return await this.client.call<SessionSaveResult>(SESSION_METHODS.save, {
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
    return await this.client.call<SessionSaveAsResult>(SESSION_METHODS.saveAs, { sessionId, id });
  }

  /**
   * 只产出交接文档（`/handoff`）：会话 id 不变、历史不动。
   *
   * 进度（`handoffWriting` / `handoffPath` / 降级）走 `session.notice`，流式正文走
   * `session.delta` —— 这个方法可能要跑一两分钟，等回执期间界面靠事件渲染。
   */
  async handoff(sessionId: string, mode?: HandoffMode): Promise<SessionHandoffResult> {
    return await this.client.call<SessionHandoffResult>(SESSION_METHODS.handoff, {
      sessionId,
      ...(mode ? { mode } : {}),
    });
  }

  /**
   * 交接 + 开新会话（`/migrate`）：**返回的 `sessionId` 是新的**。
   *
   * 调用方必须把之后所有请求都换到新 id 上，旧 id 在服务端已经退场（`unknown-session`）。
   */
  async migrate(sessionId: string, mode?: HandoffMode): Promise<SessionMigrateResult> {
    return await this.client.call<SessionMigrateResult>(SESSION_METHODS.migrate, {
      sessionId,
      ...(mode ? { mode } : {}),
    });
  }
}
