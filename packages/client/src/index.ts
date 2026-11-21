/**
 * `@ai-zen/agents-client` —— cli 与 desktop 共用的**到 `agents-host` 的连接层**。
 *
 * 一个门面，五件事：
 *
 * | 想要什么 | 从哪来 |
 * |---|---|
 * | 一条探通了的连接：`api` / `subscribe` / `reconnect` / `close` | {@link connect}（`client.ts`） |
 * | 「有就上、没有就拉一个」 | {@link ensureHost}（`connection.ts`） |
 * | 记住上次连的是哪台、说哪种语言 | `settings.ts` |
 * | 重连几次、等多久 | `reconnect.ts` |
 * | 把图片传上去、按 id 取回字节 | `asset.ts`（`uploadAsset` / `uploadAssets` / `getAsset`） |
 *
 * 契约（procedure 名、入参出参、事件形状）**不在这里重写一份**：`api` 的类型是
 * `TRPCClient<AppRouter>`，`AppRouter` 直接从 `@ai-zen/agents-host` 转出，所以
 * `client.api.session.open.query({ sessionId })` 的推导演到底，与宿主只差一次编译。运行期一个
 * 字节都不 import 那个包 —— 它的包根会把整个宿主（单根、SQLite worker、SDK 装配）拉进产物。
 *
 * 这个包 `private: true`、不发版（R69）：cli 与 desktop 打包时各自把它**捆进自己的产物**。
 */

export { connect } from "./client.js";
export type { ClientOptions, HostClient, Unsubscribe } from "./client.js";

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
  readHostFile,
  readHostVersionPin,
  readLocalToken,
  resolveDataRoot,
  resolveHostEntry,
  hostFilePath,
  spawnHostByContext,
  spawnHostEntry,
  spawnHostViaNpx,
  tokenFilePath,
  versionPinFilePath,
} from "./connection.js";
export type {
  EnsureHostOptions,
  EnsureHostResult,
  HostLaunchFailure,
  HostLaunchStage,
  HostVersionPin,
  LocalHostFacts,
  NpxHostArgv,
  SpawnDeps,
  SpawnedHost,
  SpawnHost,
  SpawnHostContext,
} from "./connection.js";

export { ClientError, fromTRPCError, isClientError, localError, localWarning } from "./errors.js";
export type {
  ClientErrorCode,
  HostErrorCode,
  LocalErrorCode,
  LocalWarning,
  LocalWarningCode,
  TRPCErrorCode,
} from "./errors.js";

export {
  reconnectUntilConnected,
  DEFAULT_RECONNECT_POLICY,
  isRetryableByDefault,
  retryDelay,
} from "./reconnect.js";
export type {
  Reconnectable,
  ReconnectAttempt,
  ReconnectOptions,
  ReconnectPolicy,
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

export { getAsset, localAssetIdOf, mimeOfPath, uploadAsset, uploadAssets } from "./asset.js";
export type {
  AssetContent,
  AssetFailure,
  AssetSource,
  ContractCaller,
  UploadAssetsResult,
} from "./asset.js";

/**
 * 契约类型的转出（只转出形状，运行期不 import 宿主）。
 *
 * 上层只用这个包时也要能写出「一段会话」「一份素材」这种类型，所以跨 wire 的那几个行形状
 * （`Session` / `Workspace` / `Asset` / `Notice` / `Question`）与事件流一起从这里出去 ——
 * 它们的定义仍然只有宿主那一份，客户端不包一层。
 */
export type { AppRouter, HostEvent } from "@ai-zen/agents-host";
export type {
  Asset,
  Choice,
  Notice,
  NoticeLevel,
  Question,
  Session,
  Workspace,
} from "@ai-zen/agents-host";
