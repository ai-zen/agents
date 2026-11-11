/**
 * 生成阶段的线上形状 —— 一轮对话里「模型现在到底在干什么」。
 *
 * ## 为什么它在契约里，而不是服务端的状态机旁边
 *
 * 这三个类型是**线上载荷的形状**：`SessionListEntry.phase`、`SessionSnapshotResult.phase`、
 * `SessionPhaseEvent.phase` 都在传它，客户端拿它渲染状态栏。契约的形状不该由
 * 某一侧的内部状态机拥有（那会让「线上长什么样」由实现决定）。判据很简单：**这个类型的实例
 * 会不会被塞进帧里发出去**。会，就归这里。
 *
 * ## 为什么 `PhaseTracker` 不在这里
 *
 * `PhaseTracker` 类本身（六态判定、按 index 记工具名、从流末消息里取全部调用）留在服务端：
 * 那是**实现**，客户端不需要它（它收到的是判定好的 `kind`）。协议只声明「一个阶段长什么样」。
 *
 * ## 文案不在这里，永远不在
 *
 * 这里只有可判别的枚举与数据（`kind` + 工具名）。渲染成「连接中…」还是「Connecting…」由
 * 客户端决定 —— 否则一个服务端同时接中文终端和英文浏览器时，只能挑一个语言撒谎。
 *
 * | 阶段 | 判据 | 用户真正关心什么 |
 * |------|------|------------------|
 * | `connecting` | 请求即将发出 → 响应头到达 | 是不是网络卡住了 |
 * | `queued` | 响应头到了、首个内容 chunk 之前 | 服务端排队 / 冷启动，还没开始吐字 |
 * | `thinking` | 收到 `reasoning_content` delta | 推理模型中 |
 * | `tool-calling` | 收到 `tool_calls` delta（正在拼参数） | 模型在决定调哪个工具 |
 * | `tool-waiting` | 流结束且本轮带工具调用 | 工具在跑，模型没在跑 |
 * | `streaming` | 收到 `content` delta | 正在输出正文 |
 */

/** 生成阶段（判据见文件头表格） */
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
   * 由读取方（客户端的状态栏 / 服务端的阶段出口）按结果状态筛过一遍，这里是「仍在跑」的那几个。
   */
  tools?: string[];
  /** `tool-waiting` 时这一轮的全部调用（带 id），供读取方按状态筛选 */
  calls?: ToolCallRef[];
}
