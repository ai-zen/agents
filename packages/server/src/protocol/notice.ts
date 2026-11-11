/**
 * **全局通知**的线上契约 —— 不属于任何会话的那些通知。
 *
 * 与 `sessions.ts` 里的 `SessionNoticeEvent` 分工：那条绑定在某一段会话上（载荷里有
 * `sessionId`），切走会话它就该跟着消失；这一份不属于任何会话，例如「MCP 连不上」
 * 「存档不可用」—— 它们说的是**这部进程**此刻的状态，用户切到哪个会话都该看得见。
 *
 * ## 生命周期
 *
 * 随**进程**生死，**不落盘**：它们是「此刻正在发生的事」，不是历史。进程退出就没了，重启
 * 后重新登记。归属放在进程（`ServerApp`）而不是某个 `LiveSession` 上，否则切一次会话就会
 * 把还没人看过的全局通知误杀。
 *
 * ## 查询与确认：`notice.list` / `notice.ack`
 *
 * 会话内的两类（题目 / 会话通知）有所属物可依附，走 `session.snapshot`/`session.attach` 的
 * 快照；全局的没有，所以单开这两条入口。
 *
 * 两个出口（实时推送的事件 / 槽位）是**同一条通知**，`id` 一致：确认只用那个 id，客户端
 * 不必先分辨「这条属于哪一类、该去哪里取 id」。
 *
 * ## 确认即消（一份状态，不按客户端各存一份已读）
 *
 * 槽位由**任意**客户端确认就消失（`notice.ack { ids }`），不做「每个客户端各记一份已读」：
 * 那是状态爆炸（连接数 × 通知数），而且会让「我说过已经确认了」变成服务端的二次记账。
 * 通知也不做计时器自动消失：寿命的终点由消费者决定，能观测；计时器则是「没看到也会没」。
 */

import type { NoticeLevel, ServerNoticeCode } from "./sessions.js";

/** 全局通知的方法名（服务端注册与客户端调用共用同一份字面量） */
export type NoticeMethod = "notice.list" | "notice.ack";

/**
 * 一个全局通知槽位。
 *
 * 有状态、有生命周期：登记之后一直在这里，直到有人确认（或进程退出）。广播只是「顺手
 * 通知一声」，槽位本身与有没有人在听无关。
 */
export interface GlobalNoticeSlot {
  /**
   * 槽位 id —— **UUID**（`crypto.randomUUID()`）。
   *
   * 为什么不用自增计数器：跨进程、跨 daemon、跨重启都不该撞号，而计数器要持久化才不撞
   * （通知不落盘，那就更不能靠它）。
   *
   * **同一个值也是那一条 `server-notice` 事件的 `id`**（`sessions.ts` 的
   * `ServerNoticeEvent.id`）：实时推送与槽位是同一条通知的两个出口，id 一致，客户端收到
   * 事件就能直接 `notice.ack`，不必回头查一次列表。
   */
  id: string;
  /** 级别：客户端据此选颜色 / 语气 */
  level: NoticeLevel;
  /** 通知种类：客户端按它查自己的 i18n 表渲染 —— 服务端不产文案 */
  code: ServerNoticeCode;
  /** 文案里的可变部分（客户端代入自己的模板） */
  params?: Record<string, unknown>;
  /** 登记时刻（ISO 8601） */
  createdAt: string;
}

/** `notice.list` 的结果：此刻还没被确认的全部槽位 */
export interface NoticeListResult {
  notices: GlobalNoticeSlot[];
}

/** `notice.ack` 的参数：要确认的槽位 id 列表 */
export interface NoticeAckParams {
  ids: string[];
}

/** `notice.ack` 的结果：确实被确认掉的 id（已经不在的、不认识的不会出现在这里） */
export interface NoticeAckResult {
  acked: string[];
}
