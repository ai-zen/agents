/**
 * **方法 → 参数 / 结果**：线上契约里唯一一处把「名字」和「形状」绑起来的地方。
 *
 * ## 为什么要有这一层
 *
 * 没有这张表时，协议只有两半：一组方法名联合，和 100 多个各自独立的 `XxxParams` / `XxxResult`。
 * 两者之间**没有任何类型联系** —— 把 `SessionSendParams` 塞给 `session.attach`、或者把方法名
 * 拼错一个字母，编译器一句话都不说。于是每一侧都得自己找一份「小心别弄错」的纪律。
 *
 * 这张表把配对写成类型：一个方法名对应唯一一组参数与结果。由此派生：
 *
 *   · `RequestFrame`（`messages.ts`）—— 一个请求帧就是这张表上的**判别联合**，
 *     `method` 决定 `params` 的类型，不需要断言；
 *   · 服务端的 handler 表、客户端的调用点，都由同一张表约束。
 *
 * ## 为什么没参数的方法写 `void`
 *
 * `ping` / `status` / `shutdown` / `config.get` / `workspace.list` / `events.watch` 这些方法
 * 不收参数。写成 `void` 而不是 `undefined` 或 `{}`：传参数这件事在类型上直接不成立，也给不出
 * 一个能装东西的袋子。
 *
 * ## 加一条方法要改几处
 *
 * 三处，缺一处就编译不过：方法名联合（名字）、`XxxParams` / `XxxResult`（形状）、以及下面这张
 * 表（配对）。这正是「一处定义」想要的那种痛 —— 漏了当场红，而不是等某个前端说
 * 「这个动作我做不了」。
 */

import type { AssetListParams, AssetListResult, AssetMethod } from "./assets.js";
import type { ContentMethod, ContentUploadParams, ContentUploadResult } from "./content.js";
import type {
  AgentGetParams,
  AgentGetResult,
  AgentListResult,
  AgentMethod,
  AgentRemoveParams,
  AgentRemoveResult,
  AgentSaveParams,
  AgentSaveResult,
  AgentSetModelParams,
  AgentSetModelResult,
  ConfigGetResult,
  ConfigMcpGetParams,
  ConfigMcpGetResult,
  ConfigMcpSaveParams,
  ConfigMcpSaveResult,
  ConfigMethod,
  ConfigReasoningPresetsResult,
  ConfigSaveParams,
  ConfigSaveResult,
  ConfigSetDefaultAgentParams,
  ConfigSetDefaultAgentResult,
  ConfigSetDefaultModelParams,
  ConfigSetDefaultModelResult,
} from "./config.js";
import type { DaemonMethod, DaemonStatusResult, PingResult, ShutdownResult } from "./daemon.js";
import type {
  EventMethod,
  EventWatchResult,
  SessionAnswerParams,
  SessionAnswerResult,
  SessionAttachParams,
  SessionAttachResult,
  SessionCancelParams,
  SessionCancelResult,
  SessionCloseParams,
  SessionCloseResult,
  SessionCreateParams,
  SessionCreateResult,
  SessionHandoffParams,
  SessionHandoffResult,
  SessionLastParams,
  SessionLastResult,
  SessionListParams,
  SessionListResult,
  SessionMethod,
  SessionMigrateParams,
  SessionMigrateResult,
  SessionModelParamsSetParams,
  SessionModelParamsSetResult,
  SessionModelSetParams,
  SessionModelSetResult,
  SessionReloadParams,
  SessionRemoveParams,
  SessionRemoveResult,
  SessionRenameParams,
  SessionRenameResult,
  SessionRollbackParams,
  SessionRollbackResult,
  SessionSaveAsParams,
  SessionSaveAsResult,
  SessionSaveParams,
  SessionSaveResult,
  SessionSendParams,
  SessionSendResult,
  SessionSetAgentParams,
  SessionSetAgentResult,
  SessionSnapshotParams,
  SessionSnapshotResult,
  SubAgentSnapshotParams,
  SubAgentSnapshotResult,
  WorkspaceFilesParams,
  WorkspaceFilesResult,
  WorkspaceListResult,
  WorkspaceMethod,
  WorkspaceRelocateParams,
  WorkspaceRelocateResult,
  WorkspaceRemoveParams,
  WorkspaceRemoveResult,
  WorkspaceRenameParams,
  WorkspaceRenameResult,
  WorkspaceResolveParams,
  WorkspaceResolveResult,
} from "./sessions.js";

/** 一条方法的线上合同：请求参数与结果各是什么 */
export interface MethodContract<P, R> {
  params: P;
  result: R;
}

/** 线上全部方法（45 条）→ 它的参数与结果 */
export interface MethodApi {
  // ---- 工作区 ----
  "workspace.resolve": MethodContract<WorkspaceResolveParams, WorkspaceResolveResult>;
  "workspace.files": MethodContract<WorkspaceFilesParams, WorkspaceFilesResult>;
  "workspace.list": MethodContract<void, WorkspaceListResult>;
  "workspace.rename": MethodContract<WorkspaceRenameParams, WorkspaceRenameResult>;
  "workspace.remove": MethodContract<WorkspaceRemoveParams, WorkspaceRemoveResult>;
  "workspace.relocate": MethodContract<WorkspaceRelocateParams, WorkspaceRelocateResult>;

  // ---- 会话 ----
  "session.create": MethodContract<SessionCreateParams, SessionCreateResult>;
  "session.attach": MethodContract<SessionAttachParams, SessionAttachResult>;
  "session.send": MethodContract<SessionSendParams, SessionSendResult>;
  "session.cancel": MethodContract<SessionCancelParams, SessionCancelResult>;
  "session.answer": MethodContract<SessionAnswerParams, SessionAnswerResult>;
  "session.list": MethodContract<SessionListParams, SessionListResult>;
  "session.rename": MethodContract<SessionRenameParams, SessionRenameResult>;
  "session.remove": MethodContract<SessionRemoveParams, SessionRemoveResult>;
  "session.last": MethodContract<SessionLastParams, SessionLastResult>;
  "session.rollback": MethodContract<SessionRollbackParams, SessionRollbackResult>;
  /** 重新读盘：结果与快照同形 */
  "session.reload": MethodContract<SessionReloadParams, SessionSnapshotResult>;
  "session.snapshot": MethodContract<SessionSnapshotParams, SessionSnapshotResult>;
  "session.save": MethodContract<SessionSaveParams, SessionSaveResult>;
  "session.saveAs": MethodContract<SessionSaveAsParams, SessionSaveAsResult>;
  "session.handoff": MethodContract<SessionHandoffParams, SessionHandoffResult>;
  "session.migrate": MethodContract<SessionMigrateParams, SessionMigrateResult>;
  "session.subAgent.snapshot": MethodContract<SubAgentSnapshotParams, SubAgentSnapshotResult>;
  "session.setAgent": MethodContract<SessionSetAgentParams, SessionSetAgentResult>;
  "session.model.set": MethodContract<SessionModelSetParams, SessionModelSetResult>;
  "session.modelParams.set": MethodContract<
    SessionModelParamsSetParams,
    SessionModelParamsSetResult
  >;
  "session.close": MethodContract<SessionCloseParams, SessionCloseResult>;

  // ---- 订阅 ----
  "events.watch": MethodContract<void, EventWatchResult>;

  // ---- 配置与 Agent 定义 ----
  "config.get": MethodContract<void, ConfigGetResult>;
  "config.save": MethodContract<ConfigSaveParams, ConfigSaveResult>;
  "config.reasoningPresets": MethodContract<void, ConfigReasoningPresetsResult>;
  "config.defaultAgent.set": MethodContract<
    ConfigSetDefaultAgentParams,
    ConfigSetDefaultAgentResult
  >;
  "config.defaultModel.set": MethodContract<
    ConfigSetDefaultModelParams,
    ConfigSetDefaultModelResult
  >;
  "config.mcp.get": MethodContract<ConfigMcpGetParams, ConfigMcpGetResult>;
  "config.mcp.save": MethodContract<ConfigMcpSaveParams, ConfigMcpSaveResult>;

  "agent.model.set": MethodContract<AgentSetModelParams, AgentSetModelResult>;
  "agent.list": MethodContract<void, AgentListResult>;
  "agent.get": MethodContract<AgentGetParams, AgentGetResult>;
  "agent.save": MethodContract<AgentSaveParams, AgentSaveResult>;
  "agent.remove": MethodContract<AgentRemoveParams, AgentRemoveResult>;

  // ---- 资产 ----
  "asset.list": MethodContract<AssetListParams, AssetListResult>;

  // ---- 内容 ----
  "content.upload": MethodContract<ContentUploadParams, ContentUploadResult>;

  // ---- 内置 ----
  ping: MethodContract<void, PingResult>;
  status: MethodContract<void, DaemonStatusResult>;
  shutdown: MethodContract<void, ShutdownResult>;
}

/** 全部方法名（= `MethodApi` 的键） */
export type AnyMethod = keyof MethodApi;

/** 某个方法的参数类型 */
export type ParamsOf<M extends AnyMethod> = MethodApi[M]["params"];

/** 某个方法的结果类型 */
export type ResultOf<M extends AnyMethod> = MethodApi[M]["result"];

/** 所有 `*Method` 联合之和 —— 配对表必须与它逐字相等 */
type AllDeclaredMethods =
  | WorkspaceMethod
  | SessionMethod
  | EventMethod
  | ConfigMethod
  | AgentMethod
  | AssetMethod
  | ContentMethod
  | DaemonMethod;

/** `T` 是 `true` 才算通过；`false` 会在这一行编译错误 */
type Assert<T extends true> = T;

/** 少一条 → 这里不是 `never`，`Assert<false>` 当场红 */
export type _ApiCoversEveryMethod = Assert<
  Exclude<AllDeclaredMethods, AnyMethod> extends never ? true : false
>;

/** 多一条（表里有、联合里没有）→ 同样当场红 */
export type _ApiHasNoExtraMethod = Assert<
  Exclude<AnyMethod, AllDeclaredMethods> extends never ? true : false
>;
