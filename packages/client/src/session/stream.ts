/**
 * `SessionStream` —— 「一轮之内前端必须持有的状态」的**唯一实现**，纯状态机。
 *
 * ## 为什么它必须存在（而不是让每个前端自己想）
 *
 * 审计的核心结论：这一块**不是展示**。它决定「屏幕上的答案会不会凭空短一截」「子任务
 * 失败会不会被显示成成功」「这一轮到底结束没有」—— 三个前端都会错，而且会错得一样。
 * 现在这套逻辑写了两遍（CLI 1276 行、桌面端 773 行），能复用的只有 126 行的
 * `stream-merge.ts`。于是把它收成两份里**唯一**一份，纯到可以直接单测：
 * 现在 TUI 的状态机只能靠 ink 渲染反推，一个竞态要摆一台终端才能看出对不对。
 *
 * ## 纯到什么程度
 *
 * 零 I/O、零 UI 框架、零 timers、零进程级全局：进的是协议事件与快照，出的是一个不可变的
 * 状态对象。所有「等一个往返」「断线重连」「谁去要快照」都在 `SessionChannel`（脏的那一半）。
 * 这条边界是硬的：本文件夹的用例**不许**起 daemon、开 socket、或装假时钟 —— 一旦需要，
 * 说明设计错了，回头改设计，不要改测试。
 *
 * ## 三个「不许」
 *
 * 1. **不许自己实现合并规则**：`settle()` 与 `applySnapshot()` 都走 `stream-merge.ts` 的
 *    {@link mergeStreamedSnapshot}。那份规则（尤其「宁可重复也不吞字」）是唯一实现，
 *    在这里再写一遍就多一份会漂的答案，而漂移只在竞态里显形。
 * 2. **不许 import `@ai-zen/agents-core` 的运行期值**：`ROLE` 用 `stream-merge.ts` 的
 *    字面量镜像（`AgentNS.Role` 是 enum，属于运行期值）；类型一律 `import type`。
 *    `totalUsage` 也一样 —— 它是 core `sumUsage` 的口径镜像，见 {@link sumUsage}。
 * 3. **`failed` 是终态**：`settle()` 不许把它擦成 `idle`（CLI 已经踩过：core 的
 *    `onSubAgentEnd` 在 `finally` 里分发，失败的那次照样会来一条收尾事件，无脑覆盖会把 ✖
 *    擦成 ✓）。只有 `beginTurn()`（新一轮开始）与 `applySnapshot()`（换基线）能清掉它。
 *
 * ## 状态形状为什么是这几个字段
 *
 * 它们是 CLI 那颗屏幕**现在就在读**的那几个事实，一个都不能少：少一个，P4 就得自己再存
 * 一份，于是「同一件事两个定义」又回来了。逐个数：
 *
 *   · 消息（`messages`）、阶段（`phase`）、子 Agent（`subAgents`）、用量（`lastUsage` /
 *     `totalUsage`）、这一轮结束没有（`turnId` / `status` / `failure`）；
 *   · 模型四件：生效 id（`modelId`）、它来自哪一级（`modelLevel`）、**实发名**（`apiModel`，
 *     拼图片内容块时按它反查端点与视觉能力 —— 缺了会把带图提交静默降级成纯文本）、
 *     生效参数覆盖及其档位（`modelParams` / `modelParamsLevel`，桌面端的「思考强度」要显示
 *     现在是什么值，而「这份值取自哪一层」只有服务端算得出来）。
 *
 * 形状对齐的是**现有屏幕的需要**，不是某个新前端的想象。
 */

import type {
  Message,
  ModelLevel,
  ModelParams,
  PhaseInfo,
  SessionSnapshotResult,
  SubAgentSnapshotResult,
  ToolCall,
  ToolCallState,
  Usage,
} from "@ai-zen/agents-protocol";
import {
  ROLE,
  mergeStreamedSnapshot,
  withAssistantText,
  type StreamedAssistant,
} from "../stream-merge.js";

/** 一轮的生命周期三态（`failed` 是终态，见文件头第 3 条） */
export type SessionStatus = "idle" | "streaming" | "failed";

/** 子 Agent 的执行状态（`failed` 一旦置上就不再变） */
export type SubAgentStatus = "running" | "done" | "failed";

/** 本轮的失败原因：机器可判的 `code` + 服务端给的原话，**文案由应用决定** */
export interface TurnFailure {
  code: string;
  message: string;
}

/**
 * 屏幕上「子AGENT{n}」那一栏所需的全部事实。
 *
 * 刻意是**数据**而不是子 Agent 实例：实例只存在于「Agent 跑在这个进程里」那种形态，
 * 而现在 Agent 在服务端，客户端能拿到的是消息。`index` / `id` 都由服务端给 ——
 * 客户端自己数就会多出第二份会漂的答案（「哪个是子AGENT2」只有分配方知道）。
 */
export interface SubAgentView {
  /** 稳定 id（React key / 选中态用它） */
  id: string;
  /** 出现序号（本轮内从 1 起）：栏目标签直接印它 */
  index: number;
  /** 它到目前为止的完整对话 */
  messages: Message[];
  status: SubAgentStatus;
}

/** 一份不可变的状态快照（每次变更换一个新对象，前端可以靠引用比较决定要不要重画） */
export interface SessionStreamState {
  /**
   * 当前这段会话的 id。
   *
   * 它**跟着 `session-id-changed` 走**：自动迁移会在一轮进行中换 id，而之后所有事件都用新
   * id 认领 —— 状态里没有它，前端就得自己再存一份（然后又是一个会漂的副本）。
   */
  sessionId: string;
  messages: Message[];
  phase: PhaseInfo | null;
  /** 在飞的那一轮；空闲 `null`。只由 `beginTurn()` 设置（只有发过一轮才知道自己等哪一轮） */
  turnId: number | null;
  /** 本轮的子 Agent 栏目（整份替换语义：每次变更都是新数组） */
  subAgents: SubAgentView[];
  /** 生效模型（三级解析的**结果**，由服务端给） */
  modelId: string;
  /** 上面那个模型来自哪一级 */
  modelLevel: ModelLevel;
  /**
   * **实发**模型名（端点上真正写的那个名字）。
   *
   * 与 {@link modelId}（配置里的身份）不一定相同 —— 用户可以在配置里给模型起别名。拼图片
   * 内容块时要按实发名反查端点与视觉能力（`file_id` 是端点维度资源）：读错了就把本来能带的
   * 图静默降级成纯文本，用户看到的是「模型没看懂图」。
   */
  apiModel: string;
  /**
   * 当前生效的模型参数覆盖（`thinking` / `reasoning_effort` 这类，键名协议不解释）。
   *
   * 桌面端的「思考强度」要显示**现在是什么值**。为什么不由客户端从「生效值 + 定义 + 默认」
   * 反推：那是优先级规则的第二份实现，反推出来的档位与真正发出去的请求迟早不一致。
   */
  modelParams?: ModelParams;
  /** 上面那份参数覆盖取自哪一级（与 {@link modelParams} 同进同出，由同一次解析给出） */
  modelParamsLevel?: ModelLevel;
  /** 最近一轮用量（服务端给才带：客户端不知道就别显示） */
  lastUsage?: Usage;
  /** 本次会话累计用量（按消息求和，含子 Agent 委派） */
  totalUsage: Usage;
  status: SessionStatus;
  /** 最近一次失败（`status === "failed"` 时才有） */
  failure?: TurnFailure;
}

/** 零用量：`totalUsage` 的起点 */
const ZERO_USAGE: Usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

/**
 * 按消息求和 token 用量 —— core `sumUsage()` 的**口径镜像**。
 *
 * 为什么这里必须有一份：本包不能 import `@ai-zen/agents-core` 的运行期值（那会把 openai
 * 拖进客户端的运行期依赖图，而「运行期只依赖协议包」是结构而不是纪律）。所以口径在这里
 * 按同一份规则重写：`message.usage`（本条响应）＋ `message.subAgentUsage`（内部委派），
 * **两者都要加** —— 只加前者会把子 Agent（含其孙级）的消耗静默漏掉。
 *
 * 漂移风险由用例钉住：`stream.test.ts` 里那条「工具消息上的 subAgentUsage 一起累加」
 * 用的是真 `AgentNS.Role` 造的数据、且期望值与 core 的 `sumUsage` 逐字相同。
 */
function sumUsage(messages: readonly Message[]): Usage {
  let acc: Usage = { ...ZERO_USAGE };
  for (const message of messages) {
    if (message.usage) acc = addUsage(acc, message.usage);
    if (message.subAgentUsage) acc = addUsage(acc, message.subAgentUsage);
  }
  return acc;
}

function addUsage(a: Usage, b: Usage): Usage {
  return {
    prompt_tokens: a.prompt_tokens + b.prompt_tokens,
    completion_tokens: a.completion_tokens + b.completion_tokens,
    total_tokens: a.total_tokens + b.total_tokens,
  };
}

/**
 * 占位 assistant 消息。
 *
 * **不带 `id`**：`Message.id` 是必填，但服务端在收尾快照里会给真 id，而屏幕在这一轮里
 * 不需要它（消息列表按顺序渲染）。编一个假 id 反而会在收尾时与快照里的真 id 打架 ——
 * 两条记录说的是同一条消息，id 却不同。所以只能断言（与 CLI 现在那份实现同一条）。
 */
function placeholder(): Message {
  return { role: ROLE.Assistant, content: "" } as Message;
}

/** `session-tool-calls` 的扁平载荷 → 消息里的嵌套形状（与 core 的 `ToolCall` 同形） */
function toToolCall(call: ToolCallState): ToolCall {
  return {
    index: call.index,
    // `id` 只有在场时才带：core 收到第一个带 id 的 chunk 之前那几片本来就没有 id，
    // 补成空串会让「与工具结果配对」这件事失效
    ...(call.id ? { id: call.id } : {}),
    type: "function",
    // 参数原样搬（半截 JSON 也照搬）：这一层不解析、不修补
    function: { name: call.name, arguments: call.arguments },
  };
}

export class SessionStream {
  private value: SessionStreamState;
  private readonly listeners = new Set<(state: SessionStreamState) => void>();
  /** 主会话正在拼的那条临时消息；不在生成中时为 `null` */
  private streaming: StreamedAssistant | null = null;
  /** 上面那条在 `messages` 里的下标（增量就地改它，屏幕才跟得上） */
  private streamSlot: number | null = null;
  /** 子 Agent id → 它正在拼的临时消息（与主会话的拼接状态**完全不共享**） */
  private readonly subAgentStreams = new Map<string, StreamedAssistant>();

  /**
   * 初值只有「首次快照到达前」的占位：`open()` 之后立刻会 `applySnapshot()` 把它盖掉。
   * `modelLevel` 给 `"agent"` 是照抄 CLI 那个占位值（界面在那之前不渲染模型信息）。
   */
  constructor(
    initial: Partial<Pick<SessionStreamState, "sessionId" | "modelId" | "modelLevel">> = {},
  ) {
    this.value = {
      sessionId: initial.sessionId ?? "",
      messages: [],
      phase: null,
      turnId: null,
      subAgents: [],
      modelId: initial.modelId ?? "",
      modelLevel: initial.modelLevel ?? "agent",
      // 实发名同样只有服务端知道（首次快照到达前是空串，界面在那之前不渲染模型信息）
      apiModel: "",
      totalUsage: { ...ZERO_USAGE },
      status: "idle",
    };
  }

  /** 当前状态（不可变：每次变更换一个新对象） */
  get state(): SessionStreamState {
    return this.value;
  }

  /** 订阅状态变更；返回解绑函数。**合帧由调用方决定**（这里只在真的变了之后通知） */
  onChange(listener: (state: SessionStreamState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ==================== 一轮的生命周期 ====================

  /**
   * 开始一轮。
   *
   * 它只做三件事：记下等的是哪一轮、把终态 `failed` 复位、把状态标成 `streaming`。
   * **不动**拼接态与消息：`chunk-parsed` 完全可能**比 `session.send` 的回执先到**
   * （服务端先推 `connecting` 再回 `turnId`），那时正文已经在拼了 —— 在这里清掉拼接态，
   * 那几片字就会在屏幕上裂成两条消息。
   *
   * 对同一轮重复调用是幂等的（调用方可能从事件与回执两处各调一次）。
   */
  beginTurn(turnId: number): void {
    if (this.value.turnId === turnId && this.value.status === "streaming") return;
    this.commit({ turnId, status: "streaming", failure: undefined });
  }

  /**
   * 一轮收尾：用服务端快照对账。
   *
   * 为什么不自己把流拼完整：工具调用、思考内容、`omit` 标记、用量都只有服务端有；客户端
   * 拼出来的只是一个「能滚动的近似」，回合结束后必须被真件替换掉。但**不能直接整份覆盖**：
   * 快照那个往返可能比第一批增量还慢，覆盖会让屏幕上已经流出来的正文短一截 ——
   * 所以走 {@link mergeStreamedSnapshot}（它已经处理了「本地更全」与「宁可重复也不吞字」）。
   *
   * `snapshot` 可以是 `null`：服务端刚重启 / 连接刚断，快照取不到。那时只把这一轮在本地
   * 收尾（拼接态、阶段、子 Agent 都收掉），消息保留本地那份近似 —— 下一轮收尾还会再同步。
   */
  settle(snapshot: SessionSnapshotResult | null): void {
    const merged = snapshot ? mergeStreamedSnapshot(snapshot.messages, this.streaming) : null;
    const messages = merged ? merged.messages : this.value.messages;
    // 一轮结束：拼接态就地丢掉（正文已经并进 messages，下一轮的增量要落到新的一条上）
    this.streaming = null;
    this.streamSlot = null;
    this.subAgentStreams.clear();
    const phase = snapshot ? snapshot.phase : null;
    this.commit({
      messages,
      totalUsage: sumUsage(messages),
      ...(snapshot
        ? {
            sessionId: snapshot.sessionId,
            modelId: snapshot.modelId,
            modelLevel: snapshot.modelLevel,
            apiModel: snapshot.apiModel,
            modelParams: snapshot.modelParams,
            modelParamsLevel: snapshot.modelParamsLevel,
            lastUsage: snapshot.lastUsage,
          }
        : {}),
      phase,
      // 服务端已空闲 → 这一轮不在飞了（`failed` 是终态，不许被这里擦成 idle）
      turnId: null,
      // 子 Agent 只活当前一轮：本轮内循环（含全部委派）已经结束，留着只是一份残影
      subAgents: [],
      status: this.value.status === "failed" ? "failed" : this.statusOf(phase, null),
    });
  }

  /**
   * 这一轮失败了（`session-turn-end{ok:false}` / 会话在断线期间没了）。
   *
   * `failed` 是**终态**：之后的 `settle()` / `applySnapshot()` 之外的任何动作都不许把它
   * 擦成成功。拼接态就地丢掉（这一轮不会再有增量了），消息保留 —— 已经流出来的字是用户
   * 该看到的半成品，删掉等于把「跑到一半断掉」伪装成「没跑过」。
   */
  failTurn(failure: TurnFailure): void {
    this.streaming = null;
    this.streamSlot = null;
    this.commit({ status: "failed", failure, turnId: null });
  }

  // ==================== 正文与工具调用 ====================

  /**
   * 正文 / 推理增量（累积到一条**临时** assistant 消息上）。
   *
   * 只带用量的收尾 chunk（`text` 与 `reasoning` 都是空串）**不进消息列表**：拼了会在转录里
   * 多出一条空 assistant。它照样有用（校准速率），但那是应用层的事（`SessionChannelPolicy`）。
   */
  applyDelta(delta: { text?: string; reasoning?: string }): void {
    const text = delta.text ?? "";
    const reasoning = delta.reasoning ?? "";
    if (!text && !reasoning) return;

    this.ensureStreaming();
    const streaming = this.streaming!;
    streaming.text += text;
    streaming.reasoning += reasoning;
    const messages = [...this.value.messages];
    const slot = this.streamSlot!;
    const message = withAssistantText(messages[slot]!, streaming.text, streaming.reasoning);
    messages[slot] = message;
    streaming.message = message;
    this.commit({
      messages,
      totalUsage: sumUsage(messages),
      status: this.value.status === "failed" ? "failed" : "streaming",
    });
  }

  /**
   * 本轮工具调用的**组装态**（整份替换语义）。
   *
   * 与正文增量刻意不同：参数是边流边长的，一个有意义的调用只在组装完成之后才存在，所以
   * 协议给的是「到现在为止是什么」，客户端按 `index` 就地更新、不往后追加（追加会把参数
   * 拼成两遍）。落在**正在流式的那条 assistant 消息**的 `tool_calls` 上 —— 它就是这条响应
   * 的一部分，收尾时由快照整份替换。
   */
  applyToolCalls(calls: readonly ToolCallState[]): void {
    this.ensureStreaming();
    const messages = [...this.value.messages];
    const slot = this.streamSlot!;
    messages[slot] = { ...messages[slot]!, tool_calls: calls.map(toToolCall) };
    this.streaming!.message = messages[slot]!;
    this.commit({
      messages,
      status: this.value.status === "failed" ? "failed" : "streaming",
    });
  }

  /**
   * 一条**已经定型**的工具结果消息上线（`tool-call-end`）。
   *
   * 原样搬进列表、不拼装、不补字段：它与收尾快照里的那条是同一份东西。同一个
   * `tool_call_id` 已经在了就**替换**（事件的多次投递 / 快照先到都会走到这儿），
   * 不追加 —— 追加的症状是同一条工具结果在屏幕上出现两遍。
   */
  applyMessageAppended(message: Message): void {
    const messages = [...this.value.messages];
    const existing = message.tool_call_id
      ? messages.findIndex(
          (item) => item.role === message.role && item.tool_call_id === message.tool_call_id,
        )
      : -1;
    if (existing >= 0) messages[existing] = message;
    else messages.push(message);
    this.commit({ messages, totalUsage: sumUsage(messages) });
  }

  // ==================== 子 Agent 栏目 ====================

  /** 一个子 Agent 开工（`index` / `id` 都是服务端给的，客户端编不出来） */
  subAgentStarted(event: { subAgentId: string; index: number }): void {
    // 幂等：同一条 started 可能到两次（同一条连接上重复订阅就会这样），重复登记会多出一个空栏目
    if (this.value.subAgents.some((view) => view.id === event.subAgentId)) return;
    const view: SubAgentView = {
      id: event.subAgentId,
      index: event.index,
      messages: [],
      status: "running",
    };
    this.commit({ subAgents: [...this.value.subAgents, view] });
  }

  /**
   * 子 Agent 的增量：拼到**它自己**的临时消息上。
   *
   * 与主会话的 `applyDelta` 是同一套拼接策略，但状态完全不共享 —— 共享就会让主会话里
   * 凭空多出子 Agent 的正文。没有 `started` 就没有这一栏（严格按会话过滤后这只会在
   * 「中途接上连接」时发生，而那时快照才是数据的来源）。
   */
  subAgentDelta(event: { subAgentId: string; text?: string; reasoning?: string }): void {
    const index = this.indexOfSubAgent(event.subAgentId);
    if (index < 0) return;
    const text = event.text ?? "";
    const reasoning = event.reasoning ?? "";
    if (!text && !reasoning) return;

    const view = this.value.subAgents[index]!;
    let stream = this.subAgentStreams.get(event.subAgentId);
    const messages = [...view.messages];
    if (!stream) {
      const message = placeholder();
      stream = { message, text: "", reasoning: "" };
      this.subAgentStreams.set(event.subAgentId, stream);
      messages.push(message);
    }
    stream.text += text;
    stream.reasoning += reasoning;
    const slot = messages.length - 1;
    const message = withAssistantText(messages[slot]!, stream.text, stream.reasoning);
    messages[slot] = message;
    stream.message = message;
    this.replaceSubAgent(index, { ...view, messages });
  }

  /**
   * 子 Agent 的快照（`session.subAgent.snapshot`）：把已有内容补齐。
   *
   * 合并只能走 {@link mergeStreamedSnapshot}：`started` 之后马上要的这次往返可能比第一批
   * 增量还慢，直接赋值会让屏幕上已经流出来的正文凭空短一截。`index` / `status` **不**从
   * 这里读（那两个事实已由 `started` / `ended` 给过，两个来源说法不同时得二选一，又多一处判定）。
   */
  subAgentSnapshot(snapshot: SubAgentSnapshotResult): void {
    const index = this.indexOfSubAgent(snapshot.subAgentId);
    if (index < 0) return;
    const merged = mergeStreamedSnapshot(
      snapshot.messages,
      this.subAgentStreams.get(snapshot.subAgentId) ?? null,
    );
    if (merged.stream) this.subAgentStreams.set(snapshot.subAgentId, merged.stream);
    else this.subAgentStreams.delete(snapshot.subAgentId);
    this.replaceSubAgent(index, { ...this.value.subAgents[index]!, messages: merged.messages });
  }

  /**
   * 一个子 Agent 收尾。
   *
   * **`failed` 不会被随后的 `done` 覆盖**：core 的 `onSubAgentEnd` 在 `finally` 里分发，
   * 出错的那次也照样会来一条结束事件 —— 无脑覆盖会把 ✖ 擦成 ✓，用户以为子任务成功了。
   */
  subAgentEnded(event: { subAgentId: string; status: "done" | "failed" }): void {
    const index = this.indexOfSubAgent(event.subAgentId);
    if (index < 0) return;
    const view = this.value.subAgents[index]!;
    if (view.status === "failed" && event.status === "done") return;
    this.replaceSubAgent(index, { ...view, status: event.status });
  }

  /** 清空栏目（`session-turn-end` / 换会话 / 换基线时同一动作） */
  clearSubAgents(): void {
    if (this.value.subAgents.length === 0) return;
    this.subAgentStreams.clear();
    this.commit({ subAgents: [] });
  }

  // ==================== 换 id / 换基线 / 阶段 ====================

  /**
   * 会话换 id（`session-id-changed`：迁移 / 另存为 / **一轮进行中的自动迁移**）。
   *
   * 只换 id 与清栏目：**不动**在飞的那一轮（`turnId` / `status` / 拼接态）—— 迁移发生在
   * 一轮内部，那一轮的 `session-turn-end` 会从新 id 上来，这里把它丢了就永远等不到了。
   * 消息由调用方随后 `applySnapshot()` 对齐（迁移把历史剔成了「模板 + 断点」）。
   */
  applyIdChanged(sessionId: string): void {
    if (this.value.sessionId === sessionId) return;
    this.subAgentStreams.clear();
    this.commit({ sessionId, subAgents: [] });
  }

  /**
   * 换基线：首屏、重连对齐、换会话之后整份对齐。
   *
   * 与 `settle()` 的差别是**语义**：那个是「这一轮收尾」（不许清 `failed`），这个是「从此
   * 开始的真相」（所以连 `failed` 一起清掉 —— 上一轮的失败已经是历史）。
   *
   * 消息同样走 {@link mergeStreamedSnapshot}：重连时本地已经拼出的正文可能比这份快照还长
   * （快照那个往返期间增量还在来），整份覆盖会让屏幕短一截。合并结果里的拼接态**留着继续
   * 往同一条消息上拼** —— 否则一轮跑到一半断线重连，后续增量会另起一条消息，答案在屏幕上
   * 裂成两段。
   *
   * ## 为什么下标必须去列表里**找**那条消息，而不是算「列表长度 - 1」
   *
   * 合并规则有一条早退分支（本地正文与推理都为空 → 原样返回快照，见
   * `mergeStreamedSnapshot`）：此刻拼接态的那条临时消息**根本不在**返回的列表里，而
   * 「长度 - 1」是服务端那条的下标。这条路径真实可达：`session-tool-calls` 会建立一条正文为空
   * 的流式态（工具调用是这条响应的一部分，正文还没开始），此时断线重连、服务端还在跑，
   * 下一片正文就会被写到服务端最后一条上 —— 而它往往是**工具结果**（`role:"tool"`）。
   * 那条消息被改写成 assistant，工具结果静默消失；用户消息同理会被顶掉。
   *
   * 所以：拼接态只在它**确实在列表里**时才留下（按引用找，不按位置猜）；不在就丢掉 ——
   * 那意味着本地没有可续的内容，下一片增量该另起一条（与合并规则「本地更全才有意义」
   * 是同一个判断）。
   */
  applySnapshot(snapshot: SessionSnapshotResult): void {
    const merged = mergeStreamedSnapshot(snapshot.messages, this.streaming);
    const slot = merged.stream ? merged.messages.indexOf(merged.stream.message) : -1;
    // 不在列表里 = 本地没有可续的内容，丢弃拼接态（早退分支之后增量该另起一条）
    this.streaming = slot >= 0 ? merged.stream : null;
    this.streamSlot = slot >= 0 ? slot : null;
    this.subAgentStreams.clear();
    this.commit({
      sessionId: snapshot.sessionId,
      messages: merged.messages,
      totalUsage: sumUsage(merged.messages),
      modelId: snapshot.modelId,
      modelLevel: snapshot.modelLevel,
      // 实发模型名与参数覆盖都是**服务端解析的结果**：客户端再推一遍就是第二份会漂的实现
      apiModel: snapshot.apiModel,
      modelParams: snapshot.modelParams,
      modelParamsLevel: snapshot.modelParamsLevel,
      lastUsage: snapshot.lastUsage,
      phase: snapshot.phase,
      // 子 Agent 属于断线/换会话之前的那一轮：`started`/`ended` 全丢在旧连接上了，
      // 留着就是一份永远不会再更新的残影
      subAgents: [],
      status: this.statusOf(snapshot.phase, this.value.turnId),
      failure: undefined,
    });
  }

  /**
   * 生成阶段变化。
   *
   * 阶段是**展示用事实**（状态栏「正在调用 edit」），它不改消息、不改在飞的轮次；
   * 但只要它非空，就说明这一轮正在跑，`status` 跟着对齐（`failed` 除外）。
   */
  setPhase(phase: PhaseInfo | null): void {
    this.commit({
      phase,
      status: this.value.status === "failed" ? "failed" : this.statusOf(phase, this.value.turnId),
    });
  }

  // ==================== 内部 ====================

  private statusOf(phase: PhaseInfo | null, turnId: number | null): SessionStatus {
    return phase !== null || turnId !== null ? "streaming" : "idle";
  }

  private indexOfSubAgent(id: string): number {
    return this.value.subAgents.findIndex((view) => view.id === id);
  }

  private replaceSubAgent(index: number, view: SubAgentView): void {
    const subAgents = [...this.value.subAgents];
    subAgents[index] = view;
    this.commit({ subAgents });
  }

  /** 保证有一条正在拼的临时消息；没有就新建一条放在列表末尾 */
  private ensureStreaming(): void {
    if (this.streaming && this.streamSlot !== null) return;
    const message = placeholder();
    this.streaming = { message, text: "", reasoning: "" };
    this.value = { ...this.value, messages: [...this.value.messages, message] };
    this.streamSlot = this.value.messages.length - 1;
  }

  private commit(patch: Partial<SessionStreamState>): void {
    this.value = { ...this.value, ...patch };
    for (const listener of [...this.listeners]) {
      try {
        listener(this.value);
      } catch {
        // 一个订阅方抛错不该影响别的订阅方（与 socket 客户端的事件分发同一口径）
      }
    }
  }
}
