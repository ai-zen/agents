/**
 * `@ai-zen/agents-client` —— cli 与 desktop 共用的**到 `agents-server` 的连接层**。
 *
 * 一个门面，五件事：
 *
 * | 想要什么 | 从哪来 |
 * |---|---|
 * | 一条已经握过手的连接：`call` / `subscribe` / `close` / `reconnect` | {@link Client}（`client.ts`） |
 * | 「有就上、没有就拉一个」 | {@link ensureServer}（`connection.ts`） |
 * | 记住上次连的是哪台、说哪种语言 | `settings.ts` |
 * | 断线之后补拉（状态 + 消息） | `resume.ts`（`resume` / `mergeResumed` / `lastMessageId`） |
 * | 重连几次、等多久 | `reconnect.ts` |
 * | 把图片传上去、回一个能放进消息的引用 | `upload.ts`（`uploadAsset` / `uploadAssets`） |
 *
 * 契约（方法名、事件名、载荷、业务码、消息本体）**不在这里重写一份**：类型直接从
 * `@ai-zen/agents-server` 转出（下方 `export type`），所以 cli / desktop 只认这一个包也能拿到
 * 与服务端逐字一致的形状。运行期一个字节都不 import 那个包 —— 它的包根会把整个服务端（单根、
 * SQLite worker、SDK 装配）拉进产物。
 *
 * 这个包 `private: true`、不发版（R69）：cli 与 desktop 打包时各自把它**捆进自己的产物**。
 */

export { Client } from "./client.js";
export type {
  CallOptions,
  ClientOptions,
  MethodCallArgs,
  ResumeOutcome,
  Unsubscribe,
} from "./client.js";

export {
  addressLabel,
  isLoopbackHost,
  normalizeAddress,
  parseAddress,
  webSocketUrl,
} from "./address.js";
export type { ServerTarget } from "./address.js";

export {
  AI_ZEN_DIR_ENV,
  ensureServer,
  readLocalToken,
  readServerFile,
  resolveDataRoot,
  resolveServerEntry,
  serverFilePath,
  spawnAgentsServer,
  tokenFilePath,
} from "./connection.js";
export type {
  EnsureServerOptions,
  EnsureServerResult,
  LocalServerFacts,
  SpawnServerContext,
} from "./connection.js";

export { ClientError, fromServerError, isClientError, localError } from "./errors.js";
export type { ClientErrorCode, LocalErrorCode } from "./errors.js";

export { mergeResumed, lastMessageId, resumeConversation } from "./resume.js";
export type { ContractCaller, ResumeMode, ResumedConversation } from "./resume.js";

export {
  DEFAULT_CHUNK_SIZE,
  DEFAULT_MAX_ASSET_BYTES,
  DEFAULT_MAX_ASSETS_PER_MESSAGE,
  formatBytes,
  mimeOfPath,
  uploadAsset,
  uploadAssets,
} from "./upload.js";
export type {
  AssetFailure,
  AssetSource,
  UploadAssetOptions,
  UploadAssetsOptions,
  UploadAssetsResult,
  UploadTransport,
} from "./upload.js";

// 上传分片的二进制帧：形状与服务端 `net/UploadReceiver` 逐字节一致，两个前端都从这里取
export { CHUNK_HEADER_LENGTH_BYTES, decodeChunkFrame, encodeChunkFrame } from "./chunkFrame.js";

export {
  DEFAULT_RECONNECT_POLICY,
  isRetryableByDefault,
  reconnectUntilConnected,
  retryDelay,
} from "./reconnect.js";
export type {
  ReconnectAttempt,
  ReconnectOptions,
  ReconnectPolicy,
  Reconnectable,
} from "./reconnect.js";

export {
  describeSettings,
  parseSettings,
  readSettings,
  redactToken,
  settingsLabel,
  settingsPath,
  settingsToTarget,
  writeSettings,
} from "./settings.js";
export type { ConnectionClient, ConnectionMode, ConnectionSettings } from "./settings.js";

/**
 * 契约类型的转出（只转出形状，运行期不 import 服务端）。
 *
 * 上层要的消息本体就是 core 的 `AgentNS.Message` —— 经服务端再导出的同一个定义，客户端不包一层。
 */
export type {
  // 方法表与事件表
  EventMap,
  EventName,
  EventPayload,
  MethodMap,
  MethodName,
  MethodParams,
  MethodResult,
  NoParams,
  // 握手与身份
  ClientInfo,
  ServerHelloParams,
  ServerHelloResult,
  // 状态形状（`conversation.state` 与事件载荷里有）
  ConversationState,
  NoticeView,
  QuestionView,
  RunState,
  UsageSnapshot,
  // 错误
  BizCode,
  ErrorData,
  // 消息本体与增量（core 的定义）
  AgentNS,
  // 上传产物与附件结局（`asset.end` 回的那个引用、`conversation.send` 回的逐条结局）
  AssetRef,
  AttachmentDelivery,
  AttachmentOutcome,
} from "@ai-zen/agents-server";
