/**
 * 会话存储的**端口** —— 服务端唯一一类「产品数据」的存取契约。
 *
 * 为什么端口里没有 `workspaceId`：一个 store 实例就属于一个工作区（构造时绑定，
 * 见 `FileSessionStore`）。工作区是一等对象，它的标识（首次分配后**冻结**）、名字与
 * 位置都由 `workspace.ts` 决定，不摊到每个方法参数上 —— 否则每个调用点都要重复说一遍
 * 「我在哪个工作区」，说漏一次就读到别人的会话。
 *
 * 为什么 `messages` 是泛型：本包不依赖 `@ai-zen/agents-core`（依赖面纪律），
 * 但会话内容是 core 的 `Message`。客户端用 `SessionRecord<AgentNS.Message>`
 * 拿到完整类型，服务端本身只把它们当**不透明载荷**搬运（它确实从不看内容）。
 */

export interface SessionRef {
  id: string;
}

/**
 * 列表条目 —— **不带消息正文**。
 *
 * 为什么单独一个类型（而不是「`SessionRecord` 里少了 messages」）：客户端的侧栏就是拿它
 * 渲染的，一条都不能少、也不该多拿一个字段就去解析几 MB 的 JSON。谁需要正文谁 `read(id)`。
 *
 * `messageCount` / `updatedAt` 不是从正文现算的：它们落在写入时维护的清单（sidecar）里，
 * 否则每刷一次侧栏就是「按文件数 × 解析全部历史」。
 */
export interface SessionEntry {
  id: string;
  agentId: string;
  /** 展示名；`undefined` = 还没起过名（客户端用首条消息兑底） */
  title?: string;
  /** 会话级模型覆盖（三级解析的最内层）；`undefined` = 用 Agent 定义里的 */
  modelId?: string;
  messageCount: number;
  /** 最后一次写档的时间（ISO） */
  updatedAt: string;
}

/** 「本工作区上一轮会话」指针 */
export interface SessionPointer {
  id: string;
  updatedAt: string;
}

/**
 * 列表的排序：`updatedAt` 倒序；同一毫秒时按 id 倒序。
 *
 * 为什么必须给平局一个确定的次序：同一毫秒内连开两段会话是常态（脚本、测试、并发客户端），
 * 只按时间排会让顺序随插入顺序变 —— 侧栏每刷一次就跳一下，用户会以为列表坏了。
 */
export function compareSessionEntries(
  a: { id: string; updatedAt: string },
  b: { id: string; updatedAt: string },
): number {
  const delta = Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
  if (delta !== 0) return delta;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

export interface SessionRecord<Message = unknown> {
  id: string;
  agentId: string;
  messages: Message[];
  /**
   * 展示名。与 `id` **是两个不同的事实**：id 是身份（存档文件名、`idChanged`、指针都指它），
   * title 是给人看的名字，改了不动 id。留空不是错 —— 客户端会拿首条消息兑底。
   */
  title?: string;
  /**
   * 会话级模型覆盖。优先级：本字段 > `AgentDefinition.modelId` > `AppConfig.defaultModel`。
   * 留空 = 跟着 Agent 走（不是“没有模型”）。
   */
  modelId?: string;
  /**
   * 会话级模型**参数**覆盖（与上面的 `modelId` 是同一级）。
   *
   * 与 `messages` 同一口径：本包不认识 core 的类型，当**不透明载荷**搬运 —— 键名是什么、
   * 哪家厂商的字段全由客户端（写）与 SDK（装配时收回去）决定，服务端只负责别把它丢了。
   *
   * 为什么要存档级字段：参数跟着「模型来自哪一级」走，会话级换了模型之后生效的是这一份；
   * 不落盘的话，`attach` 回来就退化成 Agent 定义那份参数 —— 而那是配给**另一个**模型的
   * （旧模型的思考参数发给新模型 = 端点 400）。
   */
  modelParams?: unknown;
}

export interface SessionStore<Message = unknown> {
  /**
   * 全部会话的清单，按「最后写入时间」倒序（侧栏与 `/load` 用）。
   *
   * 返回的是 {@link SessionEntry}（无正文）：这个接口存在的意义就是**列表不解大 JSON**。
   */
  list(): Promise<SessionEntry[]>;
  read(id: string): Promise<SessionRecord<Message> | null>;
  /** 原子写：进程被杀不会留下半截 JSON。同时更新列表清单（`messageCount` / `updatedAt`） */
  write(record: SessionRecord<Message>): Promise<void>;
  remove(id: string): Promise<void>;
  /** 只 `access`，不解析内容（`/save <名字>` 的重名判断用） */
  exists(id: string): Promise<boolean>;
  lastSession(): Promise<SessionPointer | null>;
  setLastSession(id: string): Promise<void>;
}
