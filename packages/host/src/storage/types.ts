/**
 * 存储层的行类型与入参类型。
 *
 * 约定：
 * - 列名与字段名都是 camelCase（SQLite 的列名并不强制风格，这里让「行类型 = 列名」，
 *   读写两侧不用再维护一张映射表）。
 * - 所有时间戳都是 `Date.now()` 的毫秒数，列类型 INTEGER（见各表注释）。
 * - 带 `Row` 后缀的是**数据库原样行**（JSON 列还是字符串），不带后缀的是仓储解好的对象。
 * - 消息正文直接用 core 的 `AgentNS.MessageContent`（R21 / R30）：列里存的就是它的 JSON，
 *   仓储反序列化后就是同一个形状，服务层与运行时不必在两种形状之间翻译。
 * - `role` / `status` 仍以字符串存取（取值与 `AgentNS.Role` / `AgentNS.MessageStatus` 一致），
 *   收敛成 core 的枚举发生在服务层。
 */

import type { AgentNS } from "@ai-zen/agents-core";

/** 消息角色，取值与 core 的 `AgentNS.Role` 对齐 */
export type MessageRole = "system" | "user" | "assistant" | "tool" | "function" | "unknown";

/** 消息状态，取值与 core 的 `AgentNS.MessageStatus` 对齐 */
export type MessageStatus = "pending" | "writing" | "completed" | "error" | "aborted" | "unknown";

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
  /** 0 / 1：这个名字是不是自动起的（R35）。创建时的原名算自动，用户改名置 0，自动命名置 1 */
  nameIsAuto: number;
  /** 0 / 1：侧栏置顶（PRD D13） */
  pinned: number;
  /** 创建时定死的助手（PRD L7），此处只存 id；定义本身在配置层 */
  agentId: string;
  /** 这段会话现在用的模型：创建时取助手定义上那个，之后可以由 `conversation.setModel` 改 */
  modelId: string;
  /**
   * 这段会话选的思考档位名；`null` = 跟随助手定义上的那份参数。
   *
   * 存的是档位名而不是展开后的参数：档位属于模型（同一个档位名在不同模型的策略表里
   * 对应不同参数），换模型时这一列被清空，展开只在装配 agent 那一刻做。
   */
  thinkingLevel: string | null;
  createdAt: number;
  /** 最后一次结构性变化的时间；排序只看 pinned + createdAt，不看它（D13） */
  updatedAt: number;
}

export interface Conversation extends Omit<ConversationRow, "pinned" | "nameIsAuto"> {
  pinned: boolean;
  /** 名字仍是自动起的那个（真值来自 `conversations.nameIsAuto` 列，不由名字反推） */
  nameIsAuto: boolean;
}

export interface ConversationCreateInput {
  id: string;
  workspaceId: string;
  name: string;
  /** 助手是对话身份的一部分，创建时必须已知（解析不出来就先解析、不建行） */
  agentId: string;
  /** 模型创建时也必须有值（取助手定义上那个，或创建时点名的那一个） */
  modelId: string;
  /** 创建时就能定的思考档位（草稿期间用户先调过档、首次发消息才落库）；缺省 `null` = 跟随助手 */
  thinkingLevel?: string | null;
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
  /** JSON：消息正文（core 内容形状的 JSON 文本） */
  content: string;
  /** JSON：其余字段（tool_calls / reasoning_content / usage / name / finish_reason …） */
  data: string | null;
  /** 供全文检索的纯文本（从 content 抽出来的正文，不含 JSON 键名） */
  searchText: string;
  /** 子 Agent 消息挂在哪次工具调用上；顶层消息为 NULL（R37） */
  parentToolCallId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface StoredMessage {
  id: string;
  conversationId: string;
  /** 子 Agent 消息所属的父工具调用 id；顶层消息为 `null`（R37） */
  parentToolCallId: string | null;
  seq: number;
  role: string;
  status: string;
  omit: boolean;
  /** 已反序列化的正文：core 的内容形状；`null` 表示这条消息没有正文 */
  content: AgentNS.MessageContent | null;
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
  /** core 的内容形状；不给表示这条消息没有正文 */
  content?: AgentNS.MessageContent | null;
  data?: Record<string, unknown> | null;
  omit?: boolean;
  /** 子 Agent 消息要挂的父工具调用 id；不给表示顶层消息（R37） */
  parentToolCallId?: string | null;
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
  /** 原始文件名（可空：粘贴的图片未必有名字） */
  name: string | null;
  /** 数据根下 `assets/` 的相对路径，库里只存引用（PRD L2） */
  path: string;
  mime: string;
  bytes: number;
  /** 内容摘要（上传时宿主自己算的那一份）：全库唯一，即全局去重的键 */
  sha256: string;
  /** 像素宽度：落定时按文件头解出（PNG / JPEG），解不出来是 null */
  width: number | null;
  /** 像素高度；口径同 `width` */
  height: number | null;
  createdAt: number;
}

export interface AssetCreateInput {
  id: string;
  name?: string | null;
  path: string;
  mime: string;
  bytes: number;
  sha256: string;
  width?: number | null;
  height?: number | null;
  createdAt: number;
}

/* ----------------------------- conversation_assets ------------------------ */

/**
 * 关系行：某条消息引用了某份素材。
 *
 * 一行就是一次「引用」；同一对 `(messageId, assetId)` 只有一行（唯一约束）。
 * 素材的归属、以及「几张会话引用了它」都从这张表算，`assets` 行上不再记对话 / 消息。
 */
export interface ConversationAssetRow {
  conversationId: string;
  messageId: string;
  assetId: string;
  createdAt: number;
}

/* --------------------------- asset_vendor_files --------------------------- */

/**
 * 厂商侧文件 id 的缓存行。
 *
 * `vendorFileId` 是**端点维度**的资源：同一个素材在 A 端点上传得到的 id 拿到 B 端点用会 not found。
 * 所以这张表是缓存：这个端点上有就直接用，没有就按素材服务那三条规则走。
 */
export interface AssetVendorFileRow {
  assetId: string;
  endpointId: string;
  vendorFileId: string;
  createdAt: number;
}

export interface AssetVendorFileUpsertInput {
  assetId: string;
  endpointId: string;
  vendorFileId: string;
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
  /** 这条通知与哪段对话有关；null 表示全局通知（对话删掉时随之级联删除） */
  conversationId: string | null;
  createdAt: number;
}

export interface Notice {
  id: string;
  level: string;
  code: string;
  params: Record<string, unknown> | null;
  durationMs: number | null;
  /** 这条通知与哪段对话有关；null 表示全局通知 */
  conversationId: string | null;
  createdAt: number;
}

export interface NoticeCreateInput {
  id: string;
  level: string;
  code: string;
  params?: Record<string, unknown> | null;
  durationMs?: number | null;
  /** 挂在哪段对话上；不给表示全局通知 */
  conversationId?: string | null;
  createdAt: number;
}

/* -------------------------------- questions ------------------------------- */

export interface QuestionRow {
  id: string;
  conversationId: string;
  /** 问题种类，取值由上层定义（交接确认、二次确认） */
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
  conversationId: string;
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
  conversationId: string;
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
