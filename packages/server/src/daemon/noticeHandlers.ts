/**
 * 通知的两个入口（`notice.list` / `notice.ack`）—— 一层薄接线。
 *
 * ## 两条方法的范围并不相同
 *
 *   · `notice.list` 只列**全局**通知：会话内的那两类（题目 / 会话通知）有所属物可依附，
 *     入口是 `session.snapshot` 的快照；
 *   · `notice.ack` 同时认**两类**的 id（全局 + 会话内）：id 是 UUID、全局唯一，一个 id 就是
 *     指那一条，客户端不必先分类再选方法（见 `ServerApp.ackNotices`）。
 *
 * ## 为什么单开一个文件
 *
 * 全局通知不属于任何命名空间（不是 `session.*`，也不是 `config.*`）：它说的是**这部进程**
 * 此刻的状态（「MCP 连不上」「存档不可用」），切到哪个会话都该看得见。挂进 `session.*` 会
 * 让人以为它跟着会话生死，而它恰恰是**不跟**会话走的那一类。
 *
 * ## 为什么不带业务判断
 *
 * 槽位表归 `ServerApp`（进程作用域的状态，见 `ServerApp.publishNotice` 的「存与播同一个
 * 入口」）与会话层（`SessionManager.ackNotice`），本文件只做**参数形状**这一层：`ids` 必须是
 * 字符串数组。认领失败（id 本来就不存在、或已被别人确认）不是错误，只是不出现在 `acked` 里
 * —— 一份状态，任意客户端确认即消。
 */

import type { MethodHandlers } from "./Daemon.js";
import { badParams, field } from "./params.js";
import type { NoticeAckResult, NoticeListResult } from "../protocol/index.js";

/**
 * 槽位表的**读与消**两面。
 *
 * 窄成这两个函数而不是递一个类：本层不该能「登记」通知（那是服务自己的动作，入口是
 * `ServerApp.publishNotice`）。协议里的两条方法各对应一个动作，接口就正好两个成员。
 */
export interface NoticeSource {
  /** 此刻还没被确认的全部槽位 */
  list(): NoticeListResult;
  /** 确认掉给定的 id（全局或会话内），回真正消失了的那些 */
  ack(ids: string[]): NoticeAckResult;
}

export function createNoticeHandlers(source: NoticeSource): MethodHandlers {
  return {
    /**
     * 此刻还挂着的全局通知。
     *
     * 不带参数：全局通知是**这部进程**的状态，没有「按调用方过滤」这回事 —— 同一台机器上的
     * 多个客户端看到的是同一份。
     */
    ["notice.list"]: (): NoticeListResult => source.list(),

    /**
     * 确认一批通知（`{ ids }` → `{ acked }`）。
     *
     * `acked` 只含**确实被这次调用消掉**的 id：本来就不存在、或已经被别人确认过的不会出现
     * 在里面 —— 客户端据此知道「这一条是我关掉的，还是早就没了」，而两种都不算错误。
     * 空数组是合法入参（什么都不确认）。
     */
    ["notice.ack"]: (params): NoticeAckResult => source.ack(requireIds(params)),
  };
}

/**
 * `ids`：非空字符串组成的数组（空数组合法：什么都不确认）。
 *
 * 逐个查而不是 `every` + 断言：报错时能指出是哪一个位置不对，而且不必在返回值上做断言
 * （断言处越多，「这里为什么可以断」就越难说清）。
 */
function requireIds(params: unknown): string[] {
  const value = field(params, "ids");
  if (!Array.isArray(value)) throw badParams(`missing or invalid "ids"`);
  for (const [index, id] of value.entries()) {
    if (typeof id !== "string" || id.length === 0) {
      throw badParams(`invalid "ids[${index}]" (expected non-empty string)`);
    }
  }
  return value as string[];
}
