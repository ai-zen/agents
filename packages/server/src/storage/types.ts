/**
 * 存储层的行类型与入参类型。
 *
 * 约定：
 * - 列名与字段名都是 camelCase（SQLite 的列名并不强制风格，这里让「行类型 = 列名」，
 *   读写两侧不用再维护一张映射表）。
 * - 所有时间戳都是 `Date.now()` 的毫秒数，列类型 INTEGER（见各表注释）。
 * - 带 `Row` 后缀的是**数据库原样行**（JSON 列还是字符串），不带后缀的是仓储解好的对象。
 * - `role` / `status` 的取值与 `@ai-zen/agents-core` 的 `AgentNS.Role` /
 *   `AgentNS.MessageStatus` 一致；这里用字符串字面量声明，不 import core —— 存储层
 *   只负责存取，不该因为运行时类型变化而连带改动。
 */

/** 消息角色，取值与 core 的 `AgentNS.Role` 对齐 */
export type MessageRole = "system" | "user" | "assistant" | "tool" | "function" | "unknown";

/** 消息状态，取值与 core 的 `AgentNS.MessageStatus` 对齐 */
export type MessageStatus = "pending" | "writing" | "completed" | "error" | "aborted" | "unknown";

/** 消息内容分段（文本段、图片段……具体形状由 core 决定，存储层原样保存） */
export interface MessageContentSection {
  type?: string;
  text?: string;
  [key: string]: unknown;
}

/** 消息的 `content` 列：字符串，或分段数组；可能为空 */
export type MessageContent = string | MessageContentSection[] | null;

/* ------------------------------- workspaces ------------------------------- */

export interface WorkspaceRow {
  id: string;
  name: string;
  /** 工作目录：创建后不可变（PRD D9），因此这里没有更新方法 */
  cwd: string;
  createdAt: number;
}

export interface WorkspaceCreateInput {
  id: string;
  name: string;
  cwd: string;
  createdAt: number;
}

/* ------------------------------ conversations ----------------------------- */

export interface ConversationRow {
  id: string;
  workspaceId: string;
  name: string;
  /** 0 / 1：侧栏置顶（PRD D13） */
  pinned: number;
  /** 创建时定死的助手与模型（PRD L7），此处只存 id；定义本身在配置层 */
  agentId: string | null;
  modelId: string | null;
  createdAt: number;
  /** 最后一次结构性变化的时间；排序只看 pinned + createdAt，不看它（D13） */
  updatedAt: number;
}

export interface Conversation extends Omit<ConversationRow, "pinned"> {
  pinned: boolean;
}

export interface ConversationCreateInput {
  id: string;
  workspaceId: string;
  name: string;
  agentId?: string | null;
  modelId?: string | null;
  createdAt: number;
  updatedAt?: number;
}

/* -------------------------------- messages -------------------------------- */

export interface MessageRow {
  id: string;
  conversationId: string;
  /** 同一对话内单调递增的序号，用于稳定排序与 `after` 游标 */
  seq: number;
  role: string;
  status: string;
  /** 0 / 1：是否已被移出上下文（PRD D15 要求 status / omit 必须落盘） */
  omit: number;
  /** JSON：消息正文（字符串或分段数组） */
  content: string;
  /** JSON：其余字段（tool_calls / reasoning_content / usage / name / finish_reason …） */
  data: string | null;
  /** 供全文检索的纯文本（从 content 抽出来的正文，不含 JSON 键名） */
  searchText: string;
  createdAt: number;
  updatedAt: number;
}

export interface StoredMessage {
  id: string;
  conversationId: string;
  seq: number;
  role: string;
  status: string;
  omit: boolean;
  content: MessageContent;
  data: Record<string, unknown> | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * 边流边写的入参：同一条消息按 id 反复 upsert，每次覆盖正文 / 状态 / omit，
 * 但 `seq` 与 `createdAt` 保持第一次写入时的值。
 */
export interface MessageUpsertInput {
  id: string;
  conversationId: string;
  role: string;
  status: string;
  content?: MessageContent;
  data?: Record<string, unknown> | null;
  omit?: boolean;
  createdAt: number;
}

/**
 * 全文搜索的范围：一段对话内，或一个 Workspace 下的全部对话。
 *
 * 之所以做成二选一的联合类型而不是两个可选字段，是因为「两个都没给」在语义上等于
 * 全库搜索，而 PRD D16 只要求「按 Workspace 过滤」，不给就不该搜全库。
 */
export type MessageSearchScope = { conversationId: string } | { workspaceId: string } | undefined;

/** 全文搜索命中项：带上对话名与命中附近的片段，前端不用再查一遍 */
export interface MessageSearchHit {
  id: string;
  conversationId: string;
  conversationName: string;
  workspaceId: string;
  role: string;
  /** 命中位置前后截取的正文片段 */
  snippet: string;
  createdAt: number;
}

/* --------------------------------- assets --------------------------------- */

export interface AssetRow {
  id: string;
  conversationId: string;
  /** 还没挂到消息上时为 null（上传早于消息落库，PRD D5 / F-H8） */
  messageId: string | null;
  /** 原始文件名（可空：粘贴的图片未必有名字） */
  name: string | null;
  /** 数据根下 `assets/` 的相对路径，库里只存引用（PRD L2） */
  path: string;
  mime: string;
  bytes: number;
  /** 上传结束时的摘要，用于校验完整性 */
  sha256: string | null;
  createdAt: number;
}

export interface AssetCreateInput {
  id: string;
  conversationId: string;
  messageId?: string | null;
  name?: string | null;
  path: string;
  mime: string;
  bytes: number;
  sha256?: string | null;
  createdAt: number;
}

/* --------------------------------- notices -------------------------------- */

export interface NoticeRow {
  id: string;
  /** 语气档位（PRD L3 的三档），取值由上层定义，存储层不判断 */
  level: string;
  /** 文案码：库里存码 + 参数，读出时按连接语言渲染（architecture.md §6） */
  code: string;
  /** JSON：文案参数 */
  params: string | null;
  /** 毫秒数；null 表示永久存在，只能手动清（PRD L3） */
  durationMs: number | null;
  createdAt: number;
}

export interface Notice {
  id: string;
  level: string;
  code: string;
  params: Record<string, unknown> | null;
  durationMs: number | null;
  createdAt: number;
}

export interface NoticeCreateInput {
  id: string;
  level: string;
  code: string;
  params?: Record<string, unknown> | null;
  durationMs?: number | null;
  createdAt: number;
}

/* -------------------------------- questions ------------------------------- */

export interface QuestionRow {
  id: string;
  conversationId: string | null;
  /** 问题种类，取值由上层定义（交接确认、登记项目……） */
  kind: string;
  /** JSON：候选项、正文等载荷 */
  payload: string;
  /** 状态机取值由上层定义，存储层原样存取（PRD D22：有状态、可持久化） */
  state: string;
  /** JSON：用户的回答 */
  answer: string | null;
  createdAt: number;
  updatedAt: number;
  answeredAt: number | null;
}

export interface Question {
  id: string;
  conversationId: string | null;
  kind: string;
  payload: unknown;
  state: string;
  answer: unknown;
  createdAt: number;
  updatedAt: number;
  answeredAt: number | null;
}

export interface QuestionCreateInput {
  id: string;
  conversationId?: string | null;
  kind: string;
  payload: unknown;
  state: string;
  createdAt: number;
}

/* ------------------------------- credentials ------------------------------ */

export interface CredentialRow {
  id: string;
  note: string;
  /** 凭证的 sha256 摘要；明文不进库（PRD L11） */
  hash: string;
  createdAt: number;
  /** 吊销时间；null 表示仍然有效 */
  revokedAt: number | null;
}

/** 对外展示用：不含 hash */
export interface CredentialInfo {
  id: string;
  note: string;
  createdAt: number;
  revokedAt: number | null;
}

export interface CredentialCreateInput {
  id: string;
  note: string;
  hash: string;
  createdAt: number;
}

/* ----------------------------------- meta --------------------------------- */

export interface MetaRow {
  id: number;
  schemaVersion: number;
  createdAt: number;
}
