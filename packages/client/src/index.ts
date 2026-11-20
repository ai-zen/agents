/**
 * `@ai-zen/agents-client` —— cli 与 desktop 共用的**到 `agents-host` 的连接层**。
 *
 * 一个门面，七件事：
 *
 * | 想要什么 | 从哪来 |
 * |---|---|
 * | 一条已经握过手的连接：`call` / `subscribe` / `close` / `reconnect` | {@link Client}（`client.ts`） |
 * | 「有就上、没有就拉一个」 | {@link ensureHost}（`connection.ts`） |
 * | 记住上次连的是哪台、说哪种语言 | `settings.ts` |
 * | 断线之后把镜像补回来（四件事 + 消息） | `mirror.ts`（`SessionMirror`）/ {@link Client.resync} |
 * | 重连几次、等多久 | `reconnect.ts` |
 * | 把图片传上去、回一个能放进消息的引用 | `upload.ts`（`uploadAsset` / `uploadAssets`） |
 * | 按素材 id 把内容取回来（历史里的 `__asset_id`） | `asset.ts`（`getAsset` / `getSectionAsset`） |
 *
 * 契约（方法名、事件名、载荷、业务码、消息本体）**不在这里重写一份**：类型直接从
 * `@ai-zen/agents-host` 转出（下方 `export type`），所以 cli / desktop 只认这一个包也能拿到
 * 与宿主逐字一致的形状。运行期一个字节都不 import 那个包 —— 它的包根会把整个宿主（单根、
 * SQLite worker、SDK 装配）拉进产物。
 *
 * 这个包 `private: true`、不发版（R69）：cli 与 desktop 打包时各自把它**捆进自己的产物**。
 */

export { Client } from "./client.js";
export type {
  CallOptions,
  ClientOptions,
  ContractCaller,
  MethodCallArgs,
  SyncOutcome,
  Unsubscribe,
} from "./client.js";

export {
  addressLabel,
  isLoopbackHost,
  normalizeAddress,
  parseAddress,
  webSocketUrl,
} from "./address.js";
export type { HostTarget } from "./address.js";

export {
  AI_ZEN_DIR_ENV,
  ensureHost,
  npxHostArgv,
  readLocalToken,
  readHostFile,
  resolveDataRoot,
  resolveHostEntry,
  hostFilePath,
  spawnHostByContext,
  spawnHostEntry,
  spawnHostViaNpx,
  tokenFilePath,
} from "./connection.js";
export type {
  EnsureHostOptions,
  EnsureHostResult,
  HostLaunchFailure,
  HostLaunchStage,
  LocalHostFacts,
  NpxHostArgv,
  SpawnDeps,
  SpawnedHost,
  SpawnHost,
  SpawnHostContext,
} from "./connection.js";

export { ClientError, fromHostError, isClientError, localError } from "./errors.js";
export type { ClientErrorCode, LocalErrorCode } from "./errors.js";

export { SessionMirror, toMirrorEvent } from "./mirror.js";
export type { MirrorEvent, MirrorSnapshot, SubAgentColumn } from "./mirror.js";

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

export { getAsset, getSectionAsset, localAssetIdOf } from "./asset.js";
export type { AssetContent, GetAssetOptions } from "./asset.js";

// 上传分片的二进制帧：形状与宿主 `net/UploadReceiver` 逐字节一致，两个前端都从这里取
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
 * 契约类型的转出（只转出形状，运行期不 import 宿主）。
 *
 * 上层要的消息本体就是 core 的 `AgentNS.Message` —— 经宿主再导出的同一个定义，客户端不包一层。
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
  HostHelloParams,
  HostHelloResult,
  // 状态形状（`session.state` 读回来的那四件事；`state` 事件推的是其中忙闲那一格）
  SessionActivity,
  SessionPresence,
  SessionState,
  InboxItem,
  NoticeView,
  QuestionView,
  // 错误
  BizCode,
  ErrorData,
  // 消息本体与增量（core 的定义）
  AgentNS,
  // 上传产物与附件结局（`asset.end` 回的那个引用、`session.send` 回的逐条结局）
  AssetRef,
  AssetVariant,
  AttachmentDelivery,
  AttachmentOutcome,
  // 内容段上的本地扩展字段（`__asset_id`）：客户端按「有没有这个字段」决定要不要走素材通道
  LocalMessageContentSection,
} from "@ai-zen/agents-host";
