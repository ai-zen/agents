/**
 * 会话存储的**端口** —— 服务端唯一一类「产品数据」的存取契约。
 *
 * 为什么端口里没有 `workspaceId`：一个 store 实例就属于一个工作区（构造时绑定，
 * 见 `FileConversationStore`）。工作区将来是一等对象，它的标识与生命周期由
 * `workspace.ts` 决定，不摊到每个方法参数上——否则每个调用点都要重复说一遍
 * 「我在哪个工作区」，说漏一次就读到别人的会话。
 *
 * 为什么 `messages` 是泛型：本包不依赖 `@ai-zen/agents-core`（依赖面纪律），
 * 但会话内容是 core 的 `Message`。客户端用 `Conversation<AgentNS.Message>`
 * 拿到完整类型，服务端本身只把它们当**不透明载荷**搬运（它确实从不看内容）。
 */

export interface ConversationSummary {
  id: string;
}

/** 「本工作区上一轮会话」指针 */
export interface SessionPointer {
  id: string;
  updatedAt: string;
}

export interface Conversation<Message = unknown> {
  id: string;
  agentId: string;
  messages: Message[];
  /** 最近一轮的提示词 token 数（TUI 状态栏用，读不到就是 undefined） */
  lastPromptTokens?: number;
}

export interface ConversationStore<Message = unknown> {
  /** 按「最后写入时间」倒序（用文件 mtime，不解析内容）：`/load` 列表用 */
  list(): Promise<ConversationSummary[]>;
  read(id: string): Promise<Conversation<Message> | null>;
  /** 原子写：进程被杀不会留下半截 JSON */
  write(conversation: Conversation<Message>): Promise<void>;
  remove(id: string): Promise<void>;
  /** 只 `access`，不解析内容（`/save <名字>` 的重名判断用） */
  exists(id: string): Promise<boolean>;
  lastSession(): Promise<SessionPointer | null>;
  setLastSession(id: string): Promise<void>;
}
