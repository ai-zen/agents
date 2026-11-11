/**
 * 一段**活着的**会话的形状 —— 四个类共用的那张对象。
 *
 * ## 为什么单独一个文件
 *
 * 它不是任何一个类的私有财产：`SessionManager` 管它的注册与回收，`EventBridge` 管它上面的
 * 流式影子（`subAgents`），`Persistence` 读它的存档字段（`title` /
 * `modelId` / `autoPersist`…），`QuestionBroker` 管它挂着的提问。
 *
 * 拆成四个类之后，如果这张形状留在其中某一个类里，另外三个就得 `import` 那个类 —— 那正是
 * 「拆了但还在一个团里」。所以形状单独一处，四边都只依赖它：**谁拥有哪个字段写在这里**，
 * 各字段的注释点名它的主人（这是拆分之后判断「这块该不该动」的依据）。
 *
 * 语义上的归属（见 `docs/zh/architecture.md` 的「`SessionManager` 的四件」）：
 *
 *   注册表 / 回收      `holders` / `reclaimCancel` / `reclaimOnSettle`
 *   turn 生命周期      `turnId` / `turnSettled` / `turnFailed` / `settleDeferred`
 *   流式影子           `subAgents` / `subAgent*Seq`
 *   存档               `title` / `modelId` / `modelParams` / `autoPersist` / `updatedAt`
 *   提问               `questions` / `questionSeq`
 *
 * 这些字段仍然**长在同一个对象上**（不是四张表）：它们说的是同一段会话的四个面，
 * 分成四张表就意味着四条「按 id 查回来」的路径，而那种查不到的状态最难解释。
 */

import type { PhaseTracker } from "../../lib/phase.js";
import type { SessionHandoff } from "../handoff/SessionHandoff.js";
import type {
  Message,
  MessageContent,
  ModelLevel,
  SessionQuestionKind,
  Usage,
} from "../../protocol/index.js";

/**
 * 能跑一轮对话的 Agent 的最小面。
 *
 * 结构性类型（不是 SDK 的 `Agent`）：SDK 的 Agent 天然满足它，本包也不必把
 * core 的类型体系拖进来 —— 与本包 `PhaseMessageLike` 同一个理由、同一个 `*Like` 后缀。
 *
 * 不叫 `SessionAgent`：那读起来像「一种 Agent」，而它只是 Agent 的一个**面**（能跑会话）。
 */
export interface AgentLike {
  /** 当前消息列表。**可写**：续接存档时由会话管理器整体换成存档里的那份 */
  messages: Message[];
  /** 最近一轮用量（SDK 的 Agent 有；假件可以不给） */
  readonly lastUsage?: Usage;
  /** 实发模型名（快照会把它带给客户端拼图片内容块；假件可以不给） */
  readonly model?: string;
  /**
   * 生效模型来自哪一级（SDK 解析出来的档位，快照原样透传给客户端）。
   *
   * **必填**：这一位没有「缺省档」可言 —— 猜一个就能让选择器把「当前生效」标错，
   * 而那种错没人会怀疑。假件照抄真件给一个值（它们本来就该与真件同形）。
   */
  readonly modelLevel: ModelLevel;
  /** 返回本轮产出（SDK 返回 `Message[]`）；会话管理器不看它，进展走事件 */
  send(input: MessageContent): Promise<unknown>;
  abort(): void;
  /**
   * SDK 的事件流（`@ai-zen/event-bus`）。
   *
   * 载荷是**多参**的，而且每个事件不一样：`chunk-parsed` 是 `(receiver, chunk)`，
   * `sub-agent-start` 是 `({ subAgent })`，`open` / `finally` 没有载荷。这里写 `(...args)`
   * 而不是 `(payload)` 是故意的：写成单参时，监听器只收一个参数也能过编译 —— 而第一个
   * 参数是那条**正在拼的消息**，不是 chunk（`EventBridge` 的 `onChunk` 读的正是第一个
   * 参数），少一个位置就把正文增量全掉了。类型说诚实话，比它“好用”重要。
   */
  events: {
    on(event: string, handler: (...args: any[]) => void): void;
    off(event: string, handler: (...args: any[]) => void): void;
  };
}

/**
 * 被委派出去的子 Agent 在本层需要的那两面：**它自己的**对话与**它自己的**事件流。
 *
 * 与 `AgentLike` 同一个理由（结构性类型、`*Like` 后缀）：SDK 的子 Agent 天然满足它，
 * 本包不必为此把 core 的类型体系拖进来，测试也能用一个最小的假件驱动整个流程。
 */
export interface SubAgentLike {
  messages: Message[];
  events: {
    // 同 `AgentLike.events`：载荷是多参的（`chunk-parsed` = `(receiver, chunk)`）
    on(event: string, handler: (...args: any[]) => void): void;
  };
}

/**
 * 一个子 Agent 在会话层的条目。
 *
 * `agent` 字段**只在本层用**（取 `messages`、挂事件监听），不进协议：客户端拿到的
 * 是数据（`SubAgentSnapshotResult.messages`），不是对象 —— 远程时这个实例根本不在
 * 客户端那边。
 *
 * 归属：`EventBridge`（子 Agent 的栏目标签只活一轮，清空在 `clearSubAgents`）。
 */
export interface SubAgentEntry {
  id: string;
  index: number;
  agent: SubAgentLike;
  /**
   * 三态，可变：`running` → `done` / `failed`。
   *
   * **`failed` 是终态**：出错之后 SDK 还会发 `sub-agent-end`，那条路径必须先看这个
   * 字段再决定是否发 `ended{done}`，否则真实的失败会在界面上变成「跑完了」。
   */
  status: "running" | "done" | "failed";
}

/**
 * 一次提问的规格（服务端 → 客户端）。
 *
 * 字段与协议里的 `SessionQuestionEvent` 一一对应，只多了 `fallback` 的语义收口：
 * 它是「没人答/答不了时服务端自己用什么收场」，由提问方给（哪条路安全只有它知道）。
 */
export interface AskQuestionSpec {
  kind: SessionQuestionKind;
  input: "select" | "text";
  options?: readonly string[];
  params?: Record<string, unknown>;
  allowSkip?: boolean;
  fallback: string | null;
}

/**
 * 一个挂着等回答的提问（`resolve` 收场，`fallback` 是没人答时的取值）。
 *
 * 归属：`QuestionBroker`（表在会话上，认领与清表都在那边 —— 清表是「来晚了」的唯一判据）。
 */
export interface PendingQuestion {
  resolve: (choice: string | null) => void;
  fallback: string | null;
}

/** 一段活着的会话（字段归属见文件头那张表） */
export interface LiveSession {
  id: string;
  workspaceId: string;
  /** 工作区路径：重建 Agent（reload）时要再交给装配方 */
  path: string;
  agentId: string;
  agent: AgentLike;
  /** 会话内的轮次编号（只增不清零；事件靠它归轮） */
  turnId: number;
  /** 阶段状态机（纯，见 `lib/phase.ts`）；`EventBridge.phaseOf` 负责「对外怎么报」 */
  phase: PhaseTracker;
  /** 本轮是否已经出过错（`error` 与 `finally` 都会到，收尾只报一次） */
  turnFailed: { code: string; message: string } | null;
  turnSettled: boolean;
  /**
   * 这一轮的收尾由交接/迁移方法自己负责（见 `settleTurn`）。
   *
   * 交接回合本身也是一次 `agent.send()`，SDK 会照常发 `finally`；不拦一下，
   * `self` 模式会在文档还没校验、历史还没剔除时就宣布本轮结束。
   */
  settleDeferred: boolean;
  /**
   * 这一轮收尾时要不要把会话写进存档（见 `Persistence.writeOnSettle`）。
   *
   * 只由「会产生对话内容」的回合置位：`send` / `handoff`。
   * `migrate` **不能**置位——它在交接前已经把**完整历史**存进旧 id，之后才把消息剔除；
   * 如果收尾时再无条件写一次，写下去的会是被 prune 过的版本，把刚存好的完整存档盖掉。
   * `autoMigrate` 反过来是安全的：它跑在 `send` 的那一轮里，收尾时 id 已经换成新的，
   * 写下去的就是新会话的开场。
   *
   * 同一条标记也是「这一轮真正的终点」的判据，所以回收判定也挂在它上：`migrate` 中场
   * 那次收尾不能触发回收（那时会话正要换 id）。
   */
  persistOnSettle: boolean;
  /**
   * 会话级的「自动落盘」策略：每轮收尾要不要写存档。
   *
   * 与上面那个**每轮**的 `persistOnSettle` 是两件事，别混：
   *   · `persistOnSettle` —— 这一轮该不该写（`migrate` 的中场收尾不写）；
   *   · `autoPersist` —— 这段会话值不值得写（一次性调用根本不进存档）。
   * 两个都为真才落盘。`false` 时想留档只有显式 `save`（CLI 的 `ai --save`）。
   */
  autoPersist: boolean;
  /**
   * 展示名（与 `id` 是两个事实：id 是身份，它是名字，改了不动 id）。
   *
   * `undefined` = 还没起过名：客户端拿首条用户消息兜底，服务端的自动标题也只在这种
   * 情况下写（不覆盖手改，见 `autoTitle`）。
   */
  title?: string;
  /**
   * 会话级模型覆盖（三级解析的最内层）：本字段 > `AgentDefinition.modelId` > `AppConfig.defaultModel`。
   *
   * 之所以不直接改写 `agent.modelConfig`：它是**这段会话**的意思，不该抹到 Agent 定义上
   * （那会改动所有用同一个 Agent 的会话）。换 Agent 时会被清掉（见 `setAgent`）。
   */
  modelId?: string;
  /**
   * 会话级模型**参数**覆盖（与上面那个 `modelId` 同一级）。
   *
   * 不透明载荷：本包不解释键名，只当数据搬（存档 ↔ 内存 ↔ 装配方），与 `messages` 同一
   * 口径。什么时候它真正生效由 SDK 按档位决定（`resolveModelParams`）—— 参数跟着「模型
   * 来自哪一级」走，模型来自 Agent 定义 / 全局兜底时这一份**不参与**合并（会话级模型配上
   * 定义级参数，等于把旧模型的 `thinking` 发给新模型，端点回 400）。
   *
   * 换模型（`setModel`）与换 Agent（`setAgent`）都会清掉它：目标模型不一定接受旧参数，
   * 与 `agent.model.set` 清思考参数同一个理由。
   */
  modelParams?: unknown;
  /** 最后一次活动的时刻（ISO）：列表排序与「运行中」的判断都不靠文件系统 */
  updatedAt: string;
  /**
   * 此刻看着这段会话的连接（不透明的连接 id）—— **「活着」的唯一判据**。
   *
   * 用 `Set` 而不是一个 id：一段会话被终端与桌面端**同时**看着是常态，谁先走都不该
   * 影响另一个。id 的类型留在 `number` 而不是 daemon 的 `Connection` —— 这一层不认识
   * 传输层，会话层只需要「若干个互不相干的身份」。
   *
   * 规则只有三句（见 `SessionManager` 文件头）：有持有者 → 活着；全没了 → 宽限期后回收；
   * `session.close` → 立刻回收。
   */
  holders: Set<number>;
  /** 正在跑的回收倒计时（取消函数）；`null` = 没在计时 */
  reclaimCancel: (() => void) | null;
  /**
   * 倒计时到点时这一轮还在跑：等它收尾再收（见 `reclaimNow`）。
   *
   * 必须记下来而不是「到点直接什么都不做」：一轮中途被收的代价是那一轮的产出与存档
   * 一起丢（`detach()` 之后 `settleTurn` 不再跑），所以只能延后，不能取消。
   */
  reclaimOnSettle: boolean;
  /** 交接服务（首次交接时创建；持有取消句柄，见 `handoffOf`） */
  handoff: SessionHandoff | null;
  /**
   * 本轮的子 Agent（subAgentId → 条目）。
   *
   * 生命周期**只到本轮结束**：一轮结束后主 Agent 已给出最终答案，子 Agent 只剩历史
   * 价值，留着会让栏目标签永远停在上一轮；`reload` / `adopt` / `close` 换了 Agent 或
   * 换了会话 id，也一并清（它们换的是同一段会话的「底座」，旧条目上的实例已不再被
   * 任何东西引用）。清空地集中在 `EventBridge.clearSubAgents`。
   */
  subAgents: Map<string, SubAgentEntry>;
  /** 展示序号（本轮内从 1 起，每轮归零：标签回到「子AGENT1」） */
  subAgentSeq: number;
  /** id 序号（与展示序号分开：id 要稳定且不带含义，见 `EventBridge.attach` 的注释） */
  subAgentIdSeq: number;
  /**
   * 等客户端回答的问题（`questionId` → resolve）。
   *
   * 一个会话同一时刻只会有 0 或 1 个（自动迁移是串行的：`settleDeferred` 占着坑），
   * 仍用 Map 是因为「过期的回答一律拒」这条判定靠它：认领时按 id 查表，查不到就是来晚了
   * （超时 / 已答过 / 会话已收），而那三种情况对客户端是同一件事 —— 不必重试。
   */
  questions: Map<string, PendingQuestion>;
  /** 提问序号（只在会话内递增）：认领靠它的而不是轮次，一轮里可以问不止一次 */
  questionSeq: number;
  /** 摘掉这个 Agent 上挂的全部 SDK 事件监听（`EventBridge.attach` 的返回值） */
  detach: () => void;
}
