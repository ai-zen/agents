/**
 * 这个包对外的全部类型。
 *
 * 目标消息的形状照着 OpenAI 的 assistant 消息写：`content` 可以是字符串，也可以是内容块数组；
 * 思考、工具调用、用量、结束原因各占一格。这样调用方手上攒好的那条消息可以原样交进来，
 * 不需要先翻译成这个包自己的说法。
 *
 * 刻意不引用本仓任何包：这个包替的是模型提供方，那是别人家的东西，不该知道调用方的内部形状。
 */

/** 端点收到的一次请求（断言「发出去的是什么」用） */
export interface FakeLlmRequest {
  method: string;
  path: string;
  /** 解析后的请求体（`messages` / `stream` / `stream_options` 都在里面） */
  body: any;
  /**
   * 请求头原样（键名已转小写）。
   *
   * 有些东西只能从头里看出来：客户端怎么自称（`user-agent`）、有没有带服务方要的会话头。
   * 契约里的其它字段都是 body 侧，这些没有第二处可证。
   */
  headers: Record<string, string | string[] | undefined>;
  /**
   * 客户端在响应写完之前就挂断了（= 它取消了这次请求）。
   *
   * 这是「取消信号真的抵达了 socket」的唯一外部证据：只看「最后抛了取消错」不够，
   * 服务可以在请求正常返回之后再检查一次 `signal.aborted` 得到同样的结果 —— 那种情况下
   * 请求其实跑完了全部延迟与 token。`jsonDelayMs` 把窗口撞开之后，这个字段才能区分两者。
   *
   * 端点自己中断流的那些请求不算（那是服务端先断的，见 `breakAfter`）。
   */
  aborted: boolean;
}

/** 用量：OpenAI 的三格，`total_tokens` 缺省由前两格相加 */
export interface FakeLlmUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens?: number;
}

/** 结束原因：只收 OpenAI 的那几个取值 */
export type FakeLlmFinishReason =
  "stop" | "length" | "tool_calls" | "function_call" | "content_filter";

/** 工具调用的函数部分：`arguments` 是一串 JSON 文本，端点只切分它，不解析它 */
export interface FakeLlmFunctionCall {
  name?: string;
  arguments?: string;
}

/** 一次工具调用；`index` 缺省按在数组里的位置算 */
export interface FakeLlmToolCall {
  index?: number;
  id?: string;
  type?: string;
  function?: FakeLlmFunctionCall;
}

/** 正文里的一个内容块（与 OpenAI 的 content part 同形） */
export type FakeLlmContentSection =
  | { index?: number; type: "text"; text: string }
  | {
      index?: number;
      type: "image_url";
      image_url: { url: string; detail?: "low" | "high" | "original" | "auto" };
    }
  | { index?: number; type: "file"; file_id?: string; file_data?: string; filename?: string };

/** 目标消息能按哪个顺序吐片 */
export type FakeLlmStreamPart = "reasoning" | "tool_call" | "content";

/**
 * 一条目标消息：端点要把它倒推成 delta 流里的那些增量。
 *
 * 缺的格一律按「这条消息没有它」处理：没有 `finish_reason` 时，带工具调用的算 `tool_calls`，
 * 其余算 `stop`。
 */
export interface FakeLlmMessage {
  role?: "assistant";
  content?: string | FakeLlmContentSection[];
  /** 思考正文；端点按与正文同一套粒度切片后逐片发出 */
  reasoning_content?: string;
  tool_calls?: FakeLlmToolCall[];
  finish_reason?: FakeLlmFinishReason;
  usage?: FakeLlmUsage;
  /**
   * 片与片的先后。
   *
   * 缺省按「思考、工具调用、正文」三块依次吐完 —— 这是本仓对一条回答内部顺序的口径。
   * 给了这一格就按它循环取：每一片取哪一块、那一块吐完了就跳过。
   * 思考与正文交错只有这一条路能表达出来。
   */
  stream_order?: FakeLlmStreamPart[];
}

/**
 * 剧本：按这次请求决定回哪一条目标消息。
 *
 * - 字符串 = 正文是这句话、没有工具调用的那条消息；
 * - 一条目标消息 = 每次请求都回它；
 * - 数组 = 按请求序号取，用完停在最后一条；
 * - 函数 = 自己按请求体算（`index` 是这次请求的序号，从 0 起）。
 */
export type FakeLlmReply =
  | string
  | FakeLlmMessage
  | readonly (string | FakeLlmMessage)[]
  | ((request: any, index: number) => string | FakeLlmMessage);

export interface FakeLlmOptions {
  /** 剧本（缺省每次回一句「假答复」） */
  reply?: FakeLlmReply;
  /**
   * 正文、思考、工具参数各自切成几片（缺省 3）。
   *
   * 片数大于 1 才能证明客户端是把流拼出来的，而不是一次收全。
   */
  chunks?: number;
  /** 每片几个字符；给了这一格就不看 `chunks`。按内容块给正文时不切内容块 */
  chunkSize?: number;
  /** 片与片之间等多久（缺省 0；给正数可模拟慢模型，也能撑出「流到一半」的窗口） */
  chunkDelayMs?: number;
  /**
   * 非流式响应「首字节」之前的等待（缺省 0）。
   *
   * `chunkDelayMs` 只活在 SSE 分支：非流式是一次性返回的，没有中间态。但有一类用例需要非流式
   * 的慢响应：「请求还在路上时被取消」（交接摘要就是这种：它不 stream，退不掉，只能真取消）。
   * 所以这里单独给一个开关，而不是让 `chunkDelayMs` 兼职。
   */
  jsonDelayMs?: number;
  /** 流末 `usage`（目标消息自己带了就以它为准；缺省给一组固定值） */
  usage?: { prompt: number; completion: number };
  /** 让请求直接失败（错误路径用；SDK 会把 message 抛成 error 事件） */
  failWith?: { status: number; message: string };
  /** 只让第几次请求失败，其余照常回内容；序号从 0 起，与剧本函数拿到的 `index` 同一口径 */
  failOn?: number;
  /**
   * 写完这么多片之后直接中断连接：不写收尾片、不写 `[DONE]`。
   *
   * 片数从首片（带 `role` 的那一片）起算。这是「拿到了回应，但流断了」这条错误路径唯一能稳定复
   * 现的来源：正常 `end()` 结尾的流在客户端看来就是一次完整回答。
   */
  breakAfter?: number;
}

/** 起好的端点 */
export interface FakeLlm {
  /** 端点根地址，直接写进 `config.json` 的 `endpoints[].baseUrl` */
  baseUrl: string;
  /** 到目前为止收到的请求（按到达顺序） */
  requests: FakeLlmRequest[];
  /** 关掉监听（用完必须关，否则进程不退出） */
  close(): Promise<void>;
}

/** 一片增量：形状就是 OpenAI chunk 里的 `choices[0].delta` */
export interface FakeLlmDelta {
  role?: "assistant";
  content?: string | FakeLlmContentSection[];
  reasoning_content?: string;
  tool_calls?: FakeLlmToolCall[];
}
