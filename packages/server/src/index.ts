/**
 * @ai-zen/agents-server — 会话/工作区服务层。
 *
 * 定位：**客户端无关**的业务层。CLI（TUI）与 Desktop 都只做「渲染 + 输入」，会话编排、
 * 能力装配、持久化、迁移都在这里。
 *
 * 依赖方向（单向，永不反向）：
 *
 *   @ai-zen/cli ─────┐
 *                    ├──→ @ai-zen/agents-server ──→ @ai-zen/agents-sdk ──→ @ai-zen/agents-core
 *   desktop/main ────┘              │                                               ↑
 *                                   └──→ @ai-zen/agents-protocol ─────→ (仅类型) ──┘
 *
 * 线上契约在**独立的包**里（`@ai-zen/agents-protocol`），不在本包：客户端只依赖那个包，
 * 于是「客户端不拖进服务端实现」是结构保证的，不靠纪律。
 *
 * 两条硬约束（可用 grep 检验，命令见 README）：
 *   1. 本包**不得**依赖任何 UI 栈（ink / react / 终端库）——包边界就是进程边界；
 *   2. 本包**不得**读进程级全局（当前工作目录、全局配置路径、全局 locale）——
 *      一切从构造参数来，否则「局部可实例化」和「一个进程服务多个工作区」同时破产。
 *      唯一例外是 `src/cli.ts`（组装根）：它允许读 env/argv，但必须当场转成注入值。
 *      （该检查的正则写在 README 里；这里刻意不把字面量写进源码，否则 grep 会命中注释本身。）
 *
 * ## 桶为什么是 `export *`
 *
 * 这里原来是 ~150 行手工列举：一半是把协议包的符号抄一遍，一半是把各模块的符号抄一遍。
 * 手工列举的问题不是难写，是**会漏**：加了一个导出却忘了加进桶，症状是「包里的东西
 * import 不到」—— 而那种错在写代码那一刻完全不显眼。改成 `export *` 之后，模块的公开面
 * 就是包的公开面，两者不可能漂。
 *
 * `export *` 撞上**重名会编译失败**，这恰恰是它比手工列举强的地方：手工列举时重名被
 * 后者静默覆盖，谁也不会发现。
 *
 * 唯一的例外是 `./daemon/wire.js`：它的 `socketWire` 适配器**刻意不导出**（外部实现者
 * 各有各的底层，抄不到它；要给本包接一种新传输，只需按 `Wire` 接口写一份），所以那里
 * 用显式具名导出。这是「选择不导出」，不是重名。
 */

export * from "@ai-zen/agents-protocol";

// ---- 机理件（无业务语义） ----
export * from "./version.js";
export * from "./lib/phase.js";
export * from "./lib/events.js";

// ---- 会话：注册表与生命周期、事件翻译、存档、提问、自动标题 ----
export * from "./domain/session/SessionManager.js";
export * from "./domain/session/EventBridge.js";
export * from "./domain/session/Persistence.js";
export * from "./domain/session/QuestionBroker.js";
export * from "./domain/session/LiveSession.js";
export * from "./domain/session/AutoTitle.js";
export * from "./domain/session/store/SessionStore.js";
export * from "./domain/session/store/FileSessionStore.js";

// ---- 其它业务对象 ----
export * from "./domain/workspace/workspace.js";
export * from "./domain/workspace/FileIndex.js";
export * from "./domain/config/ConfigService.js";
export * from "./domain/asset/AssetService.js";
export * from "./domain/handoff/SessionHandoff.js";
export * from "./domain/agent/agentPaths.js";
export * from "./domain/agent/SessionAgentFactory.js";

// ---- 传输与接线 ----
export * from "./daemon/Daemon.js";
// `Wire` 属于公开面：要给服务端接一种新传输（WebSocket / stdio）的人，必须能**在包外**
// 按这个接口写一个实现，再把每条连接交给 `Daemon.handleConnection()`。它刻意不在
// `@ai-zen/agents-protocol` 里 —— 协议面是「线上长什么样」，`Wire` 是「本进程里怎么把它递进来」，
// 是服务端的内部接缝，只是因为「实现者可能在别的包里」才必须可 import。
export type { Wire } from "./daemon/wire.js";
export * from "./daemon/sessionHandlers.js";
export * from "./daemon/agentHandlers.js";
export * from "./daemon/configHandlers.js";
export * from "./daemon/assetHandlers.js";
