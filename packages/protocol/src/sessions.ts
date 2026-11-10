/**
 * 会话层线上契约 —— 方法名、参数/结果、事件名。
 *
 * 与 `messages.ts` 的分工：那边定义**帧**（怎么在一条连接上运字节），这边定义**会话**
 * （在帧里说什么）。客户端只认这里的字面量与类型，服务端实现不得私自约定别的字段。
 *
 * ## 为什么事件是「事实」而不是「文案」
 *
 * 事件载荷只有可判别的枚举与数据（阶段 kind、工具名、正文字符串）。渲染成
 * 「连接中…」还是「Connecting…」由客户端决定 —— 否则一个服务端同时接中文终端和英文
 * 浏览器时，只能挑一个语言撒谎。
 *
 * ## 为什么 `send` 立刻返回 `turnId`
 *
 * 一轮对话可能跑几分钟，中间要推几十上百条事件。若 `send` 等到跑完才回，客户端就没有
 * 任何东西可渲染，超时也没法定（工具执行动辄数分钟）。所以：`send` 只确认「这一轮开始了」，
 * 后续全部走事件；`turnId` 用来把事件归到具体的一轮（用户可能中途连按两次）。
 */

import type { Message, ModelParams, Usage } from "./model.js";
import type { PhaseInfo } from "./phase.js";

/**
 * 词汇表（名字就这三个，不再多造）：
 *
 *   workspace  工作目录（会话的父容器）
 *   session    **与某个 Agent 进行的一段会话**，属于某个 workspace；有 id，可以活着也可以已落盘
 *   turn       session 里的一轮 `send → 结束`，用 `turnId` 归轮
 *
 * `session.*` 只用于「对一个会话做事」。不属于某个会话的动作不往这个命名空间里塞：
 * 例如「订阅事件」是**连接级**的（`events.watch`），跟具体会话无关；工作区是会话的
 * **父容器**，它的事归 `workspace.*`（见 `WORKSPACE_METHODS`）。
 */

/**
 * 工作区方法名（服务端注册与客户端调用共用同一份字面量）。
 *
 * 为什么要跟 `SESSION_METHODS` 分开：工作区是会话的父容器，两个层级的动作混在一个
 * 常量表里，调用点就得靠眼力分辨「这一步是在认容器，还是在对一段会话做事」。分开之后
 * **线上方法名一个字没变**（仍是 `workspace.resolve`）—— 客户端只改引用的常量名。
 */
export const WORKSPACE_METHODS = {
  /**
   * 路径 → 工作区身份（首次见到这个路径时写 `workspace.json`）。
   *
   * 幂等：同一个路径反复调，永远得到同一个 `workspaceId` —— id 首次分配后**冻结**，
   * 目录改名也不会变（要接回新路径只能显式调 `relocate`）。
   */
  resolve: "workspace.resolve",
  /** 某个工作区的文件清单（客户端 `@` 补全用；扫的是服务端磁盘） */
  files: "workspace.files",
  /**
   * 盘上全部工作区（带 `pathExists`）。
   *
   * 客户端启动时的侧栏要用它：只看自己 cwd 那一个工作区的话，用户 `mv` 完目录就再也
   * 看不到旧工作区 —— 而它（连同历史）还在盘上。
   */
  list: "workspace.list",
  /** 改显示名（**不动 id、不动 path**；与 `session.rename` 同名同义） */
  rename: "workspace.rename",
  /**
   * 删一个工作区 —— **连它的全部会话一起**（整个 `workspaces/<id>/` 目录）。
   *
   * 幂等：本来就没有 → `removed:false`（与 `agent.remove` / `session.remove` 同一口径）。
   */
  remove: "workspace.remove",
  /**
   * 把记录的 path 改到新目录（**id 不变**）。
   *
   * 这是「目录改名之后历史不丢」的入口：`mv` 之后调用方拿旧 id 调它，之后对新路径
   * `resolve` 就会回到同一个 id。
   */
  relocate: "workspace.relocate",
} as const;

/** 会话方法名（服务端注册与客户端调用共用同一份字面量，避免两边各写一份字符串） */
export const SESSION_METHODS = {
  create: "session.create",
  /**
   * 接上一段**已经存在**的会话（活着就接、盘上有就装回来）。
   *
   * 与 `create` 分开的理由：会话的存活期比客户端连接长，
   * 「接着上次」如果复用 `create`，会撞在它「id 撞了就拒绝」的语义上 —— 用户看到的是
   * 「打不开自己上一轮会话」。`create` 的不静默顶掉语义**不动**，两个动作各说各的。
   */
  attach: "session.attach",
  send: "session.send",
  cancel: "session.cancel",
  /**
   * 回答服务端提出的问题（目前只有自动迁移的「用哪种方式交接」）。
   *
   * 为什么是个**方法**而不是事件：提问要一个确定的答案，而且提问方（服务端）在等它
   * —— 单向事件只能承载「事实」，承载不了「往返」。问题本身仍走事件（见
   * `SESSION_EVENTS.question`），因为它的方向是服务端 → 客户端。
   */
  answer: "session.answer",
  /** 某个工作区下的会话清单（盘上的存档 ∪ 内存里的活会话，一条不重） */
  list: "session.list",
  /** 改显示名（**不动 id**；与“另存为” `saveAs` 是两件事） */
  rename: "session.rename",
  /** 删一段会话（物理删存档，幂等） */
  remove: "session.remove",
  /** 某个工作区「上一轮会话」的指针（只有 id；客户端拿它走续接） */
  last: "session.last",
  /** 撤回：删掉下标起的消息，并立即落盘 */
  rollback: "session.rollback",
  /** 按磁盘上的（新）配置与 Agent 定义重建 Agent，**保留消息** */
  reload: "session.reload",
  /** 整份快照：客户端（重）连上来时一次拿全，不用自己拼事件 */
  snapshot: "session.snapshot",
  /** 把当前会话写进工作区存档（并把它设为「上一轮会话」） */
  save: "session.save",
  /** 另存为指定 id：写新档、删旧档、活会话跟着换键（`/save <名字>`） */
  saveAs: "session.saveAs",
  /** 只产出交接文档：写文档，**不动会话**（不换 id、不剔历史） */
  handoff: "session.handoff",
  /** 交接 + 开新会话（缺省的 `prune`：写文档、剔历史、**换 sessionId**；`omit` 不换，见 `MigrationStrategy`） */
  migrate: "session.migrate",
  /** 取某个子 Agent 到目前为止的完整对话（客户端切到该栏目时对齐用） */
  subAgentSnapshot: "session.subAgent.snapshot",
  /**
   * 换 Agent：按新定义重建 Agent、**保留消息**、更新会话的 `agentId`。
   *
   * 为什么要一条方法：Agent 身份归服务端（Agent 跑在它那边），而 `/agent` 是「同一段
   * 对话换个 Agent 继续」。客户端自己搬消息重建会话是另一条路 —— 那条路要求服务端接受
   * 客户端递来的历史，与「服务端是唯一真相源」直接冲突。
   */
  setAgent: "session.setAgent",
  /**
   * 换**这一段会话**的模型：写会话存档的 `modelId`（三级解析的最内层）并重建 Agent。
   *
   * 与 `agent.model.set` 的形状刻意一样、作用域刻意不同：那个改的是**全局的** Agent 定义
   * （影响所有用它的会话），这个只改这一段（`/model` 不带作用级别的写法走这条）。
   * 两个动作都得存在：「我这次用官网上那个模型跑」（会话级）与「我以后默认用它」（定义级）
   * 是两件事，合并成一个只能靠参数开关分叉，调用方就得猜自己改的是哪一份。
   */
  modelSet: "session.model.set",
  /**
   * 改**这一段会话**的模型**参数**（`/think` 在会话级模型下写的那一层）。
   *
   * 为什么与 `modelSet` 分开：两者是同一级（会话级）的两份事实，但语义完全不同 ——
   * 「换模型」会连带清掉参数（新模型不一定接受旧参数），改参数不该动模型。合成一条就只能
   * 靠参数开关分叉，调用方得猜自己改的是哪一份。
   *
   * 为什么只有会话级有这条：参数跟着「模型来自哪一级」走。参数落在 Agent 定义上时走
   * `agent.save`（今天的行为）；模型来自全局兜底时**没有任何一层可写**（全局那一级只有
   * `config.defaultModel`），客户端自己就拒了（见 CLI 的 `/think`）。
   */
  modelParamsSet: "session.modelParams.set",
  /**
   * 关闭一段会话：摘事件、让出 Agent 与 Scope 引用，**不删存档**，**当场回收**。
   *
   * 它是「我不看这段了」的**唯一**显式表达（自动回收不靠它：持有者没了就由服务端按宽限期
   * 收）。连接断开**不算** —— 会话的存活期比连接长，关掉终端只退订阅，服务端那一轮仍会跑完。
   *
   * 为什么要有它而不是只靠宽限期：一次性调用（`ai "…"`）跑完就该让服务端当场把那段会话
   * 还回去，否则在 shell 里高频调用会一段段堆到宽限期才释放。
   */
  close: "session.close",
} as const;

/**
 * 连接级方法（与某个会话无关，所以不放在 `session.*` 里）
 */
export const EVENT_METHODS = {
  /** 让**这条连接**开始收事件（事件是服务端主动推、无 `id`、不等回执） */
  watch: "events.watch",
} as const;

/**
 * Agent 事件名（服务端主动推，无 `id`，不等回执）。**10 条，值逐字等于 core `Agent.events` 的原名。**
 *
 * 为什么照抄 core 的名字：这 10 条说的就是 core 的生命周期事实 —— 一轮开始（`open`）、
 * 一片原始 chunk 到达（`chunk`）、同一片解析完（`chunk-parsed`）、流结束（`parsed`）、
 * 一条消息被追加或就地改完（`message`）、一个工具结果定型（`tool-call-end`）、出错（`error`）、
 * 收尾（`finally`）、委派的起止（`sub-agent-start` / `sub-agent-end`）。服务端只做一件事：
 * core 发它的**同一刻**把它原样转上线。自己另起一套名字（比如把 `chunk-parsed` 叫成 delta、把 `tool-call-end`
 * 叫成「追加了一条消息」）就得在协议、服务端、客户端之间维护一份对照表，而对照表迟早
 * 与 core 漂开 —— 读实现的人只会发现名字在撒谎。
 *
 * 时机同样照抄 core，两条顺序是硬约束：`chunk` 早于同一片的 `chunk-parsed`；`error`
 * 早于 `finally`。
 *
 * 与 `SESSION_EVENTS` 的分工：这张表是**Agent 身上发生了什么**（core 那边就有的事实），
 * 那张表是**服务端额外告诉你什么**（阶段派生、通知、提问、换 id、一轮真正收尾）。不属于
 * 任何会话的事在 `SERVER_EVENTS`。
 */
export const AGENT_EVENTS = {
  /** 一轮开始（core `open`：请求发出去之前那一刻） */
  open: "open",
  /** 一片原始 chunk 到达（core `chunk`：**解析之前**）。这片载荷是厂商形状，协议不解释 */
  chunk: "chunk",
  /** 同一片解析完、receiver 就地更新之后（core `chunk-parsed`）：正文 / 推理增量 */
  chunkParsed: "chunk-parsed",
  /** 流结束、receiver 定稿（core `parsed`） */
  parsed: "parsed",
  /**
   * 一条消息被追加或就地改完（core `message`）：载荷是那条完整的消息。
   *
   * 它装的是**服务端构造出来的**那些消息（用户消息、占位 assistant、工具结果），也就是
   * 「不能由 chunk 折叠出来」的那一类；流式正文仍归 `chunk`。
   */
  message: "message",
  /** 一个工具的结果定型（core `tool-call-end`）：载荷是那条刚定型的消息 */
  toolCallEnd: "tool-call-end",
  /** 一轮出错（core `error`：**早于** `finally`） */
  error: "error",
  /**
   * 一轮收尾（core `finally`）。
   *
   * **它不是 `session-turn-end`**：`finally` 只说明 core 说完了，落盘、换 id、回收判定都
   * 还没做。两条事件时机不同，**都要发**，顺序恒为 `error`? → `finally` → `session-turn-end`。
   */
  finally: "finally",
  /** 一个子 Agent 开始（core `sub-agent-start`；本轮内 `index` 从 1 起，`subAgentId` 跨轮稳定） */
  subAgentStart: "sub-agent-start",
  /** 一个子 Agent 结束（core `sub-agent-end`：done = 正常跑完，failed = 抛错，**一旦 failed 就不再变**） */
  subAgentEnd: "sub-agent-end",
} as const;

/**
 * 会话事件名（服务端主动推，无 `id`，不等回执）。**7 条，值全部 kebab-case。**
 *
 * 这张表装的是**服务端自己派生 / 自己决定的事**：core 里没有这些事件 —— 阶段是服务端从
 * core 的事实里算出来的，`session-turn-end` 要等落盘、换 id、回收判定都做完，通知 /
 * 提问 / 换 id / 改名都是服务端自己的动作。core 原有的 10 条在 `AGENT_EVENTS`。
 *
 * 命名空间写的是**作用范围**：`session-` 前缀说明这条绑在某一段会话上（载荷里有
 * `sessionId`），不属于任何会话的事不往这张表里塞 —— 它去 `SERVER_EVENTS`（见下）。从而
 * **看到名字就知道该看哪张表**，不必背清单。
 *
 * 为什么值一律 kebab-case：线上事件名只有一种写法 —— core 的 `chunk-parsed` 与这里的
 * `session-turn-end` 长得一样，读的人不必先分辨「这条是谁的」再决定怎么念。（方法名的
 * `session.send` 那套点号是**命名空间**，不是事件名的规则，见 `SESSION_METHODS`。）
 *
 * 将来若出现「属于某个工作区但不属于某段会话」的事件，再加一张 `workspace-*` 前缀的表，
 * 不用回头改这几张的语义。
 */
export const SESSION_EVENTS = {
  /**
   * 生成阶段变化（六态 + 工具名）。
   *
   * **派生**事件：在 `open` / 每个 `chunk-parsed` / `parsed` / 每个 `tool-call-end`
   * 那一刻各报一次（那四个时刻阶段都可能变），服务端算好整份 `phase` 推上来。
   */
  phase: "session-phase",
  /**
   * 本轮工具调用的**组装态**（到目前为止是什么），客户端据此在流式期间就画出工具卡片。
   *
   * **为什么不塞进 `chunk-parsed`**：那条是**文本流** —— 每一片的语义是「再加这一段」，
   * 客户端把 `text` 往后接就对了。工具调用不是这样：参数是边流边长的，一个有意义的
   * 工具调用只在**组装完成之后**才存在（半个 JSON 什么都画不出来），所以这里给的必须是
   * 「到现在为止是什么」。两种语义（追加 vs 覆盖）混在同一条事件里，客户端只能靠猜
   * 「这个字段该接还是该替」，而猜错的症状是参数被拼成两遍。
   *
   * **为什么给组装态而不是增片**：增片要求客户端自己把 JSON 片段攒成一次调用 —— 那是把
   * core 已经做完的组装（`Agent.parseStreamData` 就地拼 `receiver.tool_calls`）在客户端
   * 再做一遍。本项目反复栽在「同一件事两份实现」上：第二份迟早与第一份漂开（core 改了
   * 合并规则、客户端还按老规则攒），而症状是「工具卡片里的参数与真正发出去的请求不一样」。
   *
   * **为什么同一个调用会被多次上报**：参数边流边长，每次有变化就重发一次全量。客户端按
   * `index`（或 `id`）就地更新那一项即可，不要往后追加 —— 它是覆盖语义。
   */
  toolCalls: "session-tool-calls",
  /**
   * 一轮**真正**结束（成功或失败）：core 的 `finally` **之后**，服务端落盘、换 id、
   * 回收判定都做完了。
   *
   * 与 `finally` 分开的理由：`finally` 只说明 core 那一侧说完了 —— 存档这时还没写、
   * 会话可能马上要被回收。客户端在这条事件上才该「当成这一轮结束了」去拉快照，否则可能
   * 拿到一份还没落盘的历史。顺序恒为 `error`? → `finally` → `session-turn-end`。
   */
  turnEnd: "session-turn-end",
  /** 对话内通知（绑会话） */
  notice: "session-notice",
  /**
   * 服务端向客户端提问：**需要用户决定的事，服务端不替用户选**。
   *
   * 与通知的区别是它要一个回答（有 `questionId`），且服务端那一侧正等着它：自动迁移
   * 「用哪种方式交接」原本是 TUI 进程内的一个三选一，前后端分离之后必须原样回到用户手上
   * —— 否则服务端就是替用户做了「保真还是便宜」这个决定。
   *
   * 回答走 `session.answer`；答案来晚了（超时 / 会话已收）服务端回 `answered: false`，
   * 不报错（那不是参数错）。
   */
  question: "session-question",
  /**
   * 会话换了 id（迁移 / 另存为 / **一轮进行中的自动迁移**）。
   *
   * 服务端可以在**一轮进行中**换 id（自动迁移就是如此）：这时客户端没有任何请求
   * 可以拿来“拿到新 id”，所以必须有一条事件说清楚 —— 否则它会在旧 id 上等一个
   * 永远不会到的 `session-turn-end`。
   *
   * 载荷用 `from` 而不是 `sessionId` 标识“这条是说哪段会话的”（那个 id 已经不存在了），
   * 客户端拿 `from === 自己当前 id` 就能认领。
   */
  idChanged: "session-id-changed",
  /**
   * 会话的显示名变了（今天只有服务端的自动标题会发）。
   *
   * 为什么必须有这条事件：自动标题发生在 `session-turn-end` **之后**的异步动作里，客户端手上
   * 没有任何请求可以拿来「拿到新名字」—— 没有它，侧栏会一直用首条消息兑底命名，
   * 直到用户手动刷新一次列表（而在那之前，用户会以为这功能没生效）。
   *
   * 客户端可以完全不理它（它只是一条展示用的名字）；手工改名（`session.rename`）**不**
   * 发它：那条请求的响应里已经有新名字了。
   */
  titleChanged: "session-title-changed",
} as const;

/**
 * 服务端事件名（不绑任何会话）。目前只有一条：服务端自己的通知。
 *
 * 为什么它必须从会话事件里**拆出来**：它压根不是会话事件 —— 载荷里没有 `sessionId`，
 * 切到别的会话也不该消失（存盘目录坏了、MCP 连不上都是「这个服务端」的事）。放在同一张
 * 表里的话，「按会话过滤事件」的代码就得给它开例外，而例外本身又成了第二套规则。
 *
 * 三张表（`AGENT_EVENTS` / `SESSION_EVENTS` / `SERVER_EVENTS`）+ 三个联合
 * （`AgentEvent` / `SessionEvent` / `ServerEvent`）的拆法，与
 * `SESSION_METHODS` / `DAEMON_METHODS` 完全同构：作用域不同的东西不放在同一张表里。
 */
export const SERVER_EVENTS = {
  /** 服务端通知（不属于任何会话：MCP 连不上、存档目录不可用…） */
  notice: "server-notice",
} as const;

// ==================== 方法参数与结果 ====================

export interface WorkspaceResolveParams {
  /**
   * 工作目录的绝对路径（服务端负责规范化与建目录）。
   *
   * **可选**：cwd 归属服务端 —— 客户端（终端 / 桌面 / 浏览器）不指定时，用服务端
   * 进程的工作目录（由组装根注入，不是这一层去读进程级全局）。不带参数的 `workspace.resolve`
   * 才是「我的工作区在哪」这个问题的正解：客户端把自己进程的当前工作目录送上来，等于让
   * 客户端替服务端决定会话跑在哪个目录。
   */
  path?: string;
}

export interface WorkspaceResolveResult {
  workspaceId: string;
  /** 规范化之后的绝对路径 */
  path: string;
}

/** 文件清单只看工作区 id：根目录靠 `workspace.json` 反查，不接受调用方递路径 */
export interface WorkspaceFilesParams {
  workspaceId: string;
}

/**
 * 与客户端 `PathEntry` 逐字对齐：`dir` 决定补全后是否补一个 `/`。
 *
 * 清单里**既有文件、也有它们的祖先目录**（目录条目排在文件之前），不仅是一堆文件路径：
 * 客户端靠 `dir: true` 渲染“可继续往里钻”的目录行、并在选中后补上末尾的 `/`。
 * 只给文件的话，远程模式下“钻目录”这个能力就不存在了。
 */
export interface WorkspaceFileEntry {
  /** 相对工作区根目录的路径，`/` 分隔，不带 `./` 前缀 */
  path: string;
  /** 是否目录（目录条目的 `path` 不带末尾 `/`，那个斜杠由客户端插入时补） */
  dir: boolean;
}

export interface WorkspaceFilesResult {
  entries: WorkspaceFileEntry[];
}

/**
 * 列表里的一行 —— 侧栏「你有这几个项目」的全部所需。
 *
 * ## 为什么带 `pathExists`
 *
 * `path` 是**记录里写着**的那条路径（冻结的），而目录本身随时可能被 `mv` / `rm`。
 * 两者不一致是常态而不是异常：`mv ~/proj ~/proj2` 之后记录还指着 `~/proj`。
 * 客户端需要知道这件事才能提示用户「去修一下」（`relocate` 到新路径，或者删掉它），
 * 而不是让这个工作区在列表里静默失踪 —— 那等于「挪个目录，历史就没了」再来一次。
 */
export interface WorkspaceSummary {
  workspaceId: string;
  /** 缺省 = 还没起过名，客户端用 `path` 的 basename 兜底 */
  title?: string;
  /** 记录里写着的工作区绝对路径 */
  path: string;
  /** 记录着的这个目录此刻还在不在（`false` = 被改名/删除/移动了，客户端要提示用户修复） */
  pathExists: boolean;
}

/**
 * `workspace.list` 不带参数：工作区表是服务端盘上的**全部**事实，不按调用方过滤。
 *
 * 顺序由服务端定死（见 `listWorkspaces`：显示名码位序，同名再按 id），客户端不必重排。
 */
export interface WorkspaceListResult {
  workspaces: WorkspaceSummary[];
}

/** 改工作区的显示名（只改 `title`：id 与 path 一个字都不动） */
export interface WorkspaceRenameParams {
  workspaceId: string;
  title: string;
}

export interface WorkspaceRenameResult {
  workspaceId: string;
  title: string;
}

/** 删一个工作区：`workspaceId` 就是它的目录名，删的是整个 `workspaces/<id>/` */
export interface WorkspaceRemoveParams {
  workspaceId: string;
}

export interface WorkspaceRemoveResult {
  /** 本来就不存在是 `false`（不当错误，与 `agent.remove` / `session.remove` 同一口径） */
  removed: boolean;
}

/**
 * 把工作区搬到一个新目录（目录改名 / 移动之后用这条把历史接回来）。
 *
 * 只改记录里的 `path`：`workspaceId` 不变，`sessions/` 不动 —— 会话属于工作区，不属于
 * 路径。
 */
export interface WorkspaceRelocateParams {
  workspaceId: string;
  /** 新路径（服务端规范化后使用）。必须**已存在**：服务端不替用户建目录 */
  path: string;
}

export interface WorkspaceRelocateResult {
  workspaceId: string;
  /** 规范化之后的绝对路径 */
  path: string;
}

export interface SessionCreateParams {
  workspaceId: string;
  /**
   * 工作区路径。**可选**：不给就由服务端按 `workspaceId` 反查（`workspace.json`）。
   *
   * 为什么干脆不该给：路径是服务端的磁盘事实，而客户端手上那份是**它自己**那边的路径 ——
   * 两机部署时那个路径在服务端可能根本不存在。客户端只持有 id，这才叫 cwd 归服务端。
   * 留这个口子只为了「同一个路径想跑两遍」这类调用；客户端本就不该有能力决定自己跑在哪个目录。
   */
  path?: string;
  /** 用哪个 Agent（缺省 `default`；**续接已有存档时不给就沿用存档里记的那个**） */
  agentId?: string;
  /**
   * 会话 id。**不给则服务端分配**（给了就用它，存档里同 id 的记录会被装进 Agent）。
   *
   * 活会话与盘上存档共用同一个 id（存档就是这段会话的落盘形态）：续接已有存档时
   * 客户端把它带进来；新会话留空，由服务端按同一套格式生成。
   */
  sessionId?: string;
  /**
   * 每轮收尾是否把会话写进工作区存档（缺省 `true`）。
   *
   * `false` 是给**一次性调用**用的（`ai "…"`、`cat f | ai` 这类管道场景）：那段会话
   * 属于这一次提问，不该在 `workspaces/<id>/sessions/` 里留档，更不该把「本工作区上一轮
   * 会话」指针挪过去 —— 否则用户下次进 TUI，续接到的是一条脚本调用的结果。想留档只有
   * 一条路：显式 `session.save`（CLI 侧就是 `ai --save`）。
   *
   * 它只管**自动落盘**，不改变其余语义：会话照样是活会话（没人看着之后按宽限期回收）、
   * 照样能 `save` / `saveAs`、迁移照样写档。
   */
  persist?: boolean;
}

export interface SessionCreateResult {
  sessionId: string;
  agentId: string;
}

/** 「本工作区上一轮会话」的指针查询（只有工作区维度，不涉某一段会话） */
export interface SessionLastParams {
  workspaceId: string;
}

export interface SessionLastResult {
  /**
   * 上一轮会话的 id。
   *
   * 两种情况下为 `null`，客户端一律走新会话：没有指针，以及**指针指向的存档已经不在了**
   * （改名 / 手删）。后者不能直接回 id —— `session.create` 对“存档里没这个 id”是静默开
   * 一段空会话，用户会以为历史丢了。
   */
  sessionId: string | null;
}

/**
 * 接上一段已有会话。
 *
 * `sessionId` 必填：attach 的语义就是「我知道是哪一段，别给我开新的」。它可能在内存里活着
 * （客户端刚崩、会话还在跑），也可能只在存档里 —— 客户端无从判断，所以判断放在服务端。
 */
export interface SessionAttachParams {
  workspaceId: string;
  sessionId: string;
  /** 同 `create`：可省，省了由服务端按 `workspaceId` 反查 */
  path?: string;
  /** 只在「存档里没有这个 id」时无关；活着的会话以自己的 `agentId` 为准 */
  agentId?: string;
}

export type SessionAttachResult = SessionCreateResult;

export interface SessionSendParams {
  sessionId: string;
  content: MessageContent;
}

export interface SessionSendResult {
  /** 本轮编号（从 1 开始，每轮 +1）：事件靠它归轮 */
  turnId: number;
}

/**
 * 会话 id 变化事件。
 *
 * 迁移（`session.migrate`）与另存为（`session.saveAs`）都会换 id，自动迁移还会在
 * **一轮进行中**换 —— 客户端靠这条事件把之后的请求与事件过滤切到新 id 上。
 */
export type SessionIdChangedEvent = {
  event: typeof SESSION_EVENTS.idChanged;
  /** 旧 id（客户端用 `from === 当前 id` 认领这条） */
  from: string;
  /** 新 id */
  sessionId: string;
};

/**
 * 会话改名的通知（见 `SESSION_EVENTS.titleChanged`）。
 *
 * 载荷只有两个事实：哪段会话、新名字是什么。**不带「谁起的」** —— 客户端不需要为
 * 名字的来源分支出两套渲染，而「自动起的名字不该反过来覆盖用户手改」是服务端的判定
 * （它手里才有那一刻的真相），不是客户端该参与的决定。
 */
export type SessionTitleChangedEvent = {
  event: typeof SESSION_EVENTS.titleChanged;
  sessionId: string;
  title: string;
};

/**
 * 服务端向客户端提问（见 `SESSION_EVENTS.question` 的「为什么」）。
 *
 * 载荷只说四件可判别的事实，**一个字幕都不产**：问的是哪一类（`kind`，客户端据此查
 * 自己的词典与分派表）、能怎么答（`input` / `options`）、渲染标题要哪些数（`params`）、
 * 不答/答不了时服务端会怎么做（`fallback`）。
 */
export type SessionQuestionEvent = {
  event: typeof SESSION_EVENTS.question;
  sessionId: string;
  /** 本次提问的 id（回答时带回来；服务端据此认领，过期的回答一律拒） */
  questionId: string;
  /** 哪一类问题 —— 客户端按它查自己的词典（标题 / 选项文案）与分派表 */
  kind: SessionQuestionKind;
  /** 怎么答：选一个（交接类问题的形态）还是填一个值（留的口子，客户端可以暂不实现） */
  input: "select" | "text";
  /** `input:"select"` 时的选项 id 列表；文案在客户端（`kind + id`） */
  options?: readonly string[];
  /**
   * 渲染标题要用的事实（交接类问题：`{ promptTokens, handoffTokens }`）。
   *
   * 走一个通用袋子而不是固定字段：换一个问题就换里面的内容，协议不用改几次。
   */
  params: Record<string, unknown>;
  /** 用户能不能「不答」（交接类问题可以 = 「不交接」） */
  allowSkip: boolean;
  /**
   * 服务端等不到答案时会用的取值。
   *
   * **客户端不认识这个 `kind` 时也直接用它** —— 哪条路安全只有服务端知道。
   */
  fallback: string | null;
};

export interface SessionCancelParams {
  sessionId: string;
}

export interface SessionCancelResult {
  /**
   * `false` = 这段会话本来就不在（幂等：客户端对一段已经退场的会话按 Esc 不该算错）。
   *
   * 与 `close` 的 `closed` 同一口径；区别是 `cancel` **不销毁会话**，只拦本轮。
   */
  cancelled: boolean;
}

export interface SessionListParams {
  /** 会话属于工作区，列会话必须指明是哪个工作区的（不提供"全局列"） */
  workspaceId: string;
  /** 只列内存里的活会话（`false` = 不读磁盘）；缺省 `true` */
  includeSaved?: boolean;
}

/**
 * 列表里的一条 —— 侧栏渲染它的全部所需，**不包含消息正文**。
 *
 * ## 为什么要 `live` + `phase`
 *
 * 侧栏是一个列表：既要全部历史，又要「这段正在跑」。两者必须在同一条条目里给出 ——
 * 分成两个来源，客户端就得自己拼，还会把同一段会话拼成两条。
 *
 * ## 为什么没有 `turnId`
 *
 * 它是**事件过滤**用的序号，客户端只在自己发过一条之后才需要它 —— 与“列表里展示什么”
 * 无关，要它自己去 `snapshot`。同理，服务端「这段会话还能活多久」是它的内政，不进协议
 * （客户端如果要它，说明契约里又混进了服务端的回收策略）。
 */
export interface SessionListEntry {
  sessionId: string;
  agentId: string;
  /** 展示名；缺省 = 还没起过名，客户端拿首条消息兑底 */
  title?: string;
  /**
   * 会话级模型**覆盖**（三级解析的最内层）；缺省 = 跟着 Agent 定义。
   *
   * **语义不动**：它仍然只回答「这一段会话有没有自己的模型选择」（`/model` 那一次写下来的
   * 那一位，存档里的 `SessionRecord.modelId`），不是「生效的模型」。绝大多数会话没有覆盖，
   * 所以这一位在清单里缺省 —— CLI 与既有客户端都按这个语义读它。
   */
  modelId?: string;
  /**
   * **生效**的模型 id —— 三级解析（`会话级覆盖 > AgentDefinition.modelId > 默认模型`）的
   * 结果，唯一实现是 SDK 的 `resolveModel`。
   *
   * ## 为什么清单里必须有这一位
   *
   * 侧栏的模型下拉框要显示「当前值」。只给上面那个 `modelId` 的话，「跟着定义走 / 跟着
   * 全局兜底走」的会话（也就是绝大多数）在清单里没有模型可显示，下拉框就空着。而按本仓的原则
   * （同一件事实只有一个定义），客户端不该拿「覆盖值 + Agent 定义 + 默认」再推一遍：
   * 那是优先级规则的第二份实现，它和真正发出去的请求迟早不一致。
   *
   * 所以：**这一位是解析后的生效值，与 `modelId` 是两件事**。`modelId` 答「这段会话有没有
   * 覆盖」，它答「这段会话实际在用哪个模型」。有覆盖时两者同值，没覆盖时后者是定义或全局
   * 那一档的值、前者缺省。
   *
   * 拿不到就**省略**（不伪造、也不退回 `modelId`）：解析不出来的会话是「这一刻说不准它的
   * 模型」（定义已删、配置里三级都空），给一个猜的值只会让界面更自信地撒谎。
   */
  effectiveModelId?: string;
  /**
   * 上面那个 {@link effectiveModelId} 来自哪一级（与 `session.snapshot` 的 `modelLevel`
   * 同一套词汇、同一次解析的副产品）。
   *
   * 客户端要标「当前生效的是哪一档」（会话级 / 定义 / 全局兜底）。档位只能在解析发生的
   * 地方算出来 —— 客户端把值映射回档，就是又一次自己推优先级。
   *
   * 与 {@link effectiveModelId} 同进同出：解析不出来时两个都省略。
   */
  effectiveModelLevel?: ModelLevel;
  messageCount: number;
  /** 最后一次活动（ISO）：列表就按它倒序 */
  updatedAt: string;
  /** 此刻在服务端内存里（能收发、可能有轮在跑） */
  live: boolean;
  /** 当前阶段；不在跑为 `null`（`live:false` 时恒为 `null`） */
  phase: PhaseInfo | null;
}

/**
 * 模型的三级解析顺序（从内到外）。
 *
 * 值只在这里声明一次，服务端用它标注快照；SDK 自己那份叫 `ModelLevel`，两边的值
 * **逐字一致**，理由同 `HandoffMode` 的双声明（协议不引用 SDK 类型）。
 */
export type ModelLevel = "session" | "agent" | "global";

/** 一屏所需的全部事实：客户端拿它直接渲染，不必先从事件流里攒 */
export interface SessionSnapshotParams {
  sessionId: string;
}

export interface SessionSnapshotResult {
  sessionId: string;
  workspaceId: string;
  agentId: string;
  /**
   * **生效的**模型 id（状态栏显示用）—— 三级解析的结果，不是某一级的原始值：
   * `会话级覆盖 > AgentDefinition.modelId > AppConfig.defaultModel`（唯一实现：SDK 的
   * `resolveModel`）。
   *
   * 为什么必须给「解析后」的那个值：客户端拿它画状态栏、拼图片内容块，而**实际发出去的
   * 请求用的就是它**；给某一级的原始值，就会出现「界面写着 A、请求发给 B」。
   * 三级都拿不到模型时这条会话根本装不起来（服务端报错），所以这里恒非空。
   */
  modelId: string;
  /**
   * 上面那个 `modelId` 来自哪一级。
   *
   * 客户端（`/model` 选择器）要标「当前生效的是哪一档」。档位只能在**解析发生的地方**
   * 算出来（服务端从 SDK 的解析结果里拿），客户端再推一遍 `??` 链就是第二份会漂的实现。
   *
   * 与 SDK 的 `ModelLevel` 逐字一致，但不引用它的类型 —— 理由同 `HandoffMode`：
   * 协议是线上契约，客户端不该为了一个枚举去装 SDK。
   */
  modelLevel: ModelLevel;
  /**
   * **当前生效**的模型参数覆盖（`thinking` / `reasoning_effort` 这类，键名协议不解释）。
   *
   * 为什么要有它：桌面端的「思考强度」要显示**现在是什么值**。这一份值在哪一层，只有
   * 服务端知道（参数跟着「模型来自哪一级」走：模型来自会话级就取会话级那份，来自 Agent
   * 定义就取定义那份，全局兜底那一级没有放参数的地方）。服务端不给，每个客户端都得自己
   * 从「生效值 + 定义 + 默认」反推 —— 那是优先级规则的**第二份实现**，反推出来的档位与
   * 真正发出去的请求迟早不一致（用户看到「高」，请求里却是 `thinking:{type:"disabled"}`）。
   *
   * 是什么：SDK 的 `resolveModelParams` 按 {@link modelLevel} 选出的那一份覆盖（唯一实现
   * 见 `packages/sdk/src/runtime/resolveModel.ts`），原样透传。它是**覆盖层**而不是合并
   * 后的请求体：字段省略（`undefined`）的意思就是「这一档没有覆盖」，模型走自己的
   * `defaultParams` —— 不是「服务端没算出来」，客户端照实显示出厂设置即可。
   */
  modelParams?: ModelParams;
  /**
   * 上面那份 `modelParams` 取自哪一级。
   *
   * 为什么与 {@link modelLevel} 分成两个字段：客户端要把「值」和「这一份值来自哪一层」
   * 绑在同一条记录上，才能既显示当前值、又说出它是会话级还是定义级设的。它和
   * `modelLevel` 由**同一次解析**给出（档位决定模型，也决定参数取哪一层），所以两者值
   * 必然相同 —— 客户端不必、也不该自己把值映射回档（那等于在客户端重写一遍选择规则）。
   *
   * 与 {@link modelParams} 同进同出：没有那份参数时它也不出现（全局兜底那一级没有参数
   * 可指）。取值与 {@link ModelLevel} 同一套词汇，不另造。
   */
  modelParamsLevel?: ModelLevel;
  /**
   * 实发模型名（端点上真正写的那个名字）。
   *
   * 与 `modelId`（配置里的身份）不一定相同：用户可以在配置里给模型起别名。客户端拼
   * 图片内容块时要按**实发名**反查端点与视觉能力（`file_id` 是端点维度资源），所以它
   * 是个必要的事实，不是元数据。
   */
  apiModel: string;
  turnId: number;
  phase: PhaseInfo | null;
  /** 当前完整消息列表（服务端是唯一真相源） */
  messages: Message[];
  /** 最近一轮用量（Agent 提供才带；客户端不知道就别显示） */
  lastUsage?: Usage;
}

export interface SessionReloadParams {
  sessionId: string;
}
/** 换 Agent：`agentId` 必须是已存在的 Agent 定义（否则 `unknown-agent`） */
export interface SessionSetAgentParams {
  sessionId: string;
  agentId: string;
}

export type SessionSetAgentResult = SessionSnapshotResult;

/**
 * 换这一段会话的模型（`session.model.set`）。
 *
 * `modelId` 必填且必须非空：它会被写进存档并成为**这段会话**实际在用的模型。想「回到跟着
 * Agent 定义走」不走这条（那是 `session.setAgent` 的副作用，或者开一段新会话）。
 */
export interface SessionModelSetParams {
  sessionId: string;
  modelId: string;
}

/** 与 `session.setAgent` 同形：改完就回一份新快照，客户端不用再要一次 */
export type SessionModelSetResult = SessionSnapshotResult;

/**
 * 改这一段会话的**模型参数**（`session.modelParams.set`）。
 *
 * 载荷是**不透明的**：协议不解释键名（那是核心资产、也因厂商而异）。与 `SessionRecord`
 * 里的 `modelParams` 同一口径 —— 服务端只负责原样搬进存档并递给装配方。
 */
export interface SessionModelParamsSetParams {
  sessionId: string;
  /**
   * 这一层的参数覆盖（原样存、原样交回 SDK 做浅合并）。
   *
   * `null` = **清掉**这一层的覆盖，回到模型出厂参数。为什么不用「不传字段」表示清除：
   * JSON 里丢掉的字段与「没给」无法区分，而「清掉」是一个明确的意图（`/think default`）。
   */
  modelParams: ModelParams | null;
}

/** 与 `session.model.set` 同形：改完就回一份新快照（客户端不用再要一次） */
export type SessionModelParamsSetResult = SessionSnapshotResult;

export interface SessionCloseParams {
  sessionId: string;
}

export interface SessionCloseResult {
  /** `false` = 这段会话本来就没在跑（幂等：客户端可以重复调） */
  closed: boolean;
}
export interface SessionSaveParams {
  sessionId: string;
  /**
   * 是否同时把「本工作区上一轮会话」指针指向它（缺省 `true`）。
   *
   * `false` 给一次性调用的归档用（`ai --save`）：留着是为了事后翻看，但下次 `ai` 不该
   * 续接到一条管道结果上 —— 连着跑几条 `cat … | ai --save` 之后，`ai` 会续到最后一条。
   */
  setAsLast?: boolean;
}

export interface SessionSaveResult {
  saved: boolean;
  sessionId: string;
}

export interface SessionSaveAsParams {
  sessionId: string;
  /** 新 id（客户端给的名字，如 `chat_debug_login`） */
  id: string;
}

export interface SessionSaveAsResult {
  saved: boolean;
  /** 另存之后的新 id：之后的请求都得用它（旧 id 已退场） */
  sessionId: string;
}

export interface SessionListResult {
  sessions: SessionListEntry[];
}

/** 改显示名（**不动 id**） */
export interface SessionRenameParams {
  /**
   * 顺带指明工作区：目标可能只是**盘上的存档**（还没进内存），而这种会话只能靠
   * `workspaceId` 找到它那个存档目录 —— 与 `remove` 同一个理由。
   */
  workspaceId: string;
  sessionId: string;
  title: string;
}

export interface SessionRenameResult {
  sessionId: string;
  title: string;
}

/** 删一段会话（物理删存档；幂等） */
export interface SessionRemoveParams {
  workspaceId: string;
  sessionId: string;
}

export interface SessionRemoveResult {
  /** 本来就不存在是 `false`（不当错误，与 `agent.remove` 同一口径） */
  removed: boolean;
}

/**
 * 用户消息的内容：纯文本，或「文本 + 图片」的内容块数组。
 *
 * 服务端**不解释**它 —— 与它对待 `messages` 一样，原样交给 Agent。内容块该怎么拼
 * （内联 data URL 还是 Files API 的 `file_id`）取决于端点能力与模型是否支持视觉，
 * 那是**客户端**在有配置、有实发模型名的情况下做的决定；服务端再判断一遍只会多出
 * 第二份会漂移的规则。
 *
 * 形状就是 OpenAI 兼容的那种内容块（模型端点要的原样结构）：
 *   - `text`：文本段；
 *   - `image_url`：内联 data URL（带可选的 `detail` 档位）；
 *   - `file`：Files API 引用 —— `file_id`（已上传）或 `file_data`（base64 内联）。
 */
export type MessageContentBlock =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: string } }
  | { type: "file"; file_id?: string; file_data?: string; filename?: string };

export type MessageContent = string | MessageContentBlock[];

/**
 * 交接文档的执行者。
 *
 *   - `self`：原 Agent 在自己的会话里停工后写（默认）。上下文完整、能核实真实状态；
 *     代价是多 1~2 次全量输入；
 *   - `summary`：一次独立模型调用把历史摘要成文档（无工具、无原会话上下文）。
 *     便宜、确定，但保真度低 —— 是**逃生模式**，也是 `self` 失败后的单向降级目标。
 *
 * 由服务端按 SDK 的 `HandoffMode` 定义，不直接引用 SDK 类型：协议是线上契约，
 * 客户端不该为了一个枚举去装 SDK。
 */
export type HandoffMode = "self" | "summary";

/**
 * 迁移之后旧历史怎么处理 —— 它与「要不要换 id」是**同一件事**，不是两个旋钮。
 *
 *   - `prune`（`session.migrate` 的缺省）：历史从内存里物理剔除，只留
 *     「模板 + 交接断点」。旧历史只剩存档一份，所以旧会话必须以**独立的一段**留在旧 id
 *     下 —— 否则那段对话就没了。于是：换 id、发 `session-id-changed`。
 *   - `omit`（SDK 的 `MigrationStrategy` 默认值）：历史消息标 `omit: true` 留在原处（可审计、
 *     可回放，但不再发给模型）。既然历史还在，就没有理由把它变成另一段会话：
 *     **同一个 sessionId**，不发 `idChanged`，`turnId` 继续累加。
 *
 * 两者**绑定**关系是语义必然，而不是实现上的巧合：id 是「这是哪一段对话」的身份。旧历史
 * 被剔除后，新旧两段的内容完全不同，继续共用同一个 id 会让存档自己盖自己；反过来，历史
 * 只是标了不再发送，会话仍是同一段，换个 id 等于凭空多出一条幽灵存档。
 *
 * 与 SDK 的 `MigrationStrategy` 逐字一致，但**不引用它的类型**：协议是线上契约，客户端
 * 不该为了一个枚举去装 SDK。
 */
export type MigrationStrategy = "prune" | "omit";

/**
 * `session.migrate` 不传 `strategy` 时的处置方式：`prune`。
 *
 * 写在协议里而不是各层各写一份 `?? "prune"`：缺省值是**线上契约**的一部分（客户端不传
 * 就该看到旧行为），而它同时被三层用到（handler 透传、会话层参数默认、交接服务参数默认）。
 * 写了两份的那天，症状就是「直调交接与走方法调用的缺省不一样」，而两者都会写档。
 *
 * 注意它**不等于** SDK 的 `HandoffService` 缺省（那边是 `omit`）：产品的缺省是 prune，
 * 所以服务端每一跳都把选定的值显式递下去，而不是依赖 SDK 的默认值。
 */
export const DEFAULT_MIGRATION_STRATEGY: MigrationStrategy = "prune";

/**
 * 服务端提问的种类。
 *
 * 只增不改语义（与通知 code 表同一条规矩）：客户端按 `kind` 决定弹哪个选择器，
 * 改一个旧值的含义等于让老客户端渲染成别的东西。
 */
export type SessionQuestionKind = "handoff-mode";

/**
 * 回答一次提问。
 *
 * `questionId` 必填且必须原样带回来：服务端靠它认领，**过期的回答一律拒**（见
 * `SessionAnswerResult.answered`）—— 用户在超时之后才点的那个选项，不该作用于
 * 一段已经继续跑下去的会话。
 */
export interface SessionAnswerParams {
  sessionId: string;
  questionId: string;
  /**
   * 选中的选项 id；`null` = 跳过（仅当 `allowSkip`）。
   *
   * 叫 `choice` 而不是具体业务名：「问什么」由 `kind` 说，回答只负责「选了哪个」。
   */
  choice: string | null;
}

export interface SessionAnswerResult {
  /** `false` = 这个问题已经不在了（超时 / 会话已收）：客户端不必重试 */
  answered: boolean;
}

export interface SessionHandoffParams {
  sessionId: string;
  /** 本次执行者；缺省 `self` */
  mode?: HandoffMode;
}

/**
 * 一次交接的结果。`handoff` 与 `migrate` 共用（迁移就多一件事：`sessionId` 可能变了）。
 *
 * 为什么连 `messages` 一起回：交接回合会往会话里追加消息、迁移则把历史剔成
 * 「模板 + 交接断点」（`omit` 则是把历史标成不再发送）。客户端拿这一份直接重渲染，不必
 * 再要一次快照（两次往返之间还会有事件插进来）。
 */
export interface SessionHandoffResult {
  /**
   * 交接之后的会话 id：`handoff` 与 `migrate{strategy:"omit"}` 不变，
   * `migrate{strategy:"prune"}` 是**新会话**的 id（旧那段作为存档留在旧 id 下）
   */
  sessionId: string;
  /** 交接文档绝对路径（在服务端的工作区里，客户端未必能直接打开） */
  handoffPath: string;
  /** **实际**使用的执行者：请求 `self` 但降级时会与入参不同 */
  mode: HandoffMode;
  /** 交接之后的消息（客户端直接重渲染） */
  messages: Message[];
}

/**
 * 交接 + 开新会话（`session.migrate`）。
 *
 * 比 `handoff` 多一个 `strategy`：它决定**旧历史怎么处置**，而处置方式又决定了「还是不是
 * 同一段会话」（见 `MigrationStrategy`）。缺省 `prune` —— 客户端不传时行为与显式传 `prune` 一致。
 */
export interface SessionMigrateParams extends SessionHandoffParams {
  /** 历史处置策略；缺省 `prune`（= 换 id 的旧行为，见 `DEFAULT_MIGRATION_STRATEGY`）。
   *  `omit` 保持同一个 sessionId */
  strategy?: MigrationStrategy;
}

/** 迁移的结果与 `handoff` 同形 —— 差别只在 `sessionId`（`prune` 下是**新的**那一段） */
export type SessionMigrateResult = SessionHandoffResult;

export interface SessionRollbackParams {
  sessionId: string;
  /** 从这个下标起（含）删掉；越界回 `bad-index`（不静默截断） */
  index: number;
}

export interface SessionRollbackResult {
  /** 删掉了多少条 */
  removed: number;
  /**
   * 被删掉的第一条用户消息的**原始**文本（客户端可拿去预填输入框）。
   *
   * 服务端不剥「工作目录备注」那类装饰：那是客户端拼进去的，也该由客户端还原。
   */
  prompt: string;
  /** 撤回之后剩下的全部消息（客户端直接重渲染，不用再要一次快照） */
  messages: Message[];
}

/**
 * 取某个子 Agent 到目前为止的完整对话。
 *
 * 为什么不走「客户端自己从事件流里攒」：客户端可能是在子 Agent 已经跑了一半时才切到
 * 那个栏目的（甚至是从没收到过 `started` 的连接），攒出来的只能是半截。服务端是唯一
 * 真相源 —— 与 `session.snapshot` 同一个理由。
 */
export interface SubAgentSnapshotParams {
  sessionId: string;
  subAgentId: string;
}

export interface SubAgentSnapshotResult {
  subAgentId: string;
  /** 本轮内从 1 起（与栏目标签的序号一致） */
  index: number;
  status: "running" | "done" | "failed";
  /** 它到目前为止的完整对话（从第 0 条起，服务端原样给，不解释形状） */
  messages: Message[];
}

// ==================== 事件 ====================
//
// 这些写成 `type` 而不是 `interface`：`interface` 不会隐式获得索引签名，于是
// 无法直接传给 `Connection.send(event: EventFrame)`（`EventFrame` 带 `[key: string]: unknown`）。
// 写成类型别名则天然兼容，不需要在发送处加一次 `as` 断言。

/**
 * 一轮开始（core `open`）。
 *
 * 载荷只留最小可用的一份：谁、哪一轮。**没有正文** —— `open` 是「请求发出去了」这个
 * 事实，内容要到后面那串 `chunk-parsed` 里才出现。
 */
export type AgentOpenEvent = {
  event: typeof AGENT_EVENTS.open;
  sessionId: string;
  turnId: number;
};

/**
 * 一片原始 chunk 到达（core `chunk`：**早于**同一片的 `chunk-parsed`）。
 *
 * `chunk` 原样搬 core 给的那个对象：**厂商形状，协议不解释**（OpenAI 的
 * `ChatCompletionChunk`，外加各家自己塞进来的 `reasoning_content` 之类）。所以类型是
 * `unknown`：在这里另造一份形状的话，core 或厂商加一个字段就得改两处，而协议并不比 core
 * 更懂它。它来自 HTTP 响应体，本来就能 JSON 序列化，可以原样上线。
 */
export type AgentChunkEvent = {
  event: typeof AGENT_EVENTS.chunk;
  sessionId: string;
  turnId: number;
  /** 有它就属于那个**子 Agent** 的对话（与 `chunk-parsed` 同一个判据） */
  subAgentId?: string;
  chunk: unknown;
};

/**
 * 同一片解析完、receiver 就地更新之后（core `chunk-parsed`）：正文 / 推理增量。
 *
 * 名称与时机都照 core：`parseStreamData` 每消费一片就先把 delta 拼进 `receiver`，然后才
 * 发 `chunk-parsed`，所以这条事件里出去的永远是**解析之后**的增量。
 */
export type AgentChunkParsedEvent = {
  event: typeof AGENT_EVENTS.chunkParsed;
  sessionId: string;
  turnId: number;
  /** 正文增量（只带推理内容时为空串） */
  text: string;
  /** 推理增量（推理模型才有） */
  reasoning: string;
  /**
   * 有它就属于那个**子 Agent**，没有就是主 Agent。
   *
   * 一条增量通道同时承载两层对话，靠这个字段分流；缺省（不等于空串）表示主 Agent，
   * 于是老客户端不改也能继续把主对话读对。
   */
  subAgentId?: string;
  /**
   * 真实用量（流末 chunk 才有）：客户端用它校准本轮速率。
   *
   * 一条「只带 usage」的增量也会因此推出去（`text`/`reasoning` 都是空串）—— 不带它，
   * 状态栏的 tok/s 就只能靠估算（按字符折算，中文偏差不小）。
   */
  usage?: { completionTokens: number };
};

/** 流结束、receiver 定稿（core `parsed`）：此后这一轮的正文不再变 */
export type AgentParsedEvent = {
  event: typeof AGENT_EVENTS.parsed;
  sessionId: string;
  turnId: number;
};

/**
 * 一条消息被追加或就地改完（core `message`）：载荷是**完整的**那条消息。
 *
 * ## 为什么需要它
 *
 * 有些消息根本不是从流里来的：用户消息（`send` 那一瞬构造）、占位 assistant（内循环开头
 * 构造，之后的 chunk 往它上面折）、工具结果（工具**执行**的产物）。它们只能整条给 ——
 * 客户端拿 chunk 无论怎么折都折不出来。
 *
 * ## 为什么载荷是消息本身
 *
 * `message.id` 必填且全局唯一（core `AgentNS.Message`），所以它就是 upsert 键：收到同 id 时
 * 整条替换、没见过则追加到末尾。工具结果因此可以**先 `pending` 后终态**发两次（参数与
 * 名字先上屏，结果跑完再补上），客户端不需要为「同一条消息的两阶段」再写一套合并规则。
 *
 * 不另造中间形状（“工具结果事件”之类）：core 手里那条就是线上那条，多一层包装就多一处会漂。
 */
export type AgentMessageEvent = {
  event: typeof AGENT_EVENTS.message;
  sessionId: string;
  turnId: number;
  /** 有它就属于那个**子 Agent** 的对话（与 `chunk-parsed` 同一个判据） */
  subAgentId?: string;
  message: Message;
};

/**
 * 一条已经定型的工具结果消息上线（core `tool-call-end`：每个工具各发一次，并行时谁先
 * 跑完谁先发）。
 *
 * `message` 是**那一条消息本身**，原样搬运：协议不解释它的字段，也不在这里另造一个
 * 「工具结果」的中间形状 —— 中间形状迟早与 core 里那份真消息漂开（core 加一个字段，客户端
 * 就得等协议也加一个），而这条事件的意义恰恰是「服务端是唯一真相源，客户端照着渲染」。
 *
 * 为什么不等到轮末的快照：`session.snapshot` 要等 `session-turn-end` 之后才拿得到，而一个
 * 长轮次里工具能跑好几分钟，用户盯着参数卡片看不到它跑出了什么。为什么只推工具结果：
 * 流式中的 assistant 消息还在拼，客户端已经在用 `chunk-parsed` + 占位消息画它了，从这里
 * 再推一遍就会出现同一条消息的两种表示。
 *
 * 为什么判据是「定型了吗」而不是「下标越过游标了」：core 在工具**执行前**就把结果消息
 * 追加进 `agent.messages`（`Message.Tool` → `status: "pending"`、正文为空），跑完才就地
 * 翻成终态 —— 于是并行时先完成的那条往往排在**后面**。只按下标往后推会把还在跑的那条
 * （正文空）当成结果发出去，而「等前面那条跑完再往后推」又会让先完成的干等后完成的。
 */
export type AgentToolCallEndEvent = {
  event: typeof AGENT_EVENTS.toolCallEnd;
  sessionId: string;
  turnId: number;
  /**
   * 刚定型、刚追加进会话的那一条消息（今天是 `role: "tool"` 的工具结果）。
   *
   * 类型是 `Message`（从 `./model.js` 转出的 core 类型）：与
   * `SessionSnapshotResult.messages` 同一份形状 —— 它就是服务端手里那一条，协议只搬运、
   * 不在这里另造中间形状。
   */
  message: Message;
};

/**
 * 一轮出错（core `error`：**早于** `finally`）。
 *
 * `Error` 实例不能上线（`message` / `stack` / 自定义字段都不是 JSON 能原样还原的东西），
 * 所以摊成两个字段：机器可判的 `code` 与给人看的 `message`。`code` 缺省是 `internal`
 * —— 与 `session-turn-end` 里那份失败原因同一口径（同一次错误有两个出口，别让它们说的
 * 不是同一件事）。
 */
export type AgentErrorEvent = {
  event: typeof AGENT_EVENTS.error;
  sessionId: string;
  turnId: number;
  error: { code: string; message: string };
};

/**
 * 一轮收尾（core `finally`）。
 *
 * 只带「谁、哪一轮」：core 的 `finally` 是个空载荷通知，它的意义全在**时机**上 —— 客户端
 * 拿它知道 core 那一侧说完了。落盘、换 id、回收判定都还没做，所以它**不是**
 * `session-turn-end`（见 `SESSION_EVENTS.turnEnd`）：两条事件时机不同，都要发，顺序恒为
 * `error`? → `finally` → `session-turn-end`。
 */
export type AgentFinallyEvent = {
  event: typeof AGENT_EVENTS.finally;
  sessionId: string;
  turnId: number;
};

/**
 * 一个子 Agent 开始了。
 *
 * `index` 是**展示用的序号**（本轮内从 1 起，栏目标签「子AGENT1」直接印它）；
 * `subAgentId` 是**稳定标识**（客户端拿它当选中态与 React key）。两者分开是因为它们
 * 回答不同的问题：「用户看到的第几栏」与「是哪一次委派」。`index` 每轮都会重来，所以
 * 它不能当 id 用；反过来，id 带上展示含义之后，改一次标签就得动一次 id。
 */
export type AgentSubAgentStartEvent = {
  event: typeof AGENT_EVENTS.subAgentStart;
  sessionId: string;
  turnId: number;
  subAgentId: string;
  index: number;
};

/**
 * 一个子 Agent 结束了。
 *
 * `failed` 是**终态**：出错之后即便 SDK 还会发结束事件，也绝不能改回 `done` ——
 * 否则界面上一个真的失败了的子任务会显示成成功。
 */
export type AgentSubAgentEndEvent = {
  event: typeof AGENT_EVENTS.subAgentEnd;
  sessionId: string;
  turnId: number;
  subAgentId: string;
  status: "done" | "failed";
};

/**
 * 一条 Agent 事件的联合（10 条，名字与 core `Agent.events` 逐字相同）。
 *
 * 名字全部带 `Agent` 前缀：联合里一眼能看出作用域，与 `SessionEvent` 拼成 `ServerEvent`
 * 时也不会读成「同一类东西」。
 */
export type AgentEvent =
  | AgentOpenEvent
  | AgentChunkEvent
  | AgentChunkParsedEvent
  | AgentParsedEvent
  | AgentMessageEvent
  | AgentToolCallEndEvent
  | AgentErrorEvent
  | AgentFinallyEvent
  | AgentSubAgentStartEvent
  | AgentSubAgentEndEvent;

/**
 * 生成阶段（`SESSION_EVENTS.phase`）。
 *
 * **派生**事件：服务端在 `open` / 每个 `chunk-parsed` / `parsed` / 每个 `tool-call-end`
 * 那一刻按状态机算一份整的阶段推上来 —— 客户端不自己推阶段（三个前端各推一遍就会各错
 * 一遍）。
 */
export type SessionPhaseEvent = {
  event: typeof SESSION_EVENTS.phase;
  sessionId: string;
  turnId: number;
  /** null = 本轮已收尾、回到空闲 */
  phase: PhaseInfo | null;
};

/**
 * 一项工具调用的组装态（`session-tool-calls` 载荷里的元素）。
 *
 * 字段与 core 里那条正在拼的 assistant 消息同形（`receiver.tool_calls[index]`）：这不是
 * 巧合 —— 服务端只做搬运，不重新解释它的含义。
 */
export interface ToolCallState {
  /**
   * 本轮内的下标（并行时区分不同调用）。
   *
   * 客户端按它就地更新：同一个 `index` 的多次上报是**同一个调用在长大**，不是新调用。
   * 名字与参数片段可能分几个 chunk 到达，靠 `id` 认领会漏掉 `id` 还没到的那一两片，
   * 所以归并键是 `index`（`id` 到了之后也一样按 `index` 归并，别换成 `id`）。
   */
  index: number;
  /** 工具名（core 只在首个 delta 里给，后续 delta 只带参数片段） */
  name: string;
  /** 调用 id（core 收到第一个带 `id` 的 chunk 之后才有）：客户端拿它和工具结果配对 */
  id?: string;
  /** 组装到此刻的参数串（**可能还不是合法 JSON**：正在流的时候它本来就是半截） */
  arguments: string;
}

/**
 * 本轮工具调用的组装态（见 `SESSION_EVENTS.toolCalls` 的三条「为什么」）。
 *
 * `toolCalls` 是**全集**而不是「这一片新增了什么」：客户端拿它整体替换自己手上的那一轮
 * 工具调用列表，不必攒片段。
 */
export type SessionToolCallsEvent = {
  event: typeof SESSION_EVENTS.toolCalls;
  sessionId: string;
  turnId: number;
  toolCalls: ToolCallState[];
};

/**
 * 一轮**真正**结束（成功或失败）：core 的 `finally` 之后，落盘、换 id、回收判定都做完了。
 *
 * 与 `AgentFinallyEvent` 的区别只有时机，但那一点足够分成两条事件：客户端在这条上才该
 * 「当成这一轮结束了」去拉快照（`finally` 时存档还没写）。`ok` 与 `error` 是给收尾用的
 * 结论，与 `AgentErrorEvent` 里那份错误同源。
 */
export type SessionTurnEndEvent = {
  event: typeof SESSION_EVENTS.turnEnd;
  sessionId: string;
  turnId: number;
  ok: boolean;
  /** 失败时的机器可判原因 */
  error?: { code: string; message: string };
};

/** 通知级别：只要客户端能据此选颜色/语气，不要更细的语义 */
export type NoticeLevel = "info" | "warn" | "error";

/**
 * 对话内通知的 code 表。
 *
 * **只增不改语义**：code 一旦发出去就是协议的一部分，改了等于客户端文案失配。
 * 客户端按 `notice.<code>` 查自己的 i18n 表渲染 —— 服务端不产文案。
 */
export const SESSION_NOTICE_CODES = {
  /** 会话落盘失败（用户以为存了，其实没存） */
  persistFailed: "persistFailed",
  /** 交接/迁移降级（请求的执行者与实际执行者不一致） */
  migrationDegraded: "migrationDegraded",
  /** 本轮被中止 */
  turnAborted: "turnAborted",
  /** 开始写交接文档（`params.mode` 是请求的执行者） */
  handoffWriting: "handoffWriting",
  /** 自动迁移被触发（`params` 带 `used` / `limit` / `mode`） */
  handoffAutoDetected: "handoffAutoDetected",
  /** 交接文档落在这个路径（`params.path`） */
  handoffPath: "handoffPath",
  /** 迁移前把旧会话存进了存档（`params.sessionId` 是**旧**会话） */
  handoffArchived: "handoffArchived",
  /** 迁移完成、新会话已开启（`params.n` 是新会话第一条上下文的消息数） */
  handoffMigrated: "handoffMigrated",
  /** 紧跟在 `handoffMigrated` 后面那条补充（新助手会先读交接文档） */
  handoffMigratedHint: "handoffMigratedHint",
  /** 用户在提问里选了「不交接」/ 没人答 → 本次跳过迁移 */
  migrationSkipped: "migrationSkipped",
  /** 子 Agent 出错（`params.message` 是原始错误文本；`params.index` 是本轮序号） */
  subAgentFailed: "subAgentFailed",
} as const;

/**
 * 服务端通知的 code 表（`server-notice` 载荷里的枚举；同上：只增不改语义）。
 *
 * 名字跟事件表走（`SERVER_EVENTS` ↔ `SERVER_NOTICE_CODES` ↔ `ServerNoticeCode`）：一张
 * 表叫 SERVER、旁边的码表叫别的，读的人只能靠猜两者是不是同一件事。**表的 key 改的是
 * 类型名，不是 code 的字面量**（那些是客户端 i18n 表的键，改字面量等于让词典失效），
 * 所以改名对线上零影响。
 */
export const SERVER_NOTICE_CODES = {
  /** MCP server 连不上 */
  mcpUnavailable: "mcpUnavailable",
  /** 存档目录不可用（读/写失败） */
  storeUnavailable: "storeUnavailable",
} as const;

export type SessionNoticeCode = (typeof SESSION_NOTICE_CODES)[keyof typeof SESSION_NOTICE_CODES];
export type ServerNoticeCode = (typeof SERVER_NOTICE_CODES)[keyof typeof SERVER_NOTICE_CODES];

/** 对话内通知：与某一段会话绑定 */
export type SessionNoticeEvent = {
  event: typeof SESSION_EVENTS.notice;
  sessionId: string;
  level: NoticeLevel;
  code: SessionNoticeCode;
  /** 文案里的可变部分（客户端代入自己的模板） */
  params?: Record<string, unknown>;
};

/** 服务端通知：不属于任何会话，切会话也不该消失 */
export type ServerNoticeEvent = {
  event: typeof SERVER_EVENTS.notice;
  level: NoticeLevel;
  code: ServerNoticeCode;
  params?: Record<string, unknown>;
};

/**
 * 一条通知的**载荷**：`level` + `code` + `params`，不含「属于哪段会话」与事件名。
 *
 * 抽出来是因为三处都在说同一件事：协议里的 `SessionNoticeEvent`、会话层的
 * `notice()` / `noticeIfAlive()`、交接服务的通知出口。少声明一份，就少一处会漂的形状。
 */
export type NoticePayload = Omit<SessionNoticeEvent, "event" | "sessionId">;

/**
 * 一条会话事件的联合（7 条，服务端派生 / 自己决定的那部分）。名字全部带 `Session`
 * 前缀：联合里一眼能看出作用域，与 `AgentEvent` / `ServerNoticeEvent` 拼成 `ServerEvent`
 * 时也不会读成「同一类东西」。
 */
export type SessionEvent =
  | SessionPhaseEvent
  | SessionToolCallsEvent
  | SessionTurnEndEvent
  | SessionNoticeEvent
  | SessionQuestionEvent
  | SessionIdChangedEvent
  | SessionTitleChangedEvent;

/**
 * 服务端能推给客户端的全部事件 = Agent 的 10 条 + 会话的 7 条 + 服务端自己的通知 1 条。
 *
 * 三张表都要在这里合上：少了 `AgentEvent`，客户端就订阅不到 `chunk-parsed` / `open`
 * 这类 core 原名事件（类型上不认识 = 写不出来 = 收不到），而那正是这次改名的目的。
 */
export type ServerEvent = AgentEvent | SessionEvent | ServerNoticeEvent;
