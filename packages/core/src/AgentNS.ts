import type { JSONSchema7 } from "json-schema";
import type { AgentError } from "./AgentError.js";

/**
 * Agent Abstraction Layer
 */
export namespace AgentNS {
  export enum Role {
    Unknown = "unknown",
    System = "system",
    User = "user",
    Assistant = "assistant",
    Function = "function",
    Tool = "tool",
  }

  export enum MessageStatus {
    Unknown = "unknown",
    Pending = "pending",
    Completed = "completed",
    Error = "error",
    Aborted = "aborted",
    Writing = "writing",
  }

  export enum FinishReason {
    Unknown = "unknown",
    Stop = "stop",
    Length = "length",
    ContentFilter = "content_filter",
    FunctionCall = "function_call",
    ToolCalls = "tool_calls",
  }

  export interface FunctionCall {
    arguments?: string;
    name?: string;
  }

  export interface ToolCall {
    index?: number;
    id?: string;
    type?: string;
    function?: FunctionCall;
  }

  export interface ImageUrlContentSection {
    index?: number;
    type: "image_url";
    image_url: {
      url: string;
      /** 图片处理细节级别（如 DeepSeek 视觉模型）：
       *  low 推理前缩放至 512×512，更省 token；high / original 保留原图；auto 自动（当前等价 original） */
      detail?: "low" | "high" | "original" | "auto";
    };
  }

  export interface TextContentSection {
    index?: number;
    type: "text";
    text: string;
  }

  /** Files API 引用内容块（如 DeepSeek Files API）：
   *  file_id 引用已上传文件；file_data 以 base64 data URL 内联（与 file_id 互斥）；
   *  filename 仅 file_data 时可带，不能与 file_id 同现 */
  export interface FileContentSection {
    index?: number;
    type: "file";
    file_id?: string;
    file_data?: string;
    filename?: string;
  }

  export type MessageContentSection =
    ImageUrlContentSection | TextContentSection | FileContentSection;

  export type MessageContent = string | MessageContentSection[];

  export interface Message {
    /** 消息唯一标识，强制必填：`Message` 构造时自动生成（或由 `newMessageId()` 给）。
     *  `formatHistory` 发出去的那一份没有它 —— 那是按白名单重排的另一个对象，不是这条消息本身 */
    id: string;
    /** 这条消息产生的时刻（epoch 毫秒）。构造 `Message` 时自动填，不从外面传 */
    createdAt: number;
    name?: string;
    content?: MessageContent;
    function_call?: FunctionCall;
    tool_call_id?: string;
    tool_calls?: ToolCall[];
    reasoning_content?: string;
    role: Role;
    status?: MessageStatus;
    finish_reason?: FinishReason;
    /**
     * 产生本条 assistant 消息的那次 API 响应的 token 用量，由流式响应的最后一个 chunk 写入；
     * 只有 assistant 消息有值。
     *
     * 每次请求都会重发完整历史，所以把一段会话里所有 assistant 消息的 `usage` 加起来就是实际
     * 消耗（计费口径）。求和用 `sumUsage()`。
     */
    usage?: Usage;
    /**
     * 本条 **tool 消息**内「内部委派」产生的累计 token 用量（如 subagent）：
     * 委派跑完时由 `AgentToolLazy` 写进 `ctx.resultMessage`，随消息持久化；
     * 与 `usage`（本条消息自身那次响应）互斥出现。求和用 `sumUsage()`。
     */
    subAgentUsage?: Usage;
    hidden?: boolean;
    omit?: boolean;
    /**
     * 这条 user 消息从哪儿来 —— 「谁说的话」只有这一个来源。宿主注入的隐藏 cwd 消息也要填
     *（`{ kind: "system", label: "cwd" }`）：缺了它，注入消息就会被数进「用户说的话」，
     * 而判据只有一条：`source.kind === "user"`。
     */
    source?: MessageSource;
    /**
     * 这条消息自己出的错 —— 与 `failed` 事件载荷是**同一个实例**，不另造一个形状。
     *
     * 错误文本不进 `content`：`content` 是模型说的话，塞进去之后只要「保留半截」策略一生效，
     * 模型下一次请求就会看到自己「说」了一段 `ECONNREFUSED`。
     * 例外是 `role: tool`：那条消息的 `content` 本来就是给模型读的**结果**。
     */
    error?: AgentError;
  }

  /**
   * 这条 user 消息从哪儿来。
   *
   * 三格都是文字，**不带任何活引用** —— 消息要落库，而 `Agent` 带着 `client`、事件
   * 监听器、自己那份 `messages`：JSON 序列化直接成环抛错，硬裁掉之后同一个字段就变成
   * 「活的时候有、读回来没有」，形状当场变形。要「点进去看那段会话」，需要的是会话 id
   *（宿主的财产），不是 agent 引用 —— core 给 label，宿主自己映射。
   */
  export type MessageSource =
    /** 用户本人说的话 */
    | { kind: "user" }
    /** 另一个 agent 推来的（「补测试」「会话 1」） */
    | { kind: "agent"; label: string }
    /** 宿主、定时器、外部系统注入的（含那条隐藏的 cwd 消息） */
    | { kind: "system"; label: string };

  /** 带正文的条目：落地成一条 User 消息 */
  export interface InboxEntryWithContent {
    /**
     * 落地成 User 消息时用的 id，由投递方给定 —— 客户端据此乐观回显；缺省则由 core 生成。
     * 只有会落地的条目才有这一格。
     */
    messageId?: string;
    /** core 补：进来的时刻。注释里用它让模型判断时效 */
    createdAt: string;
    /** 高：内循环里工具跑完后可取；低：只有外循环可取 */
    priority: "high" | "low";
    source: MessageSource;
    /** 原样搬进消息的正文，可以是多模态段数组 */
    content: MessageContent;
  }

  /**
   * **钥匙**：只为把它叫起来，自己不落地成任何消息。
   *
   * 存在的唯一理由是「输入已经在 `messages` 里了」—— 委派的 subagent、装载好历史的一次性
   * 会话，都是这种情形：燃料装好了，只差拧一下。没有正文就没有消息，所以没有 `messageId`，
   * 也没有 `source`。
   *
   * `priority` 恒为 `low`：内循环只看 high，钥匙天然取不到。
   */
  export interface InboxKey {
    createdAt: string;
    priority: "low";
    content?: undefined;
  }

  export type InboxEntry = InboxEntryWithContent | InboxKey;

  /** 投递入参：带正文的（`messageId` / `createdAt` 由 core 补），或者什么都不给 = 拧钥匙 */
  export type InboxInput =
    | (Omit<InboxEntryWithContent, "messageId" | "createdAt"> & { messageId?: string })
    | { content?: undefined };

  /**
   * 对外报的两格：在干 / 闲 —— **只由循环的位置决定**，与「收不收件」无关。
   *
   * - `working`：手上有活（这一批已经取出来了，正在跑）；
   * - `idle`：手上没活 **且** 队列真空。中间那一拍（手上没活、但队列里还压着）**不报闲** ——
   *   否则等在外面的 subagent 会在半截处收走结果。
   *
   * 「从下一批起还收不收件」**不在这一格里**：它是另一处状态（`Agent.isOutputPaused`）。
   * 两件事压在同一格上必然有一格报不出来：不取件时投进来的那批照跑（口径如此），跑完就该报
   * 闲，而那个开关仍旧是 true —— 压成一格的话，这一拍只能报一个，另一个必然丢。
   *
   * 不报「出过错」：**出过错是事实，不是状态**（读那条消息的 `status` / `error`）。
   * 其余的「在不在想」「在等哪几个工具」全部读活消息与 delta 流推断，不存第二份状态。
   */
  export type AgentState = "working" | "idle";

  /**
   * 寿命：常驻还是只用一次，构造期定下。
   *
   * 它不只是「活多久」，是**能力差**（`CORE.md` §1）：
   * - `resident`：`start` / `stop`，任何人都能 `push` 多次 —— 结果以后回来的工具还有人在收；
   * - `one-shot`：`send()` / `runOnce()` 专用；**开跑即关收**（第二次 `push` 抛 `closed`），
   *   它的寿命在调用栈里，栈一退就没收件人了。
   */
  export type AgentLifetime = "resident" | "one-shot";

  export interface Delta {
    name?: string;
    content?: MessageContent;
    function_call?: FunctionCall;
    tool_call_id?: string;
    tool_calls?: ToolCall[];
    reasoning_content?: string;
    role?: Role;
    status?: MessageStatus;
    finish_reason?: FinishReason;
    hidden?: boolean;
    omit?: boolean;
  }

  export interface Usage {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  }

  export interface FunctionDefine {
    name: string;
    description: string;
    strict?: boolean;
    parameters: JSONSchema7;
  }

  export interface ToolDefine {
    type: "function";
    function: FunctionDefine;
  }
}
