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
 * - `source` 是 core 的 `AgentNS.MessageSource`（**判别结构**，不是字符串）：库里存它的 JSON，
 *   读回来反序列化成同一个形状（兼容策略见 `MessageRepository.toSource`）。
 */

import type { AgentNS } from "@ai-zen/agents-core";
import type { HandoffMode } from "../wire/methods.js";
import type { CompactionMode } from "../wire/states.js";

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

/* ------------------------------ sessions ----------------------------- */

export interface SessionRow {
  id: string;
  workspaceId: string;
  name: string;
  /** 0 / 1：这个名字是不是自动起的（R35）。创建时的原名算自动，用户改名置 0，自动命名置 1 */
  nameIsAuto: number;
  /** 0 / 1：侧栏置顶（PRD D13） */
  pinned: number;
  /** 创建时定死的助手（PRD L7），此处只存 id；定义本身在配置层 */
  agentId: string;
  /** 这段会话现在用的模型：创建时取助手定义上那个，之后可以由 `session.setModel` 改 */
  modelId: string;
  /**
   * 这段会话选的思考档位名；`null` = 跟随助手定义上的那份参数。
   *
   * 存的是档位名而不是展开后的参数：档位属于模型（同一个档位名在不同模型的策略表里
   * 对应不同参数），换模型时这一列被清空，展开只在装配 agent 那一刻做。
   */
  thinkingLevel: string | null;
  /**
   * 这段会话上一次压缩的时刻（毫秒）；`null` = 从来没压过。
   *
   * 压缩只动 `messages`（`omit` 位 + 交接断点），会话行上原本一点痕迹也没有 —— 于是「自动压的
   * 还是用户答完压的」既不能区分也无从观测。这两列就是那个痕迹，由两条压缩路径各自写。
   */
  compactedAt: number | null;
  /** 上一次压缩是谁促成的（`null` = 没压过）：`auto` = 派生会话自动压，`manual` = 用户答完问题后压 */
  compactionMode: CompactionMode | null;
  /**
   * 这段会话自己定的交接阈值（PRD 1.4 的「交接阈值」那一格）；`null` = 跟模型走。
   *
   * NULL 才是常态：模型上那份 `tokenThresholds.handoff` 是唯一出厂的数字，会话行这一列只是
   * **覆盖层** —— 用户给这一段单独调过就写在这里，没调过就保持 NULL，读的时候退回模型那份。
   */
  handoffThreshold: number | null;
  /** 这段会话自己定的防护阈值（硬线）；`null` = 跟模型走。口径同 `handoffThreshold` */
  guardThreshold: number | null;
  /**
   * 待交接的 mode：答完交接题当时这段不闲、于是留到「下一次变闲」再兑现的那一格（PLAN §5.2）。
   *
   * `null` = 没有待交接（常态）；`"self"` / `"summary"` = 下一次变闲时用哪一种执行者交接。
   * 它必须落库：「等下一次变闲」可能跨重启，而题本身不落库（PRD 4.10），重启之后这是**唯一**
   * 能带着走的那份事实。
   */
  pendingHandoff: string | null;
  /**
   * 0 / 1：自动交接开关（PRD 1.4 的「自动交接开关」那一格）。
   *
   * 1 = 开：撞线自己交班、不问（平级会话那一侧）；0 = 关：装不下时问用户一次（用户建的那一侧）。
   * 初值由**谁开的这段会话**决定，创建那一刻写死（用户建 0 / 平级会话 1）。
   */
  autoHandoff: number;
  /**
   * 血缘：谁开的这段会话（父会话 id）；`null` = 用户建的（PRD 1.3 / 4.6）。
   *
   * 它只是**身份**：历史里显示「由会话 X 创建」、判「只限一层」（父自己也有血缘就不能再开）。
   * 投递不看它 —— 血缘不是通行证。
   */
  lineage: string | null;
  createdAt: number;
  /** 最后一次结构性变化的时间；排序只看 pinned + createdAt，不看它（D13） */
  updatedAt: number;
}

export interface Session
  extends Omit<SessionRow, "pinned" | "nameIsAuto" | "autoHandoff" | "pendingHandoff"> {
  pinned: boolean;
  /** 名字仍是自动起的那个（真值来自 `sessions.nameIsAuto` 列，不由名字反推） */
  nameIsAuto: boolean;
  /** 自动交接开关（真值来自 `sessions.autoHandoff` 列）：开 = 撞线自己交班、不问 */
  autoHandoff: boolean;
  /** 待交接的 mode（真值来自 `sessions.pendingHandoff` 列）；`null` = 没有待交接 */
  pendingHandoff: HandoffMode | null;
}

export interface SessionCreateInput {
  id: string;
  workspaceId: string;
  name: string;
  /** 助手是会话身份的一部分，创建时必须已知（解析不出来就先解析、不建行） */
  agentId: string;
  /** 模型创建时也必须有值（取助手定义上那个，或创建时点名的那一个） */
  modelId: string;
  /** 创建时就能定的思考档位（草稿期间用户先调过档、首次发消息才落库）；缺省 `null` = 跟随助手 */
  thinkingLevel?: string | null;
  /** 这段会话自己的两条阈值；不给 = `null`（跟模型走，常态） */
  handoffThreshold?: number | null;
  guardThreshold?: number | null;
  /**
   * 自动交接开关的初值；不给 = `false`（用户建的那一侧：装不下时问一次）。
   *
   * **创建那一刻写死**：平级会话那条路显式给 `true`，之后就只跟着会话行走。
   */
  autoHandoff?: boolean;
  /** 谁开的这段会话（父会话 id）；不给 = 用户建的 */
  lineage?: string | null;
  createdAt: number;
  updatedAt?: number;
}

/**
 * 交接换记忆要的那一批（PRD 4.5）：旧记忆成为另一段会话，原会话腾空之后换上**SDK 算好的那份记忆**。
 *
 * 三样合起来是一件事，所以只有这一个入参类型：拆开传就会有人只做其中一两步，而那正是
 * 「旧的已存档、新的没上岗」的来源。
 */
export interface SessionMemorySwap {
  /** 原会话：记忆要换掉的那一段，id 不变 */
  sessionId: string;
  /** 存档那一段的会话行：身份照抄原会话，id / 名字 / 创建时刻是新的（`已存档_<原名>`） */
  archived: SessionCreateInput;
  /**
   * 写回原会话的那几条消息行 —— 就是 SDK 算好的新记忆里除系统提示之外的那几条。
   *
   * 宿主这一侧用的策略是 `prune`（旧记忆整段搬去存档），所以这里通常只有一条：
   * `role: system` + `hidden` + 正文只带交接文档路径的断点消息（形状由 SDK 定，
   * 宿主不另拼一条）。
   */
  memory: MessageUpsertInput[];
}

/* -------------------------------- messages -------------------------------- */

export interface MessageRow {
  id: string;
  sessionId: string;
  /** 同一会话内单调递增的序号，用于稳定排序与 `after` 游标 */
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
  /** JSON：这条 user 消息从哪儿来（core 的 `AgentNS.MessageSource`）；NULL = 不知道（非 user 消息，或写入时没给来源） */
  source: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface StoredMessage {
  id: string;
  sessionId: string;
  seq: number;
  role: string;
  status: string;
  omit: boolean;
  /** 已反序列化的正文：core 的内容形状；`null` 表示这条消息没有正文 */
  content: AgentNS.MessageContent | null;
  /** 这条消息的来源（core 的判别结构）；`null` = 不知道（非 user 消息，或写入时没给来源） */
  source: AgentNS.MessageSource | null;
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
  sessionId: string;
  role: string;
  status: string;
  /** core 的内容形状；不给表示这条消息没有正文 */
  content?: AgentNS.MessageContent | null;
  /** core 的来源形状（判别结构）；不给表示这条消息没有来源可记 */
  source?: AgentNS.MessageSource | null;
  data?: Record<string, unknown> | null;
  omit?: boolean;
  createdAt: number;
}

/**
 * 全文搜索的范围：一段会话内，或一个 Workspace 下的全部会话。
 *
 * 之所以做成二选一的联合类型而不是两个可选字段，是因为「两个都没给」在语义上等于
 * 全库搜索，而 PRD D16 只要求「按 Workspace 过滤」，不给就不该搜全库。
 */
export type MessageSearchScope = { sessionId: string } | { workspaceId: string } | undefined;

/** 全文搜索命中项：带上会话名与命中附近的片段，前端不用再查一遍 */
export interface MessageSearchHit {
  id: string;
  sessionId: string;
  sessionName: string;
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

/* ----------------------------- session_assets ------------------------ */

/**
 * 关系行：某条消息引用了某份素材。
 *
 * 一行就是一次「引用」；同一对 `(messageId, assetId)` 只有一行（唯一约束）。
 * 素材的归属、以及「几张会话引用了它」都从这张表算，`assets` 行上不再记会话 / 消息。
 */
export interface SessionAssetRow {
  sessionId: string;
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
  /** 文案码：库里存码 + 参数，读出时按连接语言渲染（`PRD.md` 的契约口径：推送里存码不存句子） */
  code: string;
  /** JSON：文案参数 */
  params: string | null;
  /** 毫秒数；null 表示永久存在，只能手动清（PRD L3） */
  durationMs: number | null;
  /** 这条通知与哪段会话有关；null 表示全局通知（会话删掉时随之级联删除） */
  sessionId: string | null;
  createdAt: number;
}

export interface Notice {
  id: string;
  level: string;
  code: string;
  params: Record<string, unknown> | null;
  durationMs: number | null;
  /** 这条通知与哪段会话有关；null 表示全局通知 */
  sessionId: string | null;
  createdAt: number;
}

export interface NoticeCreateInput {
  id: string;
  level: string;
  code: string;
  params?: Record<string, unknown> | null;
  durationMs?: number | null;
  /** 挂在哪段会话上；不给表示全局通知 */
  sessionId?: string | null;
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
