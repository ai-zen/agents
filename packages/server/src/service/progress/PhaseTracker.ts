/**
 * 生成阶段状态机 —— 一轮对话里「模型现在到底在干什么」的六态判定。
 *
 * 纯逻辑：不依赖 React / Ink / i18n / SDK。**文案不在这里**——本包是服务端，产出的必须
 * 是可跨端传输的事实（`kind` + 工具名），渲染成「连接中…」还是「Connecting…」由客户端决定。
 * 这条分工与 `session-commands/registry.ts` 存 `descriptionKey` 不存文案是同一个道理。
 *
 * | 阶段 | 判据 | 用户真正关心什么 |
 * |------|------|------------------|
 * | `connecting` | `onInnerLoopStart`（请求即将发出）→ `open`（响应头到达） | 是不是网络卡住了 |
 * | `queued` | `open` 之后、首个内容 chunk 之前 | 服务端排队 / 冷启动，还没开始吐字 |
 * | `thinking` | 收到 `reasoning_content` delta | 推理模型中 |
 * | `tool-calling` | 收到 `tool_calls` delta（正在拼参数） | 模型在决定调哪个工具 |
 * | `tool-waiting` | 流结束且本轮带工具调用 | 工具在跑，模型没在跑 |
 * | `streaming` | 收到 `content` delta | 正在输出正文 |
 */

/** 生成阶段（见文件头表格） */
export type PhaseKind =
  "connecting" | "queued" | "thinking" | "tool-calling" | "tool-waiting" | "streaming";

/** 一次工具调用的最小身份：`id` 用来和结果消息配对，`name` 用来展示 */
export interface ToolCallRef {
  id?: string;
  name: string;
}

export interface PhaseInfo {
  kind: PhaseKind;
  /** 工具名（`tool-calling` 时有值：正在拼参数的那一个） */
  tool?: string;
  /**
   * 还在等的工具名（`tool-waiting` 时有值）。
   *
   * 存数组而不是单个名字：并行工具只报第一个就是「在等 exec 却说 edit」的由来。
   * 由读取方（`ChatSession.phase`）按结果状态筛过一遍，这里是「仍在跑」的那几个。
   */
  tools?: string[];
  /** `tool-waiting` 时这一轮的全部调用（带 id），供读取方按状态筛选 */
  calls?: ToolCallRef[];
}

/** 结果消息里能表示「这个工具已经结束」的状态（其余一律视为仍在跑） */
const FINISHED_STATUSES = new Set(["completed", "error", "aborted"]);

/** 判定「谁还在跑」只需要这几个字段，故不依赖 SDK 的 Message 类型 */
export interface PhaseMessageLike {
  role?: string;
  tool_call_id?: string;
  status?: string;
}

/**
 * 从「这一轮的全部工具调用」里筛出**仍在跑**的。
 *
 * 工具结果消息在执行**前**就以 `pending` 追加、跑完才翻成终态，所以状态就是唯一真相源。
 * 找不到对应结果消息时按「仍在跑」算：宁可多念一个名字，也不要在结果消息还没落地的
 * 那一瞬把标签清成「等待工具返回…」。
 */
export function pendingToolCalls(
  calls: readonly ToolCallRef[],
  messages: readonly PhaseMessageLike[],
): ToolCallRef[] {
  const statusById = new Map<string, string | undefined>();
  for (const message of messages) {
    if (message?.tool_call_id) statusById.set(message.tool_call_id, message.status);
  }
  return calls.filter((call) => {
    if (!call.id) return true;
    if (!statusById.has(call.id)) return true;
    return !FINISHED_STATUSES.has(statusById.get(call.id) ?? "");
  });
}

/**
 * 阶段跟踪器。生命周期由会话服务驱动：
 * `connecting()` → `opened()` → 若干 `delta()` → `streamEnded()` →（下一轮）`connecting()` …
 * 一轮结束调 `reset()`。
 */
export class PhaseTracker {
  private current: PhaseInfo | null = null;
  /**
   * 本轮各下标的工具名。
   *
   * 名字只在每个 `index` 的**首个** delta 里给出，后续 delta 只带参数片段。按 index 记，
   * 而不是一路沿用「上一个记住的名字」：并行时两个工具的参数片段会交替到达，沿用会把
   * exec 的参数错误地挂在 edit 的名字下。
   */
  private toolNames = new Map<number, string>();

  /** 当前阶段；空闲（没有在生成的轮次）时为 null */
  get phase(): PhaseInfo | null {
    return this.current;
  }

  /** 清空（一轮结束 / 重建会话时调用） */
  reset(): void {
    this.current = null;
    this.toolNames.clear();
  }

  /** 请求已发出、等响应头（DNS / TCP / TLS / 服务端受理都在这一段） */
  connecting(): void {
    this.current = { kind: "connecting" };
    this.toolNames.clear();
  }

  /**
   * 响应头已到（SDK 的 `open` 事件）——连接建立，进入「等首 token」。
   *
   * 注意不能在这里直接进 `thinking`：`open` 只说明服务端受理了请求，
   * 推理模型冷启动排几十秒是常事，那段等待被叫成「思考中」就是在骗人。
   */
  opened(): void {
    this.current = { kind: "queued" };
  }

  /**
   * 收到一个流式 chunk：按 delta 的实际内容推进阶段。
   *
   * 优先级是 `tool_calls` > `content` > `reasoning_content`：一个 chunk 里同时出现
   * 时，靠后的才代表「模型现在在干什么」（决定调工具 → 工具参数；已经出正文 →
   * 思考阶段结束）。三者都没有（如只带 `usage` 的收尾 chunk）则保持原阶段不变。
   */
  delta(chunk: unknown): void {
    const delta = (chunk as any)?.choices?.[0]?.delta;
    if (!delta || typeof delta !== "object") return;

    const toolCall = Array.isArray(delta.tool_calls) ? delta.tool_calls[0] : undefined;
    if (toolCall || delta.function_call) {
      const index = typeof toolCall?.index === "number" ? toolCall.index : 0;
      const name: string | undefined = toolCall?.function?.name || delta.function_call?.name;
      if (name) this.toolNames.set(index, name);
      // 名字按 index 取：无名的参数片段沿用**本下标**已知的名字，不会串到别的工具上
      this.current = { kind: "tool-calling", tool: this.toolNames.get(index) || undefined };
      return;
    }
    if (delta.content) {
      this.current = { kind: "streaming" };
      return;
    }
    if (delta.reasoning_content) {
      this.current = { kind: "thinking" };
    }
  }

  /**
   * 流结束（SDK 的 `parsed` 事件，参数是本轮 assistant 消息）。
   *
   * 本轮带工具调用 → 接下来是工具执行，模型不在跑；不带 → 由调用方 `reset()`。
   * 记下**全部**调用（不是第一个）：并行时只念第一个名字就是在说错话。
   */
  streamEnded(receiver: unknown): void {
    const message = receiver as any;
    const raw: any[] = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
    const calls: ToolCallRef[] = [];
    for (const [fallbackIndex, call] of raw.entries()) {
      const name: string =
        call?.function?.name ?? this.toolNames.get(call?.index ?? fallbackIndex) ?? "";
      if (name) calls.push({ id: call?.id, name });
    }
    if (message?.function_call?.name) calls.push({ name: message.function_call.name });
    if (calls.length === 0) return;
    this.current = { kind: "tool-waiting", tools: calls.map((call) => call.name), calls };
  }
}
