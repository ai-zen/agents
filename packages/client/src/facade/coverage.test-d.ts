/**
 * 门面**完整性**的类型级用例：门面的方法集合必须**等于**协议方法表的 key 集合。
 *
 * ## 为什么这件事必须由类型保证
 *
 * D6 的病灶是「门面覆盖 16/22，于是桌面端放弃门面、裸调协议」—— 于是方法名与参数拼装
 * 在两个地方各写一遍。补全只能解决**今天**；只要没人拿着枪，下一个人加一条协议方法时
 * 照样可以只在服务端注册、不在门面上补 —— 编译全绿，直到某个前端说「这个动作我做不了」。
 *
 * 所以判据写成**两个方向**都编译不过：
 *
 * 1. **少一条**：对照表被约束成 `Record<keyof typeof SESSION_METHODS, keyof RemoteSessions>`，
 *    协议新增一条方法而这张表没补 → 「缺少属性」编译错误；
 * 2. **多一条**：门面上多出一个谁也没认领的方法（比如从配置面挪剩下的 `setSessionModel`）
 *    → 下面那条 `AssertNone<Exclude<…>>` 编译错误。
 *
 * 因为「协议 key 数」与「门面方法数」相等，这两条合起来就把对应关系逼成了**一一对应**：
 * 两个协议方法指向同一个门面方法时，必然有另一个门面方法没人认领。
 *
 * ## 为什么是 `.test-d.ts`
 *
 * 这文件里一行运行期代码都没有（也不该有）：它由 `tsc --noEmit -p tsconfig.test.json`
 * 检查（`pretest` 里跑），而不是 vitest 的 `*.test.ts`。放进构建配置的 `exclude` 之后
 * 它也不会进 `dist/`。
 */

import {
  AGENT_METHODS,
  ASSET_METHODS,
  CONFIG_METHODS,
  SESSION_METHODS,
  WORKSPACE_METHODS,
} from "@ai-zen/agents-protocol";
import type { RemoteConfig } from "./config.js";
import type { RemoteSessions } from "./sessions.js";

/** 某个类型上除 `constructor` 之外的全部成员名（门面的方法集合） */
type MethodNames<T> = keyof T;

/**
 * 解不开的断言：`T` 不是 `never` 时这里就是编译错误。
 *
 * 用它表示「集合必须为空」（`Exclude<门面方法, 已被认领的方法>` 必须为 `never`）。
 */
type AssertNone<T extends never> = T;

// ==================================================================
// 会话面：`SESSION_METHODS`(21) + `WORKSPACE_METHODS`(6)
// ==================================================================

/**
 * 协议 key → 门面方法名。
 *
 * 为什么需要这张表而不是「名字必须相同」：门面里是**本地语义**（`session.create` 在客户端
 * 这一侧叫 `open`，因为 `create`/`attach` 是同一个动作的两条分支；`workspace.resolve` 叫
 * `resolveWorkspace`，因为它答的是「路径 → 身份」）。差异只在这张表里，一处。
 */
const SESSION_COVERAGE = {
  create: "open",
  attach: "attach",
  send: "send",
  cancel: "cancel",
  answer: "answer",
  list: "list",
  rename: "rename",
  remove: "remove",
  last: "last",
  rollback: "rollback",
  reload: "reload",
  snapshot: "snapshot",
  save: "save",
  saveAs: "saveAs",
  handoff: "handoff",
  migrate: "migrate",
  subAgentSnapshot: "subAgentSnapshot",
  setAgent: "setAgent",
  modelSet: "modelSet",
  modelParamsSet: "modelParamsSet",
  close: "close",
} satisfies Record<keyof typeof SESSION_METHODS, MethodNames<RemoteSessions>>;

const WORKSPACE_COVERAGE = {
  resolve: "resolveWorkspace",
  files: "files",
  list: "listWorkspaces",
  rename: "renameWorkspace",
  remove: "removeWorkspace",
  relocate: "relocateWorkspace",
} satisfies Record<keyof typeof WORKSPACE_METHODS, MethodNames<RemoteSessions>>;

/** 两张表合起来认领的方法：`RemoteSessions` 上的每一个方法都必须在这里面 */
type SessionsClaimed =
  | (typeof SESSION_COVERAGE)[keyof typeof SESSION_COVERAGE]
  | (typeof WORKSPACE_COVERAGE)[keyof typeof WORKSPACE_COVERAGE];

// 「多一条」：门面上有谁也没认领的方法 → 编译不过
export type SessionsExhaustive = AssertNone<Exclude<MethodNames<RemoteSessions>, SessionsClaimed>>;

// ==================================================================
// 配置面：`CONFIG_METHODS`(7) + `AGENT_METHODS`(5) + `ASSET_METHODS`(1)
// ==================================================================

const CONFIG_COVERAGE = {
  get: "get",
  save: "save",
  reasoningPresets: "reasoningPresets",
  defaultAgentSet: "defaultAgentSet",
  defaultModelSet: "defaultModelSet",
  mcpGet: "mcpGet",
  mcpSave: "mcpSave",
} satisfies Record<keyof typeof CONFIG_METHODS, MethodNames<RemoteConfig>>;

const AGENT_COVERAGE = {
  setModel: "agentSetModel",
  list: "agentList",
  get: "agentGet",
  save: "agentSave",
  remove: "agentRemove",
} satisfies Record<keyof typeof AGENT_METHODS, MethodNames<RemoteConfig>>;

const ASSET_COVERAGE = {
  list: "assetList",
} satisfies Record<keyof typeof ASSET_METHODS, MethodNames<RemoteConfig>>;

/** 三张表合起来认领的方法：`RemoteConfig` 上的每一个方法都必须在这里面 */
type ConfigClaimed =
  | (typeof CONFIG_COVERAGE)[keyof typeof CONFIG_COVERAGE]
  | (typeof AGENT_COVERAGE)[keyof typeof AGENT_COVERAGE]
  | (typeof ASSET_COVERAGE)[keyof typeof ASSET_COVERAGE];

// 「多一条」：`RemoteConfig` 上多出 `modelSet`（会话级动作）这类方法 → 编译不过
export type ConfigExhaustive = AssertNone<Exclude<MethodNames<RemoteConfig>, ConfigClaimed>>;

// ==================================================================
// 连接级的那一条不属于任何门面
// ==================================================================

/**
 * `events.watch` 不在上面任何一张表里：它是**连接级**的（一个连接开始收事件），
 * 归 `ServerConnection.watch()`。留在会门上的话，上面两条断言会立刻红 —— 而这正是想要的：
 * 「哪条方法归哪个对象」这件事不能靠记性。
 */
export type WatchIsNotOnSessions = AssertNone<Extract<"watch", MethodNames<RemoteSessions>>>;
export type WatchIsNotOnConfig = AssertNone<Extract<"watch", MethodNames<RemoteConfig>>>;
