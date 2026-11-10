/**
 * 会话存档的读写（D10 拆出来的第二块）。
 *
 * ## 管什么
 *
 * 存档的**形状**（`recordOf`）、写盘（`write` / `writeOnSettle` / `save` / `saveAs` /
 * `archive` / `adopt`）与「存档在哪儿」（`store`）。
 *
 * `recordOf` 是**存档形状的唯一定义处**：所有写档路径都从它取，漏一个字段就是一类数据
 * 丢失（`title` 漏了 → 改过的名字下次写档被抹掉；`modelId` 漏了 → 会话级模型覆盖在下一轮
 * 悄悄失效；`modelParams` 漏了 → 参数退回 Agent 定义那份、配给另一个模型、端点 400）。
 * 它原来埋在一个 2600 行的类中间，谁也不知道改存档要动哪儿 —— 这正是这块单独成类的理由。
 *
 * ## 不管什么
 *
 * 不管**注册表**：换 id（`saveAs` / `adopt`）在本类里只做「写新档、挪指针、删旧档」，
 * 把活会话从旧键挪到新键、清子 Agent、发 `session.idChanged` 都是会话层的事
 * （`SessionManager.rekey`）。所以本类只借两个只读事实进来：`isLive`（这个 id 有没有
 * 活会话占着）与 `nextSessionId`（新 id 从哪来）。
 *
 * ## 为什么写失败不抛
 *
 * `write` / `writeOnSettle` 跑在**一轮收尾**上：那里抛出去没人接（那一轮已经跑完了），
 * 而且「以为存了、其实没存」是最坏的失败形态 —— 用户下次 `ai` 才发现对话不翼而飞。
 * 所以它们转成一条 `persistFailed` 通知（用户至少当场看得见）。`save` / `saveAs` 相反：
 * 它们是**用户显式要求**的，存不下去必须当场报错。
 */

import type { SessionRecord, SessionStore } from "./store/SessionStore.js";
import {
  ERROR_CODES,
  SESSION_NOTICE_CODES,
  codedError,
  type Message,
  type NoticePayload,
  type SessionSaveAsResult,
  type SessionSaveResult,
} from "@ai-zen/agents-protocol";
import type { LiveSession } from "./LiveSession.js";

export interface PersistenceOptions {
  /**
   * 某个工作区的会话存档（续接与 `session.save` 用）。不注入则两者都不可用。
   *
   * 注入成**函数**而不是实例：一个进程服务多个工作区，每个工作区一份存档。
   *
   * 泛型参数写 `Message`：存档里的正文就是协议转出的那个 `Message`（`SessionSnapshotResult.messages`
   * 用的也是它）。以前这里是不带参数的 `SessionStore`（正文 = `unknown`），于是每处「把存档
   * 读回来装上 Agent」都得写一次断言 —— 那些断言就是「协议与存档两份形状」的缝隙。
   */
  storeFor?: (workspaceId: string) => SessionStore<Message> | Promise<SessionStore<Message>>;
  /**
   * 新会话的 id 生成器（客户端没指定时用；`adopt` 换 id 也用它）。
   *
   * 由会话层给：同一个分配器既给新会话也给迁移后的新段，两处不是两种编号格式。
   */
  nextSessionId: () => string;
  /** 这个 id 此刻有活会话占着吗（换 id 前要问：不静默顶掉正在跑的会话） */
  isLive: (sessionId: string) => boolean;
  /** 写档失败的出口（收尾路径不抛错，转成一条通知给用户看） */
  notice: (sessionId: string, notice: NoticePayload) => void;
}

export class Persistence {
  constructor(private readonly options: PersistenceOptions) {}

  /**
   * 存档工厂：没注入则续接与 save 都不可用。
   *
   * 读路径（`list` / `last` / `attach` / `rollback`）与写路径都从这里拿同一个端口，
   * 位置与目录布局只由端口决定，本层不碰文件。
   */
  async store(workspaceId: string): Promise<SessionStore<Message> | undefined> {
    return this.options.storeFor ? await this.options.storeFor(workspaceId) : undefined;
  }

  /** 取不到就报 `no-store`（要写档的路径用它，别自己再拼一遍同样的错） */
  async requireStore(workspaceId: string): Promise<SessionStore<Message>> {
    const store = await this.store(workspaceId);
    if (!store)
      throw codedError(ERROR_CODES.noStore, `no session store for workspace ${workspaceId}`);
    return store;
  }

  /**
   * 存档的形状**只有这一处定义**（见文件头）。
   *
   * 顺手刷新 `updatedAt`：它是「最后一次活动」的唯一来源（列表排序与侧栏都读它）。
   * 写在这里而不是每个调用点，理由同上——一处定义。
   */
  recordOf(
    session: LiveSession,
    messages: Message[] = session.agent.messages,
    id: string = session.id,
  ): SessionRecord<Message> {
    session.updatedAt = new Date().toISOString();
    return {
      id,
      agentId: session.agentId,
      messages,
      ...(session.title !== undefined ? { title: session.title } : {}),
      ...(session.modelId !== undefined ? { modelId: session.modelId } : {}),
      ...(session.modelParams !== undefined ? { modelParams: session.modelParams } : {}),
    };
  }

  /**
   * 把会话写进存档（并更新「本工作区上一轮会话」指针）。
   *
   * 两条规矩与旧版 `ConversationPersistPlugin` 逐字对齐：
   *   - **尚无用户消息就不写**：否则 `/load` 列表里会出现一串空会话；
   *   - 写失败不抛（那是收尾路径）：转成 `persistFailed` 通知给用户，因为「以为存了、
   *     其实没存」是最坏的失败形态——用户会在下次 `ai` 发现对话不翼而飞。
   */
  async write(session: LiveSession): Promise<void> {
    // 一次性会话（`persist:false`）：这一轮属于某次脚本调用，不在存档里留痕，也不挪
    // 「上一轮会话」指针 —— 否则下次 `ai` 会续接到一条管道结果上。
    if (!session.autoPersist) return;
    const messages = session.agent.messages;
    if (!messages.some((message) => message?.role === "user")) return;
    const store = await this.store(session.workspaceId);
    // 没注入存档：这条路径本来就不支持落盘（与 `save` 的 `no-store` 同口径，
    // 但这里是收尾路径，不报错）
    if (!store) return;
    try {
      await store.write(this.recordOf(session, messages));
      await store.setLastSession(session.id);
    } catch (error: any) {
      this.options.notice(session.id, {
        level: "error",
        code: SESSION_NOTICE_CODES.persistFailed,
        params: { error: error?.message ?? String(error) },
      });
    }
  }

  /**
   * 收尾时按标记落盘（为什么只有 `send` / `handoff` 置位，见 `LiveSession.persistOnSettle`）。
   *
   * 注意它与「这段会话该不该活着」是**两件不同的事**：`persistOnSettle` 说这一轮该不该写
   * 档，回收判据说这段会话该不该留在内存里（`reclaimOnSettle`）。曾经有过把两者混成一个
   * 标记的写法，症状是「迁移的中场收尾把会话收了」或「该写的档没写」。
   */
  async writeOnSettle(session: LiveSession): Promise<void> {
    if (!session.persistOnSettle) return;
    session.persistOnSettle = false;
    await this.write(session);
  }

  /**
   * 把当前会话写进工作区存档，并把它设为「上一轮会话」。
   *
   * `setAsLast:false` 是一次性调用的归档（`ai --save`）：存下来是为了事后翻看，
   * 但「本工作区上一轮会话」仍该是用户真正聊过的那一段。
   */
  async save(
    session: LiveSession,
    options: { setAsLast?: boolean } = {},
  ): Promise<SessionSaveResult> {
    const store = await this.requireStore(session.workspaceId);
    await store.write(this.recordOf(session));
    if (options.setAsLast !== false) await store.setLastSession(session.id);
    return { saved: true, sessionId: session.id };
  }

  /**
   * 另存为指定 id 的**存档侧**：写新档、删旧档、挪指针（活会话换键由会话层做）。
   *
   * 目标 id 已被另一段活会话占着时报 `session-exists`（不静默顶掉它）：这条判定在写之前，
   * 所以失败时盘上什么都没动。
   */
  async saveAs(session: LiveSession, id: string): Promise<SessionSaveAsResult> {
    const store = await this.requireStore(session.workspaceId);
    if (id !== session.id && this.options.isLive(id)) {
      throw codedError(ERROR_CODES.sessionExists, `session already exists: ${id}`);
    }

    const previousId = session.id;
    await store.write(this.recordOf(session, session.agent.messages, id));
    await store.setLastSession(id);
    if (id !== previousId) await store.remove(previousId);
    return { saved: true, sessionId: id };
  }

  /**
   * 把**这一整段**历史按 `id` 存一份（交接 / 迁移动手之前的归档）。
   *
   * 消息要显式传一份拷贝：交接之后 SDK 会就地剔历史（prune），而存下去的那一份必须是
   * **剔之前**的完整历史。
   *
   * `store` 由调用方递进来（调用方本来就为了别的判定取过它）：这里再 `store()` 一次
   * 就是同一条路径上问两次「这个工作区的存档在哪」，而这条路径上每一次都在几分钟级的
   * 交接之前 —— 省下来的是「一次没必要的解析」而不是一次 IO。
   */
  async archive(session: LiveSession, id: string, store: SessionStore<Message>): Promise<void> {
    await store.write(this.recordOf(session, [...session.agent.messages], id));
    await store.setLastSession(id);
  }

  /**
   * 换 id 的**存档侧**：起一个新 id、写新档、挪指针，返回新 id（活会话换键由会话层做）。
   *
   * 顺序是「先写盘、再换键」：写失败时注册表还在旧 id 上，客户端收到的错误与它看到的
   * 状态才一致；反过来会出现「响应说迁移失败、会话其实已经改名」这种谁也修不了的状态。
   */
  async adopt(session: LiveSession, store: SessionStore<Message>): Promise<string> {
    const nextId = this.options.nextSessionId();
    if (this.options.isLive(nextId)) {
      throw codedError(ERROR_CODES.sessionExists, `session already exists: ${nextId}`);
    }

    await store.write(this.recordOf(session, [...session.agent.messages], nextId));
    await store.setLastSession(nextId);
    return nextId;
  }
}
