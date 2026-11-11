/**
 * 线上错误码 —— 只有类型，没有运行期表。
 *
 * ## 为什么它是协议的一部分
 *
 * 这些码会原样出现在错误响应的 `error.data.code` 里（数字码在 `error.code`，见
 * `RpcErrorCode`），客户端靠它决定「是改请求（`bad-params` / `bad-index`）、还是重试
 * （`turn-busy`）、还是换一段会话（`session-missing` / `unknown-session`）」。
 *
 * ## 只增不改语义
 *
 * 一个码一旦发出去就是协议的一部分：改它的值等于让老客户端的 `switch` 落到 `default`。
 * 要换语义就新增一个码。
 *
 * ## 为什么 `CodedError` 是 `Error & { code }` 而不是一个类
 *
 * 抛错的是多个服务模块，它们各自 `throw`；用 `instanceof` 收口会让「不是本包造的错误」
 * 全被漏掉（例如 SDK 抛出来的、带同样 `code` 形状的错误）。判断靠结构检查，跨包、
 * 跨版本都成立 —— 实现见 `src/wire/errors.ts`，两侧各一份。
 */

/**
 * 线上错误码：值就是错误对象里 `data.code` 的字面量（数字码在 `error.code`，见 `RpcErrorCode`）。
 *
 * 表里混着两类：**业务码**（`session-missing` / `bad-index` …，由服务层 `throw` 出来）与
 * **协议码**（下面带大段说明的那几个，由传输层 / 派发器产生）。两类落在同一个字段里，是
 * 因为客户端对它们的读法一样：看 `data.code` 决定这一段如何处理，不看它住在哪一层。
 *
 * 本版**没有** `frame-too-large`：单条消息的体积上限交给 WebSocket 的 `maxPayload`（超了
 * 由传输层直接断连），这条码永远不会出现在线上，留着就是死码。
 */
export type ErrorCode =
  | "no-store"
  | "unknown-workspace"
  | "turn-in-flight"
  | "session-exists"
  | "bad-params"
  | "session-missing"
  | "workspace-required"
  | "workspace-path-missing"
  | "workspace-exists"
  | "unknown-session"
  | "unknown-model"
  | "unknown-agent"
  | "turn-busy"
  | "sub-agent-missing"
  | "nothing-to-handoff"
  | "no-handoff"
  | "handoff-in-flight"
  | "handoff-aborted"
  | "bad-index"
  /**
   * 这条文本消息**不是一条能处理的帧** —— 不是合法 JSON。
   *
   * 这个码在本版**不断连**（与上一版的判据相反）。理由只有一条：WebSocket 已经把消息边界
   * 给了我们，「这一条不是 JSON」不再等于「后面的字节全部错位」—— 下一条消息照样从它自己的
   * 边界开始。所以它和别的请求级错误一样：回一条错误、连接照旧。
   *
   * 归不到任何请求（JSON 都没解出来，`id` 无从谈起），所以这条错误的 `id` 是 `null`。
   */
  | "bad-frame"
  /**
   * 合法 JSON，但**不是合法请求对象**。
   *
   * 四种情形都落这个码：
   *
   *   1. 顶层是**数组** —— 本版不支持 JSON-RPC 的批量（不逐项展开，整体回一条错误）；
   *   2. 缺 `method`（有 `id` 却没说要干什么）—— 包括本版不收的通知与响应；
   *   3. 外壳不合法（缺 `jsonrpc: "2.0"`、`id` 不是 `0 … 2³²-1` 的整数）；
   *   4. 握手完成之后**再次**发 `hello`（握手只有一次，重放不是「再来一遍」）。
   *
   * 与 `bad-frame` 的分界线：`bad-frame` 是「这条消息不是 JSON」，这一个说的是「JSON 解析
   * 成功了，但那个对象不是像样的请求」。两者都回错误、都**不断连**。
   */
  | "invalid-request"
  /**
   * 握手之前调用了别的方法。
   *
   * 这是**请求级**的协议失败，不是连接级的：回一条错误就行，连接照旧（客户端补上
   * `hello` 就能继续用）。
   */
  | "handshake-required"
  /**
   * 握手本身不合格（上一版的第一个首帧校验用的码）。
   *
   * 本版不再产出它：握手前的失败现在分得更细 —— 顺序不对是 `handshake-required`，版本
   * 不对是 `version-mismatch`，握手之后重放是 `invalid-request`。它留在表里，是因为码
   * **只增不改**：老的客户端可能还在 `switch` 它，从联合里删掉会让那段落到 `never` 上。
   */
  | "bad-handshake"
  /**
   * 客户端与服务端说的协议版本不一样 —— 断代，不连。
   *
   * 唯一一个「回了错误还必须断连」的请求级码：版本不同意味着**后面每一条消息的形状都不可
   * 信**，继续用下去只会在别处以更难查的形式出错。所以这是**连接级**失败。
   */
  | "version-mismatch"
  /** 方法名字不认识（本服务端没有注册它） */
  | "unknown-method"
  /** 服务端自己出的事（handler 抛了一个不带码的错误）：既不是参数错，也不是业务拒绝 */
  | "internal";

/**
 * JSON-RPC 2.0 的 `error.code`。
 *
 * 六个值够用：五个规范定义的码 + 一个服务端自定义码（`-32000`，规范留给实现的那一段）。
 * 之所以能收得这么窄：业务语义全部留在 `data.code` 的字符串里（见 `ErrorCode`），数字码只
 * 回答「是不是协议级失败、客户端该不该改请求」。
 */
export type RpcErrorCode = -32700 | -32600 | -32601 | -32602 | -32603 | -32000;

/**
 * 字符串码 → 数字码。**纯类型**，没有一张运行期映射表：表一旦是运行期的，就会出现
 * 「表里有、联合里没有」这种编译器管不到的分叉（运行期那份按需存在 `wire/errors.ts`）。
 *
 * 只有五条需要专门的数字码（`bad-frame` / `invalid-request` / `unknown-method` /
 * `bad-params` / `internal`），其余（业务码 + `bad-handshake` / `version-mismatch` /
 * `handshake-required`）一律落 `-32000` —— 它们的共同点是「服务端拒绝了这次请求」，
 * 客户端该看的是 `data.code`，不是数字码。
 *
 * `bad-frame` 与 `invalid-request` 是**两档**，不是同一条：前者是「不是合法 JSON」（解析
 * 就失败了），后者是「JSON 合法、但不是合法请求对象」（顶层数组 / 缺 `method` / 重发
 * `hello`）。分开的理由是客户端能做的事不同 —— 前者要修的是「你发的那串东西本身」，后者
 * 要修的是「请求对象长什么样」。两者都不断连。
 */
export type RpcCodeOf<E extends string> = E extends "bad-frame"
  ? -32700
  : E extends "invalid-request"
    ? -32600
    : E extends "unknown-method"
      ? -32601
      : E extends "bad-params"
        ? -32602
        : E extends "internal"
          ? -32603
          : -32000;

/** 带机器可判别 `code` 的错误 —— 帧层原样把 `code` 递给客户端 */
export interface CodedError extends Error {
  code: ErrorCode;
}
